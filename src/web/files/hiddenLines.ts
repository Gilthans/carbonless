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
 * come from) is also compared with its partner. A changed line holding
 * a BOM (drawn as nothing) without marks (unpaired, or too long to
 * compare) counts too: its BOM may be all that changed, and nothing
 * tells (overstating is the safe side).
 */
export function hiddenLines(
	rows: readonly DiffRow[],
	words: ReadonlyMap<DiffLine, readonly Mark[]>,
	tabWidth: number,
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
	const partners = new Map<DiffLine, DiffLine>();
	for (const [del, add] of hunkPairs(rows)) {
		partners.set(del, add);
		partners.set(add, del);
	}
	for (const [line, marks] of words) {
		const partner = partners.get(line);
		const change = hiddenChange(line.text, marks, {
			tabWidth,
			newline: !line.noNewline,
			partner: partner && {
				text: partner.text,
				newline: !partner.noNewline,
			},
		});
		if (change) hidden.add(line);
	}
	return hidden;
}
