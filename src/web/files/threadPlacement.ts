import type {
	DiffLine,
	DiffSide,
	DisplayHunk,
	FileHunks,
	ReviewThread,
} from "../../shared/types";
import { fileGaps } from "./gaps";

/** A diff row by its number on one side: `RIGHT:12` is the row whose new number is 12. */
export type LineKey = `${DiffSide}:${number}`;

export interface FilePlacement {
	/** Threads whose range ends on a shown line, by that line. */
	end: Map<LineKey, ReviewThread[]>;
	/** Every line a placed thread's range covers (the highlight). */
	covered: Set<LineKey>;
	/** Threads whose end line sits in gap `index` (collapsed context). */
	gaps: Map<number, ReviewThread[]>;
	/** File comments ("file") and lines that couldn't be placed ("unplaced"). */
	header: { thread: ReviewThread; reason: "file" | "unplaced" }[];
}

/** The row a line key names: RIGHT matches `newNo`, LEFT matches `oldNo`. */
export function lineKey(side: DiffSide, line: DiffLine): LineKey | null {
	const n = side === "RIGHT" ? line.newNo : line.oldNo;
	return n === undefined ? null : `${side}:${n}`;
}

/** Both keys of a row (a context row has two). */
function keysOf(line: DiffLine): LineKey[] {
	const keys: LineKey[] = [];
	const left = lineKey("LEFT", line);
	const right = lineKey("RIGHT", line);
	if (left) keys.push(left);
	if (right) keys.push(right);
	return keys;
}

/**
 * The rows on screen in the order they show: each gap's loaded context
 * before the hunk below it, the hunks' own lines, the last gap's after.
 */
function shownRows(hunks: DisplayHunk[], loadedContext: DiffLine[]) {
	const inHunks = new Set<number>();
	for (const h of hunks) {
		for (const l of h.lines) if (l.newNo !== undefined) inHunks.add(l.newNo);
	}
	const context = loadedContext
		.filter((l) => l.newNo !== undefined && !inHunks.has(l.newNo))
		.sort((a, b) => (a.newNo ?? 0) - (b.newNo ?? 0));
	const rows: DiffLine[] = [];
	let next = 0;
	for (const h of hunks) {
		while (next < context.length && (context[next]?.newNo ?? 0) < h.newStart) {
			rows.push(context[next] as DiffLine);
			next++;
		}
		rows.push(...h.lines);
	}
	rows.push(...context.slice(next));
	return rows;
}

/** A hunk's first line after it on each side (a 0-count hunk's start is the line before it). */
const endOf = (start: number, count: number) =>
	count === 0 ? start + 1 : start + count;

/**
 * The new-side number of a line that no hunk shows: a RIGHT line is its own;
 * a LEFT line is shifted by what the hunks above it added and removed.
 */
function newNumberOf(side: DiffSide, n: number, hunks: DisplayHunk[]): number {
	if (side === "RIGHT") return n;
	let offset = 0;
	for (const h of hunks) {
		if (n < h.oldStart) break;
		offset = endOf(h.newStart, h.newCount) - endOf(h.oldStart, h.oldCount);
	}
	return n + offset;
}

/**
 * Which threads belong to this file's viewed diff, and where. Threads on
 * other commits (or on none GitHub named) are left out. The one place that
 * decides where a thread shows in Files changed: threads from earlier
 * commits, and LEFT lines checked against the old side the commenter saw,
 * will change only this. Today LEFT lines are placed by their number alone,
 * like RIGHT ones.
 *
 * Every thread it keeps lands somewhere: on its last line's row, on the gap
 * hiding that line, or in the file's header (a file comment, or a line it
 * couldn't place, flagged). Without the hunks yet (`null`), only file
 * comments are placed.
 */
export function placeThreads(args: {
	threads: ReviewThread[];
	path: string;
	snapshotHead: string;
	hunks: FileHunks | null;
	loadedContext: DiffLine[];
}): FilePlacement {
	const placement: FilePlacement = {
		end: new Map(),
		covered: new Set(),
		gaps: new Map(),
		header: [],
	};
	const mine = args.threads.filter(
		(t) =>
			t.path === args.path && t.commit !== "" && t.commit === args.snapshotHead,
	);
	const { hunks } = args;
	const rows = hunks ? shownRows(hunks.hunks, args.loadedContext) : [];
	const rowAt = new Map<LineKey, number>();
	rows.forEach((row, i) => {
		for (const key of keysOf(row)) rowAt.set(key, i);
	});
	const gaps = hunks ? fileGaps(hunks.hunks, hunks.newLineCount) : [];
	const push = <K>(map: Map<K, ReviewThread[]>, key: K, t: ReviewThread) => {
		const list = map.get(key);
		if (list) list.push(t);
		else map.set(key, [t]);
	};

	for (const t of mine) {
		const anchor = t.anchor;
		if (!anchor) {
			if (t.subject === "file") {
				placement.header.push({ thread: t, reason: "file" });
			} else if (hunks) {
				placement.header.push({ thread: t, reason: "unplaced" });
			}
			continue;
		}
		if (!hunks) continue;
		const endKey: LineKey = `${anchor.side}:${anchor.line}`;
		const endRow = rowAt.get(endKey);
		if (endRow !== undefined) {
			push(placement.end, endKey, t);
			// From the first shown row at or past the range's start, in the
			// order rows show, to the end row.
			let startRow = endRow;
			for (let i = 0; i < endRow; i++) {
				const row = rows[i] as DiffLine;
				const n = anchor.startSide === "RIGHT" ? row.newNo : row.oldNo;
				if (n !== undefined && n >= anchor.startLine) {
					startRow = i;
					break;
				}
			}
			for (let i = startRow; i <= endRow; i++) {
				const row = rows[i] as DiffLine;
				const key = lineKey(anchor.side, row) ?? keysOf(row)[0];
				if (key) placement.covered.add(key);
			}
			continue;
		}
		const n = newNumberOf(anchor.side, anchor.line, hunks.hunks);
		const gap = gaps.find((g) => g.from <= n && n <= g.to);
		if (gap) push(placement.gaps, gap.index, t);
		else placement.header.push({ thread: t, reason: "unplaced" });
	}
	return placement;
}
