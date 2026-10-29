import { afterEach, describe, expect, it, vi } from "vitest";
import { homePr } from "../../../test/fake-gh/scenario";
import {
	createHomeFixture,
	type HomeFixture,
} from "../../../test/home-fixture";
import type { SearchResult } from "../../shared/home.js";
import type { StartedReview } from "./facts.js";
import { type HomeConfig, HomeService } from "./homeService.js";
import { HomeSearch, parseQuery } from "./search.js";

// Each fake gh call is a node process: give a loaded machine time.
vi.setConfig({ testTimeout: 30_000 });

describe("parseQuery", () => {
	it("a PR URL or owner/repo#n is a PR", () => {
		const pr = { kind: "pr", owner: "acme", repo: "api", number: 12 };
		expect(parseQuery("https://github.com/acme/api/pull/12")).toEqual(pr);
		expect(
			parseQuery("https://github.com/acme/api/pull/12/files#diff"),
		).toEqual(pr);
		expect(parseQuery("  acme/api#12 ")).toEqual(pr);
	});

	it("owner/repo and a space scopes to the repo, words after it", () => {
		expect(parseQuery("acme/api ")).toEqual({
			kind: "scoped",
			owner: "acme",
			repo: "api",
			words: [],
		});
		expect(parseQuery("acme/api fix Login")).toEqual({
			kind: "scoped",
			owner: "acme",
			repo: "api",
			words: ["fix", "login"],
		});
	});

	it("#n or n after a repo is that PR", () => {
		const pr = { kind: "pr", owner: "acme", repo: "api", number: 7 };
		expect(parseQuery("acme/api #7")).toEqual(pr);
		expect(parseQuery("acme/api 7")).toEqual(pr);
	});

	it("anything else is free text; a repo without the space too", () => {
		expect(parseQuery("Login fix")).toEqual({
			kind: "free",
			text: "login fix",
			words: ["login", "fix"],
		});
		expect(parseQuery("acme/api")).toEqual({
			kind: "free",
			text: "acme/api",
			words: ["acme/api"],
		});
		expect(parseQuery("")).toEqual({ kind: "free", text: "", words: [] });
	});
});

const T0 = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
let fx: HomeFixture | undefined;
afterEach(() => {
	fx?.cleanup();
	fx = undefined;
});

async function setup(started: StartedReview[] = []) {
	fx = createHomeFixture({
		repos: {
			"acme/api": {
				prs: [
					homePr({
						repo: "acme/api",
						number: 1,
						title: "Fix the login page",
						author: "alice",
						updatedAt: iso(T0 - 1000),
					}),
					homePr({
						repo: "acme/api",
						number: 2,
						title: "Login: fix redirect",
						author: "bob",
						updatedAt: iso(T0 - 5000),
					}),
					homePr({
						repo: "acme/api",
						number: 3,
						title: "Login cleanup",
						author: "bob",
						state: "MERGED",
						closedAt: iso(T0 - 500),
					}),
					homePr({
						repo: "acme/api",
						number: 4,
						title: "Unrelated",
						author: "bob",
						updatedAt: iso(T0 - 100),
					}),
				],
			},
			"other/tool": {
				prs: [
					homePr({
						repo: "other/tool",
						number: 9,
						title: "Fix login in tool",
						author: "carol",
						updatedAt: iso(T0),
					}),
				],
			},
		},
		search: {
			repos: [{ fullName: "acme/apiary" }, { fullName: "zed/api-tools" }],
		},
	});
	const config: HomeConfig = {
		views: [{ name: "My PRs", repos: ["acme/api"] }],
		refresh: { minutes: 2 },
	};
	const home = new HomeService({
		config: {
			read: async () => ({ config, problems: [] }),
			update: async () => config,
		},
		started: { list: async () => started },
	});
	await home.refresh();
	return { home, search: new HomeSearch(home) };
}

/** Asks until the GitHub search is in. */
async function settle(search: HomeSearch, q: string): Promise<SearchResult> {
	for (let i = 0; i < 100; i++) {
		const r = await search.search(q);
		if (!r.pending) return r;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("search never settled");
}
const prIds = (r: SearchResult) =>
	r.prs.map((p) => `${p.owner}/${p.repo}#${p.number}`);

describe("HomeSearch", () => {
	it("free text: the view's PR titles, words in any order, open before closed", async () => {
		const { search } = await setup();
		const r = await search.search("fix login");
		expect(prIds(r)).toEqual(["acme/api#1", "acme/api#2"]);
		const all = await search.search("LOGIN");
		expect(prIds(all)).toEqual(["acme/api#1", "acme/api#2", "acme/api#3"]);
		expect(r.scope).toBe(null);
	});

	it("repos: the view's, then recent reviews', then GitHub's after 3 characters", async () => {
		const started: StartedReview = {
			owner: "other",
			repo: "tool",
			number: 9,
			id: "01jbaaaaaaaaaaaaaaaaaaaaaa",
			pinnedHead: null,
			asOf: null,
			coverage: { done: 0, total: 1, unit: "lines" },
			lastActedAt: iso(T0),
		};
		const { search } = await setup([started]);
		const short = await search.search("a");
		expect(short.pending).toBe(false);
		expect(fx?.ghLog()).not.toMatch(/search repos/);
		const first = await search.search("api");
		expect(first.pending).toBe(true);
		expect(first.repos[0]).toEqual({
			name: "acme/api",
			inView: true,
			openCount: 3,
		});
		const done = await settle(search, "api");
		expect(done.repos.map((r) => r.name)).toEqual([
			"acme/api",
			"acme/apiary",
			"zed/api-tools",
		]);
		const tool = await settle(search, "tool");
		expect(tool.repos[0]).toEqual({
			name: "other/tool",
			inView: false,
			openCount: null,
		});
	});

	it("a scoped view repo lists its PRs by latest activity, then words filter", async () => {
		const { search } = await setup();
		const r = await search.search("acme/api ");
		expect(r.scope).toBe("acme/api");
		expect(prIds(r)).toEqual([
			"acme/api#4",
			"acme/api#1",
			"acme/api#2",
			"acme/api#3",
		]);
		const words = await settle(search, "acme/api redirect");
		expect(prIds(words)).toEqual(["acme/api#2"]);
	});

	it("a scoped repo outside the view asks GitHub, answered through pending", async () => {
		const { search } = await setup();
		const first = await search.search("other/tool login");
		expect(first).toMatchObject({
			pending: true,
			scope: "other/tool",
			prs: [],
		});
		const done = await settle(search, "other/tool login");
		expect(done.prs).toEqual([
			{
				owner: "other",
				repo: "tool",
				number: 9,
				title: "Fix login in tool",
				author: {
					login: "carol",
					avatarUrl: "https://github.com/carol.png?size=40",
				},
				state: "OPEN",
				updatedAt: iso(T0),
				hidden: null,
			},
		]);
	});

	it("a snoozed PR still shows, flagged", async () => {
		const { home, search } = await setup();
		await home.annotate("acme", "api", 1, {
			op: "snooze",
			until: iso(T0 + 3_600_000),
			wakeOnActivity: false,
		});
		const r = await search.search("fix login");
		expect(r.prs.find((p) => p.number === 1)?.hidden).toBe("snoozed");
	});

	it("a PR named outright: known, or read from GitHub", async () => {
		const { search } = await setup();
		expect(prIds(await search.search("acme/api#2"))).toEqual(["acme/api#2"]);
		const outside = await settle(
			search,
			"https://github.com/other/tool/pull/9",
		);
		expect(prIds(outside)).toEqual(["other/tool#9"]);
		expect(outside.scope).toBe("other/tool");
	});
});
