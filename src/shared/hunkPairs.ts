import {
	type AlignBudget,
	alignCluster,
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
	const pairs: LinePair[] = [];
	let dels: DiffLine[] = [];
	let adds: DiffLine[] = [];
	const flush = () => {
		if (dels.length > 0 && dels.length === adds.length) {
			dels.forEach((del, i) => {
				pairs.push([del, adds[i] as DiffLine]);
			});
		} else if (dels.length > 0 && adds.length > 0) {
			for (const [i, j] of alignCluster(
				dels.map((l) => l.text),
				adds.map((l) => l.text),
				work,
			)) {
				pairs.push([dels[i] as DiffLine, adds[j] as DiffLine]);
			}
		}
		dels = [];
		adds = [];
	};
	for (const row of rows) {
		if (row.kind !== "line" || row.line.kind === "context") flush();
		else if (row.line.kind === "del") {
			if (adds.length > 0) flush();
			dels.push(row.line);
		} else adds.push(row.line);
	}
	flush();
	return pairs;
}
