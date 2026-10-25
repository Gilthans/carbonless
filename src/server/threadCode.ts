import { type HunkLine, numberOn, parseDiffHunk } from "../shared/diffHunk.js";
import type { PrOverview } from "../shared/types.js";
import { ensureCommit } from "./clone.js";
import { runGit } from "./git.js";

type Code = NonNullable<PrOverview["threads"][number]["code"]>;

/** Lines a rebuilt hunk keeps before the commented range. */
const LEAD = 3;
/** …and at least this many lines in all, like GitHub's hunks. */
const MIN_LINES = 8;
/** Threads rebuilt at once. */
const CONCURRENCY = 4;

/** Index of the last line numbered `no` on `side`, at or before `upTo`. */
function lastIndex(
	lines: HunkLine[],
	upTo: number,
	side: Code["side"],
	no: number,
): number {
	for (let i = upTo; i >= 0; i--) {
		const line = lines[i];
		if (line && numberOn(line, side) === no) return i;
	}
	return -1;
}

/**
 * A GitHub-style diff hunk cut from `lines` (one whole-file hunk): a few
 * lines before the commented range, ending at its last line. Null when
 * either end of the range isn't in the file: a range is shown whole or not
 * at all.
 */
export function cutHunk(lines: HunkLine[], code: Code): string | null {
	const end = lastIndex(lines, lines.length - 1, code.side, code.endLine);
	if (end === -1) return null;
	const start = lastIndex(lines, end, code.startSide, code.startLine);
	if (start === -1) return null;
	const from = Math.max(0, Math.min(start - LEAD, end - MIN_LINES + 1));
	const kept = lines.slice(from, end + 1);
	// Where each side's numbering stands at the first kept line.
	let oldStart = 1;
	let newStart = 1;
	for (let i = from; i >= 0; i--) {
		const line = lines[i];
		if (line?.oldNo != null) {
			oldStart = line.oldNo + (i < from ? 1 : 0);
			break;
		}
	}
	for (let i = from; i >= 0; i--) {
		const line = lines[i];
		if (line?.newNo != null) {
			newStart = line.newNo + (i < from ? 1 : 0);
			break;
		}
	}
	const oldCount = kept.filter((l) => l.oldNo !== null).length;
	const newCount = kept.filter((l) => l.newNo !== null).length;
	// Git's convention: an empty side starts one line earlier (-0,0 for a new file).
	const header = `@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`;
	const body = kept.flatMap((l) => [
		`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`,
		...(l.noNewline ? ["\\ No newline at end of file"] : []),
	]);
	return [header, ...body].join("\n");
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
 * Rebuilds the code of line comments GitHub kept no diff hunk for, from the
 * clone. One per session (a Refresh starts a new one): every answer is
 * cached, a failure too, so a commit GitHub can't give us is fetched once.
 * `fetchCommit` is the clone's (tests swap it).
 */
export class ThreadCodeSource {
	readonly #commits = new Map<string, Promise<boolean>>();
	readonly #hunks = new Map<string, Promise<string | null>>();
	readonly #bases = new Map<string, Promise<string | null>>();
	readonly #renames = new Map<string, Promise<Set<string> | null>>();

	constructor(
		private readonly repo: string,
		private readonly fetchCommit: (
			repo: string,
			oid: string,
		) => Promise<boolean> = ensureCommit,
	) {}

	#commit(oid: string): Promise<boolean> {
		let known = this.#commits.get(oid);
		if (!known) {
			known = this.fetchCommit(this.repo, oid).catch(() => false);
			this.#commits.set(oid, known);
		}
		return known;
	}

	#cached<T>(
		map: Map<string, Promise<T>>,
		key: string,
		make: () => Promise<T>,
	) {
		let known = map.get(key);
		if (!known) {
			known = make();
			map.set(key, known);
		}
		return known;
	}

	/**
	 * The code of a line comment GitHub kept no hunk for: the file's diff at
	 * the comment's commit against that commit's merge base with `base` (the
	 * snapshot's), cut like GitHub's hunk. A range on the old side also needs
	 * `then` to show that old side is the one the comment saw. Null, never a
	 * guess, when any git step fails, the commit or file or either end of
	 * the range is missing, the file was renamed (its old side is another
	 * path), or the diff isn't exactly one file.
	 */
	rebuild(
		base: string,
		code: Code,
		path: string,
		/** For a range on the old side: the base branch and the comment's time. */
		then?: { baseRef: string; at: string },
	): Promise<string | null> {
		const key = JSON.stringify([
			base,
			then?.baseRef,
			then?.at,
			code.commit,
			path,
			code.side,
			code.startSide,
			code.startLine,
			code.endLine,
		]);
		return this.#cached(this.#hunks, key, () =>
			this.#rebuild(base, code, path, then).catch(() => null),
		);
	}

	#mergeBase(commit: string, other: string): Promise<string | null> {
		return this.#cached(this.#bases, `${commit} ${other}`, async () => {
			const out = await tryGit(this.repo, ["merge-base", commit, other]);
			const oid = out?.trim() ?? "";
			return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
		});
	}

	/**
	 * Whether the old side the comment was written against is `left`: the
	 * merge base with the base branch as it stood when the comment was made
	 * (its last first-parent commit by then) must be the same commit.
	 */
	async #sameOldSide(
		commit: string,
		left: string,
		then: { baseRef: string; at: string } | undefined,
	): Promise<boolean> {
		if (!then || Number.isNaN(Date.parse(then.at))) return false;
		const tip = await this.#cached(
			this.#bases,
			`tip ${then.baseRef} ${then.at}`,
			async () =>
				(
					await tryGit(this.repo, [
						"rev-list",
						"-1",
						"--first-parent",
						`--before=${then.at}`,
						then.baseRef,
						"--",
					])
				)?.trim() || null,
		);
		return tip !== null && (await this.#mergeBase(commit, tip)) === left;
	}

	async #rebuild(
		base: string,
		code: Code,
		path: string,
		then: { baseRef: string; at: string } | undefined,
	) {
		const { repo } = this;
		if (!(await this.#commit(code.commit))) return null;
		const left = await this.#mergeBase(code.commit, base);
		if (!left) return null;
		// Old-side text must be right or absent: only when the base then
		// gives the same old side as the snapshot's does.
		const old = code.side === "LEFT" || code.startSide === "LEFT";
		if (old && !(await this.#sameOldSide(code.commit, left, then))) {
			return null;
		}
		const renamed = await this.#cached(
			this.#renames,
			`${left} ${code.commit}`,
			() => renamedPaths(repo, left, code.commit),
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
			code.commit,
			"--",
			path,
		]);
		if (diff === null) return null;
		const files = diff.match(/^diff --git /gm)?.length ?? 0;
		if (files > 1) return null;
		if (files === 1) return cutHunk(parseDiffHunk(diff), code);
		// No change: only when the file is the same blob on both sides.
		const [oldBlob, newBlob] = await Promise.all([
			tryGit(repo, ["rev-parse", "--verify", "--quiet", `${left}:${path}`]),
			tryGit(repo, [
				"rev-parse",
				"--verify",
				"--quiet",
				`${code.commit}:${path}`,
			]),
		]);
		const blob = newBlob?.trim();
		if (!blob || oldBlob?.trim() !== blob) return null;
		const content = await tryGit(repo, ["cat-file", "blob", blob]);
		if (content === null) return null;
		return cutHunk(contextLines(content), code);
	}

	/**
	 * Fills in the code of every thread GitHub returned without a diff hunk,
	 * a few at a time; a thread whose code can't be rebuilt gets none.
	 */
	async fill(
		base: string,
		overview: PrOverview,
		/** The base branch's ref, for ranges on the old side. */
		baseRef?: string,
	): Promise<PrOverview> {
		const threads = [...overview.threads];
		let next = 0;
		const work = async () => {
			for (let i = next++; i < threads.length; i = next++) {
				const thread = threads[i];
				const code = thread?.code;
				if (!thread || !code || code.diffHunk) continue;
				const diffHunk = await this.rebuild(
					base,
					code,
					thread.path,
					baseRef ? { baseRef, at: thread.createdAt } : undefined,
				);
				threads[i] = {
					...thread,
					code: diffHunk ? { ...code, diffHunk } : null,
				};
			}
		};
		await Promise.all(Array.from({ length: CONCURRENCY }, work));
		return { ...overview, threads };
	}
}
