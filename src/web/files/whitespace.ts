import { lineRuns } from "../../shared/pieces";
import type { DiffLine } from "../../shared/types";
import {
	matchSides,
	PAIR_CAP,
	type Side,
	whitespaceKey,
} from "../../shared/whitespace";
import { orderRun, type Partners } from "./pairOrder";
import { hunkPairs, type LinePair } from "./wordBlocks";

/**
 * "Ignore whitespace" (Settings): the view matches a hunk's removed and
 * added lines with whitespace-equal lines on the other side, so they read
 * as quiet rows. A view only: nothing here changes clusters, keys, counts
 * or review state, and every removed and added line of the hunk is in the
 * rows exactly once (whitespace.test.ts checks that for any input). The
 * server already cuts each git hunk's whitespace-only runs into clusters of
 * their own (src/shared/whitespace.ts splitHunk); the matching here is over
 * the whole display hunk, context included, so a line's twin may also be a
 * context line or sit in another cluster (a one-sided `~` row).
 */

export {
	matchSides,
	PAIR_CAP,
	type Side,
	stripWhitespace,
	whitespaceEqual,
} from "../../shared/whitespace";

/**
 * What a line compares by (whitespaceKey): its text without whitespace,
 * and whether git's "No newline at end of file" follows it.
 */
const keyOf = (line: DiffLine): string =>
	whitespaceKey(line.text, line.noNewline === true);

/** Two lines a pair may join: whitespace-equal, with the same final newline. */
export const linesWhitespaceEqual = (del: DiffLine, add: DiffLine): boolean =>
	keyOf(del) === keyOf(add);

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

/** Splits a hunk into runs of context lines and runs of one cluster's lines. */
export function runs(lines: DiffLine[]): { key?: string; lines: DiffLine[] }[] {
	// A changed run without a key stays apart from context (pieces.ts).
	return lineRuns(lines).map(({ key, lines }) =>
		key === undefined ? { lines } : { key, lines },
	);
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

/** What the view shows of a hunk: its runs, and the pairs behind the marks and the order. */
export interface HunkView {
	runs: ViewRun[];
	/**
	 * Every run's rows one after the other in git's order: pairRun's with
	 * Ignore whitespace on, before orderRun moves a pair together.
	 */
	gitRows: DiffRow[];
	/** hunkPairs over `gitRows`. */
	pairs: LinePair[];
	partners: Partners;
}

const viewsByHunk = new WeakMap<DiffLine[], [HunkView?, HunkView?]>();

/**
 * A hunk as the view shows it (HunkRows, Find in PR, the fixture test, so
 * they can't drift), once per hunk's lines and "Ignore whitespace" setting
 * (the hunks query's arrays: callers must never change `lines` in place).
 * With the setting on, a cluster's run is paired (pairRun, by the whole
 * hunk's twins); otherwise, and for context runs, every line is a row as it
 * is. `pairs` come from the rows in git's order (a stretch ends at a
 * context or `~` row); then each cluster run's rows are put in unified B's
 * order (orderRun): a pair reads together.
 */
export function hunkView(
	lines: DiffLine[],
	ignoreWhitespace: boolean,
): HunkView {
	const slot = ignoreWhitespace ? 1 : 0;
	const cached = viewsByHunk.get(lines);
	if (cached?.[slot]) return cached[slot];
	const twins = ignoreWhitespace ? hunkTwins(lines) : null;
	const git = runs(lines).map((run) => ({
		...run,
		rows:
			twins && run.key !== undefined
				? pairRun(run.lines, twins)
				: run.lines.map((line): DiffRow => ({ kind: "line", line })),
	}));
	const gitRows = git.flatMap((run) => run.rows);
	const pairs = hunkPairs(gitRows);
	const partners = new Map<DiffLine, DiffLine>();
	for (const [del, add] of pairs) {
		partners.set(del, add);
		partners.set(add, del);
	}
	const view: HunkView = {
		runs: git.map((run) =>
			run.key === undefined
				? run
				: { ...run, rows: orderRun(run.rows, partners) },
		),
		gitRows,
		pairs,
		partners,
	};
	const entry = cached ?? [];
	entry[slot] = view;
	viewsByHunk.set(lines, entry);
	return view;
}
