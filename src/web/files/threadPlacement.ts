import type { ThreadPlacement } from "../../shared/rereview/placement";
import { createLineMapper } from "../../shared/tracer/lineMapper";
import type {
	Cluster,
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
	/**
	 * File comments ("file") and lines that couldn't be placed ("unplaced");
	 * in the since view, an unplaced line its comparison doesn't hold says
	 * why (`notHere`, CAR-255).
	 */
	header: { thread: T; reason: "file" | "unplaced"; notHere?: NotHere }[];
	/**
	 * Threads the tracer couldn't place in this file, with their fate: the
	 * list under the file's header.
	 */
	fates: {
		thread: T;
		placement: Extract<ThreadPlacement, { kind: "unplaced" }>;
	}[];
	/**
	 * Threads still being placed (`pending`, CAR-8): listed under the
	 * header with a spinner, never on a line meanwhile.
	 */
	waiting: T[];
}

/**
 * The since view: why a thread's line has no row in it (CAR-255), and the
 * line it is on in the full diff (its base line, LEFT), to open there.
 * Not a tracer fate: the line is where the thread says, only outside this
 * comparison.
 * - "deleted-before": the compared patch set had already deleted it (no
 *   removed row of the interdiff is it, and every removed row is a known
 *   base line the full diff deletes too).
 * - "unchanged": the same, and the file isn't changed between these patch
 *   sets at all (said as "deleted before" too; notHereText).
 * - "unknown": some removed row's base line isn't known, or the two diffs
 *   pair twin lines differently: only that this comparison doesn't show it.
 */
export interface NotHere {
	why: "deleted-before" | "unchanged" | "unknown";
	side: "LEFT";
	line: number;
}

/**
 * Why the since view's `hunks` don't show base line `line` (NotHere),
 * which `left` (SinceLeft) found the full diff deleted. "deleted-before"
 * only when every removed row is a base line the full diff deletes too:
 * one whose base line isn't known could be it, and one on a line the full
 * diff keeps means the two diffs paired twin lines differently (the
 * compared patch set may well have had this one): "unknown" for both.
 */
export function notHereOf(
	hunks: FileHunks,
	line: number,
	left: SinceLeft,
): NotHere {
	const removed = hunks.hunks
		.flatMap((h) => h.lines)
		.filter((l) => l.kind === "del");
	const doubtful = removed.some(
		(l) =>
			l.baseNo === undefined ||
			(typeof l.baseNo === "number" && left(l.baseNo)?.side === "RIGHT"),
	);
	const why: NotHere["why"] = doubtful
		? "unknown"
		: hunks.wholeGap || hunks.hunks.length === 0
			? "unchanged"
			: "deleted-before";
	return { why, side: "LEFT", line };
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
	/** Threads the reviewer moved (CAR-139): their columns don't hold. */
	moved?: ReadonlyMap<string, unknown> | null,
): ReviewThread | null {
	const p = placements?.get(t.id);
	if (!p) return madeOnHead(t, snapshotHead) ? t : null;
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
		// A rewritten line's columns no longer hold, nor a moved thread's:
		// whole lines.
		const cols =
			p.kind === "placed" && t.anchor && !moved?.has(t.id)
				? {
						startCol: t.anchor.startCol ?? null,
						endCol: t.anchor.endCol ?? null,
					}
				: { startCol: null, endCol: null };
		shown = {
			...t,
			madeOn: t.madeOn ?? t.commit,
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
	} else if (p.kind === "pending") {
		// Still being placed (CAR-8): on no line of this head meanwhile.
		shown = {
			...t,
			madeOn: t.madeOn ?? t.commit,
			path: p.path,
			commit: snapshotHead,
			anchor: null,
		};
	} else {
		shown = {
			...t,
			madeOn: t.madeOn ?? t.commit,
			path: p.path,
			commit: snapshotHead,
		};
	}
	copies.set(p, shown);
	return shown;
}

