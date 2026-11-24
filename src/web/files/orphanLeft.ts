import type { DiffLine } from "../../shared/types";

/**
 * The since view's removed orphan rows (CAR-216) have no old number: the
 * line isn't the compared patch set's, only the base's. Their LEFT number
 * in this view's keys (rows, picks, threads, composers) is their base
 * number past ORPHAN_LEFT, so it never meets an old number of the
 * compared patch set's, and keeps the run's order (CAR-276). Never shown
 * and never sent: GitHub's number is the base one (`baseNo`).
 */
export const ORPHAN_LEFT = 1_000_000_000;

/** A LEFT number in ORPHAN_LEFT's space: an orphan removed row's. */
export const isOrphanLeft = (n: number) => n > ORPHAN_LEFT;

/** The base number an orphan removed row's LEFT number stands for. */
export const orphanBase = (n: number) => n - ORPHAN_LEFT;

/** A row as leftNo reads it. */
export interface LeftRow {
	oldNo?: number | null;
	kind?: string;
	baseNo?: DiffLine["baseNo"];
	orphan?: boolean;
}

/**
 * A row's LEFT number in this view: its old number, or, a since-view
 * removed orphan row (no old number), its base number in ORPHAN_LEFT's
 * space; undefined when it has neither.
 */
export function leftNo(line: LeftRow): number | undefined {
	if (line.oldNo !== undefined && line.oldNo !== null) return line.oldNo;
	return line.orphan && line.kind !== "add" && typeof line.baseNo === "number"
		? ORPHAN_LEFT + line.baseNo
		: undefined;
}

/**
 * A selector for the row of a line by its number on one side (`old`: its
 * LEFT number, leftNo's: an orphan removed row by its base number).
 */
export const rowSelector = (old: boolean, line: number) =>
	old && isOrphanLeft(line)
		? `tr[data-orphan][data-base-no="${orphanBase(line)}"]:not([data-old-no])`
		: `tr[data-${old ? "old" : "new"}-no="${line}"]`;
