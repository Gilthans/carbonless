import type { DiffSide } from "../../shared/types";
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
 *   read from the row otherwise;
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
}

export function cellLine(cell: Element): CellLine | null {
	const side = cell.getAttribute("data-side");
	const line = Number(
		cell
			.closest("tr")
			?.getAttribute(side === "LEFT" ? "data-old-no" : "data-new-no"),
	);
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

/** A span over cells `start`..`end` (in the order shown), whole lines unless cols are given. */
export function spanOfCells(
	start: CellLine,
	end: CellLine,
	commit: string,
	cols?: { startCol: number; endCol: number },
): CodeSpan {
	const whole = !cols || (cols.startCol === 0 && cols.endCol === end.len);
	return {
		path: start.path,
		commit,
		subject: "line",
		startSide: start.side,
		startLine: start.line,
		side: end.side,
		line: end.line,
		startCol: whole ? null : (cols?.startCol ?? null),
		endCol: whole ? null : (cols?.endCol ?? null),
	};
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
 */
export function spanOfRange(
	range: Range,
	commit: string,
): {
	span: CodeSpan;
	inDiff: boolean;
	backwards: boolean;
	/** The code cells of its first and last line. */
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
	return {
		span: spanOfCells(head, last, commit, {
			startCol: start.col,
			endCol: end.col,
		}),
		inDiff: inHunk(head) && inHunk(last),
		backwards: backwards(head, last),
		cells: { head: head.cell, last: last.cell },
	};
}

/**
 * The start comes after the end in GitHub's order of the hunk (Ignore
 * whitespace shows a pair where its added line goes, ahead of deleted
 * lines GitHub lists first): GitHub won't take that range.
 */
export const backwards = (
	head: Pick<CellLine, "hunk" | "order">,
	last: Pick<CellLine, "hunk" | "order">,
) =>
	head.hunk === last.hunk &&
	head.order !== undefined &&
	last.order !== undefined &&
	head.order > last.order;
