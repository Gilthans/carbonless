import type { ThreadPlacement } from "../../shared/rereview/placement";
import type {
	DiffLine,
	DiffSide,
	DisplayHunk,
	FileHunks,
	ReviewThread,
} from "../../shared/types";
import type { Mark } from "../code/Invisibles";
import { type SpanRange, spanMarks } from "../threads/spanMarks";
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

/**
 * What placeThreads places: a review thread, or an agent thread seen the
 * same way (its path, the commit it was asked on, file or line, the range).
 * `id` is a review thread's: the key of its traced placement (agent
 * threads have none and are placed on the commit they were asked on).
 */
export interface Placeable {
	id?: string;
	path: string;
	commit: string;
	subject: "line" | "file";
	anchor: SpanRange | null;
}

export interface FilePlacement<T extends Placeable = ReviewThread> {
	/** Threads whose range ends on a shown line, by that line. */
	end: Map<LineKey, T[]>;
	/** Every line a placed thread's range covers (the highlight). */
	covered: Set<LineKey>;
	/**
	 * The exact characters of the ranges with columns that fit (spanMarks),
	 * by row: painted over `covered`.
	 */
	marks: Map<LineKey, Mark[]>;
	/** `spans` that end on a shown row (painted), by their index. */
	spansShown: Set<number>;
	/** Threads whose end line sits in gap `index` (collapsed context). */
	gaps: Map<number, T[]>;
	/**
	 * For each thread in `gaps`: the new-side lines its range spans (what
	 * to load to show it) and the key of the row it will end on once they
	 * are loaded (what to open).
	 */
	gapTargets: Map<T, GapTarget>;
	/** File comments ("file") and lines that couldn't be placed ("unplaced"). */
	header: { thread: T; reason: "file" | "unplaced" }[];
	/**
	 * Threads the tracer couldn't place in this file, with their fate: the
	 * list under the file's header.
	 */
	fates: {
		thread: T;
		placement: Extract<ThreadPlacement, { kind: "unplaced" }>;
	}[];
}

/** Each unresolved thread's place in the viewed snapshot, by thread id (GET /placements). */
export type Placements = ReadonlyMap<string, ThreadPlacement>;

/** Re-anchored copies, one per thread and placement (stable identities). */
const shownCopies = new WeakMap<
	ReviewThread,
	WeakMap<ThreadPlacement, ReviewThread>
>();

/**
 * A thread as Files changed shows it in the viewed snapshot (its head
 * `snapshotHead`): a placed or changed one on its new lines (and path), a
 * file comment on its file's path now, an unplaced one under its file's
 * path, each as if made on the viewed head; its code pane stays its own.
 * One with no placement (resolved, id-less, or the placements not in yet)
 * shows only where it was made, when that is the viewed head. Null: not
 * in this snapshot's files (outside the comparison, or another head's).
 */
export function shownThread(
	t: ReviewThread,
	snapshotHead: string,
	placements: Placements | null,
): ReviewThread | null {
	const p = placements?.get(t.id);
	if (!p) return t.commit !== "" && t.commit === snapshotHead ? t : null;
	if (p.kind === "outside") return null;
	let copies = shownCopies.get(t);
	if (!copies) {
		copies = new WeakMap();
		shownCopies.set(t, copies);
	}
	const known = copies.get(p);
	if (known && known.commit === snapshotHead) return known;
	let shown: ReviewThread;
	if (p.kind === "placed" || p.kind === "changed") {
		const a = p.anchor;
		// A rewritten line's columns no longer hold: whole lines.
		const cols =
			p.kind === "placed" && t.anchor
				? {
						startCol: t.anchor.startCol ?? null,
						endCol: t.anchor.endCol ?? null,
					}
				: { startCol: null, endCol: null };
		shown = {
			...t,
			path: a.path,
			commit: snapshotHead,
			subject: "line",
			anchor: {
				path: a.path,
				commit: snapshotHead,
				side: a.side,
				line: a.line,
				startSide: a.startSide,
				startLine: a.startLine,
				at: t.anchor?.at ?? t.createdAt,
				...cols,
			},
		};
	} else {
		shown = { ...t, path: p.path, commit: snapshotHead };
	}
	copies.set(p, shown);
	return shown;
}

/** Every thread Files changed shows in the viewed snapshot's files (shownThread). */
export function shownThreads(
	threads: readonly ReviewThread[],
	snapshotHead: string,
	placements: Placements | null,
): ReviewThread[] {
	return threads.flatMap((t) => {
		const shown = shownThread(t, snapshotHead, placements);
		return shown ? [shown] : [];
	});
}

/**
 * The threads whose file is not in the comparison at all (the trailing
 * "Not in this comparison" group), in the order given.
 */
export function outsideThreads(
	threads: readonly ReviewThread[],
	placements: Placements | null,
): {
	thread: ReviewThread;
	placement: Extract<ThreadPlacement, { kind: "outside" }>;
}[] {
	return threads.flatMap((thread) => {
		const placement = placements?.get(thread.id);
		return placement?.kind === "outside" ? [{ thread, placement }] : [];
	});
}

