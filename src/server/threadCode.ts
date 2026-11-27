import { type HunkLine, parseDiffHunk } from "../shared/diffHunk.js";
import type { CodeAnchor, CodeRow, CodeWindow } from "../shared/types.js";
import { Activity, runIn, waitOn } from "./activity.js";
import { readBlob, readObject } from "./catFile.js";
import { ensureCommit } from "./clone.js";
import {
	hunkWindowRows,
	snapshotOf,
	touchesOldSide,
	windowRows,
} from "./codeWindow.js";
import { runGit } from "./git.js";
import { limiter } from "./limiter.js";

/** What the PR's diff is taken against. */
export interface DiffBase {
	/** The snapshot's base (Snapshot.base). */
	snapshot: string;
	/** The base branch's ref in the clone, as it stood at a comment's time. */
	ref: string;
}

/**
 * Promises by key, each made once. A failed answer (`failed`) stays until
 * `forgetFailures`, so what can't be had is asked for once per Refresh.
 * Holds at most `max` keys, dropping the least recently used: a long
 * session with many Refreshes doesn't grow without bound (a dropped answer
 * is just asked for again).
 */
export class Memo<T> {
	readonly #map = new Map<string, Promise<T>>();
	/** Each promise's making, in an Activity of its own (activity.ts). */
	readonly #work = new WeakMap<Promise<T>, Activity>();
	readonly #failed = new Set<string>();

	constructor(
		private readonly failed: (value: T) => boolean,
		private readonly max: number,
	) {}

	get size(): number {
		return this.#map.size;
	}

	get(key: string, make: () => Promise<T>): Promise<T> {
		const known = this.#map.get(key);
		if (known !== undefined) {
			// Most recently used last.
			this.#map.delete(key);
			this.#map.set(key, known);
			return this.#wait(known);
		}
		// Made in an Activity of its own: whoever waits on it (this caller,
		// or another read's, the agent's, the placer's later) shows its step.
		const activity = new Activity();
		const made: Promise<T> = runIn(activity, make).then((value) => {
			if (this.failed(value) && this.#map.get(key) === made) {
				this.#failed.add(key);
			}
			return value;
		});
		this.#map.set(key, made);
		this.#work.set(made, activity);
		for (const oldest of this.#map.keys()) {
			if (this.#map.size <= this.max) break;
			this.#map.delete(oldest);
			this.#failed.delete(oldest);
		}
		return this.#wait(made);
	}

	/** Awaits `promise`, showing its making's step meanwhile. */
	#wait(promise: Promise<T>): Promise<T> {
		const activity = this.#work.get(promise);
		return activity ? waitOn(promise, () => activity) : promise;
	}

