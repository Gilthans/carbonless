import { afterEach, describe, expect, it, vi } from "vitest";
import { homePr } from "../../../test/fake-gh/scenario";
import {
	createHomeFixture,
	type HomeFixture,
} from "../../../test/home-fixture";
import type { SearchResult } from "../../shared/home.js";
import type { StartedReview } from "./facts.js";
import { type HomeConfig, HomeService } from "./homeService.js";
import { HomeSearch, mapSearchPrs, parseQuery } from "./search.js";

/** Every git process the code under test starts, counted. */
const gitCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("../git.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../git.js")>();
	return {
		...real,
		runGit: (...args: Parameters<typeof real.runGit>) => {
			gitCalls.n++;
			return real.runGit(...args);
		},
	};
});

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
afterEach(async () => {
	await fx?.cleanup();
	fx = undefined;
});

async function setup(
	started: StartedReview[] = [],
	options: { now?: () => number; maxRepoPages?: number } = {},
) {
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
		viewerRepos: [
			{ name: "acme/apiary", relation: "ORGANIZATION_MEMBER" },
			{ name: "Octo/api-notes", relation: "OWNER" },
			{ name: "zed/api-tools", relation: "NONE" },
			{ name: "friend/api-lab", relation: "COLLABORATOR" },
			{ name: "acme/api", relation: "ORGANIZATION_MEMBER" },
		],
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
	return { home, search: new HomeSearch(home, options) };
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

	it("repos only (view settings): no PR titles, and the text is a repo name whatever it looks like", async () => {
		const { search } = await setup();
		const r = await search.search("api", { only: "repos" });
		expect(r.prs).toEqual([]);
		expect(r.scope).toBe(null);
		expect(r.repos[0]).toMatchObject({ name: "acme/api", inView: true });
		expect((await search.search("login", { only: "repos" })).prs).toEqual([]);
		for (const q of ["acme/api", "acme/api ", "acme/api#1"]) {
			const named = await search.search(q, { only: "repos" });
			expect(named.prs, q).toEqual([]);
			expect(
				named.repos.map((x) => x.name),
				q,
			).toEqual(q === "acme/api#1" ? [] : ["acme/api"]);
		}
	});

	it("repos: the view's, then recent reviews', then the viewer's own; known ones while the list loads", async () => {
		const started: StartedReview = {
			owner: "other",
			repo: "tool",
			number: 9,
			id: "01jbaaaaaaaaaaaaaaaaaaaaaa",
			pinnedHead: null,
			head: "9".padStart(40, "0"),
			asOf: null,
			coverage: { done: 0, total: 1, unit: "lines" },
			lastActedAt: iso(T0),
		};
		const { search } = await setup([started]);
		const first = await search.search("a");
		// The viewer's list isn't in yet: what Home knows, flagged pending.
		expect(first).toMatchObject({ pending: true, reposPending: true });
		expect(first.repos).toEqual([
			{ name: "acme/api", inView: true, openCount: 3 },
		]);
		const done = await settle(search, "api");
		expect(done.reposPending).toBe(false);
		expect(done.repos.map((r) => r.name)).toEqual([
			"acme/api",
			"acme/apiary",
			"octo/api-notes",
			"friend/api-lab",
		]);
		const tool = await search.search("tool");
		expect(tool.repos[0]).toEqual({
			name: "other/tool",
			inView: false,
			openCount: null,
		});
		// Never GitHub's public repo search.
		expect(fx?.ghLog()).not.toMatch(/search repos/);
	});

	it("never lists a public repo the viewer has no relation to; org-member and collaborator repos do show", async () => {
		const { search } = await setup();
		const r = await settle(search, "api-");
		expect(r.repos.map((x) => x.name)).toEqual([
			"octo/api-notes",
			"friend/api-lab",
		]);
		expect((await search.search("zed")).repos).toEqual([]);
		expect((await search.search("apiary")).repos).toEqual([
			{ name: "acme/apiary", inView: false, openCount: null },
		]);
	});

	it("reads the viewer's repos once, all pages, and again only after an hour", async () => {
		const clock = { now: T0 };
		const { search } = await setup([], { now: () => clock.now });
		fx?.scenario({ viewerReposPageSize: 2 });
		await settle(search, "a");
		for (const q of ["ap", "api", "apia", "apiar", "acme", "x"]) {
			expect((await search.search(q)).reposPending).toBe(false);
		}
		const reads = () =>
			(fx?.ghLog().match(/viewer \{ repositories\(/g) ?? []).length;
		// Five repos (one the query leaves out), two a page: 2 pages.
		expect(reads()).toBe(2);
		const names = (await search.search("api")).repos.map((r) => r.name);
		expect(names).toContain("friend/api-lab");
		clock.now = T0 + 59 * 60_000;
		await search.search("api");
		expect(reads()).toBe(2);
		clock.now = T0 + 61 * 60_000;
		fx?.scenario({
			viewerRepos: [{ name: "acme/apinew", relation: "OWNER" }],
		});
		// Refreshed in the background: the old list meanwhile, never pending.
		expect((await search.search("api")).reposPending).toBe(false);
		await expect
			.poll(async () => (await search.search("apinew")).repos.length)
			.toBe(1);
		// A repo gone from the viewer's list is gone from Repos.
		const after = (await search.search("api")).repos.map((r) => r.name);
		expect(after).not.toContain("friend/api-lab");
		expect(after).toEqual(["acme/api", "acme/apinew"]);
	});

	it("a failed first read is asked again after about a minute", async () => {
		const clock = { now: T0 };
		const { search } = await setup([], { now: () => clock.now });
		fx?.scenario({ failGraphql: "repositories(" });
		expect((await settle(search, "api")).error).toMatch(/went wrong/);
		fx?.scenario({ failGraphql: undefined });
		clock.now = T0 + 30_000;
		// Within the minute: the same error, no new read.
		expect(await search.search("api")).toMatchObject({
			pending: false,
			error: expect.stringMatching(/went wrong/),
		});
		clock.now = T0 + 61_000;
		const r = await settle(search, "api");
		expect(r.error).toBeUndefined();
		expect(r.repos.map((x) => x.name)).toContain("friend/api-lab");
	});

	it("starts reading the viewer's repos when Home refreshes, before any search", async () => {
		// setup refreshes Home before its search exists: nothing read yet.
		const { home, search } = await setup();
		const reads = () =>
			(fx?.ghLog().match(/viewer \{ repositories\(/g) ?? []).length;
		expect(reads()).toBe(0);
		await home.refresh();
		await expect.poll(reads).toBe(1);
		await expect
			.poll(async () => (await search.search("api")).reposPending)
			.toBe(false);
		expect(reads()).toBe(1);
	});

	it("a list cut at the page cap says so once in the log, and keeps what it read", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { search } = await setup([], { maxRepoPages: 2 });
			fx?.scenario({ viewerReposPageSize: 1 });
			const r = await settle(search, "a");
			expect(r.repos.map((x) => x.name)).toEqual([
				"acme/api",
				"acme/apiary",
				"octo/api-notes",
			]);
			await search.search("ap");
			const cut = errors.mock.calls.filter((c) =>
				String(c[0]).includes("your repos"),
			);
			expect(cut).toHaveLength(1);
		} finally {
			errors.mockRestore();
		}
	});

	it("a failed read of the viewer's repos ends pending, with the error, and keeps what Home knows", async () => {
		const { search } = await setup();
		fx?.scenario({ failGraphql: "repositories(" });
		const r = await settle(search, "api");
		expect(r).toMatchObject({ pending: false, reposPending: false });
		expect(r.error).toMatch(/went wrong/);
		expect(r.repos.map((x) => x.name)).toEqual(["acme/api"]);
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

describe("HomeSearch, fix round 1", () => {
	it("reads each repo's inbox once, after cutting to the shown PRs", async () => {
		fx = createHomeFixture({
			repos: {
				"acme/api": {
					prs: Array.from({ length: 60 }, (_, i) =>
						homePr({
							repo: "acme/api",
							number: i + 1,
							title: `Fix thing ${i}`,
							author: "bob",
							updatedAt: iso(T0 - i * 1000),
						}),
					),
				},
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
			started: { list: async () => [] },
		});
		await home.refresh();
		// An inbox to read: one note.
		await home.annotate("acme", "api", 1, { op: "note", text: "x" });
		const search = new HomeSearch(home);
		gitCalls.n = 0;
		const r = await search.search("fix");
		expect(r.prs).toHaveLength(30);
		// One inbox: its tip (rev-parse) and at most one log, never one per PR.
		expect(gitCalls.n).toBeLessThanOrEqual(3);
	});

	it("a failed GitHub search ends pending, with the error", async () => {
		const { search } = await setup();
		fx?.scenario({ search: { fail: "HTTP 403: API rate limit exceeded" } });
		const r = await settle(search, "other/tool login");
		expect(r.pending).toBe(false);
		expect(r.error).toMatch(/rate limit/i);
		// Asked again within its lifetime: no new search, the same error.
		const again = await search.search("other/tool login");
		expect(again).toMatchObject({ pending: false, error: r.error });
	});
});

describe("mapSearchPrs", () => {
	it("keeps only the scope's PRs and maps states, unknown ones as closed", () => {
		const raw = [
			{
				number: 1,
				title: "a",
				author: { login: "x" },
				state: "open",
				updatedAt: iso(T0),
				repository: { nameWithOwner: "Acme/API" },
			},
			{
				number: 2,
				title: "b",
				author: { login: "x" },
				state: "merged",
				updatedAt: iso(T0),
				repository: { nameWithOwner: "acme/api" },
			},
			{
				number: 3,
				title: "c",
				author: { login: "x" },
				state: "weird",
				updatedAt: iso(T0),
				repository: { nameWithOwner: "acme/api" },
			},
			{
				number: 4,
				title: "d",
				author: { login: "x" },
				state: "open",
				updatedAt: iso(T0),
				repository: { nameWithOwner: "other/x" },
			},
			{
				number: 5,
				title: "e",
				author: { login: "x" },
				state: "open",
				updatedAt: iso(T0),
			},
		];
		expect(
			mapSearchPrs("acme", "api", raw).map((p) => [p.number, p.state]),
		).toEqual([
			[1, "OPEN"],
			[2, "MERGED"],
			[3, "CLOSED"],
		]);
	});
});
