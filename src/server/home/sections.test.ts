import { describe, expect, it } from "vitest";
import type { PrFacts, StartedReview } from "./facts.js";
import {
	RECENTLY_CLOSED_MS,
	sectionOf,
	turnOf,
	turnWithWaiting,
} from "./sections.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const person = (login: string) => ({ login, avatarUrl: `https://a/${login}` });

function pr(over: Partial<PrFacts> = {}): PrFacts {
	return {
		owner: "acme",
		repo: "api",
		number: 1,
		title: "A change",
		url: "https://github.com/acme/api/pull/1",
		author: person("alice"),
		draft: false,
		state: "OPEN",
		closedAt: null,
		updatedAt: iso(NOW - 1000),
		checks: null,
		decision: null,
		unresolvedThreads: 0,
		requested: { users: [], teams: [] },
		reviewers: [],
		lastActivity: {},
		people: {},
		...over,
	};
}

const started = (over: Partial<StartedReview> = {}): StartedReview => ({
	owner: "acme",
	repo: "api",
	number: 1,
	id: "01jbxxxxxxxxxxxxxxxxxxxxxx",
	pinnedHead: null,
	asOf: null,
	coverage: { done: 1, total: 10, unit: "lines" },
	lastActedAt: iso(NOW - 5000),
	...over,
});

const VIEWER = "Octo";
const section = (
	p: PrFacts,
	s: StartedReview[] = [],
	teams: string[] | null = [],
) => sectionOf(p, VIEWER, teams, s, NOW);

describe("sectionOf", () => {
	it("Mine: the viewer is the author, drafts included, case-insensitive", () => {
		expect(section(pr({ author: person("octo") }))).toBe("mine");
		expect(section(pr({ author: person("OCTO"), draft: true }))).toBe("mine");
		// Requested from the viewer on their own PR: still Mine.
		expect(
			section(
				pr({
					author: person("octo"),
					requested: { users: ["Octo"], teams: [] },
				}),
			),
		).toBe("mine");
	});

	it("Reviewing: a review requested from the viewer directly", () => {
		expect(section(pr({ requested: { users: ["octo"], teams: [] } }))).toBe(
			"reviewing",
		);
	});

	it("Reviewing: requested from a team the viewer is in", () => {
		const p = pr({ requested: { users: [], teams: ["acme/backend"] } });
		expect(section(p, [], ["ACME/backend"])).toBe("reviewing");
		expect(section(p, [], ["acme/frontend"])).toBe("other");
	});

	it("teams unknown: a team request is not the viewer's (Other open)", () => {
		const p = pr({ requested: { users: [], teams: ["acme/backend"] } });
		expect(section(p, [], null)).toBe("other");
	});

	it("Reviewing: the viewer submitted a review or a review comment", () => {
		expect(section(pr({ reviewers: ["OCTO"] }))).toBe("reviewing");
	});

	it("Reviewing: the viewer started it in carbonless", () => {
		expect(section(pr(), [started()])).toBe("reviewing");
		// A draft too: started beats Other open.
		expect(section(pr({ draft: true }), [started()])).toBe("reviewing");
	});

	it("--as-of reviews never count as started", () => {
		expect(section(pr(), [started({ asOf: "2026-10-01T00:00:00Z" })])).toBe(
			"grabs",
		);
	});

	it("a pinned (--head) review counts as started", () => {
		expect(section(pr(), [started({ pinnedHead: "a".repeat(40) })])).toBe(
			"reviewing",
		);
	});

	it("started in a repo outside the view goes through the same table", () => {
		const outside = { owner: "other", repo: "tool" };
		const mine = pr({ ...outside, author: person("octo") });
		const s = [started(outside)];
		expect(section(mine, s)).toBe("mine");
		expect(section(pr(outside), s)).toBe("reviewing");
		expect(
			section(pr({ ...outside, state: "MERGED", closedAt: iso(NOW - DAY) }), s),
		).toBe("closed");
	});

	it("Up for grabs: not mine, not a draft, nothing requested, no review", () => {
		expect(section(pr())).toBe("grabs");
		expect(section(pr({ draft: true }))).toBe("other");
		expect(section(pr({ requested: { users: ["bob"], teams: [] } }))).toBe(
			"other",
		);
		expect(section(pr({ requested: { users: [], teams: ["acme/x"] } }))).toBe(
			"other",
		);
		expect(section(pr({ reviewers: ["bob"] }))).toBe("other");
	});

	it("Recently closed: merged or closed within 3 days, then dropped", () => {
		for (const state of ["MERGED", "CLOSED"] as const) {
			expect(section(pr({ state, closedAt: iso(NOW - DAY) }))).toBe("closed");
			expect(
				section(pr({ state, closedAt: iso(NOW - RECENTLY_CLOSED_MS + 1) })),
			).toBe("closed");
			expect(
				section(pr({ state, closedAt: iso(NOW - RECENTLY_CLOSED_MS - 1) })),
			).toBe(null);
			// The viewer's own closed PR is closed, not Mine.
			expect(
				section(pr({ state, closedAt: iso(NOW), author: person("octo") })),
			).toBe("closed");
		}
		// No date (GitHub gave none): not recent.
		expect(section(pr({ state: "MERGED", closedAt: null }))).toBe(null);
	});
});