	forgetFailures(): void {
		for (const key of this.#failed) this.#map.delete(key);
		this.#failed.clear();
	}

	clear(): void {
		this.#map.clear();
		this.#failed.clear();
	}
}

/** One side of the whole file as context lines (the file is unchanged there). */
function contextLines(content: string): HunkLine[] {
	if (content === "") return [];
	const texts = content.split("\n");
	if (content.endsWith("\n")) texts.pop();
	return texts.map((text, i) => ({
		kind: "context",
		oldNo: i + 1,
		newNo: i + 1,
		text,
	}));
}

/** git output, or null when git fails (never a guess). */
const tryGit = (repo: string, signal: AbortSignal, args: string[]) =>
	runGit(repo, args, { signal }).then(
		(out) => out,
		() => null,
	);

/** Gits one source runs at once: its reads batch, but many commits still make many. */
export const CODE_GITS = 8;

/** The most gits a source ran at once since `most` was reset (tests). */
export const codeGits = { running: 0, most: 0 };

/** Paths are GitHub's, not patterns: `[id].tsx` must not match `i.tsx`. */
const LITERAL = "--literal-pathspecs";

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The renames between two commits: new path → old path, and the old paths. */
interface Renames {
	from: Map<string, string>;
	old: Set<string>;
}

/**
 * The renames between two commits, from `git diff -M --name-status -z`
 * (as the Files page pairs them). Null when git fails.
 */
async function renamedPaths(
	git: (args: string[]) => Promise<string | null>,
	left: string,
	right: string,
): Promise<Renames | null> {
	const out = await git([
		LITERAL,
		"diff",
		"--no-color",
		"--no-ext-diff",
		"-M",
		"--name-status",
		"-z",
		left,
		right,
	]);
	if (out === null) return null;
	const fields = out.split("\0");
	const renames: Renames = { from: new Map(), old: new Set() };
	for (let i = 0; i < fields.length; ) {
		const status = fields[i] ?? "";
		if (!status) break;
		if (status.startsWith("R")) {
			const [from = "", to = ""] = [fields[i + 1], fields[i + 2]];
			renames.from.set(to, from);
			renames.old.add(from);
			i += 3;
		} else {
			i += 2;
		}
	}
	return renames;
}

/** The newest commits of a first-parent chain, newest first. */
interface Chain {
	commits: { oid: string; time: number }[];
	/** The chain has no more (fewer than asked for). */
	complete: boolean;
}

/** How many of a base branch's newest commits one read takes (#chain). */
const CHAIN_PAGE = 500;

/** Paths asked of one diff, and its answer: each path's sections. */
interface DiffBatch {
	paths: Set<string>;
	result: Promise<Map<string, string[]> | null>;
}

/**
 * A path git writes as is in `diff --git a/<path> b/<path>` (with
 * core.quotePath off): no control characters, quotes or backslashes.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: what git quotes
const PLAIN_PATH = /^[^\x00-\x1f\x7f"\\]+$/;

/**
 * A whole diff cut into each asked path's sections: those whose header is
 * exactly `diff --git a/<path> b/<path>` (renames are off, so both sides
 * name it). Every asked path gets a list, empty when git listed none.
 */
export function splitSections(
	out: string,
	paths: readonly string[],
): Map<string, string[]> {
	const byHeader = new Map<string, string>();
	for (const p of paths) byHeader.set(`diff --git a/${p} b/${p}`, p);
	const sections = new Map<string, string[]>(paths.map((p) => [p, []]));
	const starts: number[] = [];
	const re = /^diff --git /gm;
	for (let m = re.exec(out); m; m = re.exec(out)) starts.push(m.index);
	starts.forEach((start, i) => {
		const end = starts[i + 1] ?? out.length;
		const text = out.slice(start, end);
		const eol = text.indexOf("\n");
		const header = eol === -1 ? text : text.slice(0, eol);
		const path = byHeader.get(header);
		if (path !== undefined) {
			sections.get(path)?.push(text);
			return;
		}
		// A section no asked path's header names (a file under an asked
		// path that is a directory there): counted against that path, or
		// against every path when none is it, so none is taken for a single
		// file's diff (never a guess).
		const under = paths.filter((p) => header.includes(`a/${p}/`));
		for (const p of under.length > 0 ? under : paths) {
			sections.get(p)?.push(text);
		}
	});
	return sections;
}

/**
 * The code comments point at, from the clone: for an anchor, the PR's diff
 * of its file at its commit, windowed to its range (codeWindow.ts). One per
 * session. Everything git answers is cached (commits, merge bases and diffs
 * don't change), so a reload costs no git; a failure is cached too, so a
 * commit GitHub can't give us is fetched once, until `forgetFailures` (a
 * Refresh). `fetchCommit` is the clone's (tests swap it).
 */
export class ThreadCodeSource {
	// Bounded: a whole file's diff each in #files; the rest are small.
	readonly #commits = new Memo<boolean>((ok) => !ok, 1024);
	readonly #bases = new Memo<string | null>((oid) => oid === null, 2048);
	/** The base branch's tip at a time: moves when a Refresh fetches it. */
	readonly #tips = new Memo<string | null>(() => false, 1024);
	/** The base branch's newest commits (#chain): moves with it too. */
	readonly #chains = new Memo<Chain | null>((c) => c === null, 16);
	/** Paths asked of one diff (left, commit) not yet read, by that pair. */
	readonly #batches = new Map<string, DiffBatch>();
	readonly #renames = new Memo<Renames | null>((r) => r === null, 64);
	readonly #files = new Memo<HunkLine[] | null>((lines) => lines === null, 256);

	/** Stops every git call (close). */
	readonly #stop = new AbortController();
	/** Its gits, at most CODE_GITS at a time. */
	readonly #limit = limiter(CODE_GITS);

	/** git output, or null when git fails; waits for a slot (#limit). */
	#git(args: string[]): Promise<string | null> {
		return this.#limit(() => this.#counted(args));
	}

	/** git output, or null, counted in codeGits (inside a slot). */
	async #counted(args: string[]): Promise<string | null> {
		codeGits.running++;
		codeGits.most = Math.max(codeGits.most, codeGits.running);
		try {
			return await tryGit(this.repo, this.#stop.signal, args);
		} finally {
			codeGits.running--;
		}
	}

