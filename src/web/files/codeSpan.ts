import type { DiffSide } from "../../shared/types";
import { ORPHAN_LEFT } from "./orphanLeft";
import type { CodeSpan } from "./selectionActions";

/**
 * Mapping a selection in Files changed to a CodeSpan, from what the diff's
 * DOM says about each code cell (DiffBody; the spec's "Cells" contract,
 * which side by side builds on):
 * - `data-code-cell`: a code cell, with `data-side` (RIGHT for added and
 *   context lines, LEFT for deleted ones, the shown side's for whitespace
 *   rows), `data-len` (its text's UTF-16 length) and `data-hunk` (the hunk
 *   it is in, `h<i>`, or the gap of expanded context, `g<i>`), `data-order`
 *   (in a hunk: its line's index in GitHub's order of it); its line is
 *   its row's number on that side (`data-old-no` / `data-new-no`), never
 *   read from the row otherwise. The since view numbers its old side in
 *   the earlier patch set: its removed rows also carry `data-base-no`,
 *   the base line GitHub knows a LEFT line by on the head (empty: a line
 *   only that patch set had, which GitHub has no line for; CAR-217); such
 *   a line also carries `data-ps-no`, its line on that patch set's commit,
 *   when that commit's diff adds it (a comment goes there, CAR-233). A
 *   since-view orphan line's cell (CAR-216) carries `data-orphan`; a
 *   removed one has no old number: its line is its base number in
 *   ORPHAN_LEFT's space (orphanLeft.ts, CAR-276). Side by side, a context line is shown in
 *   a cell on each side (`data-kind="context"`, `data-side` the cell's
 *   column): it is one line, RIGHT from either cell;
 * - inside it, `[data-code]` holds exactly the line's characters (CodeLine):
 *   a column is the text before a point in it;
 * - the file's section carries `data-path`.
 * The side comes from the cell, never the row: a side-by-side view puts
 * two cells in one row.
 */

export const CODE_CELL = "data-code-cell";

/** A code cell's line, as its attributes say. */
export interface CellLine {
	cell: Element;
	side: DiffSide;
	line: number;
	len: number;
	/** The hunk (`h<i>`) or gap of expanded context (`g<i>`) it is in. */
	hunk: string;
	/** Its line's place in its hunk as GitHub lists it (`data-order`); none in a gap. */
	order?: number;
	path: string;
	/**
	 * A LEFT cell of the since view (`data-base-no`): GitHub's number for
	 * its line (in the base), null when GitHub has none (a line only the
	 * earlier patch set had), "unknown" when the row doesn't say (never
	 * its own number then: fails closed). Absent elsewhere: `line` is
	 * GitHub's.
	 */
	base?: number | null | "unknown";
	/**
	 * A since-view LEFT cell with `base` null (`data-ps-no`): its line on
	 * the compared patch set's commit, an added line of that commit's diff
	 * (GitHub's RIGHT line there, CAR-233). Absent when that diff hasn't it.
	 */
	ps?: number;
	/**
	 * A since-view LEFT cell with `base` null whose line that patch set's
	 * diff adds at another path than this file's (`data-ps-moved`): no
	 * comment can name it (CAR-233).
	 */
	psMoved?: boolean;
	/**
	 * A since-view orphan line's cell (`data-orphan`, CAR-216): a removed
	 * one's `line` is in ORPHAN_LEFT's space, its GitHub line `base`.
	 */
	orphan?: boolean;
	/**
	 * A since-view RIGHT cell whose line GitHub's diff hasn't
	 * (`data-off-github`, DiffLine.offGithub): no comment can go on it
	 * (CAR-293).
	 */
	offGithub?: boolean;
}

/**
 * Why a since-view span can't go to GitHub: a line only an earlier patch
 * set had and not in its diff either ("earlier"), a line it doesn't know
 * ("unknown"), or lines of the earlier patch set's commit mixed with the
 * head's ("mixed").
 */
