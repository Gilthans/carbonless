import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpHomePr, homePr } from "../../../test/fake-gh/scenario";
import {
	createHomeFixture,
	type HomeFixture,
} from "../../../test/home-fixture";
import {
	DETAILS_MAX_AGE_MS,
	fetchPrDetails,
	fetchRepoPrs,
	fetchViewer,
	fetchViewerTeams,
	type Known,
	mapPrNode,
	newCost,
} from "./prFacts.js";

// Each fake gh call is a node process: give a loaded machine time.
vi.setConfig({ testTimeout: 30_000 });

const NOW = Date.parse("2026-10-29T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const SINCE = NOW - 3 * DAY;

let fx: HomeFixture;
afterEach(() => {
	fx?.cleanup();
	fx = undefined as unknown as HomeFixture;
});

const listCalls = () =>
	fx
		.ghLog()
		.split("\n")
		.filter((l) => l.includes("open: pullRequests")).length;
const detailCalls = () =>
	fx
		.ghLog()
		.split("\n")
		.filter((l) => /r0: repository/.test(l)).length;

describe("mapPrNode", () => {
	it("maps checks, decision, unresolved threads, requests and activity", () => {
		const node = homePr({
			repo: "acme/api",
			number: 7,
			title: "Add a thing",
			author: "alice",
			requested: ["bob", "acme/backend"],
			reviews: [
				{ login: "carol", state: "APPROVED", at: iso(NOW - 3000) },
				{ login: "alice", state: "COMMENTED", at: iso(NOW - 2500) },
				{ login: "dave", state: "PENDING", at: iso(NOW - 2000) },
			],
			comments: [{ login: "Bob", at: iso(NOW - 1000) }],
			commits: [{ login: "alice", at: iso(NOW - 4000) }],
			checks: "FAILURE",
			decision: "APPROVED",
			threads: { resolved: 2, unresolved: 3 },
		});
		const facts = mapPrNode("acme", "api", node);
		expect(facts).toMatchObject({
			owner: "acme",
			repo: "api",
			number: 7,
			title: "Add a thing",
			author: { login: "alice" },
			checks: "failing",
			decision: "approved",
			unresolvedThreads: 3,
			requested: { users: ["bob"], teams: ["acme/backend"] },
			// The author's own review and a pending one aren't reviewers.
			reviewers: ["carol"],
			state: "OPEN",
			closedAt: null,
		});
		expect(facts?.lastActivity).toEqual({
			alice: iso(NOW - 2500),
			carol: iso(NOW - 3000),
			bob: iso(NOW - 1000),
		});
		expect(facts?.people["acme/backend"]).toEqual({
			login: "acme/backend",
			avatarUrl: "https://avatars.example/acme/backend",
		});
	});

	it("checks: running for pending, none without a rollup", () => {
		const base = {
			repo: "acme/api",
			number: 1,
			author: "a",
			commits: [{ at: iso(NOW) }],
		};
		expect(
			mapPrNode("acme", "api", homePr({ ...base, checks: "PENDING" }))?.checks,
		).toBe("running");
		expect(
			mapPrNode("acme", "api", homePr({ ...base, checks: null }))?.checks,
		).toBe(null);
		expect(
			mapPrNode("acme", "api", homePr({ ...base, checks: "SUCCESS" }))?.checks,
		).toBe("passing");
	});

	it("a merged PR's closedAt is its merge time; odd nodes are skipped", () => {
		const merged = homePr({
			repo: "acme/api",
			number: 2,
			author: "a",
			state: "MERGED",
			closedAt: iso(NOW - DAY),
		});
		expect(mapPrNode("acme", "api", merged)).toMatchObject({
			state: "MERGED",
			closedAt: iso(NOW - DAY),
		});
		expect(mapPrNode("acme", "api", null)).toBe(null);
		expect(mapPrNode("acme", "api", { number: "7", updatedAt: iso(NOW) })).toBe(
			null,
		);
		// A deleted author reads as ghost.
		expect(
			mapPrNode("acme", "api", { ...merged, author: null })?.author.login,
		).toBe("ghost");
	});
});

describe("fetchRepoPrs (fake gh)", () => {
	const open = (n: number, at = NOW - n * 1000) =>
		homePr({
			repo: "acme/api",
			number: n,
			author: "alice",
			updatedAt: iso(at),
		});

	it("lists every open PR past one page, and those closed in the last 3 days", async () => {
		const prs = [
			...Array.from({ length: 250 }, (_, i) => open(i + 1)),
			homePr({
				repo: "acme/api",
				number: 900,
				author: "a",
				state: "MERGED",
				closedAt: iso(NOW - DAY),
			}),
			homePr({
				repo: "acme/api",
				number: 901,
				author: "a",
				state: "CLOSED",
				closedAt: iso(NOW - 2 * DAY),
			}),
			homePr({
				repo: "acme/api",
				number: 902,
				author: "a",
				state: "MERGED",
				closedAt: iso(NOW - 4 * DAY),
			}),
		];
		fx = createHomeFixture({ repos: { "acme/api": { prs } } });
		const cost = newCost();
		const got = await fetchRepoPrs("acme", "api", SINCE, { cost, now: NOW });
		expect(got.map((p) => p.number).sort((a, b) => a - b)).toEqual([
			...Array.from({ length: 250 }, (_, i) => i + 1),
			900,
			901,
		]);
		// 3 list pages, 13 detail batches of 20.
		expect(listCalls()).toBe(3);
		expect(detailCalls()).toBe(13);
		expect(cost).toMatchObject({ calls: 16, points: 16, remaining: 4999 });
	});

	it("reads details only of PRs whose updatedAt moved, running checks or old facts", async () => {
		const prs = [open(1), open(2), open(3), open(4)];
		prs[2] = homePr({
			repo: "acme/api",
			number: 3,
			author: "a",
			commits: [{ at: iso(NOW - 3000) }],
			checks: "PENDING",
		});
		fx = createHomeFixture({ repos: { "acme/api": { prs } } });
		const first = await fetchRepoPrs("acme", "api", SINCE, { now: NOW });
		const known = new Map<number, Known>(
			first.map((f) => [f.number, { facts: f, readAt: NOW }]),
		);
		// PR 4's facts are old.
		known.set(4, {
			facts: known.get(4)?.facts as never,
			readAt: NOW - DETAILS_MAX_AGE_MS,
		});
		bumpHomePr(fx.path, "acme/api", 1, iso(NOW + 1000), "bob");
		const before = fx.ghLog().length;
		const again = await fetchRepoPrs("acme", "api", SINCE, {
			known,
			now: NOW + 2000,
		});
		const calls = fx.ghLog().slice(before);
		const read = [...calls.matchAll(/p(\d+): pullRequest/g)].map((m) =>
			Number(m[1]),
		);
		expect(read.sort()).toEqual([1, 3, 4]);
		expect(again.find((p) => p.number === 1)?.lastActivity.bob).toBe(
			iso(NOW + 1000),
		);
		expect(again).toHaveLength(4);
	});

	it("with listedSince, stops listing at known history and keeps the rest", async () => {
		const prs = Array.from({ length: 250 }, (_, i) =>
			open(i + 1, NOW - (i + 1) * 60_000),
		);
		fx = createHomeFixture({ repos: { "acme/api": { prs } } });
		const first = await fetchRepoPrs("acme", "api", SINCE, { now: NOW });
		const known = new Map<number, Known>(
			first.map((f) => [f.number, { facts: f, readAt: NOW }]),
		);
		const lists = listCalls();
		const again = await fetchRepoPrs("acme", "api", SINCE, {
			known,
			listedSince: NOW,
			now: NOW + 1000,
		});
		// One page reaches back past the margin: no second.
		expect(listCalls() - lists).toBe(1);
		expect(again).toHaveLength(250);
	});

	it("a PR that closed in between leaves the open list and joins the closed one", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: [open(1), open(2)] } },
		});
		const first = await fetchRepoPrs("acme", "api", SINCE, { now: NOW });
		const known = new Map<number, Known>(
			first.map((f) => [f.number, { facts: f, readAt: NOW }]),
		);
		const s = fx.current();
		const pr = s.repos?.["acme/api"]?.prs[1];
		if (!pr) throw new Error("no PR");
		Object.assign(pr, {
			state: "MERGED",
			mergedAt: iso(NOW + 500),
			closedAt: iso(NOW + 500),
			updatedAt: iso(NOW + 500),
		});
		fx.scenario({ repos: s.repos });
		const again = await fetchRepoPrs("acme", "api", SINCE, {
			known,
			listedSince: NOW,
			now: NOW + 1000,
		});
		expect(again.find((p) => p.number === 2)).toMatchObject({
			state: "MERGED",
		});
		expect(again).toHaveLength(2);
	});

	it("fails on an unknown repo, and as GitHub does when rate limited", async () => {
		fx = createHomeFixture({ repos: {} });
		await expect(fetchRepoPrs("acme", "nope", SINCE)).rejects.toThrow(
			/acme\/nope/,
		);
		fx.scenario({
			repos: { "acme/api": { prs: [open(1)] } },
			rateLimited: true,
		});
		await expect(fetchRepoPrs("acme", "api", SINCE)).rejects.toThrow(
			/rate limit/i,
		);
	});
});