	constructor(
		private readonly repo: string,
		private readonly fetchCommit: (
			repo: string,
			oid: string,
			signal?: AbortSignal,
		) => Promise<boolean> = ensureCommit,
	) {}

	/** Stops its git calls, under way and to come (the session closing). */
	close(): void {
		this.#stop.abort();
	}

	/** Lets a Refresh retry what failed, and re-date the base branch. */
	forgetFailures(): void {
		this.#commits.forgetFailures();
		this.#bases.forgetFailures();
		this.#tips.clear();
		this.#chains.clear();
		this.#renames.forgetFailures();
		this.#files.forgetFailures();
	}

	/**
	 * Asks for every commit of `anchors` at once, so the clone fetches the
	 * missing ones in one `git fetch` (ensureCommit batches asks made
	 * together) rather than as each thread's code is built.
	 */
	prefetch(anchors: readonly CodeAnchor[]): void {
		for (const { commit } of anchors) {
			if (OID.test(commit)) void this.#commit(commit);
		}
	}

	#commit(oid: string): Promise<boolean> {
		return this.#commits.get(oid, () =>
			this.fetchCommit(this.repo, oid, this.#stop.signal).catch(() => false),
		);
	}

	#mergeBase(commit: string, other: string): Promise<string | null> {
		return this.#bases.get(`${commit} ${other}`, async () => {
			const out = await this.#git(["merge-base", commit, other]);
			const oid = out?.trim() ?? "";
			return OID.test(oid) ? oid : null;
		});
	}

	/**
	 * The base branch's last first-parent commit by `at`: the first commit
	 * of its first-parent chain whose commit time is at or before `at`, as
	 * `git rev-list -1 --first-parent --before=<at>` gives it. Read off the
	 * chain's newest commits (#chain), one git for every comment's time
	 * rather than one each (CAR-320); a deeper read only when they're all
	 * newer.
	 */
	#tip(ref: string, at: string): Promise<string | null> {
		const ms = Date.parse(at);
		if (Number.isNaN(ms)) return Promise.resolve(null);
		const seconds = Math.floor(ms / 1000);
		return this.#tips.get(`${ref} ${at}`, async () => {
			for (let n = CHAIN_PAGE; ; n *= 4) {
				const chain = await this.#chain(ref, n);
				if (!chain) return null;
				const hit = chain.commits.find((c) => c.time <= seconds);
				if (hit) return hit.oid;
				if (chain.complete) return null;
			}
		});
	}

	/** The newest `n` commits of `ref`'s first-parent chain, with their commit times. */
	#chain(ref: string, n: number): Promise<Chain | null> {
		return this.#chains.get(`${ref} ${n}`, async () => {
			const out = await this.#git([
				"rev-list",
				"--first-parent",
				"--timestamp",
				`--max-count=${n}`,
				ref,
				"--",
			]);
			if (out === null) return null;
			const commits: Chain["commits"] = [];
			for (const line of out.split("\n")) {
				if (!line) continue;
				const [time = "", oid = ""] = line.split(" ");
				if (!/^\d+$/.test(time) || !OID.test(oid)) return null;
				commits.push({ time: Number(time), oid });
			}
			return { commits, complete: commits.length < n };
		});
	}

	/**
	 * The diff's old side for a comment: the merge base of its commit with
	 * the snapshot's base, which must be the one the base branch as it stood
	 * at the comment's time gives (so old-side rows are right). `lenient`
	 * skips that check for a range wholly on the new side, whose own rows
	 * are right either way.
	 */
	async #left(
		anchor: CodeAnchor,
		base: DiffBase,
		lenient: boolean,
	): Promise<string | null> {
		const left = await this.#mergeBase(anchor.commit, base.snapshot);
		if (!left || (lenient && !touchesOldSide(anchor))) return left;
		const tip = await this.#tip(base.ref, anchor.at);
		if (!tip) return null;
		return (await this.#mergeBase(anchor.commit, tip)) === left ? left : null;
	}

	/**
	 * Every line of `path`'s diff between `left` and `commit` (the whole
	 * file as context when it's unchanged). A file renamed to `path` is
	 * diffed against its old path, paired as the whole diff pairs it. Null,
	 * never a guess, when any git step fails, the file is missing, `path` is
	 * only a rename's old path, or the diff isn't exactly that one file.
	 */
	#fileLines(
		left: string,
		commit: string,
		path: string,
	): Promise<HunkLine[] | null> {
		const { repo } = this;
		return this.#files.get(JSON.stringify([left, commit, path]), async () => {
			const renames = await this.#renames.get(`${left} ${commit}`, () =>
				renamedPaths((args) => this.#git(args), left, commit),
			);
			if (!renames) return null;
			const from = renames.from.get(path);
			if (from !== undefined)
				return this.#renamedLines(left, commit, from, path);
			if (renames.old.has(path)) return null;
			const sections = await this.#fileDiff(left, commit, path);
			if (sections === null) return null;
			if (sections.length > 1) return null;
			if (sections.length === 1) return parseDiffHunk(sections[0] as string);
			// No change: only when the file is the same blob on both sides.
			const signal = this.#stop.signal;
			const [before, after] = await Promise.all([
				readObject(repo, `${left}:${path}`, signal),
				readObject(repo, `${commit}:${path}`, signal),
			]).catch(() => [null, null]);
			if (after?.type !== "blob" || before?.oid !== after.oid) {
				return null;
			}
			return contextLines(after.content.toString("utf8"));
		});
	}

	/**
	 * `path`'s sections of the diff between `left` and `commit` (`diff
	 * --git` on, one per file git lists; none when it's the same on both
	 * sides), whole-file context, no renames. The paths asked of one pair
	 * in the same turn share one `git diff` (CAR-320: a thread each made
	 * one); a path git would quote in the header is read on its own. Null
	 * when git fails.
	 */
	#fileDiff(
		left: string,
		commit: string,
		path: string,
	): Promise<string[] | null> {
		if (!PLAIN_PATH.test(path)) {
			return this.#limit(() => this.#diffPaths(left, commit, [path])).then(
				(out) =>
					out === null ? null : (splitSections(out, [path]).get(path) ?? []),
			);
		}
		const key = `${left} ${commit}`;
		let batch = this.#batches.get(key);
		if (!batch) {
			const made: DiffBatch = {
				paths: new Set(),
				result: new Promise((resolve) => {
					// Paths join until the diff starts: the turn's, and any
					// asked while it waits for a slot.
					setImmediate(() =>
						resolve(
							this.#limit(() => {
								if (this.#batches.get(key) === made) {
									this.#batches.delete(key);
								}
								const paths = [...made.paths];
								return this.#diffPaths(left, commit, paths).then((out) =>
									out === null ? null : splitSections(out, paths),
								);
							}),
						),
					);
				}),
			};
			batch = made;
			this.#batches.set(key, batch);
		}
		batch.paths.add(path);
		return batch.result.then((sections) =>
			sections === null ? null : (sections.get(path) ?? []),
		);
	}

	/**
	 * The whole-file diff of `paths` between `left` and `commit`; null when
	 * git fails. Run inside a slot (#limit).
	 */
	#diffPaths(
		left: string,
		commit: string,
		paths: string[],
	): Promise<string | null> {
		return this.#counted([
			LITERAL,
			"-c",
			"core.quotePath=false",
			"diff",
			"--no-color",
			"--no-ext-diff",
			"--no-renames",
			"--unified=100000000",
			left,
			commit,
			"--",
			...paths,
		]);
	}

	/**
	 * A renamed file's diff: `from` at `left` against `to` at `commit`, the
	 * pathspec limited to the pair, so the one rename found is theirs. A
	 * rename with no change is the whole file as context.
	 */
	async #renamedLines(
		left: string,
		commit: string,
		from: string,
		to: string,
	): Promise<HunkLine[] | null> {
		const { repo } = this;
		const diff = await this.#git([
			LITERAL,
			"diff",
			"--no-color",
			"--no-ext-diff",
			"-M",
			"--unified=100000000",
			left,
			commit,
			"--",
			from,
			to,
		]);
		if (diff === null) return null;
		const files = diff.match(/^diff --git /gm)?.length ?? 0;
		if (
			files !== 1 ||
			!/^rename from /m.test(diff) ||
			!/^rename to /m.test(diff)
		) {
			return null;
		}
		if (/^@@ /m.test(diff)) return parseDiffHunk(diff);
		// Renamed as it was: the file itself.
		const content = await readBlob(
			repo,
			`${commit}:${to}`,
			this.#stop.signal,
		).catch(() => null);
		return content === null ? null : contextLines(content.toString("utf8"));
	}

	/**
	 * A comment's own snapshot: its commit and the base its diff is taken
	 * against (#left, as for its code, else the plain merge base with the
	 * snapshot's base). Null when the commit can't be had or has no merge
	 * base with it.
	 */
	async endpoints(
		anchor: CodeAnchor,
		base: DiffBase,
	): Promise<{ base: string; head: string } | null> {
		try {
			if (!OID.test(anchor.commit)) return null;
			if (!(await this.#commit(anchor.commit))) return null;
			// The code pane's base when it is certain; else the merge base
			// itself (an old-side range whose base branch at the comment's
			// time can't be told): the tracer then follows the base's own
			// changes from there, and a line the base changed says so.
			const left =
				(await this.#left(anchor, base, true)) ??
				(await this.#mergeBase(anchor.commit, base.snapshot));
			return left ? { base: left, head: anchor.commit } : null;
		} catch {
			return null;
		}
	}

	/**
	 * The old sides a comment's LEFT lines may count on (CAR-8): `then`,
	 * the merge base of its commit with the base branch as it stood at the
	 * comment's time (null when that can't be told); `now`, with the
	 * snapshot's base. Null when the commit can't be had.
	 */
	async oldSides(
		anchor: CodeAnchor,
		base: DiffBase,
	): Promise<{ then: string | null; now: string | null } | null> {
		try {
			if (!OID.test(anchor.commit)) return null;
			if (!(await this.#commit(anchor.commit))) return null;
			const [now, tip] = await Promise.all([
				this.#mergeBase(anchor.commit, base.snapshot),
				this.#tip(base.ref, anchor.at),
			]);
			const then = tip ? await this.#mergeBase(anchor.commit, tip) : null;
			return { then, now };
		} catch {
			return null;
		}
	}

	/**
	 * The rows of `anchor`'s window in the PR's diff at its commit. Null,
	 * never a guess, when the commit can't be had, the old side isn't
	 * certain (see #left), the file's diff can't be had (#fileLines) or
	 * either end of the range isn't in it.
	 */
	async window(
		anchor: CodeAnchor,
		base: DiffBase,
		lenient = false,
	): Promise<CodeRow[] | null> {
		return (await this.#built(anchor, base, lenient))?.rows ?? null;
	}

	/** window's rows, and the whole file's diff they are cut from. */
	async #built(
		anchor: CodeAnchor,
		base: DiffBase,
		lenient: boolean,
	): Promise<{ rows: CodeRow[]; lines: HunkLine[] } | null> {
		try {
			if (!OID.test(anchor.commit)) return null;
			if (!(await this.#commit(anchor.commit))) return null;
			const left = await this.#left(anchor, base, lenient);
			if (!left) return null;
			const lines = await this.#fileLines(left, anchor.commit, anchor.path);
			const rows = lines && windowRows(lines, anchor);
			return lines && rows ? { rows, lines } : null;
		} catch {
			return null;
		}
	}

	/**
	 * A comment's code: the clone's, checked against the comment host's own
	 * hunk (`hostHunk`, the diff of the view the comment was made in) for
	 * whether it is what the commenter saw (`snapshot`, snapshotOf). Where
	 * the clone can't give it for certain, that hunk itself (`source:
	 * "github"`, the commenter's own view); with no hunk, a range on the new
	 * side from the clone anyway (#left's `lenient`), which nothing vouches
	 * for; else none. A hunk that can't be read counts as none.
	 */
	async code(
		anchor: CodeAnchor,
		base: DiffBase,
		hostHunk: () => Promise<string>,
	): Promise<CodeWindow | null> {
		const hunk = () => hostHunk().catch(() => "");
		const built = await this.#built(anchor, base, false);
		if (built) {
			return {
				anchor,
				rows: built.rows,
				source: "clone",
				snapshot: snapshotOf(await hunk(), built.lines, anchor),
			};
		}
		const text = await hunk();
		const hosted = text.trim() ? hunkWindowRows(text, anchor) : [];
		if (hosted.length) {
			return {
				anchor,
				rows: hosted,
				source: "github",
				snapshot: { same: true },
			};
		}
		const lenient = await this.#built(anchor, base, true);
		if (!lenient) return null;
		return {
			anchor,
			rows: lenient.rows,
			source: "clone",
			snapshot: snapshotOf(text, lenient.lines, anchor),
		};
	}
}
