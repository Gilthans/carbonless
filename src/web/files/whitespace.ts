import { lineRuns } from "../../shared/pieces";
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
 * A hunk (else each of its cluster runs) with more old-side or more
 * new-side lines than this isn't matched (the matching is O(n·m)).
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
	// A changed run without a key stays apart from context (pieces.ts).
	return lineRuns(lines).map(({ key, lines }) =>
		key === undefined ? { lines } : { key, lines },
	);
}

/** One side of a line as the matching sees it. */
export interface Side {
	key: string;
	context: boolean;
}

/**
 * The heaviest common subsequence of `a` and `b` under key equality, as
 * index pairs in order. A context side weighs P = n + m + 1 (more than
 * every change-to-change match together could), a change side nothing but
 * a floor of 1: context↔context = 2P, context side↔change = P,
 * change↔change = 1. Matching every context line to itself is always
 * possible, so any optimum matches every context side, to itself or to
 * changes: no unmatched line is ever a context side, which is what makes
 * the rows a sound `-w` edit script (a block moved across an unchanged
 * line is never "whitespace only").
 *
 * Fast path (`fast`, on but in its test): when both sides are the same
 * keys line for line, with context sides at the same places (a wholesale
 * re-indent), the identity is the optimum (each context side matched to
 * itself, the most changes matched) and the DP's traceback takes exactly
 * that diagonal: O(n), not O(n·m). whitespace.test.ts checks it gives what
 * the DP gives.
 */
export function matchSides(
	a: Side[],
	b: Side[],
	fast = true,
): [number, number][] {
	const n = a.length;
	const m = b.length;
	if (
		fast &&
		n === m &&
		a.every(
			(s, i) =>
				s.key === (b[i] as Side).key && s.context === (b[i] as Side).context,
		)
	)
		return a.map((_, i) => [i, i]);
	const w = m + 1;
	const P = n + m + 1;
	const weight = (i: number, j: number) =>
		((a[i] as Side).context ? P : 0) + ((b[j] as Side).context ? P : 0) || 1;
	// best[i * w + j]: the best weight over a[i..] and b[j..]; up to
	// 2P × PAIR_CAP ≈ 1.6e7, so 32 bits (16 MB at the cap, once per hunk).
	const best = new Uint32Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			const skip = Math.max(
				best[(i + 1) * w + j] as number,
				best[i * w + j + 1] as number,
			);
			const take =
				(a[i] as Side).key === (b[j] as Side).key
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
			(a[i] as Side).key === (b[j] as Side).key &&
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
 * The rows are sound: dropping the lines left unmatched (shown as add/del)
 * from both sides leaves whitespace-equal sequences. The weights (`matchSides`)
 * see to it that every context side is matched, to its own other side or
 * to a change (two context lines of one key may also match each other
 * across, with their other sides taken by changes: the same thing along a
 * chain), so the matched lines on each side are one sequence of equal
 * keys. Should a context side ever be left unmatched, nothing pairs: all
 * plain rows are always sound. Empty too when no change can match at all
 * (then there is no O(n·m) work). A hunk with a side over PAIR_CAP is
 * matched run by run instead (a big re-indented file keeps its rows); a
 * run over the cap on its own isn't matched.
 */
export function matchHunk(lines: DiffLine[]): ReadonlyMap<DiffLine, DiffLine> {
	const twins = new Map<DiffLine, DiffLine>();
	const old = lines.filter((l) => l.kind !== "add");
	const young = lines.filter((l) => l.kind !== "del");
	if (old.length > PAIR_CAP || young.length > PAIR_CAP) {
		// A whole hunk, not one run already: match its cluster runs apart.
		if (runs(lines).length > 1) {
			for (const run of runs(lines)) {
				if (run.key === undefined) continue;
				for (const [line, twin] of matchHunk(run.lines)) twins.set(line, twin);
			}
		}
		return twins;
	}
	const side = (l: DiffLine): Side => ({
		key: keyOf(l),
		context: l.kind === "context",
	});
	const a = old.map(side);
	const b = young.map(side);
	const oldKeys = new Set(a.map((s) => s.key));
	const newKeys = new Set(b.map((s) => s.key));
	const can =
		old.some((l, i) => l.kind === "del" && newKeys.has((a[i] as Side).key)) ||
		young.some((l, j) => l.kind === "add" && oldKeys.has((b[j] as Side).key));
	if (!can) return twins;
	let contextSides = 0;
	for (const [i, j] of matchSides(a, b)) {
		const o = old[i] as DiffLine;
		const n = young[j] as DiffLine;
		if (o.kind === "context") contextSides++;
		if (n.kind === "context") contextSides++;
		if (o.kind === "del") twins.set(o, n);
		if (n.kind === "add") twins.set(n, o);
	}
	const contexts = lines.filter((l) => l.kind === "context").length;
	if (contextSides !== 2 * contexts) twins.clear();
	return twins;
}

/**
 * A cluster run's lines (its removed lines, then its added ones) as rows,
 * given the hunk's twins: a removed line and its twin added line of the
 * same run become one two-sided row; a line whose twin is elsewhere (a
 * context line, another run) a one-sided row; the rest stay as they are.
 * In diff order: the unpaired removed lines, the unpaired added lines, then
 * the pair, and so on. The server lays a cluster out as its removed lines
 * then its added ones (src/server/diff/hunks.ts); a run of any other shape
 * stays as it is, plain (its lines' twins elsewhere would still show as
 * `~`, which no hunk from the server can bring about).
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

/**
 * matchHunk, once per hunk's lines (the hunks query's arrays: callers must
 * never change `lines` in place): the diff (HunkRows) and Find in PR (findInPr) share
 * one O(n·m) matching per hunk.
 */
const twinsByHunk = new WeakMap<DiffLine[], ReadonlyMap<DiffLine, DiffLine>>();
function hunkTwins(lines: DiffLine[]): ReadonlyMap<DiffLine, DiffLine> {
	let twins = twinsByHunk.get(lines);
	if (!twins) {
		twins = matchHunk(lines);
		twinsByHunk.set(lines, twins);
	}
	return twins;
}

/** A hunk's run and the rows the view shows for it. */
export interface ViewRun {
	key?: string;
	lines: DiffLine[];
	rows: DiffRow[];
}

/**
 * A hunk's runs and each run's rows as the view shows them (HunkRows, and
 * the word-marks fixture test, so the two can't drift): with "Ignore
 * whitespace" on, a cluster's run is paired (pairRun, by the whole hunk's
 * twins); otherwise, and for context runs, every line as it is.
 */
export function viewRuns(
	lines: DiffLine[],
	ignoreWhitespace: boolean,
): ViewRun[] {
	const twins = ignoreWhitespace ? hunkTwins(lines) : null;
	return runs(lines).map((run) => ({
		...run,
		rows:
			twins && run.key !== undefined
				? pairRun(run.lines, twins)
				: run.lines.map((line): DiffRow => ({ kind: "line", line })),
	}));
}

/** A whole hunk's rows, run by run (what the view shows, flattened). */
export function pairHunk(lines: DiffLine[]): DiffRow[] {
	return viewRuns(lines, true).flatMap((run) => run.rows);
}
