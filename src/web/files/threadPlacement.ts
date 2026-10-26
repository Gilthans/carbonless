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

/** Where a thread hidden in a gap will show once its lines are loaded. */
export interface GapTarget {
	/** New-side lines `[from, to]` of its range, inside its gap. */
	show: [number, number];
	/** The row it ends on, as `FilePlacement.end` will key it. */
	key: LineKey;
}

export interface FilePlacement {
	/** Threads whose range ends on a shown line, by that line. */
	end: Map<LineKey, ReviewThread[]>;
	/** Every line a placed thread's range covers (the highlight). */
	covered: Set<LineKey>;
	/** Threads whose end line sits in gap `index` (collapsed context). */
	gaps: Map<number, ReviewThread[]>;
	/**
	 * For each thread in `gaps`: the new-side lines its range spans (what
	 * to load to show it) and the key of the row it will end on once they
	 * are loaded (what to open).
	 */
	gapTargets: Map<ReviewThread, GapTarget>;
	/** File comments ("file") and lines that couldn't be placed ("unplaced"). */
	header: { thread: ReviewThread; reason: "file" | "unplaced" }[];
}

/**
 * The threads Files changed shows for the viewed head, in their order:
 * those whose opening comment was made on it. One on no known commit ("")
 * is on no head.
 */
export function threadsOnHead(
	threads: ReviewThread[],
	snapshotHead: string,
): ReviewThread[] {
	return threads.filter((t) => t.commit !== "" && t.commit === snapshotHead);
}

/**
 * This file's threads on the viewed head, whether or not its diff is in:
 * what a closed file's header and the file tree count.
 */
export function fileThreads(
	threads: ReviewThread[],
	path: string,
	snapshotHead: string,
): ReviewThread[] {
	return threadsOnHead(threads, snapshotHead).filter((t) => t.path === path);
}

/**
 * Where a thread sits top down in its file, for reading order: file
 * comments first, then by the new-side number of its last line (a LEFT
 * line shifted by the hunks above it, once they are in).
 */
export function threadOrder(t: ReviewThread, hunks: FileHunks | null): number {
	if (!t.anchor) return -1;
	return newNumberOf(t.anchor.side, t.anchor.line, hunks?.hunks ?? []);
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

/**
 * A hunk's first line on one side, and the first after it. A 0-count
 * hunk's start is the line before it (`-3,0`: an insertion after old 3).
 */
const firstOf = (start: number, count: number) =>
	count === 0 ? start + 1 : start;
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
		if (n < firstOf(h.oldStart, h.oldCount)) break;
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
		gapTargets: new Map(),
		header: [],
	};
	const mine = fileThreads(args.threads, args.path, args.snapshotHead);
	if (mine.length === 0) return placement;
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
		if (gap) {
			push(placement.gaps, gap.index, t);
			const start = newNumberOf(
				anchor.startSide,
				anchor.startLine,
				hunks.hunks,
			);
			placement.gapTargets.set(t, {
				show: [Math.max(gap.from, Math.min(start, n)), n],
				key: endKey,
			});
		} else placement.header.push({ thread: t, reason: "unplaced" });
	}
	return placement;
}
