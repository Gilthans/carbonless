import type { DiffLine } from "../../shared/types";

/**
 * "Ignore whitespace" (Settings): the view matches a hunk's removed and
 * added lines with whitespace-equal lines on the other side, so they read
 * as quiet rows. A view only: nothing here changes clusters, keys, counts
 * or review state, and every removed and added line of the hunk is in the
 * rows exactly once (whitespace.test.ts checks that for any input).
 */

/** ASCII whitespace, as git's `-w` ignores it. Unicode blanks are content. */
const WHITESPACE = /[ \t\r\v\f]/g;

export const stripWhitespace = (text: string): string =>
	text.replace(WHITESPACE, "");

/** Byte-identical after removing every ASCII whitespace character. */
export const whitespaceEqual = (a: string, b: string): boolean =>
	stripWhitespace(a) === stripWhitespace(b);

/**
 * What a line compares by: its text without whitespace, and whether git's
 * "No newline at end of file" follows it (`-w` doesn't ignore that: a
 * final newline lost or gained is a real change).
 */
const keyOf = (line: DiffLine): string =>
	`${stripWhitespace(line.text)}${line.noNewline ? "\0" : ""}`;

/** Two lines a pair may join: whitespace-equal, with the same final newline. */
export const linesWhitespaceEqual = (del: DiffLine, add: DiffLine): boolean =>
	keyOf(del) === keyOf(add);

/**
 * A hunk with more old-side or more new-side lines than this isn't matched
 * (the matching is O(n·m)).
 */
export const PAIR_CAP = 2000;

/**
 * A row of a cluster's run: a line as it is (a context line, or a change),
 * or a whitespace-only row. The whitespace-only row has both sides when a
 * removed line pairs with an added line of the same run; one side when the
 * line's twin is a context line or sits in another run (the twin stays
 * where it is).
 */
export type DiffRow =
	| { kind: "line"; line: DiffLine }
	| { kind: "ws"; del: DiffLine; add?: DiffLine }
	| { kind: "ws"; del?: DiffLine; add: DiffLine };

/** Every row is whitespace-only: the run changes nothing but whitespace. */
export const whitespaceOnly = (rows: DiffRow[]): boolean =>
	rows.length > 0 && rows.every((r) => r.kind === "ws");

/** Splits a hunk into runs of context lines and runs of one cluster's lines. */
export function runs(lines: DiffLine[]): { key?: string; lines: DiffLine[] }[] {
	const result: { key?: string; lines: DiffLine[] }[] = [];
	for (const line of lines) {
		const last = result[result.length - 1];
		if (last && last.key === line.clusterKey) last.lines.push(line);
		else result.push({ key: line.clusterKey, lines: [line] });
	}
	return result;
}

/**
 * The heaviest common subsequence of `a` and `b` under key equality, as
 * index pairs in order. A match of two context lines weighs 2, any other
 * 1: context lines stay matched to each other, so the line that really
 * moved or was added is the one left out, as `git diff -w` shows it.
 */
function match(
	a: { key: string; context: boolean }[],
	b: { key: string; context: boolean }[],
): [number, number][] {
	const n = a.length;
	const m = b.length;
	const w = m + 1;
	const weight = (i: number, j: number) =>
		(a[i] as { context: boolean }).context &&
		(b[j] as { context: boolean }).context
			? 2
			: 1;
	// best[i * w + j]: the best weight over a[i..] and b[j..] (≤ 2 × PAIR_CAP).
	const best = new Uint16Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			const skip = Math.max(
				best[(i + 1) * w + j] as number,
				best[i * w + j + 1] as number,
			);
			const take =
				(a[i] as { key: string }).key === (b[j] as { key: string }).key
					? weight(i, j) + (best[(i + 1) * w + j + 1] as number)
					: 0;
			best[i * w + j] = Math.max(skip, take);
		}
	}
	const out: [number, number][] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (
			(a[i] as { key: string }).key === (b[j] as { key: string }).key &&
			best[i * w + j] === weight(i, j) + (best[(i + 1) * w + j + 1] as number)
		) {
			out.push([i, j]);
			i++;
			j++;
		} else if (
			(best[(i + 1) * w + j] as number) >= (best[i * w + j + 1] as number)
		) {
			i++;
		} else {
			j++;
		}
	}
	return out;
}