/**
 * The threads made on the viewed head, in their order. One on no known
 * commit ("") is on no head. Agent threads, never traced, show this way.
 */
export function threadsOnHead<T extends Placeable>(
	threads: T[],
	snapshotHead: string,
): T[] {
	return threads.filter((t) => t.commit !== "" && t.commit === snapshotHead);
}

/**
 * This file's threads on the viewed head, whether or not its diff is in:
 * what a closed file's header and the file tree count.
 */
export function fileThreads<T extends Placeable>(
	threads: T[],
	path: string,
	snapshotHead: string,
): T[] {
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
export function lineKey(
	side: DiffSide,
	line: Pick<DiffLine, "oldNo" | "newNo">,
): LineKey | null {
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
 * Which threads belong to this file's viewed diff, and where: the one
 * place that decides where a thread shows in Files changed. `threads` are
 * shownThreads' (each on the viewed head, the tracer's placement applied:
 * threads from earlier commits on their traced lines, LEFT lines checked
 * against the old side the commenter saw); threads on other commits are
 * left out. Those the tracer couldn't place go to `fates`.
 *
 * Every thread it keeps lands somewhere: on its last line's row, on the gap
 * hiding that line, or in the file's header (a file comment, or a line it
 * couldn't place, flagged). Without the hunks yet (`null`), only file
 * comments are placed, and the line threads of a file that has no lines to
 * show (`noLines`: binary, a submodule) go to the header unplaced.
 */
export function placeThreads<T extends Placeable = ReviewThread>(args: {
	threads: T[];
	path: string;
	snapshotHead: string;
	hunks: FileHunks | null;
	loadedContext: DiffLine[];
	/** The file has no lines to show (binary, a submodule): known without hunks. */
	noLines?: boolean;
	/** More ranges to paint like a thread's (new threads being written). */
	spans?: readonly SpanRange[];
	/** Where the tracer put each thread (shownThreads applied them already). */
	placements?: Placements | null;
}): FilePlacement<T> {
	const placement: FilePlacement<T> = {
		end: new Map(),
		covered: new Set(),
		marks: new Map(),
		spansShown: new Set(),
		gaps: new Map(),
		gapTargets: new Map(),
		header: [],
		fates: [],
	};
	const mine = fileThreads(args.threads, args.path, args.snapshotHead);
	const spans = args.spans ?? [];
	if (mine.length === 0 && spans.length === 0) return placement;
	const { hunks } = args;
	const rows = hunks ? shownRows(hunks.hunks, args.loadedContext) : [];
	const rowAt = new Map<LineKey, number>();
	rows.forEach((row, i) => {
		for (const key of keysOf(row)) rowAt.set(key, i);
	});
	const gaps = hunks ? fileGaps(hunks.hunks, hunks.newLineCount) : [];
	const push = <K>(map: Map<K, T[]>, key: K, t: T) => {
		const list = map.get(key);
		if (list) list.push(t);
		else map.set(key, [t]);
	};

	/**
	 * Marks a range ending on row `endRow`: from the first shown row at or
	 * past its start, in the order rows show, to the end row; and its exact
	 * characters when its columns fit those rows.
	 */
	const paint = (range: SpanRange, endRow: number) => {
		let startRow = endRow;
		for (let i = 0; i < endRow; i++) {
			const row = rows[i] as DiffLine;
			const n = range.startSide === "RIGHT" ? row.newNo : row.oldNo;
			if (n !== undefined && n >= range.startLine) {
				startRow = i;
				break;
			}
		}
		const covered = rows.slice(startRow, endRow + 1);
		const keys = covered.map(
			(row) => lineKey(range.side, row) ?? keysOf(row)[0],
		);
		for (const key of keys) if (key) placement.covered.add(key);
		const marks = spanMarks(covered, range);
		if (!marks) return;
		keys.forEach((key, i) => {
			if (!key) return;
			placement.marks.set(key, [
				...(placement.marks.get(key) ?? []),
				...(marks[i] ?? []),
			]);
		});
	};

	if (hunks && !args.noLines) {
		spans.forEach((span, i) => {
			const endRow = rowAt.get(`${span.side}:${span.line}`);
			if (endRow === undefined) return;
			paint(span, endRow);
			placement.spansShown.add(i);
		});
	}

	for (const t of mine) {
		const traced = t.id === undefined ? undefined : args.placements?.get(t.id);
		if (traced?.kind === "unplaced") {
			placement.fates.push({ thread: t, placement: traced });
			continue;
		}
		const anchor = t.anchor;
		if (!anchor) {
			if (t.subject === "file") {
				placement.header.push({ thread: t, reason: "file" });
			} else if (hunks || args.noLines) {
				placement.header.push({ thread: t, reason: "unplaced" });
			}
			continue;
		}
		if (args.noLines) {
			placement.header.push({ thread: t, reason: "unplaced" });
			continue;
		}
		if (!hunks) continue;
		const endKey: LineKey = `${anchor.side}:${anchor.line}`;
		const endRow = rowAt.get(endKey);
		if (endRow !== undefined) {
			push(placement.end, endKey, t);
			paint(anchor, endRow);
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