const turn = (p: PrFacts) => turnOf(p, VIEWER);

describe("turnOf (first match wins)", () => {
	it("1: merged or closed → none, even a draft", () => {
		expect(turn(pr({ state: "MERGED", draft: true }))).toEqual({
			kind: "none",
		});
		expect(turn(pr({ state: "CLOSED" }))).toEqual({ kind: "none" });
	});

	it("2: draft → author, even with changes requested", () => {
		expect(turn(pr({ draft: true, decision: "changes-requested" }))).toEqual({
			kind: "people",
			logins: ["alice"],
		});
	});

	it("3: changes requested → author, even with a pending request", () => {
		expect(
			turn(
				pr({
					decision: "changes-requested",
					requested: { users: ["bob"], teams: [] },
				}),
			),
		).toEqual({ kind: "people", logins: ["alice"] });
	});

	it("4: requested and not submitted → those reviewers, the viewer first", () => {
		expect(
			turn(
				pr({
					requested: { users: ["bob", "octo", "carol"], teams: ["acme/x"] },
				}),
			),
		).toEqual({ kind: "people", logins: ["octo", "bob", "carol", "acme/x"] });
		// Before approved.
		expect(
			turn(
				pr({ decision: "approved", requested: { users: ["bob"], teams: [] } }),
			),
		).toEqual({ kind: "people", logins: ["bob"] });
	});

	it("5: approved → author, labelled merge", () => {
		expect(turn(pr({ decision: "approved", reviewers: ["bob"] }))).toEqual({
			kind: "people",
			logins: ["alice"],
			label: "merge",
		});
	});

	it("6: last activity the author's → the reviewers who have reviewed", () => {
		const p = pr({
			reviewers: ["bob", "Octo"],
			lastActivity: {
				alice: iso(NOW - 10),
				bob: iso(NOW - 100),
				octo: iso(NOW - 50),
			},
		});
		expect(turn(p)).toEqual({ kind: "people", logins: ["Octo", "bob"] });
	});

	it("7: last activity a reviewer's → author", () => {
		const p = pr({
			reviewers: ["bob"],
			lastActivity: { alice: iso(NOW - 100), bob: iso(NOW - 10) },
		});
		expect(turn(p)).toEqual({ kind: "people", logins: ["alice"] });
		// The author never acted: the reviewer's was last.
		expect(
			turn(pr({ reviewers: ["bob"], lastActivity: { bob: iso(NOW) } })),
		).toEqual({
			kind: "people",
			logins: ["alice"],
		});
	});

	it("8: no reviewers → no reviewer", () => {
		expect(turn(pr())).toEqual({ kind: "no-reviewer" });
	});
});

describe("turnWithWaiting", () => {
	const base = { kind: "no-reviewer" } as const;
	it("waiting on a login names them; on me, the viewer", () => {
		expect(turnWithWaiting(base, { who: "bob", at: iso(NOW) }, VIEWER)).toEqual(
			{
				kind: "people",
				logins: ["bob"],
			},
		);
		expect(turnWithWaiting(base, { who: "me", at: iso(NOW) }, VIEWER)).toEqual({
			kind: "people",
			logins: [VIEWER],
		});
	});
	it("nothing waited on: the facts' turn", () => {
		expect(turnWithWaiting(base, undefined, VIEWER)).toBe(base);
	});
	it("a closed PR keeps none", () => {
		expect(
			turnWithWaiting({ kind: "none" }, { who: "bob", at: iso(NOW) }, VIEWER),
		).toEqual({
			kind: "none",
		});
	});
});
