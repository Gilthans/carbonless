/**
 * Line numbers through one file's diff: old line to new line and back.
 *
 * Pure: hunks in, numbers out. A hunk is the four range fields of a -U0
 * hunk header (structurally `Pick<Cluster, "oldStart" | "oldCount" |
 * "newStart" | "newCount">`), in git's convention: a pure deletion has
 * `newCount: 0` with `newStart` = the new line after which it sat, a pure
 * addition `oldCount: 0` with `oldStart` = the old line after which it
 * sits (0 at the top of the file).
 *
 * Lines pair by position only: a line inside a removed range has no image,
 * whatever its text, and a line inside an added range has no source.
 */

export interface MapHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
}

export interface LineMapper {
	/** The new line old line `n` became; `null`: the diff removed it. */
	oldToNew(n: number): number | null;
	/** The old line new line `n` came from; `null`: the diff added it. */
	newToOld(n: number): number | null;
	/** The hunk whose old range contains `n` (the one removing it). */
	hunkRemovingOld(n: number): MapHunk | null;
	/** The hunk whose new range contains `n` (the one adding it). */
	hunkAddingNew(n: number): MapHunk | null;
}

/** One side of a hunk list: ranges on that side, with the shift after each. */
interface Side {
	/** Sorted by `start`. */
	hunks: MapHunk[];
	start: (h: MapHunk) => number;
	count: (h: MapHunk) => number;
	/** Net delta to add to a line after hunk i (inclusive), from this side to the other. */
	shiftAfter: number[];
}

function makeSide(
	hunks: MapHunk[],
	start: (h: MapHunk) => number,
	count: (h: MapHunk) => number,
	delta: (h: MapHunk) => number,
): Side {
	const sorted = [...hunks].sort(
		(a, b) => start(a) - start(b) || count(b) - count(a),
	);
	const shiftAfter: number[] = [];
	let shift = 0;
	for (const h of sorted) {
		shift += delta(h);
		shiftAfter.push(shift);
	}
	return { hunks: sorted, start, count, shiftAfter };
}

/**
 * The last line a hunk occupies on this side; for an empty range, the line
 * it sits after, so "before n" reads the same for both.
 */
function lastLine(side: Side, h: MapHunk): number {
	const count = side.count(h);
	return count > 0 ? side.start(h) + count - 1 : side.start(h);
}

/** Index of the last hunk whose range ends before line n, or -1. */
function lastBefore(side: Side, n: number): number {
	let lo = 0;
	let hi = side.hunks.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const h = side.hunks[mid] as MapHunk;
		if (lastLine(side, h) < n) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return found;
}

/** The hunk whose non-empty range on this side contains n, or null. */
function containing(side: Side, n: number): MapHunk | null {
	// The containing hunk, if any, is the first one not entirely before n.
	const h = side.hunks[lastBefore(side, n) + 1];
	if (!h) return null;
	const count = side.count(h);
	return count > 0 && n >= side.start(h) && n < side.start(h) + count
		? h
		: null;
}

function map(side: Side, n: number): number | null {
	if (containing(side, n)) return null;
	const i = lastBefore(side, n);
	return n + (i >= 0 ? (side.shiftAfter[i] as number) : 0);
}

export function createLineMapper(hunks: readonly MapHunk[]): LineMapper {
	const plain: MapHunk[] = hunks.map((h) => ({
		oldStart: h.oldStart,
		oldCount: h.oldCount,
		newStart: h.newStart,
		newCount: h.newCount,
	}));
	const old = makeSide(
		plain,
		(h) => h.oldStart,
		(h) => h.oldCount,
		(h) => h.newCount - h.oldCount,
	);
	const fresh = makeSide(
		plain,
		(h) => h.newStart,
		(h) => h.newCount,
		(h) => h.oldCount - h.newCount,
	);
	return {
		oldToNew: (n) => map(old, n),
		newToOld: (n) => map(fresh, n),
		hunkRemovingOld: (n) => containing(old, n),
		hunkAddingNew: (n) => containing(fresh, n),
	};
}

/** The mapper of an untouched file: every line is its own image. */
export const IDENTITY: LineMapper = createLineMapper([]);
