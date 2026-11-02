import type { DiffLine } from "../../shared/types";
import type { Mark } from "../code/Invisibles";
import type { DiffRow } from "./whitespace";
import { wordMarks } from "./wordDiff";

/**
 * GitHub's pairs in a hunk, and each paired line's word marks (spec:
 * docs/superpowers/specs/2026-11-01-inline-diff-design.md). `rows` are the
 * whole hunk's displayed rows in order, every run's rows one after the
 * other, so a block that spans two clusters still pairs. A block is a run
 * of removed lines directly followed by a run of added lines; a context
 * line or a whitespace-only (`~`) row ends it. Only a block with as many
 * added lines as removed ones pairs, i-th with i-th. Lines without a mark
 * are left out.
 */
export function hunkWordMarks(
	rows: readonly DiffRow[],
): Map<DiffLine, readonly Mark[]> {
	const marks = new Map<DiffLine, readonly Mark[]>();
	let dels: DiffLine[] = [];
	let adds: DiffLine[] = [];
	const flush = () => {
		if (dels.length > 0 && dels.length === adds.length) {
			dels.forEach((del, i) => {
				const add = adds[i] as DiffLine;
				const pair = wordMarks(del.text, add.text);
				if (pair.old.length > 0) marks.set(del, pair.old);
				if (pair.new.length > 0) marks.set(add, pair.new);
			});
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
	return marks;
}
