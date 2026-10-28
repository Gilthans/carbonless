import type { DiffSide } from "../../shared/types";
import type { CodeSpan } from "./selectionActions";

/**
 * Mapping a selection in Files changed to a CodeSpan, from what the diff's
 * DOM says about each code cell (DiffBody):
 * - `data-code-cell`: a row's code cell, with `data-side` and `data-line`
 *   (the line GitHub numbers it by: the new number for added and context
 *   rows, the old one for deleted rows, the shown side's for whitespace
 *   rows), `data-old-line` on a context row (its old number), `data-len`
 *   (its text's UTF-16 length) and `data-hunk` (the hunk it is in, or the
 *   gap for expanded context);
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
	/** A context row's old number: it is on both sides. */
	oldLine?: number;
	len: number;
	/** The hunk (or gap of expanded context) it is in. */
	hunk: string;
	path: string;
}

export function cellLine(cell: Element): CellLine | null {
	const side = cell.getAttribute("data-side");
	const line = Number(cell.getAttribute("data-line"));
	const path = cell.closest("[data-path]")?.getAttribute("data-path");
	if ((side !== "LEFT" && side !== "RIGHT") || !line || path == null) {
		return null;
	}
	const old = cell.getAttribute("data-old-line");
	const hunk = cell.getAttribute("data-hunk");
	return {
		cell,
		side,
		line,
		...(old ? { oldLine: Number(old) } : {}),
		len: Number(cell.getAttribute("data-len")) || 0,
		hunk: hunk ?? "",
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

/** A span over cells `start`..`end` (in the order shown), whole lines unless cols are given. */
export function spanOfCells(
	start: CellLine,
	end: CellLine,
	commit: string,
	cols?: { startCol: number; endCol: number },
): CodeSpan {
	// A context row is on both sides: a range ending on an old line starts
	// on its old number, so both ends are on the old side as GitHub wants.
	const startOld =
		end.side === "LEFT" && start.side === "RIGHT" && start.oldLine;
	const whole = !cols || (cols.startCol === 0 && cols.endCol === end.len);
	return {
		path: start.path,
		commit,
		subject: "line",
		startSide: startOld ? "LEFT" : start.side,
		startLine: startOld ? (start.oldLine as number) : start.line,
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
	const cells: CellLine[] = [];
	for (const el of within) {
		if (!range.intersectsNode(el)) continue;
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
): { span: CodeSpan; oneHunk: boolean } | null {
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
		oneHunk: head.hunk === last.hunk,
	};
}
