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

/** A line that tells nothing on its own: blank, or punctuation alone (`}`, `);`). */
const trivial = (text: string) => /^[\s\p{P}\p{S}]*$/u.test(text);

/**
 * A run of rows worth finding elsewhere: at least MIN_RUN rows, at least
 * MIN_TELLING of them not trivial. A shorter or emptier run (a `}`, a
 * blank and one `return null;`) can sit once in unrelated code.
 */
const MIN_RUN = 3;
const MIN_TELLING = 2;
function telling(rows: readonly { text: string }[]): boolean {
	return (
		rows.length >= MIN_RUN &&
		rows.filter((r) => !trivial(r.text)).length >= MIN_TELLING
	);
}

/**
 * Where the hunk's old-side rows sit in `text` (a candidate old side, one
 * string per line): `0` where the hunk numbers them; else the shift that
 * puts the whole run of them at the one place in `text` it occurs (a run
 * that tells enough: `telling`); null when they are nowhere, in several
 * places, too short or trivial to look for, or the hunk has none (or
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
	// The rows are consecutive old lines: one run to look for, and only one
	// that says enough to be told from boilerplate elsewhere.
	const first = rows[0];
	if (!first || !telling(rows)) return null;
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