/**
 * Each removed or added line of a hunk that has a whitespace-equal twin on
 * the other side, by the matching over the hunk's whole old side (context
 * and removed lines) and new side (context and added lines): the twin is a
 * line added or removed anywhere in the hunk, or a context line.
 *
 * A context line is a row that stays unchanged, so the matching may only
 * use it whole: its old side taken by an added line and its new side by a
 * removed one (a re-indent whose `}` git aligned with another `}`). A
 * change matched to one side of a context line alone would leave the other
 * side an insertion or deletion no row shows (a wrapped block's new `}`),
 * so it stays an ordinary change. Empty when a side is over PAIR_CAP, or
 * when no change can match at all (then there is no O(n·m) work).
 */
export function matchHunk(lines: DiffLine[]): ReadonlyMap<DiffLine, DiffLine> {
	const twins = new Map<DiffLine, DiffLine>();
	const old = lines.filter((l) => l.kind !== "add");
	const young = lines.filter((l) => l.kind !== "del");
	if (old.length > PAIR_CAP || young.length > PAIR_CAP) return twins;
	const side = (l: DiffLine) => ({
		key: keyOf(l),
		context: l.kind === "context",
	});
	const a = old.map(side);
	const b = young.map(side);
	const oldKeys = new Set(a.map((s) => s.key));
	const newKeys = new Set(b.map((s) => s.key));
	const can =
		old.some(
			(l, i) => l.kind === "del" && newKeys.has((a[i] as { key: string }).key),
		) ||
		young.some(
			(l, j) => l.kind === "add" && oldKeys.has((b[j] as { key: string }).key),
		);
	if (!can) return twins;
	// A context line's sides, when a change took them.
	const oldSideTakenBy = new Map<DiffLine, DiffLine>();
	const newSideTakenBy = new Map<DiffLine, DiffLine>();
	for (const [i, j] of match(a, b)) {
		const o = old[i] as DiffLine;
		const n = young[j] as DiffLine;
		if (o.kind === "del" && n.kind === "add") {
			twins.set(o, n);
			twins.set(n, o);
		} else if (o.kind === "context" && n.kind === "add") {
			oldSideTakenBy.set(o, n);
		} else if (o.kind === "del" && n.kind === "context") {
			newSideTakenBy.set(n, o);
		}
		// Two context lines matched: a shift that means nothing to any row.
	}
	for (const [context, add] of oldSideTakenBy) {
		const del = newSideTakenBy.get(context);
		if (!del) continue;
		twins.set(add, context);
		twins.set(del, context);
	}
	return twins;
}

/**
 * A cluster run's lines (its removed lines, then its added ones) as rows,
 * given the hunk's twins: a removed line and its twin added line of the
 * same run become one two-sided row; a line whose twin is elsewhere (a
 * context line, another run) a one-sided row; the rest stay as they are.
 * In diff order: the unpaired removed lines, the unpaired added lines, then
 * the pair, and so on. A run of any other shape stays as it is.
 */
export function pairRun(
	run: DiffLine[],
	twins: ReadonlyMap<DiffLine, DiffLine>,
): DiffRow[] {
	const plain = (): DiffRow[] => run.map((line) => ({ kind: "line", line }));
	const dels: DiffLine[] = [];
	const adds: DiffLine[] = [];
	for (const line of run) {
		if (line.kind === "del" && adds.length === 0) dels.push(line);
		else if (line.kind === "add") adds.push(line);
		else return plain();
	}
	const addAt = new Map(adds.map((l, i) => [l, i]));
	const rows: DiffRow[] = [];
	let d = 0;
	let a = 0;
	const one = (line: DiffLine): DiffRow =>
		!twins.has(line)
			? { kind: "line", line }
			: line.kind === "del"
				? { kind: "ws", del: line }
				: { kind: "ws", add: line };
	const upTo = (toD: number, toA: number) => {
		for (; d < toD; d++) rows.push(one(dels[d] as DiffLine));
		for (; a < toA; a++) rows.push(one(adds[a] as DiffLine));
	};
	for (let i = 0; i < dels.length; i++) {
		const del = dels[i] as DiffLine;
		const j = addAt.get(twins.get(del) as DiffLine);
		// Twins come in order; one already passed (never, but never twice).
		if (j === undefined || j < a) continue;
		upTo(i, j);
		rows.push({ kind: "ws", del, add: adds[j] as DiffLine });
		d = i + 1;
		a = j + 1;
	}
	upTo(dels.length, adds.length);
	return rows;
}

/** A whole hunk's rows, run by run (what the view shows, flattened). */
export function pairHunk(lines: DiffLine[]): DiffRow[] {
	const twins = matchHunk(lines);
	return runs(lines).flatMap((run) =>
		run.key === undefined
			? run.lines.map((line): DiffRow => ({ kind: "line", line }))
			: pairRun(run.lines, twins),
	);
}
