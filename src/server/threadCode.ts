import { type HunkLine, parseDiffHunk } from "../shared/diffHunk.js";
import type { CodeAnchor, CodeRow, PrOverview } from "../shared/types.js";
import { ensureCommit } from "./clone.js";
import { touchesOldSide, windowRows } from "./codeWindow.js";
import { runGit } from "./git.js";

/** Windows built at once. */
const CONCURRENCY = 8;

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
 */
class Memo<T> {
	readonly #map = new Map<string, Promise<T>>();
	readonly #failed = new Set<string>();

	constructor(private readonly failed: (value: T) => boolean) {}

	get(key: string, make: () => Promise<T>): Promise<T> {
		let known = this.#map.get(key);
		if (!known) {
			const made: Promise<T> = make().then((value) => {
				if (this.failed(value) && this.#map.get(key) === made) {
					this.#failed.add(key);
				}
				return value;
			});
			known = made;
			this.#map.set(key, made);
		}
		return known;
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
const tryGit = (repo: string, args: string[]) =>
	runGit(repo, args).then(
		(out) => out,
		() => null,
	);

/** Paths are GitHub's, not patterns: `[id].tsx` must not match `i.tsx`. */
const LITERAL = "--literal-pathspecs";

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Paths a rename touched between two commits (either end), from
 * `git diff -M --name-status -z`. Null when git fails.
 */
async function renamedPaths(
	repo: string,
	left: string,
	right: string,
): Promise<Set<string> | null> {
	const out = await tryGit(repo, [
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
	const paths = new Set<string>();
	for (let i = 0; i < fields.length; ) {
		const status = fields[i] ?? "";
		if (!status) break;
		if (status.startsWith("R")) {
			paths.add(fields[i + 1] ?? "");
			paths.add(fields[i + 2] ?? "");
			i += 3;
		} else {
			i += 2;
		}
	}
	return paths;
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
	readonly #commits = new Memo<boolean>((ok) => !ok);
	readonly #bases = new Memo<string | null>((oid) => oid === null);
	/** The base branch's tip at a time: moves when a Refresh fetches it. */
	readonly #tips = new Memo<string | null>(() => false);
	readonly #renames = new Memo<Set<string> | null>((set) => set === null);
	readonly #files = new Memo<HunkLine[] | null>((lines) => lines === null);

	constructor(
		private readonly repo: string,
		private readonly fetchCommit: (
			repo: string,
			oid: string,
		) => Promise<boolean> = ensureCommit,
	) {}

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
			this.fetchCommit(this.repo, oid).catch(() => false),
		);
	}

	#mergeBase(commit: string, other: string): Promise<string | null> {
		return this.#bases.get(`${commit} ${other}`, async () => {
			const out = await tryGit(this.repo, ["merge-base", commit, other]);
			const oid = out?.trim() ?? "";
			return OID.test(oid) ? oid : null;
		});
	}

	/** The base branch's last first-parent commit by `at`. */
	#tip(ref: string, at: string): Promise<string | null> {
		if (Number.isNaN(Date.parse(at))) return Promise.resolve(null);
		return this.#tips.get(`${ref} ${at}`, async () => {
			const out = await tryGit(this.repo, [
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
	 * file as context when it's unchanged). Null, never a guess, when any
	 * git step fails, the file is missing, it was renamed (its old side is
	 * another path), or the diff isn't exactly one file.
	 */
	#fileLines(
		left: string,
		commit: string,
		path: string,
	): Promise<HunkLine[] | null> {
		const { repo } = this;
		return this.#files.get(JSON.stringify([left, commit, path]), async () => {
			const renamed = await this.#renames.get(`${left} ${commit}`, () =>
				renamedPaths(repo, left, commit),
			);
			if (!renamed || renamed.has(path)) return null;
			const diff = await tryGit(repo, [
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
				tryGit(repo, ["rev-parse", "--verify", "--quiet", `${left}:${path}`]),
				tryGit(repo, ["rev-parse", "--verify", "--quiet", `${commit}:${path}`]),
			]);
			const blob = newBlob?.trim();
			if (!blob || oldBlob?.trim() !== blob) return null;
			const content = await tryGit(repo, ["cat-file", "blob", blob]);
			return content === null ? null : contextLines(content);
		});
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
		try {
			if (!OID.test(anchor.commit)) return null;
			if (!(await this.#commit(anchor.commit))) return null;
			const left = await this.#left(anchor, base, lenient);
			if (!left) return null;
			const lines = await this.#fileLines(left, anchor.commit, anchor.path);
			return lines && windowRows(lines, anchor);
		} catch {
			return null;
		}
	}

	/**
	 * Every thread's code from the clone, a few at a time. Where the clone
	 * can't give it for certain, the comment host's own rows stay (marked
	 * `source: "github"`); a range on the new side with no such rows takes
	 * the clone's anyway (#left's `lenient`). A thread with neither gets no
	 * code.
	 */
	async fill(overview: PrOverview, base: DiffBase): Promise<PrOverview> {
		const threads = [...overview.threads];
		let next = 0;
		const work = async () => {
			for (let i = next++; i < threads.length; i = next++) {
				const thread = threads[i];
				const code = thread?.code;
				if (!thread || !code) continue;
				const { anchor } = code;
				const hosted = code.rows.length > 0;
				const rows =
					(await this.window(anchor, base)) ??
					(hosted ? null : await this.window(anchor, base, true));
				threads[i] = {
					...thread,
					code: rows ? { anchor, rows, source: "clone" } : hosted ? code : null,
				};
			}
		};
		await Promise.all(Array.from({ length: CONCURRENCY }, work));
		return { ...overview, threads };
	}
}