/**
 * A thread made on the viewed head (`viewedHead`): shown where it was
 * made, so it needs no placing, and never reads "place unknown" when the
 * placements fail (CAR-271). A copy shown as if made on the head (its
 * `madeOn` the commit it was made on) wasn't. One on no known commit ("")
 * is on no head.
 */
export const madeOnHead = (
	t: Pick<ReviewThread, "commit" | "madeOn">,
	viewedHead: string | null | undefined,
): boolean => {
	const made = t.madeOn ?? t.commit;
	return !!viewedHead && made !== "" && made === viewedHead;
};

/** Copies of threads made on the since view's compared patch set's head (CAR-233). */
const earlierCopies = new WeakMap<ReviewThread, ReviewThread>();

/**
 * The since view's threads made on its compared patch set's head
 * (`earlierHead`) that the tracer hasn't placed yet (one just posted
 * there, CAR-233), or placed outside the comparison (its file isn't in
 * the full diff: a gone file's, CAR-256; still listed under "Not in this
 * comparison"): RIGHT line threads, as made on the viewed head (their
 * anchor keeps their commit). placeThreads' `earlierPending` puts each on
 * the removed row of its line, if it has one; none goes anywhere else.
 */
export function earlierPending(
	threads: readonly ReviewThread[],
	snapshotHead: string,
	placements: Placements | null,
	earlierHead: string | undefined,
	/** Threads the reviewer moved (CAR-139): their move decides, never their own line. */
	moved?: ReadonlyMap<string, unknown> | null,
): ReviewThread[] {
	if (earlierHead === undefined || earlierHead === snapshotHead) return [];
	return threads.flatMap((t) => {
		if (
			t.commit !== earlierHead ||
			t.subject !== "line" ||
			t.anchor?.side !== "RIGHT" ||
			t.anchor.startSide !== "RIGHT" ||
			!earlierUnplaced(t, placements, moved)
		) {
			return [];
		}
		let copy = earlierCopies.get(t);
		if (copy?.commit !== snapshotHead) {
			// Shown on the viewed head, made on the earlier one (madeOnHead).
			copy = { ...t, madeOn: t.madeOn ?? t.commit, commit: snapshotHead };
			earlierCopies.set(t, copy);
		}
		return [copy];
	});
}

/**
 * Whether a thread made on the compared patch set's head waits for its
 * removed (or kept) row there (earlierPending): no placement yet, or one
 * outside the comparison by its own path (a gone file's, CAR-256); never
 * one the reviewer moved, whose move decides where it goes.
 */
export function earlierUnplaced(
	t: { id?: string; path: string },
	placements: Placements | null,
	moved?: ReadonlyMap<string, unknown> | null,
	/**
	 * Unplaced in its own file too: an agent thread's placeable loses its
	 * lines there (tracedAgentPlaceables), so it waits here rather than in
	 * placeThreads' own unplaced path, which a review thread takes.
	 */
	unplaced = false,
): boolean {
	if (t.id === undefined) return false;
	if (moved?.has(t.id)) return false;
	const placed = placements?.get(t.id);
	return (
		placed === undefined ||
		((placed.kind === "outside" || (unplaced && placed.kind === "unplaced")) &&
			placed.path === t.path)
	);
}

