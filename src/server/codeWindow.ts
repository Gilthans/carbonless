import { type HunkLine, numberOn, parseDiffHunk } from "../shared/diffHunk.js";
import type { CodeAnchor, CodeRow, DiffSide } from "../shared/types.js";

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
