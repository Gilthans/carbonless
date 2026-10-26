import { type HunkLine, parseDiffHunk } from "../shared/diffHunk.js";
import type { CodeAnchor, CodeRow, CodeWindow } from "../shared/types.js";
import { ensureCommit } from "./clone.js";
import {
	hunkWindowRows,
	snapshotOf,
	touchesOldSide,
	windowRows,
} from "./codeWindow.js";
import { runGit } from "./git.js";

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
		if (known) {
			// Most recently used last.
			this.#map.delete(key);
			this.#map.set(key, known);
			return known;
		}
		const made: Promise<T> = make().then((value) => {
			if (this.failed(value) && this.#map.get(key) === made) {
				this.#failed.add(key);
			}
			return value;
		});
		this.#map.set(key, made);
		for (const oldest of this.#map.keys()) {
			if (this.#map.size <= this.max) break;
			this.#map.delete(oldest);
			this.#failed.delete(oldest);
		}
		return made;
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
	repo: string,
	signal: AbortSignal,
	left: string,
	right: string,
): Promise<Renames | null> {
	const out = await tryGit(repo, signal, [
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
	readonly #renames = new Memo<Renames | null>((r) => r === null, 64);
	readonly #files = new Memo<HunkLine[] | null>((lines) => lines === null, 256);

	/** Stops every git call (close). */
	readonly #stop = new AbortController();

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
		this.#renames.forgetFailures();
		this.#files.forgetFailures();
	}

	#commit(oid: string): Promise<boolean> {
		return this.#commits.get(oid, () =>
			this.fetchCommit(this.repo, oid, this.#stop.signal).catch(() => false),
		);
	}

	#mergeBase(commit: string, other: string): Promise<string | null> {
		return this.#bases.get(`${commit} ${other}`, async () => {
			const out = await tryGit(this.repo, this.#stop.signal, [
				"merge-base",
				commit,
				other,
			]);
			const oid = out?.trim() ?? "";
			return OID.test(oid) ? oid : null;
		});
	}

	/** The base branch's last first-parent commit by `at`. */
	#tip(ref: string, at: string): Promise<string | null> {
		if (Number.isNaN(Date.parse(at))) return Promise.resolve(null);
		return this.#tips.get(`${ref} ${at}`, async () => {
			const out = await tryGit(this.repo, this.#stop.signal, [
				"rev-list",
				"-1",
				"--first-parent",
				`--before=${at}`,
				ref,
				"--",
			]);
			const oid = out?.trim() ?? "";
			return OID.test(oid) ? oid : null;
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
				renamedPaths(repo, this.#stop.signal, left, commit),
			);
			if (!renames) return null;
			const from = renames.from.get(path);
			if (from !== undefined)
				return this.#renamedLines(left, commit, from, path);
			if (renames.old.has(path)) return null;
			const diff = await tryGit(repo, this.#stop.signal, [
				LITERAL,
				"diff",
				"--no-color",
				"--no-ext-diff",
				"--no-renames",
				"--unified=100000000",
				left,
				commit,
				"--",
				path,
			]);
			if (diff === null) return null;
			const files = diff.match(/^diff --git /gm)?.length ?? 0;
			if (files > 1) return null;
			if (files === 1) return parseDiffHunk(diff);
			// No change: only when the file is the same blob on both sides.
			const [oldBlob, newBlob] = await Promise.all([
				tryGit(repo, this.#stop.signal, [
					"rev-parse",
					"--verify",
					"--quiet",
					`${left}:${path}`,
				]),
				tryGit(repo, this.#stop.signal, [
					"rev-parse",
					"--verify",
					"--quiet",
					`${commit}:${path}`,
				]),
			]);
			const blob = newBlob?.trim();
			if (!blob || oldBlob?.trim() !== blob) return null;
			const content = await tryGit(repo, this.#stop.signal, [
				"cat-file",
				"blob",
				blob,
			]);
			return content === null ? null : contextLines(content);
		});
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
		const diff = await tryGit(repo, this.#stop.signal, [
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
		const content = await tryGit(repo, this.#stop.signal, [
			"cat-file",
			"blob",
			`${commit}:${to}`,
		]);
		return content === null ? null : contextLines(content);
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
