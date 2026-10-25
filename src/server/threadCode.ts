import { type HunkLine, numberOn, parseDiffHunk } from "../shared/diffHunk.js";
import type { PrOverview } from "../shared/types.js";
import { ensureCommit } from "./clone.js";
import { runGit } from "./git.js";

type Code = NonNullable<PrOverview["threads"][number]["code"]>;

/** Lines a rebuilt hunk keeps before the commented range. */
const LEAD = 3;
/** …and at least this many lines in all, like GitHub's hunks. */
const MIN_LINES = 8;

/**
 * A GitHub-style diff hunk cut from `lines` (one whole-file hunk): a few
 * lines before the commented range, ending at its last line. Null when the
 * range's end isn't in the file.
 */
export function cutHunk(lines: HunkLine[], code: Code): string | null {
	let end = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line && numberOn(line, code.side) === code.endLine) {
			end = i;
			break;
		}
	}
	if (end === -1) return null;
	let start = end;
	for (let i = end; i >= 0; i--) {
		const line = lines[i];
		if (line && numberOn(line, code.startSide) === code.startLine) {
			start = i;
			break;
		}
	}
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

/**
 * The code of a line comment GitHub kept no diff hunk for, rebuilt from the
 * clone: the file's diff at the comment's commit against that commit's
 * merge base with `base` (the snapshot's), cut like GitHub's hunk. Null when
 * the commit, file or line is missing.
 */
export async function rebuildHunk(
	repo: string,
	base: string,
	code: Code,
	path: string,
): Promise<string | null> {
	if (!(await ensureCommit(repo, code.commit))) return null;
	const left =
		(
			await runGit(repo, ["merge-base", code.commit, base], {
				allowFailure: true,
			})
		).trim() || base;
	const diff = await runGit(
		repo,
		[
			"diff",
			"--no-color",
			"--no-ext-diff",
			"--no-renames",
			"--unified=100000000",
			left,
			code.commit,
			"--",
			path,
		],
		{ allowFailure: true },
	);
	let lines = parseDiffHunk(diff);
	if (lines.length === 0) {
		// No change to the file at that commit: the same text on both sides.
		const content = await runGit(repo, ["show", `${code.commit}:${path}`], {
			allowFailure: true,
		});
		lines = contextLines(content);
	}
	return cutHunk(lines, code);
}

/**
 * Fills in the code of every thread GitHub returned without a diff hunk
 * (see `rebuildHunk`); a thread whose code can't be rebuilt gets none.
 */
export async function fillThreadCode(
	repo: string,
	base: string,
	overview: PrOverview,
): Promise<PrOverview> {
	const threads = await Promise.all(
		overview.threads.map(async (thread) => {
			const code = thread.code;
			if (!code || code.diffHunk) return thread;
			const diffHunk = await rebuildHunk(repo, base, code, thread.path).catch(
				() => null,
			);
			return { ...thread, code: diffHunk ? { ...code, diffHunk } : null };
		}),
	);
	return { ...overview, threads };
}