/** Every thread Files changed shows in the viewed snapshot's files (shownThread). */
export function shownThreads(
	threads: readonly ReviewThread[],
	snapshotHead: string,
	placements: Placements | null,
	moved?: ReadonlyMap<string, unknown> | null,
): ReviewThread[] {
	return threads.flatMap((t) => {
		const shown = shownThread(t, snapshotHead, placements, moved);
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
 * The since view's row for a LEFT line GitHub names (a base line on the
 * head): through the full diff's line clusters (base → head), the head
 * line it became, as the full diff shows it; only when the full diff
 * deleted it, the removed row the since view shows it on (its `baseNo`,
 * keyed by its own old number there); null when neither. Never a removed
 * row for a base line the full diff keeps (a twin git aligns otherwise in
 * the interdiff): both views put a thread on the same line.
 */
export type SinceLeft = (n: number) => { side: DiffSide; line: number } | null;

/** The since view's SinceLeft, from the full diff's clusters and its hunks' removed rows. */
export function sinceLeft(
	clusters: readonly Pick<
		Cluster,
		"kind" | "oldStart" | "oldCount" | "newStart" | "newCount"
	>[],
	hunks: readonly DisplayHunk[] | null | undefined,
): SinceLeft {
	const full = createLineMapper(clusters.filter((c) => c.kind === "lines"));
	const removed = new Map<number, number>();
	for (const h of hunks ?? []) {
		for (const l of h.lines) {
			if (typeof l.baseNo === "number" && l.oldNo !== undefined) {
				removed.set(l.baseNo, l.oldNo);
			}
		}
	}
	return (n) => {
		const line = full.oldToNew(n);
		if (line !== null) return { side: "RIGHT", line };
		const old = removed.get(n);
		return old === undefined ? null : { side: "LEFT", line: old };
	};
}

/**
 * The since view's lines only the compared patch set had, on its commit
 * (CAR-233): its head, and the since view's removed row (its own old
 * number) of that commit's RIGHT line `n`, or null.
 */
export interface SinceEarlier {
	head: string;
	row: (n: number) => number | null;
}

/** The since view's SinceEarlier, from its hunks' removed rows (`psNo`) and a gone file's kept ones (`psKept`). */
export function sinceEarlier(
	head: string,
	hunks: readonly DisplayHunk[] | null | undefined,
): SinceEarlier {
	const rows = new Map<number, number>();
	for (const h of hunks ?? []) {
		for (const l of h.lines) {
			if (l.oldNo === undefined) continue;
			// A removed line only it had, or (a gone file's) a line it left
			// alone (CAR-256).
			const ps = l.psNo ?? l.psKept;
			if (ps !== undefined) rows.set(ps, l.oldNo);
		}
	}
	return { head, row: (n) => rows.get(n) ?? null };
}

/**
 * A span as GitHub names it (LEFT in the base), on the since view's rows
 * through `left` (SinceLeft); null when its end line has no row there. A
 * start line with none starts the range at its end. Without `left` (any
 * other view), the span as it is. A span on the compared patch set's
 * commit (`earlier`, CAR-233) is its RIGHT lines there, on the removed
 * rows that show them (`early`); none without them.
 */
export function onSinceRows<A extends SpanRange & { earlier?: boolean }>(
	span: A,
	left: SinceLeft | undefined,
	early?: SinceEarlier,
): A | null {
	if (span.earlier) {
		if (!left || !early) return null;
		const end = span.side === "RIGHT" ? early.row(span.line) : null;
		if (end === null) return null;
		const start = span.startSide === "RIGHT" ? early.row(span.startLine) : null;
		return {
			...span,
			side: "LEFT",
			line: end,
			startSide: "LEFT",
			startLine: start === null || start > end ? end : start,
		};
	}
	if (!left) return span;
	const at = (side: DiffSide, line: number) =>
		side === "LEFT" ? left(line) : { side, line };
	const end = at(span.side, span.line);
	if (end === null) return null;
	const start = at(span.startSide, span.startLine);
	const from =
		start === null || (start.side === end.side && start.line > end.line)
			? end
			: start;
	return {
		...span,
		side: end.side,
		line: end.line,
		startSide: from.side,
		startLine: from.line,
	};
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
	/**
	 * The since view: its old side is the compared patch set's, not the
	 * base a LEFT anchor (or span) counts in. Where base line `n` shows
	 * there (SinceLeft): its removed row, else the head line it became;
	 * one with neither goes to the header, never onto a row that merely
	 * shares its number.
	 */
	sinceLeft?: SinceLeft;
	/**
	 * The since view's lines only the compared patch set had (CAR-233):
	 * spans marked `earlier`, and threads made on that patch set's head on
	 * such a line (the tracer can't place them in the head), go on the
	 * removed rows that show them.
	 */
	sinceEarlier?: SinceEarlier;
	/**
	 * The since view: threads made on its compared patch set's head that
	 * the tracer hasn't placed (no placement yet), as made on the viewed
	 * head (their anchor keeps their commit). Each goes on the removed row
	 * of its RIGHT line, when it has one; else it isn't shown here.
	 */
	earlierPending?: readonly T[];
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
		waiting: [],
	};
	const mine = fileThreads(args.threads, args.path, args.snapshotHead);
	const spans = args.spans ?? [];
	if (
		mine.length === 0 &&
		spans.length === 0 &&
		(args.earlierPending ?? []).length === 0
	) {
		return placement;
	}
	const { hunks } = args;
	const rows = hunks ? shownRows(hunks.hunks, args.loadedContext) : [];
	const rowAt = new Map<LineKey, number>();
	rows.forEach((row, i) => {
		for (const key of keysOf(row)) rowAt.set(key, i);
	});
	const gaps = hunks
		? fileGaps(hunks.hunks, hunks.newLineCount, hunks.wholeGap)
		: [];
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
		spans.forEach((asked, i) => {
			const span = onSinceRows(asked, args.sinceLeft, args.sinceEarlier);
			if (!span) return;
			const endRow = rowAt.get(`${span.side}:${span.line}`);
			if (endRow === undefined) return;
			paint(span, endRow);
			placement.spansShown.add(i);
		});
	}

	/**
	 * Where a RIGHT thread made on the since view's compared patch set's
	 * head goes (CAR-233): the removed row that shows its line, or null
	 * (no such row: it goes as any other thread would).
	 */
	const earlierRow = (t: T) => {
		const early = args.sinceEarlier;
		const made = t.anchor as (SpanRange & { commit?: string }) | null;
		if (!early || !hunks || args.noLines) return null;
		if (made?.commit !== early.head || made.side !== "RIGHT") return null;
		if (made.startSide !== "RIGHT") return null;
		const range = onSinceRows(
			{ ...made, earlier: true },
			args.sinceLeft,
			early,
		);
		if (!range) return null;
		const key: LineKey = `${range.side}:${range.line}`;
		const row = rowAt.get(key);
		return row === undefined ? null : { key, row, range };
	};
	// Threads made on the compared patch set's head that the tracer hasn't
	// placed yet (one just posted there): on their removed rows when they
	// have one; else not shown here until placed, as before (never as
	// unplaced while that is pending).
	// Those that landed on a row: not listed with a fate as well.
	const landed = new Set<string>();
	for (const t of args.earlierPending ?? []) {
		if (t.path !== args.path) continue;
		const at = earlierRow(t);
		if (!at) continue;
		push(placement.end, at.key, t);
		paint(at.range, at.row);
		if (t.id !== undefined) landed.add(t.id);
	}
	for (const t of mine) {
		const traced = t.id === undefined ? undefined : args.placements?.get(t.id);
		if (traced?.kind === "pending") {
			placement.waiting.push(t);
			continue;
		}
		if (traced?.kind === "unplaced") {
			if (t.id !== undefined && landed.has(t.id)) continue;
			// Made on the compared patch set's head on a line only it had
			// (CAR-233): on the since view's removed row that shows it.
			const at = earlierRow(t);
			if (at) {
				push(placement.end, at.key, t);
				paint(at.range, at.row);
				continue;
			}
			placement.fates.push({ thread: t, placement: traced });
			continue;
		}
		const anchor = t.anchor && onSinceRows(t.anchor, args.sinceLeft);
		if (anchor === null && t.anchor) {
			// A LEFT line the full diff deleted that the since view doesn't
			// show: no row of it is that line. Which removed rows are base
			// lines is known once the hunks are in: till then it waits, as
			// any line thread does.
			if (args.noLines) {
				placement.header.push({ thread: t, reason: "unplaced" });
			} else if (hunks) {
				placement.header.push({
					thread: t,
					reason: "unplaced",
					// sinceLeft is set: only it gives a null anchor.
					notHere: notHereOf(hunks, t.anchor.line, args.sinceLeft as SinceLeft),
				});
			}
			continue;
		}
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
