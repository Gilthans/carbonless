import type { DiffSide } from "../../shared/types";
import type { Mark } from "../code/Invisibles";

/** A range of diff rows, with the exact characters when both cols are set. */
export interface SpanRange {
	startSide: DiffSide;
	startLine: number;
	side: DiffSide;
	line: number;
	startCol?: number | null;
	endCol?: number | null;
}

/** A row as both the diff and a thread's code window have it. */
export interface SpanRow {
	text: string;
	oldNo?: number | null;
	newNo?: number | null;
}

const numberOn = (row: SpanRow, side: DiffSide) =>
	(side === "RIGHT" ? row.newNo : row.oldNo) ?? null;

/**
 * The characters to paint on each of a range's rows (`rows`: the rows its
 * lines cover, first to last, as shown), or null when the range has no
 * columns or they don't fit what is shown: its first and last rows aren't
 * its start and end lines, or a column runs past its line's text (the code
 * moved on, or the comment was edited). Null means: paint the lines only.
 */
export function spanMarks(
	rows: readonly SpanRow[],
	range: SpanRange,
): Mark[][] | null {
	const { startCol, endCol } = range;
	if (startCol == null || endCol == null) return null;
	const first = rows[0];
	const last = rows[rows.length - 1];
	if (!first || !last) return null;
	if (
		numberOn(first, range.startSide) !== range.startLine ||
		numberOn(last, range.side) !== range.line
	) {
		return null;
	}
	if (startCol < 0 || startCol > first.text.length) return null;
	if (endCol < 0 || endCol > last.text.length) return null;
	if (rows.length === 1) {
		return startCol < endCol ? [[[startCol, endCol]]] : null;
	}
	return rows.map((row, i) => [
		[i === 0 ? startCol : 0, i === rows.length - 1 ? endCol : row.text.length],
	]);
}

/**
 * A thread's code window rows with its span's characters (`marks`) on its
 * marked rows, when its anchor has columns that fit them (else as they are:
 * the lines alone show).
 */
export function withSpanMarks<R extends SpanRow & { marked: boolean }>(
	rows: readonly R[],
	anchor: SpanRange | null,
): (R & { marks?: Mark[] })[] {
	if (!anchor || anchor.startCol == null || anchor.endCol == null) {
		return rows as R[];
	}
	const first = rows.findIndex((r) => r.marked);
	const last = rows.findLastIndex((r) => r.marked);
	if (first < 0) return rows as R[];
	const marks = spanMarks(rows.slice(first, last + 1), anchor);
	if (!marks) return rows as R[];
	return rows.map((r, i) =>
		i >= first && i <= last ? { ...r, marks: marks[i - first] } : r,
	);
}