describe("fetchPrDetails", () => {
	it("reads PRs across repos and leaves out ones GitHub doesn't know", async () => {
		fx = createHomeFixture({
			repos: {
				"acme/api": {
					prs: [homePr({ repo: "acme/api", number: 1, author: "a" })],
				},
				"other/tool": {
					prs: [homePr({ repo: "other/tool", number: 5, author: "b" })],
				},
			},
		});
		const got = await fetchPrDetails([
			{ owner: "acme", repo: "api", number: 1 },
			{ owner: "acme", repo: "api", number: 99 },
			{ owner: "other", repo: "tool", number: 5 },
			{ owner: "gone", repo: "repo", number: 3 },
		]);
		expect(got.map((p) => `${p.owner}/${p.repo}#${p.number}`).sort()).toEqual([
			"acme/api#1",
			"other/tool#5",
		]);
	});

	it("refuses names that aren't GitHub's", async () => {
		await expect(
			fetchPrDetails([{ owner: 'a") { x }', repo: "b", number: 1 }]),
		).rejects.toThrow(/Not a PR/);
	});
});

describe("the viewer", () => {
	it("reads the login, avatar and teams", async () => {
		fx = createHomeFixture({
			viewerTeams: ["acme/backend", "acme/infra", "other/x"],
		});
		expect(await fetchViewer()).toEqual({
			login: "Octo",
			avatarUrl: "https://avatars.example/Octo",
		});
		expect(await fetchViewerTeams("Octo")).toEqual([
			"acme/backend",
			"acme/infra",
			"other/x",
		]);
	});

	it("teams unreadable (no read:org): null", async () => {
		fx = createHomeFixture({ viewerTeams: null });
		expect(await fetchViewerTeams("Octo")).toBe(null);
	});
});
