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

/**
 * A line's number on its own side: a removed line of the since view
 * without an old number (an orphan, CAR-216) by its base number; none when
 * it has neither.
 */
const numberOf = (line: DiffLine): number | undefined =>
	(line.kind === "del" ? (line.oldNo ?? line.baseNo) : line.newNo) ?? undefined;

/**
 * "Line 12 split into 12–16" | "Lines 7–9 joined into 7". A line without a
 * number reads "A line" (the one line) or "N lines" (a run), never
 * `undefined`.
 */
export function groupLabel(group: LineGroup): string {
	const one = numberOf(group.one);
	const from = numberOf(group.run[0] as DiffLine);
	const to = numberOf(group.run[group.run.length - 1] as DiffLine);
	const lines =
		from !== undefined && to !== undefined
			? `${from}–${to}`
			: `${group.run.length} lines`;
	if (group.one.kind === "del")
		return `${one === undefined ? "A line" : `Line ${one}`} split into ${lines}`;
	return `${from !== undefined && to !== undefined ? `Lines ${lines}` : lines} joined into ${one ?? "one line"}`;
}
