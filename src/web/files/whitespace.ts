import {
	type DiffRow,
	type HunkItems,
	hunkItems,
	type LinePair,
} from "../../shared/hunkPairs";
import { lineRuns } from "../../shared/pieces";
import type { DiffLine } from "../../shared/types";
import { matchDisplayHunk, whitespaceKey } from "../../shared/whitespace";
import { orderRun, type Partners, partnersOf } from "./pairOrder";

/**
 * "Ignore whitespace" (Settings): the view matches a hunk's removed and
 * added lines with whitespace-equal lines on the other side, so they read
 * as quiet rows. A view only: nothing here changes clusters, keys, counts
 * or review state, and every removed and added line of the hunk is in the
 * rows exactly once (whitespace.test.ts checks that for any input). The
 * server cuts whitespace-only runs into clusters of their own by the same
 * matching (src/shared/whitespace.ts matchDisplayHunk, CAR-218): over the
 * whole display hunk, context included, so a line's twin may also be a
 * context line or sit in another cluster (a one-sided `~` row).
 */

export {
	matchSides,
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

export type { DiffRow } from "../../shared/hunkPairs";

/**
 * Splits a hunk into runs of context lines and runs of one cluster's
 * lines; a run of orphan lines (CAR-216) stays apart from its cluster's
 * other lines. `starts` (the since view's pieces' first lines, CAR-218): a
 * changed run is also cut before each line in it, keeping its key, so
 * every piece is a run of its own with its own controls. `shaped`: the
 * run it was cut from is its removed lines, then its added ones (what
 * pairRun pairs; a part of a run of another shape stays plain, as the
 * whole run would, so the rows follow the server's cut).
 */
export function runs(
	lines: DiffLine[],
	starts?: ReadonlySet<DiffLine>,
): { key?: string; orphan?: true; lines: DiffLine[]; shaped: boolean }[] {
	const out: {
		key?: string;
		orphan?: true;
		lines: DiffLine[];
		shaped: boolean;
	}[] = [];
	// A changed run without a key stays apart from context (pieces.ts).
	for (const { key, change, orphan, lines: all } of lineRuns(lines)) {
		const firstAdd = all.findIndex((l) => l.kind === "add");
		const shaped =
			change &&
			all.every((l, i) =>
				firstAdd < 0 || i < firstAdd ? l.kind === "del" : l.kind === "add",
			);
		let part: DiffLine[] = [];
		const flush = () => {
			if (part.length === 0) return;
			out.push({
				...(key === undefined ? {} : { key }),
				...(orphan ? { orphan } : {}),
				lines: part,
				shaped,
			});
			part = [];
		};
		for (const line of all) {
			if (change && starts?.has(line)) flush();
			part.push(line);
		}
		flush();
	}
	return out;
}

/**
 * Each removed or added line of a hunk that has a whitespace-equal twin on
 * the other side: the display hunk's one matching, shared with the
 * server's cut (`matchDisplayHunk`, src/shared/whitespace.ts: the
 * soundness, the weights and the cap are described there). Cached per
 * `lines` array: the diff (HunkRows) and Find in PR (findInPr) share one
 * O(n·m) matching per hunk.
 */
export function matchHunk(lines: DiffLine[]): ReadonlyMap<DiffLine, DiffLine> {
	return matchDisplayHunk(lines);
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

/** A hunk's run and the rows the view shows for it. */
interface ViewRun {
	key?: string;
	/** A run of orphan lines (DiffLine.orphan, CAR-216). */
	orphan?: true;
	lines: DiffLine[];
	rows: DiffRow[];
}

/** What the view shows of a hunk: its runs, and the pairs and groups behind the marks and the order. */
export interface HunkView {
	runs: ViewRun[];
	/**
	 * Every run's rows one after the other in git's order: pairRun's with
	 * Ignore whitespace on, before orderRun moves a pair together.
	 */
	gitRows: DiffRow[];
	/**
	 * hunkItems over the runs' rows in git's order: the pairs and the
	 * groups (a line split or joined, CAR-130; never across two runs).
	 */
	items: HunkItems;
	/** `items.pairs`: hunkPairs over `gitRows` wherever no group replaced them. */
	pairs: LinePair[];
	/** Every line of a pair or group → its item. */
	partners: Partners;
}

const viewsByHunk = new WeakMap<DiffLine[], Map<string, HunkView>>();

/**
 * A hunk as the view shows it (HunkRows, Find in PR, the fixture test, so
 * they can't drift), once per hunk's lines and "Ignore whitespace" setting
 * (the hunks query's arrays: callers must never change `lines` in place).
 * With the setting on, a cluster's run is paired (pairRun, by the whole
 * hunk's twins); otherwise, and for context runs, every line is a row as it
 * is. `items` (pairs and groups) come from the rows in git's order (a
 * stretch ends at a context or `~` row; a group stays in its run); then
 * each cluster run's rows are put in unified B's order (orderRun): a pair
 * or a group reads together. `starts`: the since view's
 * pieces' first lines (runs), cut before pairing, so a pair that would
 * straddle two pieces is two one-sided `~` rows; the full diff and Find
 * pass none.
 */
export function hunkView(
	lines: DiffLine[],
	ignoreWhitespace: boolean,
	starts?: ReadonlySet<DiffLine>,
): HunkView {
	let at = "";
	if (starts && starts.size > 0) {
		lines.forEach((l, i) => {
			if (starts.has(l)) at += `,${i}`;
		});
	}
	const slot = `${ignoreWhitespace ? 1 : 0}${at}`;
	const cached = viewsByHunk.get(lines);
	const hit = cached?.get(slot);
	if (hit) return hit;
	const twins = ignoreWhitespace ? matchHunk(lines) : null;
	const git = runs(lines, starts).map(({ shaped, ...run }) => ({
		...run,
		rows:
			twins && run.key !== undefined && shaped
				? pairRun(run.lines, twins)
				: run.lines.map((line): DiffRow => ({ kind: "line", line })),
	}));
	const gitRows = git.flatMap((run) => run.rows);
	const items = hunkItems(git.map((run) => run.rows));
	const partners = partnersOf(items);
	const view: HunkView = {
		runs: git.map((run) =>
			run.key === undefined
				? run
				: { ...run, rows: orderRun(run.rows, partners) },
		),
		gitRows,
		items,
		pairs: items.pairs,
		partners,
	};
	const entry = cached ?? new Map<string, HunkView>();
	entry.set(slot, view);
	viewsByHunk.set(lines, entry);
	return view;
}
