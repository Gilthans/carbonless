import type { HomeRow, HomeSection, SectionId, Turn } from "./home.js";

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

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The turn names the viewer (a team they're in names the team, not them). */
export function viewersTurn(turn: Turn, viewer: string): boolean {
	return (
		!!viewer &&
		turn.kind === "people" &&
		turn.logins.some((l) => same(l, viewer))
	);
}

type Sortable = Pick<
	HomeRow,
	"owner" | "repo" | "number" | "turn" | "updatedAt"
>;

/**
 * A section's order (owner, 2026-10-31: "things in my turn should appear
 * before things with someone else's turn"): the viewer's turn first, then
 * by last GitHub activity, newest first, in each group; ties by repo and
 * number, so the order never depends on which repo answered first.
 */
export function compareRows(viewer: string) {
	const repo = (r: Sortable) => `${r.owner}/${r.repo}`.toLowerCase();
	return (a: Sortable, b: Sortable): number =>
		Number(viewersTurn(b.turn, viewer)) - Number(viewersTurn(a.turn, viewer)) ||
		Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
		repo(a).localeCompare(repo(b)) ||
		b.number - a.number;
}

/**
 * All five sections, in order, from `rows` (any repos'). Every row lands
 * in one: one whose section this page doesn't know goes to Other open
 * rather than nowhere. Hidden rows stay, flagged (the page folds them).
 */
export function composeSections(
	rows: Iterable<HomeRow>,
	viewer: string,
): HomeSection[] {
	const by = new Map<SectionId, HomeRow[]>(SECTION_IDS.map((id) => [id, []]));
	for (const row of rows) {
		(by.get(row.section) ?? by.get("other"))?.push(row);
	}
	return SECTION_IDS.map((id) => ({
		id,
		rows: (by.get(id) ?? []).sort(compareRows(viewer)),
	}));
}
