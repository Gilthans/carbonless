import { type HunkLine, numberOn, parseDiffHunk } from "../shared/diffHunk.js";
import type {
	CodeAnchor,
	CodeRow,
	CodeSnapshot,
	DiffSide,
} from "../shared/types.js";

/** Rows a window keeps before and after the commented range. */
export const CONTEXT = 3;

/** Index of the last line numbered `no` on `side`, at or before `upTo`. */
function lastIndex(
	lines: HunkLine[],
	upTo: number,
	side: DiffSide,
	no: number,
): number {
	for (let i = upTo; i >= 0; i--) {
		const line = lines[i];
		if (line && numberOn(line, side) === no) return i;
	}
	return -1;
}

/** Lines `start`..`end` marked, with up to CONTEXT lines on either side. */
function around(lines: HunkLine[], start: number, end: number): CodeRow[] {
	const from = Math.max(0, start - CONTEXT);
	const to = Math.min(lines.length, end + 1 + CONTEXT);
	return lines.slice(from, to).map((line, i) => ({
		...line,
		marked: from + i >= start && from + i <= end,
	}));
}

/**
 * The window of `anchor`'s range in `lines`, the whole file's diff (or the
 * whole file as context). Null when either end of the range isn't there:
 * a range is shown whole or not at all.
 */
export function windowRows(
	lines: HunkLine[],
	anchor: CodeAnchor,
): CodeRow[] | null {
	const end = lastIndex(lines, lines.length - 1, anchor.side, anchor.line);
	if (end === -1) return null;
	const start = lastIndex(lines, end, anchor.startSide, anchor.startLine);
	if (start === -1) return null;
	return around(lines, start, end);
}

/**
 * The window of a comment host's own diff hunk (GitHub's ends at the
 * commented line, so it has no rows after the range). If the range's
 * numbers aren't in the hunk, its last line stands for it: a bad range
 * never hides the code. [] for an empty hunk.
 */
export function hunkWindowRows(hunk: string, anchor: CodeAnchor): CodeRow[] {
	const lines = parseDiffHunk(hunk);
	if (lines.length === 0) return [];
	let end = lastIndex(lines, lines.length - 1, anchor.side, anchor.line);
	if (end === -1) end = lines.length - 1;
	let start = lastIndex(lines, end, anchor.startSide, anchor.startLine);
	if (start === -1) start = end;
	return around(lines, start, end);
}

/** Whether any end of the range is on the old side. */
export function touchesOldSide(anchor: CodeAnchor): boolean {
	return anchor.side === "LEFT" || anchor.startSide === "LEFT";
}

/** The same diff row: kind, numbers on both sides, text, end-of-file mark. */
function sameLine(a: HunkLine, b: HunkLine): boolean {
	return (
		a.kind === b.kind &&
		a.oldNo === b.oldNo &&
		a.newNo === b.newNo &&
		a.text === b.text &&
		!!a.noNewline === !!b.noNewline
	);
}

/**
 * Whether code rebuilt as `lines` (the whole file's diff the window is cut
 * from) is what the commenter saw, judged by `hunk`, the host's diff of the
 * view the comment was made in (GitHub's diffHunk: one hunk, from its
 * header to the commented line). Same only when the hunk is a run of
 * `lines`, row for row (kind, both numbers, text), and holds both ends of
 * the range. With no hunk to check against, or any row that disagrees, it
 * is not: a failure to show equality flags the code, never the other way.
 * Rows outside the hunk (after the range, above its first line) can't be
 * checked: the host keeps none.
 */
export function snapshotOf(
	hunk: string,
	lines: HunkLine[],
	anchor: CodeAnchor,
): CodeSnapshot {
	const host = parseDiffHunk(hunk);
	const first = host[0];
	if (!first) return { same: false, reason: "no-host-diff" };
	const differs: CodeSnapshot = { same: false, reason: "diff-differs" };
	const side: DiffSide = first.kind === "del" ? "LEFT" : "RIGHT";
	const no = numberOn(first, side);
	const start = lines.findIndex((l) => numberOn(l, side) === no);
	if (start === -1 || start + host.length > lines.length) return differs;
	for (let i = 0; i < host.length; i++) {
		const ours = lines[start + i];
		const theirs = host[i];
		if (!ours || !theirs || !sameLine(ours, theirs)) return differs;
	}
	const end = lastIndex(host, host.length - 1, anchor.side, anchor.line);
	if (end === -1) return differs;
	if (lastIndex(host, end, anchor.startSide, anchor.startLine) === -1) {
		return differs;
	}
	return { same: true };
}
