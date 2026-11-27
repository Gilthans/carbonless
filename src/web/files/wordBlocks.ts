import type { LinePair } from "../../shared/hunkPairs";
import type { DiffLine } from "../../shared/types";
import type { Mark } from "../code/Invisibles";
import { wordMarks } from "./wordDiff";

export { hunkPairs, type LinePair } from "../../shared/hunkPairs";

/** Each paired line's word marks. Lines without a mark are left out. */
export function pairWordMarks(
	pairs: readonly LinePair[],
): Map<DiffLine, readonly Mark[]> {
	const marks = new Map<DiffLine, readonly Mark[]>();
	for (const [del, add] of pairs) {
		const pair = wordMarks(del.text, add.text);
		if (pair.old.length > 0) marks.set(del, pair.old);
		if (pair.new.length > 0) marks.set(add, pair.new);
	}
	return marks;
}
