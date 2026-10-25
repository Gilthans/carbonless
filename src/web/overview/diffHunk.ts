import { type HunkLine, numberOn, parseDiffHunk } from "../../shared/diffHunk";
import type { PrOverview } from "../../shared/types";

export type ThreadCode = NonNullable<PrOverview["threads"][number]["code"]>;

export type { HunkLine };
export { parseDiffHunk };

function lastIndexOf(
	lines: HunkLine[],
	upTo: number,
	side: ThreadCode["side"],
	no: number,
): number {
	for (let i = upTo; i >= 0; i--) {
		const line = lines[i];
		if (line && numberOn(line, side) === no) return i;
	}
	return -1;
}

/**
 * The end of the hunk around the commented range: the range itself and the
 * lines before it, `context` lines in all at least. GitHub's hunk ends at
 * the commented line; if the numbers don't match, its last line stands for
 * it, so a bad range never hides the code.
 */
export function codeExcerpt(
	code: ThreadCode,
	context = 6,
): { lines: (HunkLine & { marked: boolean })[] } {
	const lines = parseDiffHunk(code.diffHunk);
	if (lines.length === 0) return { lines: [] };
	let end = lastIndexOf(lines, lines.length - 1, code.side, code.endLine);
	if (end === -1) end = lines.length - 1;
	let start = lastIndexOf(lines, end, code.startSide, code.startLine);
	if (start === -1) start = end;
	const from = Math.max(0, Math.min(start, end - context + 1));
	return {
		lines: lines.slice(from, end + 1).map((line, i) => ({
			...line,
			marked: from + i >= start,
		})),
	};
}
