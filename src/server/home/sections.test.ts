import { describe, expect, it } from "vitest";
import { viewersTurn } from "../../shared/homeSections.js";
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
		headOid: "",
		updatedAt: iso(NOW - 1000),
		checks: null,
		decision: null,
		unresolvedThreads: 0,
		requested: { users: [], teams: [] },
		reviewers: [],
		lastActivity: {},
		people: {},
		bots: [],
		...over,
	};
}

const started = (over: Partial<StartedReview> = {}): StartedReview => ({
	owner: "acme",
	repo: "api",
	number: 1,
	id: "01jbxxxxxxxxxxxxxxxxxxxxxx",
	pinnedHead: null,
	head: "a".repeat(40),
	asOf: null,
	coverage: { done: 1, total: 10, unit: "lines" },
	lastActedAt: iso(NOW - 5000),
	...over,
});

const VIEWER = "Octo";
const section = (
	p: PrFacts,
	s: StartedReview[] = [],
	teams: string[] | null = ["ACME/backend"],
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

	it("asked only of the viewer's teams: up for grabs until someone reviews (owner, 2026-10-30)", () => {
		const team = { users: [], teams: ["acme/backend"] };
		// Nobody reviewed: grabs.
		expect(section(pr({ requested: team }))).toBe("grabs");
		// Someone reviewed: Other open.
		expect(section(pr({ requested: team, reviewers: ["bob"] }))).toBe("other");
		// Only a bot reviewed: still grabs.
		expect(
			section(
				pr({ requested: team, reviewers: ["copilot"], bots: ["copilot"] }),
			),
		).toBe("grabs");
		// The team and the viewer directly: Reviewing.
		expect(
			section(pr({ requested: { users: ["octo"], teams: ["acme/backend"] } })),
		).toBe("reviewing");
		// The viewer started it: Reviewing.
		expect(section(pr({ requested: team }), [started()])).toBe("reviewing");
		// The viewer reviewed it: Reviewing.
		expect(section(pr({ requested: team, reviewers: ["OCTO"] }))).toBe(
			"reviewing",
		);
		// A draft stays Other open.
		expect(section(pr({ requested: team, draft: true }))).toBe("other");
	});

	it("a team the viewer isn't in, or teams unknown: Other open, nobody asked the viewer", () => {
		const theirs = { users: [], teams: ["acme/frontend"] };
		expect(section(pr({ requested: theirs }))).toBe("other");
		// One of the viewer's teams and another: still someone else's ask.
		expect(
			section(
				pr({
					requested: { users: [], teams: ["acme/backend", "acme/frontend"] },
				}),
			),
		).toBe("other");
		// No read:org: a team request isn't the viewer's.
		expect(
			section(
				pr({ requested: { users: [], teams: ["acme/backend"] } }),
				[],
				null,
			),
		).toBe("other");
	});

	it("a bot's review doesn't count as someone reviewed", () => {
		expect(section(pr({ reviewers: ["copilot"], bots: ["copilot"] }))).toBe(
			"grabs",
		);
		expect(
			section(pr({ reviewers: ["copilot", "bob"], bots: ["copilot"] })),
		).toBe("other");
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

	it("a started PR goes through the same table: mine stays Mine, a merged one is closed", () => {
		const s = [started()];
		expect(section(pr({ author: person("octo") }), s)).toBe("mine");
		expect(section(pr(), s)).toBe("reviewing");
		expect(section(pr({ state: "MERGED", closedAt: iso(NOW - DAY) }), s)).toBe(
			"closed",
		);
	});

	it("Up for grabs: not mine, not a draft, no person requested, no review", () => {
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

	it("4: a team the viewer is in comes right after the viewer", () => {
		expect(
			turnOf(
				pr({ requested: { users: ["bob"], teams: ["acme/x", "acme/mine"] } }),
				VIEWER,
				["acme/mine"],
			),
		).toEqual({ kind: "people", logins: ["acme/mine", "bob", "acme/x"] });
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

	it("8: no reviewers → no reviewer; on the viewer's own PR, the viewer, to request one", () => {
		expect(turn(pr())).toEqual({ kind: "no-reviewer" });
		expect(turn(pr({ author: person("Octo") }))).toEqual({
			kind: "people",
			logins: ["Octo"],
			label: "request",
		});
		// A draft is the author's anyway (rule 2), without the label.
		expect(turn(pr({ author: person("Octo"), draft: true }))).toEqual({
			kind: "people",
			logins: ["Octo"],
		});
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
		// The viewer's own login (any case) is "you".
		expect(
			turnWithWaiting(base, { who: "octo", at: iso(NOW) }, VIEWER),
		).toEqual({
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

describe("viewersTurn", () => {
	const mine = (p: PrFacts, teams: string[] | null = ["ACME/backend"]) =>
		viewersTurn(turnOf(p, VIEWER, teams), VIEWER);
	it("is the viewer's turn when the turn table names them, case-insensitive", () => {
		// 2: their own draft.
		expect(mine(pr({ author: person("octo"), draft: true }))).toBe(true);
		// 3: changes requested on their PR.
		expect(
			mine(pr({ author: person("OCTO"), decision: "changes-requested" })),
		).toBe(true);
		// 4: a review requested from them, among others.
		expect(mine(pr({ requested: { users: ["bob", "octo"], teams: [] } }))).toBe(
			true,
		);
		// 5: their approved PR, to merge.
		expect(mine(pr({ author: person("Octo"), decision: "approved" }))).toBe(
			true,
		);
		// 6: they reviewed, the author answered last.
		expect(
			mine(
				pr({
					reviewers: ["octo"],
					lastActivity: { alice: iso(NOW - 10), octo: iso(NOW - 100) },
				}),
			),
		).toBe(true);
		// 7: a reviewer acted last on their PR.
		expect(
			mine(
				pr({
					author: person("Octo"),
					reviewers: ["bob"],
					lastActivity: { Octo: iso(NOW - 100), bob: iso(NOW - 10) },
				}),
			),
		).toBe(true);
		// 8: their own PR with no reviewer: theirs to request one.
		expect(mine(pr({ author: person("Octo") }))).toBe(true);
	});

	it("isn't when the turn is someone else's, a team's, nobody's or none", () => {
		expect(mine(pr({ draft: true }))).toBe(false);
		expect(mine(pr({ requested: { users: ["bob"], teams: [] } }))).toBe(false);
		// A team the viewer is in names the team, not them.
		expect(
			mine(pr({ requested: { users: [], teams: ["acme/backend"] } })),
		).toBe(false);
		// 8 on someone else's PR: "no reviewer".
		expect(mine(pr())).toBe(false);
		expect(mine(pr({ author: person("octo"), state: "MERGED" }))).toBe(false);
	});

	it("follows the viewer's waiting-on: Me makes it theirs, someone else doesn't", () => {
		const turn = turnOf(
			pr({ requested: { users: ["bob"], teams: [] } }),
			VIEWER,
		);
		expect(
			viewersTurn(
				turnWithWaiting(turn, { who: "octo", at: iso(NOW) }, VIEWER),
				VIEWER,
			),
		).toBe(true);
		const own = turnOf(pr({ author: person("Octo") }), VIEWER);
		expect(
			viewersTurn(
				turnWithWaiting(own, { who: "bob", at: iso(NOW) }, VIEWER),
				VIEWER,
			),
		).toBe(false);
	});
});
