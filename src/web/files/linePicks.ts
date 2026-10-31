import { useSyncExternalStore } from "react";
import type { DiffSide } from "../../shared/types";
import type { CellLine } from "./codeSpan";

/** A picked row: its code cell's line, without the element. */
export type PickedLine = Omit<CellLine, "cell">;

/** `RIGHT:12`: a picked row by its code cell's side and line. */
export const pickKey = (l: Pick<PickedLine, "side" | "line">) =>
	`${l.side}:${l.line}`;

/**
 * Lines picked by their numbers in one file: `anchor` where the pick
 * started, `focus` where it was extended to; `lines` every row between
 * them, top down (the first and last make the span). `column`, side by
 * side only: the number column `focus` was picked from (a context line's
 * old number picks its RIGHT line from the left), where the bar goes.
 */
export interface Picks {
	path: string;
	anchor: PickedLine;
	focus: PickedLine;
	lines: PickedLine[];
	column?: DiffSide;
}

let picks: Picks | null = null;
const listeners = new Set<() => void>();

export function setPicks(next: Picks | null): void {
	if (next === picks) return;
	picks = next;
	for (const l of listeners) l();
}

export const getPicks = (): Picks | null => picks;

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
};

export function usePicks(): Picks | null {
	return useSyncExternalStore(subscribe, getPicks, getPicks);
}

/** A cell's picked line (CellLine without the element). */
export function picked(c: CellLine): PickedLine {
	const { cell: _, ...rest } = c;
	return rest;
}

/**
 * Picks extended: every line between `anchor` and `focus`. Both in one
 * hunk, that is GitHub's order of it (`order`): the lines between the two
 * in that order, first to last, so the span's ends are what GitHub takes
 * whichever way the pick went and whichever way the view lays the lines
 * out (side by side shows a pair's old and new line in one row; unified
 * with Ignore whitespace shows a pair where its added line goes). Else
 * (expanded context, or across hunks) the order of `cells` (the file's
 * code cells, top down). Null if either isn't there.
 */
export function pickRange(
	cells: readonly CellLine[],
	anchor: PickedLine,
	focus: PickedLine,
): Picks | null {
	const at = (l: PickedLine) =>
		cells.findIndex((c) => c.side === l.side && c.line === l.line);
	const a = at(anchor);
	const f = at(focus);
	if (a < 0 || f < 0) return null;
	const from = cells[a] as CellLine;
	const to = cells[f] as CellLine;
	const lines =
		from.hunk === to.hunk && from.order !== undefined && to.order !== undefined
			? between(cells, from.hunk, from.order, to.order)
			: cells.slice(Math.min(a, f), Math.max(a, f) + 1);
	return { path: anchor.path, anchor, focus, lines: lines.map(picked) };
}

/** The hunk's cells whose place in GitHub's order lies between `a` and `b`, in that order. */
function between(
	cells: readonly CellLine[],
	hunk: string,
	a: number,
	b: number,
): CellLine[] {
	const [lo, hi] = a <= b ? [a, b] : [b, a];
	return cells
		.filter(
			(c) =>
				c.hunk === hunk &&
				c.order !== undefined &&
				c.order >= lo &&
				c.order <= hi,
		)
		.sort((x, y) => (x.order as number) - (y.order as number));
}
