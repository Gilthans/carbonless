import type { DiffLine } from "../src/shared/types";
import type { SideRow } from "../src/web/files/sideBySide";
import type { LinePair } from "../src/web/files/wordBlocks";

/**
 * The pure parts of scripts/pairing-compare.mjs: how one cluster looks today
 * (side by side by position, git's order in unified) and with step 2's pairs,
 * whether step 2 changed it, and the order of the page.
 */

/** A cluster's lines in git's order, as indexes: removed 0..n-1, added n.. */
export interface ClusterLayouts {
	/** Today's side-by-side rows (by position), as [del, add] line indexes. */
	today: [number | null, number | null][];
	/** Step 2's side-by-side rows. */
	step2: [number | null, number | null][];
	/** Today's unified order (git's), and step 2's (unified B). */
	todayUnified: number[];
	step2Unified: number[];
	/** Step 2's pairs as line indexes. */
	pairs: [number, number][];
	/** Today's pairs (step 1: only an equal cluster pairs i-th with i-th). */
	todayPairs: [number, number][];
}

/** Side-by-side rows as line indexes (a row's missing side is null). */
export function rowIndexes(
	rows: readonly SideRow[],
	at: ReadonlyMap<DiffLine, number>,
): [number | null, number | null][] {
	const out: [number | null, number | null][] = [];
	for (const row of rows) {
		if (row.kind !== "pair") continue;
		out.push([
			row.del ? (at.get(row.del) ?? null) : null,
			row.add ? (at.get(row.add) ?? null) : null,
		]);
	}
	return out;
}

/** Pairs of lines as index pairs; pairs with a line outside `at` are left out. */
export function pairIndexes(
	pairs: readonly LinePair[],
	at: ReadonlyMap<DiffLine, number>,
): [number, number][] {
	const out: [number, number][] = [];
	for (const [del, add] of pairs) {
		const d = at.get(del);
		const a = at.get(add);
		if (d !== undefined && a !== undefined) out.push([d, a]);
	}
	return out;
}

const same = (a: readonly unknown[], b: readonly unknown[]): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

/** Step 2 changed the cluster: its rows, its unified order or its pairs differ from today's. */
export function changedByStep2(l: ClusterLayouts): boolean {
	return (
		!same(l.today, l.step2) ||
		!same(l.todayUnified, l.step2Unified) ||
		!same(l.todayPairs, l.pairs)
	);
}

/** How far step 2 moved the pair that moved the farthest: the rows between where its two lines sat today. */
export function farthestMove(l: ClusterLayouts): number {
	const rowOf = new Map<number, number>();
	l.today.forEach(([d, a], i) => {
		if (d !== null) rowOf.set(d, i);
		if (a !== null) rowOf.set(a, i);
	});
	let far = 0;
	for (const [d, a] of l.pairs) {
		far = Math.max(far, Math.abs((rowOf.get(d) ?? 0) - (rowOf.get(a) ?? 0)));
	}
	return far;
}

/** What the page sorts a case by. */
export interface CaseRank {
	/** The lowest pair score in the cluster (Infinity when nothing paired). */
	minScore: number;
	/** farthestMove. */
	move: number;
	/** Removed plus added lines. */
	size: number;
}

/** Worst first: the lowest passing score, then the farthest move, then the biggest cluster. */
export function byWorst(a: CaseRank, b: CaseRank): number {
	return a.minScore - b.minScore || b.move - a.move || b.size - a.size;
}

/** Text as HTML: code from other people's repos reaches the page only through this. */
export function esc(s: string): string {
	return s.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] as string,
	);
}

/** A line's text, escaped, with its marked ranges (UTF-16 offsets, `to` exclusive) as <mark>. */
export function markup(
	text: string,
	marks: readonly (readonly [number, number])[] | undefined,
): string {
	let out = "";
	let at = 0;
	for (const [from, to] of marks ?? []) {
		out += `${esc(text.slice(at, from))}<mark>${esc(text.slice(from, to))}</mark>`;
		at = to;
	}
	return out + esc(text.slice(at));
}
