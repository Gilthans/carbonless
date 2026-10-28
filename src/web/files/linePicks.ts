import { useSyncExternalStore } from "react";
import type { CellLine } from "./codeSpan";

/** A picked row: its code cell's line, without the element. */
export type PickedLine = Omit<CellLine, "cell">;

/** `RIGHT:12`: a picked row by its code cell's side and line. */
export const pickKey = (l: Pick<PickedLine, "side" | "line">) =>
	`${l.side}:${l.line}`;

/**
 * Lines picked by their numbers in one file: `anchor` where the pick
 * started, `focus` where it was extended to; `lines` every row between
 * them, top down (the first and last make the span).
 */
export interface Picks {
	path: string;
	anchor: PickedLine;
	focus: PickedLine;
	lines: PickedLine[];
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
 * Picks extended: every row between `anchor` and `focus`, in the order of
 * `cells` (the file's code cells, top down). Null if either isn't there.
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
	const [from, to] = a <= f ? [a, f] : [f, a];
	return {
		path: anchor.path,
		anchor,
		focus,
		lines: cells.slice(from, to + 1).map(picked),
	};
}
