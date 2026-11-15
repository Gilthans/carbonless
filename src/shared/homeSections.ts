import type { HomeRow, HomeSection, SectionId } from "./home.js";

/**
 * Home's sections from every view repo's rows (each its own query on the
 * page, src/web/home): which rows go where is the server's (row.section),
 * the order is here. Spec: "Sections" in
 * docs/superpowers/specs/2026-10-28-home-and-always-on-server-design.md.
 */

export const SECTION_IDS: readonly SectionId[] = [
	"mine",
	"reviewing",
	"grabs",
	"other",
	"closed",
];

type Sortable = Pick<HomeRow, "owner" | "repo" | "number" | "updatedAt">;

const repoOf = (r: Sortable) => `${r.owner}/${r.repo}`.toLowerCase();

/**
 * A section's order: last GitHub activity, newest first, whoever's turn
 * it is (owner, 2026-11-14: "let's drop the your turn grouping"); ties by
 * repo and number, so the order never depends on which repo answered first.
 */
export function compareRows(a: Sortable, b: Sortable): number {
	return (
		Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
		repoOf(a).localeCompare(repoOf(b)) ||
		b.number - a.number
	);
}

/**
 * All five sections, in order, from `rows` (any repos'). Every row lands
 * in one: one whose section this page doesn't know goes to Other open
 * rather than nowhere. Hidden rows stay, flagged (the page folds them).
 */
export function composeSections(rows: Iterable<HomeRow>): HomeSection[] {
	const by = new Map<SectionId, HomeRow[]>(SECTION_IDS.map((id) => [id, []]));
	for (const row of rows) {
		(by.get(row.section) ?? by.get("other"))?.push(row);
	}
	return SECTION_IDS.map((id) => ({
		id,
		rows: (by.get(id) ?? []).sort(compareRows),
	}));
}
