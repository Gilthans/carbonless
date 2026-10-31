import { afterEach, describe, expect, it, vi } from "vitest";
import { homePr } from "../../../test/fake-gh/scenario";
import {
	createHomeFixture,
	type HomeFixture,
} from "../../../test/home-fixture";
import type { PeopleResult } from "../../shared/home.js";
import { type HomeConfig, HomeService } from "./homeService.js";
import { HomePeople, ORG_MEMBERS_TTL_MS } from "./people.js";

// Each fake gh call is a node process: give a loaded machine time.
vi.setConfig({ testTimeout: 30_000 });

let fx: HomeFixture | undefined;
afterEach(() => {
	fx?.cleanup();
	fx = undefined;
});

const T0 = Date.parse("2026-10-29T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

async function setup(over: Parameters<typeof createHomeFixture>[0] = {}) {
	fx = createHomeFixture({
		repos: {
			"acme/api": {
				prs: [
					homePr({
						repo: "acme/api",
						number: 1,
						author: "bobby-tables",
						requested: ["carol", "acme/backend"],
						reviews: [
							{ login: "dependabot", at: iso(T0 - 9000), bot: true },
							{ login: "bob", at: iso(T0 - 8000) },
						],
						updatedAt: iso(T0 - 1000),
					}),
					homePr({
						repo: "acme/api",
						number: 2,
						author: "bob",
						requested: ["Octo"],
						updatedAt: iso(T0 - 2000),
					}),
				],
			},
		},
		viewerTeams: ["acme/backend"],
		orgMembers: { acme: ["Octo", "abbott", "obo", "zed"] },
		githubUsers: [
			"bob",
			"boba-fett",
			"bobcat",
			{ login: "bobsorg", org: true },
		],
		...over,
	});
	const config: HomeConfig = {
		views: [{ name: "My PRs", repos: ["acme/api"] }],
		refresh: { minutes: 2 },
	};
	const clock = { now: T0 };
	const home = new HomeService({
		config: {
			read: async () => ({ config, problems: [] }),
			update: async () => config,
		},
		started: { list: async () => [] },
		now: () => clock.now,
	});
	await home.refresh();
	return {
		home,
		clock,
		people: new HomePeople(home, { now: () => clock.now }),
	};
}

/** Asks until nothing is pending. */
async function settle(people: HomePeople, q: string): Promise<PeopleResult> {
	for (let i = 0; i < 200; i++) {
		const r = await people.people(q);
		if (!r.pending) return r;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("people never settled");
}
const logins = (r: PeopleResult) => ({
	close: r.close.map((p) => p.login),
	others: r.others.map((p) => p.login),
});
const userSearches = () =>
	(fx?.ghLog() ?? "").split("\n").filter((l) => /type: USER/.test(l));

describe("HomePeople", () => {
	it("the viewer's orgs and the people on their repos first, then GitHub's users; never the viewer, a team, a bot or an org", async () => {
		const { people } = await setup();
		const r = await settle(people, "bo");
		expect(logins(r)).toEqual({
			// Starting with the text first, then the most active on the view's
			// PRs, then by login.
			close: ["bob", "bobby-tables", "abbott", "obo"],
			others: ["boba-fett", "bobcat"],
		});
		expect(r.close[0]).toEqual({
			login: "bob",
			avatarUrl: expect.any(String),
		});
		// Teams are never offered: they never act themselves.
		expect(logins(await settle(people, "backend")).close).toEqual([]);
		expect(logins(await settle(people, "dependabot")).close).toEqual([]);
		expect(logins(await settle(people, "octo"))).toEqual({
			close: [],
			others: [],
		});
	});

	it("searches GitHub's users only from 2 characters", async () => {
		const { people } = await setup();
		const one = await settle(people, "b");
		expect(one.others).toEqual([]);
		expect(logins(one).close).toEqual(["bob", "bobby-tables", "abbott", "obo"]);
		expect(userSearches()).toEqual([]);
		await settle(people, " @B");
		expect(userSearches()).toEqual([]);
		await settle(people, "bo");
		expect(userSearches()).toHaveLength(1);
		// Asked again soon: the same answer, no new search.
		await settle(people, "bo");
		expect(userSearches()).toHaveLength(1);
	});

	it("reads the org members once, then again only after an hour", async () => {
		const { people, clock } = await setup();
		const reads = () =>
			(fx?.ghLog() ?? "").split("\n").filter((l) => /membersWithRole/.test(l))
				.length;
		await settle(people, "z");
		await settle(people, "zz");
		expect(reads()).toBe(1);
		fx?.scenario({ orgMembers: { acme: ["Octo", "zed", "zelda"] } });
		clock.now = T0 + ORG_MEMBERS_TTL_MS - 1;
		expect(logins(await settle(people, "zel")).close).toEqual([]);
		expect(reads()).toBe(1);
		clock.now = T0 + ORG_MEMBERS_TTL_MS;
		// The stale list answers while it's read again.
		let r = await people.people("zel");
		for (let i = 0; i < 200 && r.close.length === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			r = await people.people("zel");
		}
		expect(logins(r).close).toEqual(["zelda"]);
		expect(reads()).toBe(2);
	});

	it("pages through an org's members", async () => {
		const { people } = await setup({
			orgMembers: { acme: ["m1", "m2", "m3", "m4", "m5"] },
			orgMembersPageSize: 2,
		});
		expect(logins(await settle(people, "m")).close).toEqual([
			"m1",
			"m2",
			"m3",
			"m4",
			"m5",
		]);
	});

	it("without read:org, the repos' people still come; a failed user search says why", async () => {
		const { people } = await setup({
			viewerTeams: null,
			userSearch: { fail: "API rate limit exceeded" },
		});
		const r = await settle(people, "bo");
		expect(logins(r)).toEqual({ close: ["bob", "bobby-tables"], others: [] });
		expect(r.error).toMatch(/rate limit/);
	});
});
