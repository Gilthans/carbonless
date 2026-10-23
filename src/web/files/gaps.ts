import type { DisplayHunk } from "../../shared/types";

/** Lines loaded per ↑ or ↓ click. */
export const EXPAND_STEP = 20;

/**
 * Unchanged new-side lines `from..to` that no hunk shows. Gap `index` sits
 * above hunk `index` (the last one is below the last hunk). `above`: a hunk
 * ends right above it (↓ grows it from the top); `below`: a hunk starts right
 * below it (↑ grows it from the bottom).
 */
export interface Gap {
	index: number;
	from: number;
	to: number;
	above: boolean;
	below: boolean;
}

/**
 * The gaps of a file. Files without hunks (renames, binaries) have none: there
 * is no diff to put context around. Hunks always show at least one new-side
 * line unless the new file is empty.
 */
export function fileGaps(hunks: DisplayHunk[], newLineCount: number): Gap[] {
	if (hunks.length === 0 || newLineCount === 0) return [];
	const gaps: Gap[] = [];
	let next = 1;
	hunks.forEach((hunk, index) => {
		if (hunk.newStart > next) {
			gaps.push({
				index,
				from: next,
				to: hunk.newStart - 1,
				above: index > 0,
				below: true,
			});
		}
		next = Math.max(next, hunk.newStart + hunk.newCount);
	});
	if (next <= newLineCount) {
		gaps.push({
			index: hunks.length,
			from: next,
			to: newLineCount,
			above: true,
			below: false,
		});
	}
	return gaps;
}

/**
 * How much of a gap is loaded: `top` lines from its start, `bottom` from its
 * end (never overlapping), and what is still hidden in between.
 */
export function gapState(
	gap: Gap,
	loaded: ReadonlySet<number>,
): { top: number; bottom: number; remaining: number } {
	const size = gap.to - gap.from + 1;
	let top = 0;
	while (top < size && loaded.has(gap.from + top)) top++;
	let bottom = 0;
	while (top + bottom < size && loaded.has(gap.to - bottom)) bottom++;
	return { top, bottom, remaining: size - top - bottom };
}
