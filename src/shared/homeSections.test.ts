import { describe, expect, it } from "vitest";
import type { HomeRow, SectionId, Turn } from "./home.js";
import { compareRows, composeSections, SECTION_IDS } from "./homeSections.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const VIEWER = "Octo";

const people = (...logins: string[]): Turn => ({ kind: "people", logins });

function row(
	repo: string,
	number: number,
	section: SectionId,
	minutesAgo: number,
	over: Partial<HomeRow> = {},
): HomeRow {
	return {
		owner: "acme",
		repo,
		number,
		section,
		title: `PR ${number}`,
		url: `https://github.com/acme/${repo}/pull/${number}`,
		author: { login: "alice", avatarUrl: "" },
		draft: false,
		state: section === "closed" ? "MERGED" : "OPEN",
		closedAt: null,
		updatedAt: iso(NOW - minutesAgo * 60_000),
		checks: null,
		decision: null,
		unresolvedThreads: 0,
		turn: { kind: "no-reviewer" },
		reviewers: [],
		people: {},
		annotations: {},
		hidden: null,
		woke: null,
		reviews: [],
		openable: true,
		...over,
	};
}

const ids = (sections: ReturnType<typeof composeSections>, id: SectionId) =>
	sections.find((s) => s.id === id)?.rows.map((r) => `${r.repo}#${r.number}`);

describe("compareRows", () => {
	const r = (number: number, minutesAgo: number, turn: string[] | null) => ({
		owner: "acme",
		repo: "api",
		number,
		updatedAt: iso(NOW - minutesAgo * 60_000),
		turn: turn ? people(...turn) : ({ kind: "no-reviewer" } as const),
	});
	it("puts the viewer's turn first, then last activity, newest first, in each group", () => {
		const rows = [
			r(1, 1, ["bob"]),
			r(2, 50, ["octo"]),
			r(3, 5, null),
			r(4, 10, ["Octo", "bob"]),
			r(5, 5, ["alice"]),
		];
		expect([...rows].sort(compareRows(VIEWER)).map((x) => x.number)).toEqual([
			4, 2, 1, 5, 3,
		]);
	});

	it("a tie across repos is still one order", () => {
		const a = { ...r(1, 5, null), repo: "web" };
		const b = r(1, 5, null);
		expect([a, b].sort(compareRows(VIEWER)).map((x) => x.repo)).toEqual([
			"api",
			"web",
		]);
		expect([b, a].sort(compareRows(VIEWER)).map((x) => x.repo)).toEqual([
			"api",
			"web",
		]);
	});
});

describe("composeSections", () => {
	it("all five sections in order, always, even with no rows", () => {
		const sections = composeSections([], VIEWER);
		expect(sections.map((s) => s.id)).toEqual(SECTION_IDS);
		expect(sections.every((s) => s.rows.length === 0)).toBe(true);
	});

	it("merges several repos' rows into their sections: the viewer's turn first, then newest activity", () => {
		const api = [
			row("api", 1, "mine", 5),
			row("api", 2, "reviewing", 30, { turn: people("octo") }),
			row("api", 3, "grabs", 1),
			row("api", 5, "closed", 60),
		];
		const web = [
			row("web", 10, "mine", 1),
			row("web", 11, "reviewing", 2, { turn: people("bob") }),
			row("web", 12, "reviewing", 50, { turn: people("Octo", "bob") }),
			row("web", 13, "closed", 10),
		];
		const sections = composeSections([...api, ...web], VIEWER);
		expect(ids(sections, "mine")).toEqual(["web#10", "api#1"]);
		expect(ids(sections, "reviewing")).toEqual(["api#2", "web#12", "web#11"]);
		expect(ids(sections, "grabs")).toEqual(["api#3"]);
		expect(ids(sections, "other")).toEqual([]);
		expect(ids(sections, "closed")).toEqual(["web#13", "api#5"]);
	});

	it("keeps every row: hidden ones flagged in place, more than a fold, sub-rows with their PR", () => {
		const many = Array.from({ length: 25 }, (_, i) =>
			row(i % 2 ? "api" : "web", i + 1, "other", i),
		);
		const snoozed = row("api", 99, "other", 0, { hidden: "snoozed" });
		const waiting = row("web", 98, "other", 0, { hidden: "waiting" });
		const started = row("api", 97, "reviewing", 0, {
			reviews: [
				{
					id: "01jbaaaaaaaaaaaaaaaaaaaaaa",
					label: "head",
					pinnedHead: null,
					coverage: { done: 1, total: 2, unit: "lines" },
					lastActedAt: iso(NOW),
					headMoved: false,
				},
				{
					id: "01jbbbbbbbbbbbbbbbbbbbbbbb",
					label: "abcdef1",
					pinnedHead: "abcdef1".padEnd(40, "0"),
					coverage: { done: 2, total: 2, unit: "lines" },
					lastActedAt: iso(NOW - 1000),
					headMoved: false,
				},
			],
		});
		const sections = composeSections(
			[...many, snoozed, waiting, started],
			VIEWER,
		);
		const other = sections.find((s) => s.id === "other")?.rows ?? [];
		// The fold and the hidden footer are the page's: nothing is cut here.
		expect(other).toHaveLength(27);
		expect(other.filter((r) => r.hidden !== null)).toHaveLength(2);
		const reviewing = sections.find((s) => s.id === "reviewing")?.rows;
		expect(reviewing?.[0]?.reviews.map((r) => r.label)).toEqual([
			"head",
			"abcdef1",
		]);
	});

	it("a row whose section the page doesn't know lands in Other open, never dropped", () => {
		const odd = row("api", 7, "later" as SectionId, 1);
		const sections = composeSections([odd], VIEWER);
		expect(ids(sections, "other")).toEqual(["api#7"]);
	});
});