export type NoLine =
	| "earlier"
	| "unknown"
	| "mixed"
	| "renamed"
	| "split"
	| "orphan"
	| "orphan-split";

/** A line only the compared patch set had, on its commit (CAR-233). */
export const onEarlier = (c: Pick<CellLine, "base" | "ps">) =>
	c.base === null && c.ps !== undefined;

/** The line GitHub knows a cell's line by: its base number in the since view. */
const githubLine = (c: Pick<CellLine, "line" | "base">) =>
	typeof c.base === "number" ? c.base : c.line;

/** Why a cell's line has no GitHub line (codeSpan's NoLine), or null when it has one. */
export const noLineOf = (
	c: Pick<CellLine, "base" | "ps" | "psMoved">,
): NoLine | null =>
	c.base === null
		? c.ps !== undefined
			? null
			: c.psMoved
				? "renamed"
				: "earlier"
		: c.base === "unknown"
			? "unknown"
			: null;

/**
 * Why the span over `cells` can't go to GitHub (the first line's reason),
 * or null. Lines on the earlier patch set's commit go there all together
 * or not at all: mixed with others, "mixed"; with no such commit known
 * (`earlier`), "unknown". An orphan line (CAR-276) goes with orphan
 * lines only: with others, "orphan" (the view shows them apart, unlike
 * GitHub's range between them); its removed lines' base lines one run, else
 * "orphan-split" (the range would hold base lines the view never showed).
 */
export function noLineIn(
	cells: readonly (Pick<CellLine, "base" | "ps" | "psMoved"> &
		Partial<Pick<CellLine, "orphan" | "side">>)[],
	earlier?: string,
): NoLine | null {
	for (const c of cells) {
		const why = noLineOf(c);
		if (why) return why;
	}
	if (cells.some((c) => c.orphan) && cells.some((c) => !c.orphan)) {
		return "orphan";
	}
	const bases = cells
		.filter((c) => c.orphan && c.side === "LEFT" && typeof c.base === "number")
		.map((c) => c.base as number)
		.sort((a, b) => a - b);
	if (bases.some((n, i) => i > 0 && n !== (bases[i - 1] as number) + 1)) {
		return "orphan-split";
	}
	const on = cells.filter(onEarlier).length;
	if (on === 0) return null;
	if (on < cells.length) return "mixed";
	if (!earlier) return "unknown";
	// One run of lines on that commit: else its range would hold lines the
	// view never showed (a base change between them since).
	const ps = cells.map((c) => c.ps as number).sort((a, b) => a - b);
	return ps.every((n, i) => i === 0 || n === (ps[i - 1] as number) + 1)
		? null
		: "split";
}

export function cellLine(cell: Element): CellLine | null {
	// A context line's left cell (side by side) is the same line as its right one.
	const side =
		cell.getAttribute("data-kind") === "context"
			? "RIGHT"
			: cell.getAttribute("data-side");
	const row = cell.closest("tr");
	const baseAttr = side === "LEFT" ? row?.getAttribute("data-base-no") : null;
	const orphan = cell.hasAttribute("data-orphan");
	const numbered = row?.getAttribute(
		side === "LEFT" ? "data-old-no" : "data-new-no",
	);
	// An orphan removed line has no old number: its base one, in its own
	// space (CAR-276).
	const line =
		numbered == null && side === "LEFT" && orphan && baseAttr
			? ORPHAN_LEFT + Number(baseAttr)
			: Number(numbered);
	const psAttr = baseAttr === "" ? row?.getAttribute("data-ps-no") : null;
	// The since view's LEFT line without a base number: not known (CAR-217).
	const unknown =
		side === "LEFT" &&
		baseAttr == null &&
		cell.closest("[data-since]") !== null;
	const path = cell.closest("[data-path]")?.getAttribute("data-path");
	if ((side !== "LEFT" && side !== "RIGHT") || !line || path == null) {
		return null;
	}
	const hunk = cell.getAttribute("data-hunk");
	const order = cell.getAttribute("data-order");
	return {
		cell,
		side,
		line,
		len: Number(cell.getAttribute("data-len")) || 0,
		hunk: hunk ?? "",
		...(order !== null && order !== "" ? { order: Number(order) } : {}),
		path,
		...(unknown
			? { base: "unknown" as const }
			: baseAttr == null
				? {}
				: { base: baseAttr === "" ? null : Number(baseAttr) }),
		...(psAttr ? { ps: Number(psAttr) } : {}),
		...(baseAttr === "" && row?.hasAttribute("data-ps-moved")
			? { psMoved: true }
			: {}),
		...(orphan ? { orphan: true } : {}),
		...(side === "RIGHT" && row?.hasAttribute("data-off-github")
			? { offGithub: true }
			: {}),
	};
}

