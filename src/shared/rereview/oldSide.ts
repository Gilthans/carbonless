/**
 * Which old side a review comment's LEFT lines count on (CAR-8). GitHub
 * keeps no commit for a comment's old side (its `commit_id` and
 * `original_commit_id` are both PR heads), so a LEFT line number may count
 * on another merge base than the one carbonless takes (the base moved, or
 * the PR's merge base did). Only GitHub's `diff_hunk`, the diff the
 * commenter saw up to the commented line, shows which: its old-side rows
 * (context and removed lines, by their old numbers) must be the text of
 * the old side the comment is traced from.
 *
 * Pure: no git, no I/O.
 */

import { parseDiffHunk } from "../diffHunk.js";

/** A line's text without the CR of a CRLF ending. */
const bare = (text: string) => (text.endsWith("\r") ? text.slice(0, -1) : text);

/** The hunk's old-side rows (context and removed lines), in order. */
export function hunkOldRows(hunk: string): { line: number; text: string }[] {
	const out: { line: number; text: string }[] = [];
	for (const row of parseDiffHunk(hunk)) {
		if (row.oldNo !== null) out.push({ line: row.oldNo, text: bare(row.text) });
	}
	return out;
}

/**
 * Where the hunk's old-side rows sit in `text` (a candidate old side, one
 * string per line): `0` where the hunk numbers them; else the shift that
 * puts the whole run of them at the one place in `text` it occurs; null
 * when they are nowhere, in several places, or the hunk has none (or
 * doesn't hold `line`, the commented old line, as the commenter's hunk
 * always does). A failure to find the rows is never a guess.
 */
export function oldSideShift(
	rows: readonly { line: number; text: string }[],
	text: readonly string[] | null,
	line: number,
): number | null {
	if (!text || rows.length === 0) return null;
	if (!rows.some((r) => r.line === line)) return null;
	const at = (n: number) => {
		const t = text[n - 1];
		return t === undefined ? null : bare(t);
	};
	if (rows.every((r) => at(r.line) === r.text)) return 0;
	// The rows are consecutive old lines: one run to look for.
	const first = rows[0];
	if (!first) return null;
	const consecutive = rows.every((r, i) => r.line === first.line + i);
	if (!consecutive) return null;
	let found: number | null = null;
	for (let start = 1; start + rows.length - 1 <= text.length; start++) {
		if (!rows.every((r, i) => at(start + i) === r.text)) continue;
		if (found !== null) return null;
		found = start;
	}
	return found === null ? null : found - first.line;
}
