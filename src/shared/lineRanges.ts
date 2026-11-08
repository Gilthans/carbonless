/**
 * Sets of a cluster's lines, as half-open ranges `[start, end)` over its
 * line index: its removed lines first (0 … removed.length - 1), then its
 * added lines (removed.length … lines - 1), GitHub's order within a
 * cluster. Normalized: sorted, disjoint, not touching, none empty. A mark
 * on part of a cluster (`lines-reviewed`, ClusterView.reviewedLines) is one.
 */
export type LineRanges = [number, number][];

/** At most this many ranges in one set (a write's limit; a read keeps fewer). */
export const MAX_RANGES = 1000;

const isIndex = (n: unknown): n is number =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * `value` as ranges when it is a list of at most MAX_RANGES pairs of
 * non-negative integers with start < end (in any order, overlapping or
 * not), normalized; else null. Untrusted input (a request, an event).
 */
export function parseRanges(value: unknown): LineRanges | null {
	if (!Array.isArray(value) || value.length > MAX_RANGES) return null;
	const out: LineRanges = [];
	for (const r of value) {
		if (!Array.isArray(r) || r.length !== 2) return null;
		const [start, end] = r as unknown[];
		if (!isIndex(start) || !isIndex(end) || start >= end) return null;
		out.push([start, end]);
	}
	return normalize(out);
}

/** Sorted, merged (touching ranges too), empty ones dropped. */
export function normalize(ranges: readonly (readonly [number, number])[]) {
	const sorted = ranges
		.filter(([s, e]) => s < e)
		.map(([s, e]): [number, number] => [s, e])
		.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const out: LineRanges = [];
	for (const [s, e] of sorted) {
		const last = out.at(-1);
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else out.push([s, e]);
	}
	return out;
}

export const union = (a: LineRanges, b: LineRanges): LineRanges =>
	normalize([...a, ...b]);

/** The lines of `a` not in `b`. */
export function subtract(a: LineRanges, b: LineRanges): LineRanges {
	const out: LineRanges = [];
	for (const [s0, e] of normalize(a)) {
		let s = s0;
		for (const [bs, be] of normalize(b)) {
			if (be <= s || bs >= e) continue;
			if (bs > s) out.push([s, bs]);
			s = Math.max(s, be);
			if (s >= e) break;
		}
		if (s < e) out.push([s, e]);
	}
	return out;
}

/** How many lines. */
export const size = (ranges: LineRanges): number =>
	ranges.reduce((n, [s, e]) => n + (e - s), 0);

/** Every line of `b` is in `a`. */
export const contains = (a: LineRanges, b: LineRanges): boolean =>
	subtract(b, a).length === 0;

export const has = (ranges: LineRanges, index: number): boolean =>
	ranges.some(([s, e]) => s <= index && index < e);

/** All `n` lines: `[[0, n)]`, or none for 0. */
export const all = (n: number): LineRanges => (n > 0 ? [[0, n]] : []);

/** The ranges cover every one of `n` lines. */
export const covers = (ranges: LineRanges, n: number): boolean =>
	n > 0 && contains(ranges, all(n));

/** Every range lies within `n` lines. */
export const within = (ranges: LineRanges, n: number): boolean =>
	ranges.every(([s, e]) => s >= 0 && s < e && e <= n);

/** Ranges from a set of line indexes. */
export function fromIndexes(indexes: Iterable<number>): LineRanges {
	return normalize([...indexes].map((i): [number, number] => [i, i + 1]));
}