/** Where a boundary point lies against a cell's text, and its column there. */
function pointIn(
	cell: Element,
	len: number,
	node: Node,
	offset: number,
): { col: number; where: "before" | "in" | "after" } {
	const code = cell.querySelector("[data-code]");
	if (!code) return { col: 0, where: "before" };
	const whole = document.createRange();
	whole.selectNodeContents(code);
	let cmp: number;
	try {
		cmp = whole.comparePoint(node, offset);
	} catch {
		return { col: 0, where: "before" };
	}
	if (cmp < 0) return { col: 0, where: "before" };
	if (cmp > 0) return { col: len, where: "after" };
	const head = document.createRange();
	head.setStart(code, 0);
	head.setEnd(node, offset);
	return { col: Math.min(head.toString().length, len), where: "in" };
}

/** Whether the cell's line is in GitHub's diff (a hunk's, not expanded context). */
export const inHunk = (c: Pick<CellLine, "hunk">) => c.hunk.startsWith("h");

/**
 * Whether GitHub takes a comment on the cell's line: a hunk's, and not a
 * since-view line GitHub's diff hasn't (CAR-293).
 */
export const onGithub = (c: Pick<CellLine, "hunk" | "offGithub">) =>
	inHunk(c) && !c.offGithub;

/**
 * A span over cells `start`..`end` (in the order shown), whole lines unless
 * cols are given; each end by GitHub's number for it (`base` in the since
 * view). Both ends lines only the compared patch set had, on its commit
 * (`earlier`): that commit's RIGHT lines (`ps`), marked `earlier`
 * (CAR-233).
 */
export function spanOfCells(
	start: CellLine,
	end: CellLine,
	commit: string,
	cols?: { startCol: number; endCol: number },
	earlier?: string,
): CodeSpan {
	const whole = !cols || (cols.startCol === 0 && cols.endCol === end.len);
	if (earlier && onEarlier(start) && onEarlier(end)) {
		return {
			path: start.path,
			commit: earlier,
			subject: "line",
			startSide: "RIGHT",
			startLine: start.ps as number,
			side: "RIGHT",
			line: end.ps as number,
			startCol: whole ? null : (cols?.startCol ?? null),
			endCol: whole ? null : (cols?.endCol ?? null),
			earlier: true,
		};
	}
	return {
		path: start.path,
		commit,
		subject: "line",
		startSide: start.side,
		startLine: githubLine(start),
		side: end.side,
		line: githubLine(end),
		startCol: whole ? null : (cols?.startCol ?? null),
		endCol: whole ? null : (cols?.endCol ?? null),
	};
}

/** Whether the cell is on the side a side-by-side selection leaves out. */
function unselectable(cell: Element): boolean {
	const selecting = cell.closest("table")?.getAttribute("data-selecting");
	if (!selecting) return false;
	const side = cell.getAttribute("data-side");
	return selecting === "old" ? side === "RIGHT" : side === "LEFT";
}

