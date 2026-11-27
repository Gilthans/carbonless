import type { HunkItems } from "../../shared/hunkPairs";
import type { DiffLine } from "../../shared/types";
import { hiddenChange } from "../code/hiddenChange";
import type { Mark } from "../code/Invisibles";
import { BOM } from "../code/invisibleChars";
import type { DiffRow } from "./whitespace";
import { hunkPairs } from "./wordBlocks";

/**
 * The hunk's marked lines whose change doesn't show while "Show hidden
 * characters" is off (hiddenChange.ts). Every marked line is checked for a
 * mark that draws nothing; a paired line (hunkPairs, the pairing its marks
 * come from; `items` when the caller has them already) is also compared with its partner.
 * In a group (a split or join, CAR-130) the one line's partner is the run's
 * first line and that line's partner the one line; other run lines have
 * none; `noNewline` is compared between the one line and the run's last. A changed line holding
 * a BOM (drawn as nothing) without marks (unpaired, or too long to
 * compare) counts too: its BOM may be all that changed, and nothing
 * tells (overstating is the safe side). Without `items`, `rows` must be in
 * git's order (hunkPairs pairs the rows as given, not the view's reordered ones).
 */
export function hiddenLines(
	rows: readonly DiffRow[],
	words: ReadonlyMap<DiffLine, readonly Mark[]>,
	tabWidth: number,
	items?: HunkItems,
): ReadonlySet<DiffLine> {
	const hidden = new Set<DiffLine>();
	for (const row of rows) {
		if (row.kind !== "line") continue;
		const line = row.line;
		if (
			line.kind !== "context" &&
			!words.has(line) &&
			line.text.includes(BOM)
		) {
			hidden.add(line);
		}
	}
	if (words.size === 0) return hidden;
	/** A partner: its text, and whether a newline follows the group's end. */
	type Partner = { text: string; newline: boolean };
	const partners = new Map<DiffLine, Partner>();
	const partner = (line: DiffLine, newlineFrom = line): Partner => ({
		text: line.text,
		newline: !newlineFrom.noNewline,
	});
	const { pairs, groups } = items ?? { pairs: hunkPairs(rows), groups: [] };
	for (const [del, add] of pairs) {
		partners.set(del, partner(add));
		partners.set(add, partner(del));
	}
	for (const { one, run } of groups) {
		const first = run[0] as DiffLine;
		const last = run[run.length - 1] as DiffLine;
		partners.set(one, partner(first, last));
		partners.set(first, partner(one));
	}
	for (const [line, marks] of words) {
		const change = hiddenChange(line.text, marks, {
			tabWidth,
			newline: !line.noNewline,
			partner: partners.get(line),
		});
		if (change) hidden.add(line);
	}
	return hidden;
}
