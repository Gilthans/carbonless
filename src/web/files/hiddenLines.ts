import type { DiffLine } from "../../shared/types";
import { hiddenChange } from "../code/hiddenChange";
import type { Mark } from "../code/Invisibles";
import type { DiffRow } from "./whitespace";
import { hunkPairs } from "./wordBlocks";

/**
 * The hunk's marked lines whose change doesn't show while "Show hidden
 * characters" is off (hiddenChange.ts). Every marked line is checked for a
 * mark that draws nothing; a paired line (hunkPairs, the pairing its marks
 * come from) is also compared with its partner.
 */
export function hiddenLines(
	rows: readonly DiffRow[],
	words: ReadonlyMap<DiffLine, readonly Mark[]>,
	tabWidth: number,
): ReadonlySet<DiffLine> {
	const hidden = new Set<DiffLine>();
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
