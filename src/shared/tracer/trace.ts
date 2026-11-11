/**
 * Where a position of an old snapshot sits in a new one: GitLab's
 * three-diff trace over `LineMapper`s.
 *
 * The old snapshot is `(B1, H1)`, the new one `(B2, H2)`; a RIGHT line
 * lives in `H1`, a LEFT one in `B1`. Three diffs of one file carry a line
 * across: `ac` (B1 to B2), `bd` (H1 to H2) and `cd` (the new snapshot's
 * own diff, B2 to H2). Nothing here assumes H2 descends from H1 or B2 from
 * B1: the diffs are all that is used. Lines pair by position in those
 * diffs, never by searching text across lines, so a position is never
 * placed on a line whose text differs without saying so (`changed`), and
 * never dropped: every input yields a placement, unplaced ones with a reason.
 *
 * Pure: no git, no I/O, nothing from `src/server/`.
 */

import type { DiffSide } from "../types.js";
import type { LineMapper } from "./lineMapper.js";

/** Bumped when a placement for the same inputs could change. */
export const TRACER_VERSION = 1;

export interface Position {
	side: DiffSide;
	line: number;
}

export interface TraceDiffs {
	/** Old base to new base, this file. */
	ac: LineMapper;
	/** Old head to new head, this file (through its rename pair). */
	bd: LineMapper;
	/** The new snapshot's own diff, this file. */
	cd: LineMapper;
	/** Text in the old snapshot, for `changed`. */
	oldLineText?: (pos: Position) => string | null;
	/** File lengths in the new snapshot, for "outside". */
	newLineCount?: { LEFT: number; RIGHT: number };
}

export type Placement =
	/** Same text, at this line; `became: "context"`: the new snapshot no longer changes it. */
	| { kind: "placed"; side: DiffSide; line: number; became?: "context" }
	/** The line was edited in place: its replacement, with the text as it was. */
	| { kind: "changed"; side: DiffSide; line: number; oldText: string | null }
	/** Gone; `nearest`: the closest surviving line above, in the new snapshot. */
	| {
			kind: "unplaced";
			reason: "deleted" | "rewritten" | "base-changed" | "outside";
			nearest: Position | null;
	  };

const OUTSIDE: Placement = {
	kind: "unplaced",
	reason: "outside",
	nearest: null,
};

/** The image of the last line above `line` that the mapper keeps, or null. */
function nearestAbove(
	mapper: LineMapper,
	line: number,
	side: DiffSide,
): Position | null {
	let n = line - 1;
	while (n >= 1) {
		const mapped = mapper.oldToNew(n);
		if (mapped !== null) return { side, line: mapped };
		// Skip the whole removed range this line is in.
		const hunk = mapper.hunkRemovingOld(n);
		n = hunk ? hunk.oldStart - 1 : n - 1;
	}
	return null;
}

function traceRight(pos: Position, diffs: TraceDiffs): Placement {
	const { bd, cd } = diffs;
	const mapped = bd.oldToNew(pos.line);
	if (mapped !== null) {
		return cd.newToOld(mapped) === null
			? { kind: "placed", side: "RIGHT", line: mapped }
			: { kind: "placed", side: "RIGHT", line: mapped, became: "context" };
	}
	const hunk = bd.hunkRemovingOld(pos.line);
	if (hunk && hunk.newCount > 0) {
		const offset = Math.min(pos.line - hunk.oldStart, hunk.newCount - 1);
		return {
			kind: "changed",
			side: "RIGHT",
			line: hunk.newStart + offset,
			oldText: diffs.oldLineText?.(pos) ?? null,
		};
	}
	return {
		kind: "unplaced",
		reason: "deleted",
		nearest: nearestAbove(bd, pos.line, "RIGHT"),
	};
}

function traceLeft(pos: Position, diffs: TraceDiffs): Placement {
	const { ac, cd } = diffs;
	const mapped = ac.oldToNew(pos.line);
	if (mapped === null) {
		return {
			kind: "unplaced",
			reason: "base-changed",
			nearest: nearestAbove(ac, pos.line, "LEFT"),
		};
	}
	const kept = cd.oldToNew(mapped);
	return kept === null
		? { kind: "placed", side: "LEFT", line: mapped }
		: { kind: "placed", side: "RIGHT", line: kept, became: "context" };
}

/** A line below 1 or, when the new file's lengths are known, past the end. */
function outside(placement: Placement, diffs: TraceDiffs): boolean {
	if (placement.kind === "unplaced") return false;
	const count = diffs.newLineCount?.[placement.side];
	return count !== undefined && placement.line > count;
}

export function tracePosition(pos: Position, diffs: TraceDiffs): Placement {
	if (!Number.isInteger(pos.line) || pos.line < 1) return OUTSIDE;
	const placement =
		pos.side === "LEFT" ? traceLeft(pos, diffs) : traceRight(pos, diffs);
	return outside(placement, diffs) ? OUTSIDE : placement;
}

/**
 * Both ends of a range. When the traced end precedes the start on the same
 * side, the range collapses: both ends are the end line, marked changed.
 */
export function traceRange(
	start: Position,
	end: Position,
	diffs: TraceDiffs,
): { start: Placement; end: Placement; collapsed: boolean } {
	const first = tracePosition(start, diffs);
	const last = tracePosition(end, diffs);
	if (
		first.kind !== "unplaced" &&
		last.kind !== "unplaced" &&
		first.side === last.side &&
		last.line < first.line
	) {
		const collapsed: Placement = {
			kind: "changed",
			side: last.side,
			line: last.line,
			oldText: diffs.oldLineText?.(end) ?? null,
		};
		return { start: collapsed, end: collapsed, collapsed: true };
	}
	return { start: first, end: last, collapsed: false };
}

/**
 * The span's text, re-found in the new line: its new columns when it occurs
 * exactly once there, else null (the caller falls back to whole lines).
 */
export function traceSpan(
	span: { startCol: number; endCol: number },
	oldLineText: string,
	newLineText: string,
): { startCol: number; endCol: number } | null {
	if (span.endCol <= span.startCol) return null;
	const text = oldLineText.slice(span.startCol, span.endCol);
	if (text === "") return null;
	const at = newLineText.indexOf(text);
	if (at === -1 || newLineText.indexOf(text, at + 1) !== -1) return null;
	return { startCol: at, endCol: at + text.length };
}
