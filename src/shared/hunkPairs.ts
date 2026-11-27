import {
	type AlignBudget,
	alignGroups,
	alignOrOver,
	HUNK_ALIGN_WORD_OPS,
} from "./linePairing.js";
import type { DiffLine } from "./types.js";

/**
 * The view's line pairs (word highlighting, side by side), shared by the
 * page (src/web/files/wordBlocks.ts, whitespace.ts hunkView) and the
 * agent's `diff` read (src/server/agent/reads.ts), so both pair alike.
 */

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

/** A removed line and the added line it pairs with. */
export type LinePair = [del: DiffLine, add: DiffLine];

/**
 * The pairs behind a hunk's word marks and its pairs' places, each as its
 * removed and its added line. `rows` are the whole hunk's displayed rows
 * in order, every run's rows one after the other, so a block that spans
 * two clusters still pairs. A block is a run of removed lines directly
 * followed by a run of added lines; a context line or a whitespace-only
 * (`~`) row ends it (a stretch). A stretch with as many added lines as
 * removed ones pairs i-th with i-th: GitHub's pairs (spec:
 * docs/superpowers/specs/2026-11-01-inline-diff-design.md). One with a
 * different count, both above 0, pairs by similarity (step 2, alignCluster,
 * spec: docs/superpowers/specs/2026-11-08-inline-diff-step2-design.md),
 * the hunk's unequal stretches sharing `budget` word steps (default
 * HUNK_ALIGN_WORD_OPS): once one doesn't fit, it and every later unequal
 * stretch get none.
 */
export function hunkPairs(
	rows: readonly DiffRow[],
	budget = HUNK_ALIGN_WORD_OPS,
): LinePair[] {
	const work: AlignBudget = { left: budget };
	return stretchesOf([rows]).flatMap((s) =>
		(stretchPairs(s, work) ?? []).map(
			([i, j]): LinePair => [s.dels[i] as DiffLine, s.adds[j] as DiffLine],
		),
	);
}

/**
 * One line (`one`) and the adjacent run it split into or was joined from.
 * `one.kind === "del"`: a split (run = added lines); `"add"`: a join (run =
 * removed lines). run.length in [2, GROUP_MAX_LINES], in order.
 */
export type LineGroup = { one: DiffLine; run: readonly DiffLine[] };

/** A hunk's pairs and groups (CAR-130), each line in one at most. */
export type HunkItems = { pairs: LinePair[]; groups: LineGroup[] };

/**
 * A hunk's pairs and groups. `runs`: the hunk's view runs' rows in git
 * order (hunkView's `git`). The pairs are hunkPairs(runs.flat(), budget)'s
 * wherever no group replaced them, chosen first and spending the budget as
 * there; the groups (alignGroups, spec:
 * docs/superpowers/specs/2026-11-24-split-joined-lines-design.md) are then
 * looked for in each unequal stretch whose pairs were scored, in order,
 * from what the pairs left of the budget: once a stretch's don't fit, it
 * and every later stretch keep their pairs alone. A group's lines are all
 * in one view run; an equal stretch keeps its i-th-with-i-th pairs.
 * `grouped(r)`: whether run `r` may hold a group (default: every run).
 * The view puts a group's rows together only in the runs it reorders (a
 * cluster's, orderRun): in another run a group's rows could sit apart, an
 * unrelated row breaking its bracket, so a stretch with a line in such a
 * run keeps its pairs alone.
 */
export function hunkItems(
	runs: readonly (readonly DiffRow[])[],
	budget = HUNK_ALIGN_WORD_OPS,
	grouped: (run: number) => boolean = () => true,
): HunkItems {
	const work: AlignBudget = { left: budget };
	const stretches = stretchesOf(runs);
	const found = stretches.map((s) => stretchPairs(s, work));
	const groupWork: AlignBudget = { left: work.left };
	const out: HunkItems = { pairs: [], groups: [] };
	stretches.forEach((s, k) => {
		const pairs = found[k];
		if (!pairs) return;
		const unequal =
			s.dels.length !== s.adds.length &&
			s.delRuns.every(grouped) &&
			s.addRuns.every(grouped);
		const { pairs: kept, groups } = unequal
			? alignGroups(
					s.dels.map((l) => l.text),
					s.adds.map((l) => l.text),
					pairs,
					s.delRuns,
					s.addRuns,
					groupWork,
				)
			: { pairs, groups: [] };
		for (const [i, j] of kept)
			out.pairs.push([s.dels[i] as DiffLine, s.adds[j] as DiffLine]);
		for (const g of groups) {
			const [one, other] =
				g.one === "del" ? [s.dels, s.adds] : [s.adds, s.dels];
			out.groups.push({
				one: one[g.at] as DiffLine,
				run: other.slice(g.from, g.to),
			});
		}
	});
	return out;
}

/**
 * A stretch: removed lines directly followed by added ones, both sides
 * non-empty, with each line's view run.
 */
type Stretch = {
	dels: DiffLine[];
	adds: DiffLine[];
	delRuns: number[];
	addRuns: number[];
};

/**
 * The stretches of a hunk's rows, `runs` one after the other: a context
 * line or a whitespace-only row ends one, and so does a removed line after
 * an added one.
 */
function stretchesOf(runs: readonly (readonly DiffRow[])[]): Stretch[] {
	const out: Stretch[] = [];
	let s: Stretch = { dels: [], adds: [], delRuns: [], addRuns: [] };
	const flush = () => {
		if (s.dels.length > 0 && s.adds.length > 0) out.push(s);
		s = { dels: [], adds: [], delRuns: [], addRuns: [] };
	};
	runs.forEach((rows, r) => {
		for (const row of rows) {
			if (row.kind !== "line" || row.line.kind === "context") flush();
			else if (row.line.kind === "del") {
				if (s.adds.length > 0) flush();
				s.dels.push(row.line);
				s.delRuns.push(r);
			} else {
				s.adds.push(row.line);
				s.addRuns.push(r);
			}
		}
	});
	flush();
	return out;
}

/**
 * A stretch's pairs as index pairs: i-th with i-th when equal, else
 * alignCluster's from `work`; null when a guard or the budget stopped them.
 */
function stretchPairs(
	s: Stretch,
	work: AlignBudget,
): [number, number][] | null {
	if (s.dels.length === s.adds.length)
		return s.dels.map((_, i): [number, number] => [i, i]);
	return alignOrOver(
		s.dels.map((l) => l.text),
		s.adds.map((l) => l.text),
		work,
	);
}
