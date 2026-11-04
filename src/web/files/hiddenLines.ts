import type { DiffLine } from "../../shared/types";
import { hiddenChange } from "../code/hiddenChange";
import type { Mark } from "../code/Invisibles";
import type { DiffRow } from "./whitespace";

/**
 * The hunk's marked lines whose change doesn't show while "Show hidden
 * characters" is off (hiddenChange.ts): each line compared with the line
 * it pairs with, paired as hunkWordMarks (wordBlocks.ts) pairs them (a run
 * of removed lines directly followed by as many added ones, i-th with
 * i-th; a context or whitespace-only row ends a block).
 */
export function hiddenLines(
	rows: readonly DiffRow[],
	words: ReadonlyMap<DiffLine, readonly Mark[]>,
	tabWidth: number,
): ReadonlySet<DiffLine> {
	const hidden = new Set<DiffLine>();
	if (words.size === 0) return hidden;
	const check = (line: DiffLine, partner: DiffLine) => {
		const marks = words.get(line);
		if (!marks) return;
		const change = hiddenChange(line.text, marks, {
			tabWidth,
			newline: !line.noNewline,
			partner: { text: partner.text, newline: !partner.noNewline },
		});
		if (change) hidden.add(line);
	};
	let dels: DiffLine[] = [];
	let adds: DiffLine[] = [];
	const flush = () => {
		if (dels.length > 0 && dels.length === adds.length) {
			dels.forEach((del, i) => {
				const add = adds[i] as DiffLine;
				check(del, add);
				check(add, del);
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
	return hidden;
}
