import type { HunkItems, LineGroup, LinePair } from "../../shared/hunkPairs";
import type { DiffLine } from "../../shared/types";
import type { DiffRow } from "./whitespace";

/**
 * Every line of a pair or a group (hunkItems, CAR-130) → its item: a pair's
 * two lines, a group's one line and every line of its run.
 */
export type Partners = ReadonlyMap<DiffLine, LinePair | LineGroup>;

const isGroup = (x: LinePair | LineGroup): x is LineGroup => !Array.isArray(x);

/** The partners of a hunk's items. */
export function partnersOf(items: HunkItems): Partners {
	const out = new Map<DiffLine, LinePair | LineGroup>();
	for (const pair of items.pairs) {
		out.set(pair[0], pair);
		out.set(pair[1], pair);
	}
	for (const group of items.groups) {
		out.set(group.one, group);
		for (const line of group.run) out.set(line, group);
	}
	return out;
}

/**
 * An item's place in a stretch: removed lines `d0..d1` and added lines
 * `a0..a1` (inclusive). A pair is one of each; a split one removed line
 * and its run; a join its run and one added line.
 */
export type Span = {
	d0: number;
	d1: number;
	a0: number;
	a1: number;
	group: boolean;
};

/**
 * The items over a stretch's removed lines `dels` and added lines `adds`,
 * in the order of their removed lines: each whose every line is in the
 * stretch, a group's run in a row, in order. An item with a line elsewhere
 * (another stretch, another run) counts as none. Spans may cross (callers
 * decide).
 */
export function spansOf(
	dels: readonly DiffLine[],
	adds: readonly DiffLine[],
	partners: Partners,
): Span[] {
	const addAt = new Map(adds.map((l, j) => [l, j]));
	const out: Span[] = [];
	dels.forEach((d, i) => {
		const item = partners.get(d);
		if (item === undefined) return;
		if (!isGroup(item)) {
			const j = item[0] === d ? addAt.get(item[1]) : undefined;
			if (j !== undefined)
				out.push({ d0: i, d1: i, a0: j, a1: j, group: false });
			return;
		}
		const { one, run } = item;
		if (run.length === 0) return;
		if (one === d) {
			// A split: the run is added lines in a row.
			const j = addAt.get(run[0] as DiffLine);
			if (j === undefined || !run.every((l, k) => adds[j + k] === l)) return;
			out.push({ d0: i, d1: i, a0: j, a1: j + run.length - 1, group: true });
		} else if (run[0] === d) {
			// A join: the run is removed lines in a row, from this one.
			const j = addAt.get(one);
			if (j === undefined || !run.every((l, k) => dels[i + k] === l)) return;
			out.push({ d0: i, d1: i + run.length - 1, a0: j, a1: j, group: true });
		}
	});
	return out;
}

const isPlain = (row: DiffRow): row is DiffRow & { kind: "line" } =>
	row.kind === "line" && row.line.kind !== "context";

/**
 * One stretch of plain removed and added lines (the server lays it out as
 * its removed lines, then its added ones) in unified B's order: the gap's
 * removed lines, the gap's added lines, then a run of consecutive pairs as
 * its removed lines and its added lines; and again. A group (CAR-130) is a
 * block of its own, never merged with a neighbouring pair: a split reads
 * −one, +run…, a join −run…, +one. An item with a line outside the
 * stretch counts as none. A stretch of another shape, or items that cross,
 * stay as they are.
 */
function orderStretch(rows: DiffRow[], partners: Partners): DiffRow[] {
	const dels: DiffRow[] = [];
	const adds: DiffRow[] = [];
	for (const row of rows) {
		const line = (row as DiffRow & { kind: "line" }).line;
		if (line.kind === "del" && adds.length === 0) dels.push(row);
		else if (line.kind === "add") adds.push(row);
		else return rows;
	}
	const lineOf = (r: DiffRow) => (r as DiffRow & { kind: "line" }).line;
	const at = spansOf(dels.map(lineOf), adds.map(lineOf), partners);
	if (at.length === 0) return rows;
	// Items that cross or share a line (never from hunkItems) leave the
	// stretch as it is: every line once, whatever the items say.
	for (let k = 1; k < at.length; k++)
		if (
			(at[k] as Span).a0 <= (at[k - 1] as Span).a1 ||
			(at[k] as Span).d0 <= (at[k - 1] as Span).d1
		)
			return rows;
	const out: DiffRow[] = [];
	let d = 0;
	let a = 0;
	for (let k = 0; k < at.length; ) {
		const { d0, a0, group } = at[k] as Span;
		let last = k;
		while (
			!group &&
			last + 1 < at.length &&
			!(at[last + 1] as Span).group &&
			(at[last + 1] as Span).d0 === (at[last] as Span).d1 + 1 &&
			(at[last + 1] as Span).a0 === (at[last] as Span).a1 + 1
		)
			last++;
		const { d1, a1 } = at[last] as Span;
		out.push(...dels.slice(d, d0), ...adds.slice(a, a0));
		out.push(...dels.slice(d0, d1 + 1), ...adds.slice(a0, a1 + 1));
		d = d1 + 1;
		a = a1 + 1;
		k = last + 1;
	}
	out.push(...dels.slice(d), ...adds.slice(a));
	return out;
}

/**
 * A cluster run's rows in unified B's order (spec: "Unified (B)"): within
 * each stretch of plain removed and added rows, a pair reads together.
 * Context and whitespace-only (`~`) rows end a stretch and stay at their
 * indices, so no line crosses one; so does a removed line after an added
 * one (hunkItems' stretches). A stretch without partners is unchanged.
 * A group's rows are adjacent (orderStretch).
 */
export function orderRun(
	rows: readonly DiffRow[],
	partners: Partners,
): DiffRow[] {
	const out: DiffRow[] = [];
	let stretch: DiffRow[] = [];
	const flush = () => {
		out.push(...(stretch.length > 0 ? orderStretch(stretch, partners) : []));
		stretch = [];
	};
	for (const row of rows) {
		if (isPlain(row)) {
			// A removed line after an added one starts a stretch, as in
			// hunkItems: a group's rows stay adjacent in a run of any shape.
			const last = stretch[stretch.length - 1] as
				| (DiffRow & { kind: "line" })
				| undefined;
			if (row.line.kind === "del" && last?.line.kind === "add") flush();
			stretch.push(row);
		} else {
			flush();
			out.push(row);
		}
	}
	flush();
	return out;
}
