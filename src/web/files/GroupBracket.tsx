import { createContext, useContext } from "react";
import type { DiffSide } from "../../shared/types";

/**
 * The bracket that ties a split or joined line's group together (CAR-130,
 * docs/superpowers/specs/2026-11-24-split-joined-lines-design.md, "The
 * bracket"). It is drawn piece by piece with the rows: each group row's
 * code cell holds one in its left padding (the 0.5rem before the sign, so
 * nothing moves and a hunk without a group looks as before), `first` with
 * a stub at the top, `last` with one at the bottom, `mid` a plain rule;
 * a row inserted inside a group (a thread, a composer, a phone's bubble
 * row) holds a `through` piece at the same x, under any card it holds, so
 * the bracket runs on past it. Unified, every group row has a piece;
 * side by side, the run's side only. Not interactive: hidden from
 * readers, its label a hover tooltip; the line-number cells carry the
 * label in their accessible names.
 */
export type BracketAt = "first" | "mid" | "last" | "through";

const SHAPE: Record<BracketAt, string> = {
	first: "top-2.5 bottom-0 rounded-tl border-t-2",
	mid: "inset-y-0",
	last: "top-0 h-2.5 rounded-bl border-b-2",
	through: "inset-y-0 -z-10",
};

/** One piece of the bracket, absolutely placed in its cell (which is `relative`). */
export function BracketPiece(props: {
	at: BracketAt;
	label: string;
	/** The piece's x in its cell (a CSS length); the cell's left edge by default. */
	left?: string;
}) {
	return (
		<span
			data-testid="group-bracket"
			data-group-at={props.at}
			aria-hidden="true"
			title={props.label}
			style={props.left ? { left: props.left } : undefined}
			className={`absolute ${props.left ? "" : "left-0.5"} w-1.5 border-l-2 border-accent select-none ${SHAPE[props.at]}`}
		/>
	);
}

/**
 * A group row's inserted rows (what renders under it while the group goes
 * on): the label, and the side its run is on (side by side, the bracket's
 * side). Null outside a group, and under a group's last row.
 */
export interface Through {
	label: string;
	side: DiffSide;
}
export const GroupThrough = createContext<Through | null>(null);
export const useGroupThrough = () => useContext(GroupThrough);

/** A cell that holds a `through` piece: its own stacking, so the piece sits under the cell's card. */
export const THROUGH_CELL = "relative isolate";

/*
 * Where a code column starts, from the left of a cell that spans the
 * table: the rail (0.25rem), the controls column (`--controls-w`) and the
 * number columns (`--num-w`, DiffBody's TABLE_VARS and NUMBER_W) before it.
 * Side by side the table is fixed and its two code columns share what the
 * rest leaves, so the right one starts halfway past the fixed columns.
 * The piece sits 0.125rem into the column, as in a code cell.
 */
const NUM = "var(--num-w,3rem)";
const CONTROLS = "var(--controls-w)";

/**
 * The `through` piece's x in a cell spanning the table from `from` (the
 * rail's column, or the one after it) to its end.
 */
export function throughLeft(
	view: "unified" | "side-by-side",
	side: DiffSide,
	from: "rail" | "controls",
): string {
	const rail = from === "rail" ? "0.25rem" : "0rem";
	if (view === "unified")
		return `calc(${rail} + ${CONTROLS} + 2 * ${NUM} + 0.125rem)`;
	if (side === "LEFT") return `calc(${rail} + ${CONTROLS} + ${NUM} + 0.125rem)`;
	// Right: (width + rail + controls + 2 numbers) / 2 from the rail's
	// left; from the controls', the rail's width less.
	return from === "rail"
		? `calc((100% + 0.25rem + ${CONTROLS} + 2 * ${NUM}) / 2 + 0.125rem)`
		: `calc((100% + ${CONTROLS} + 2 * ${NUM}) / 2 + 0.125rem)`;
}

/**
 * From a `through` piece's x to where a card under its row starts: the
 * piece (0.375rem) and a gap (0.375rem), so the bracket runs on beside the
 * card, never under it.
 */
export const PAST_BRACKET = "0.75rem";

/** Within one side's number and code columns (a side-by-side card's or blank's cell). */
export const THROUGH_IN_SIDE = `calc(${NUM} + 0.125rem)`;
