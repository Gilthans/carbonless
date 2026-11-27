import type { HunkItems, LineGroup } from "../../shared/hunkPairs";
import type { DiffLine } from "../../shared/types";

/**
 * A group line's place in its group's rows as shown (the bracket's ends,
 * CAR-130) and the group's label.
 */
export type GroupSpan = {
	group: LineGroup;
	at: "first" | "mid" | "last";
	label: string;
};

/**
 * Each group line's place in its group's rows as shown, and the label.
 * Unified (the default), the group's row order: a split reads −one,
 * +run…, a join −run…, +one. Side by side, the rows of the layout
 * (sideBySide.ts): the one line shares the first row with the run's
 * first, so both are `first`; the run's other lines follow, its last
 * `last`.
 */
export function groupSpans(
	items: HunkItems,
	view: "unified" | "side-by-side" = "unified",
): ReadonlyMap<DiffLine, GroupSpan> {
	const out = new Map<DiffLine, GroupSpan>();
	for (const group of items.groups) {
		const label = groupLabel(group);
		const rows: DiffLine[][] =
			view === "side-by-side"
				? group.run.map((l, k) => (k === 0 ? [group.one, l] : [l]))
				: (group.one.kind === "del"
						? [group.one, ...group.run]
						: [...group.run, group.one]
					).map((l) => [l]);
		rows.forEach((row, k) => {
			const at = k === 0 ? "first" : k === rows.length - 1 ? "last" : "mid";
			for (const line of row) out.set(line, { group, at, label });
		});
	}
	return out;
}

/** A line's number on its own side. */
const numberOf = (line: DiffLine): number | undefined =>
	line.kind === "del" ? line.oldNo : line.newNo;

/** "Line 12 split into 12–16" | "Lines 7–9 joined into 7". */
export function groupLabel(group: LineGroup): string {
	const one = numberOf(group.one);
	const from = numberOf(group.run[0] as DiffLine);
	const to = numberOf(group.run[group.run.length - 1] as DiffLine);
	return group.one.kind === "del"
		? `Line ${one} split into ${from}–${to}`
		: `Lines ${from}–${to} joined into ${one}`;
}