/** The selection's cells: those it touches, in one file (the first one's). */
function selectedCells(range: Range): CellLine[] {
	const root =
		range.commonAncestorContainer instanceof Element
			? range.commonAncestorContainer
			: range.commonAncestorContainer.parentElement;
	if (!root) return [];
	const within = root.closest(`[${CODE_CELL}]`)
		? [root.closest(`[${CODE_CELL}]`) as Element]
		: [...root.querySelectorAll(`[${CODE_CELL}]`)];
	// Cells are in document order: skip those ending before the range by a
	// binary search, and stop at the first one past it.
	const endsBefore = (el: Element) => {
		try {
			return range.comparePoint(el, el.childNodes.length) < 0;
		} catch {
			return false;
		}
	};
	let lo = 0;
	let hi = within.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (endsBefore(within[mid] as Element)) lo = mid + 1;
		else hi = mid;
	}
	const cells: CellLine[] = [];
	for (let i = lo; i < within.length; i++) {
		const el = within[i] as Element;
		if (!range.intersectsNode(el)) {
			if (cells.length > 0) break;
			continue;
		}
		// Side by side, a selection is on one side (DiffBody's
		// `data-selecting`): the other side's cells, which the range runs
		// through in the DOM, hold none of it.
		if (unselectable(el)) continue;
		const c = cellLine(el);
		if (!c) continue;
		if (cells.length > 0 && c.path !== cells[0]?.path) break;
		cells.push(c);
	}
	return cells;
}

/**
 * The code span a selection makes, or null when it holds no code: clamped
 * to the code cells of one file (the first it touches); a row it only
 * touches at its edge (its end before the next row's first character, its
 * start after the last row's last one) isn't in it. Whole lines when it
 * runs from a line's start to the last line's end.
 *
 * The ends go in GitHub's order of the hunk, whichever way the view shows
 * them: Ignore whitespace shows a pair where its added line goes, ahead of
 * deleted lines GitHub lists first, so a selection from the pair's row
 * into such a deleted row starts after its end to GitHub. It is sent the
 * other way round (the earlier line first) as whole lines: the selected
 * characters are a tail of one line and a head of the other, which no
 * marker on the swapped ends describes.
 */
export function spanOfRange(
	range: Range,
	commit: string,
	/** The since view's compared patch set's head (CAR-233). */
	earlier?: string,
): {
	span: CodeSpan;
	inDiff: boolean;
	/** An end of it is a since-view line GitHub's diff hasn't (CAR-293). */
	sameAsBase: boolean;
	/** Why one of its lines has no GitHub line (the since view), or null. */
	noLine: NoLine | null;
	/** The code cells of its first and last line, as shown (SelectionBar's geometry). */
	cells: { head: Element; last: Element };
} | null {
	if (range.collapsed) return null;
	let cells = selectedCells(range);
	if (cells.length === 0) return null;
	const first = cells[0] as CellLine;
	let start = pointIn(
		first.cell,
		first.len,
		range.startContainer,
		range.startOffset,
	);
	if (
		cells.length > 1 &&
		start.col === first.len &&
		first.len > 0 &&
		start.where !== "before"
	) {
		cells = cells.slice(1);
		start = { col: 0, where: "before" };
	}
	let last = cells[cells.length - 1] as CellLine;
	let end = pointIn(last.cell, last.len, range.endContainer, range.endOffset);
	if (cells.length > 1 && end.col === 0) {
		cells = cells.slice(0, -1);
		last = cells[cells.length - 1] as CellLine;
		end = { col: last.len, where: "after" };
	}
	const head = cells[0] as CellLine;
	if (cells.length === 1 && start.col >= end.col) return null;
	const swapped =
		head.hunk === last.hunk &&
		head.order !== undefined &&
		last.order !== undefined &&
		head.order > last.order;
	return {
		span: swapped
			? spanOfCells(last, head, commit, undefined, earlier)
			: spanOfCells(
					head,
					last,
					commit,
					{ startCol: start.col, endCol: end.col },
					earlier,
				),
		inDiff: onGithub(head) && onGithub(last),
		sameAsBase: !!(head.offGithub || last.offGithub),
		noLine: noLineIn(cells, earlier),
		cells: { head: head.cell, last: last.cell },
	};
}
