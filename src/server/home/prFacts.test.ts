import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpHomePr, homePr, release } from "../../../test/fake-gh/scenario";
import {
	createHomeFixture,
	type HomeFixture,
} from "../../../test/home-fixture";
import {
	DETAILS_BATCH,
	DETAILS_MAX_AGE_MS,
	FIRST_BATCH,
	fetchPrDetails,
	fetchRepoPrs,
	fetchViewer,
	fetchViewerRepos,
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
afterEach(async () => {
	await fx?.cleanup();
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

describe("fetchRepoPrs never drops a PR it knew", () => {
	const open = (n: number, at = NOW - n * 1000) =>
		homePr({
			repo: "acme/api",
			number: n,
			author: "alice",
			updatedAt: iso(at),
		});
	const knownOf = (prs: { number: number }[], readAt = NOW) =>
		new Map<number, Known>(
			prs.map((f) => [f.number, { facts: f as never, readAt }]),
		);

	it("a known open PR the list skipped (pages shifted) stays", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: [open(1), open(2), open(3)] } },
		});
		const first = await fetchRepoPrs("acme", "api", SINCE, { now: NOW });
		fx.scenario({ homeListSkip: { "acme/api": [2] } });
		const again = await fetchRepoPrs("acme", "api", SINCE, {
			known: knownOf(first),
			now: NOW + 1000,
		});
		expect(again.map((p) => p.number).sort()).toEqual([1, 2, 3]);
		// Old facts of a skipped PR are read again, not dropped.
		const missing: number[] = [];
		const stale = await fetchRepoPrs("acme", "api", SINCE, {
			known: knownOf(first, NOW - DETAILS_MAX_AGE_MS),
			now: NOW + 1000,
			missing,
		});
		expect(stale.map((p) => p.number).sort()).toEqual([1, 2, 3]);
		expect(missing).toEqual([]);
	});

	it("a PR whose details came back null keeps its facts, and is reported", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: [open(1), open(2)] } },
		});
		const first = await fetchRepoPrs("acme", "api", SINCE, { now: NOW });
		bumpHomePr(fx.path, "acme/api", 2, iso(NOW + 500), "bob");
		fx.scenario({ homeDetailsNull: { "acme/api": [2] } });
		const missing: number[] = [];
		const again = await fetchRepoPrs("acme", "api", SINCE, {
			known: knownOf(first),
			now: NOW + 1000,
			missing,
		});
		expect(again.find((p) => p.number === 2)).toEqual(
			first.find((p) => p.number === 2),
		);
		expect(missing).toEqual([2]);
		// A new PR whose details are null can't show, but is reported.
		const fresh: number[] = [];
		const none = await fetchRepoPrs("acme", "api", SINCE, {
			now: NOW,
			missing: fresh,
		});
		expect(none.map((p) => p.number)).toEqual([1]);
		expect(fresh).toEqual([2]);
	});
});

describe("fetchRepoPrs, progressively (CAR-290)", () => {
	const open = (n: number) =>
		homePr({
			repo: "acme/api",
			number: n,
			author: "alice",
			// #1 newest.
			updatedAt: iso(NOW - n * 1000),
		});

	it("reads details newest updatedAt first, open and closed together", async () => {
		const closed = (n: number, at: number) =>
			homePr({
				repo: "acme/api",
				number: n,
				author: "a",
				state: "MERGED",
				closedAt: iso(at),
				updatedAt: iso(at),
			});
		// Two open pages (5 a page) and closed PRs between them by updatedAt.
		fx = createHomeFixture({
			repos: {
				"acme/api": {
					prs: [
						...Array.from({ length: 12 }, (_, i) => open(i + 1)),
						closed(900, NOW - 2500),
						closed(901, NOW - 11_500),
					],
				},
			},
			homePageSize: 5,
		});
		const got = await fetchRepoPrs("acme", "api", SINCE, { now: NOW });
		expect(got.map((p) => p.number)).toEqual([
			1, 2, 900, 3, 4, 5, 6, 7, 8, 9, 10, 11, 901, 12,
		]);
	});

	it("shows the batches as they land, in order: a later one waits for an earlier one", async () => {
		// Batches: 10 (#1-10), 20 (#11-30), 20 (#31-50), 20 (#51-70), 5.
		expect([FIRST_BATCH, DETAILS_BATCH]).toEqual([10, 20]);
		fx = createHomeFixture({
			repos: {
				"acme/api": { prs: Array.from({ length: 75 }, (_, i) => open(i + 1)) },
			},
			hold: ["homePr:11", "homePr:51"],
		});
		const cost = newCost();
		const shown: number[][] = [];
		const reading = fetchRepoPrs("acme", "api", SINCE, {
			now: NOW,
			cost,
			onProgress: (prs) => shown.push(prs.map((p) => p.number)),
		});
		const range = (from: number, to: number) =>
			Array.from({ length: to - from + 1 }, (_, i) => from + i);
		// The list and the first, third and fifth batches have answered (the
		// second and fourth are held): only the first shows.
		await vi.waitFor(() => expect(cost.calls).toBe(4), { timeout: 20_000 });
		expect(shown).toEqual([range(1, 10)]);
		release(fx.path, "homePr:11");
		await vi.waitFor(() => expect(shown).toHaveLength(2), { timeout: 20_000 });
		expect(shown[1]).toEqual(range(1, 50));
		release(fx.path, "homePr:51");
		const got = await reading;
		expect(got.map((p) => p.number)).toEqual(range(1, 75));
		// The last batch is the answer itself, never a progress.
		expect(shown).toHaveLength(2);
		// One list call, five detail batches: every call counted.
		expect(cost).toMatchObject({ calls: 6, points: 6 });
	});

	it("a read that failed shows no batch that lands after (fix round 1)", async () => {
		// Batches: 10 (#1-10, held), 20 (#11-30), 20 (#31-50, fails).
		fx = createHomeFixture({
			repos: {
				"acme/api": { prs: Array.from({ length: 50 }, (_, i) => open(i + 1)) },
			},
			hold: ["homePr:1"],
			homeDetailsFail: [31],
		});
		const cost = newCost();
		const shown: number[][] = [];
		await expect(
			fetchRepoPrs("acme", "api", SINCE, {
				now: NOW,
				cost,
				onProgress: (prs) => shown.push(prs.map((p) => p.number)),
			}),
		).rejects.toThrow(/502/);
		// The second batch has answered; the first lands only now.
		await vi.waitFor(() => expect(cost.calls).toBe(2), { timeout: 20_000 });
		release(fx.path, "homePr:1");
		await vi.waitFor(() => expect(cost.calls).toBe(3), { timeout: 20_000 });
		expect(shown).toEqual([]);
	});

	it("known rows not read yet stay in the progress (a retry keeps its rows)", async () => {
		fx = createHomeFixture({
			repos: {
				"acme/api": { prs: Array.from({ length: 30 }, (_, i) => open(i + 1)) },
			},
		});
		const first = await fetchRepoPrs("acme", "api", SINCE, { now: NOW });
		// #21-30 known but old: read again, in the held second batch.
		const known = new Map<number, Known>(
			first
				.filter((f) => f.number > 20)
				.map((f) => [f.number, { facts: f, readAt: NOW - DETAILS_MAX_AGE_MS }]),
		);
		fx.scenario({ hold: ["homePr:11"] });
		const shown: number[][] = [];
		const reading = fetchRepoPrs("acme", "api", SINCE, {
			now: NOW,
			known,
			onProgress: (prs) =>
				shown.push(prs.map((p) => p.number).sort((a, b) => a - b)),
		});
		await vi.waitFor(() => expect(shown).toHaveLength(1), { timeout: 20_000 });
		expect(shown[0]).toEqual([
			...Array.from({ length: 10 }, (_, i) => i + 1),
			...Array.from({ length: 10 }, (_, i) => i + 21),
		]);
		release(fx.path, "homePr:11");
		expect(await reading).toHaveLength(30);
	});

	it("without onProgress, batches stay DETAILS_BATCH (no extra call)", async () => {
		fx = createHomeFixture({
			repos: {
				"acme/api": { prs: Array.from({ length: 40 }, (_, i) => open(i + 1)) },
			},
		});
		await fetchRepoPrs("acme", "api", SINCE, { now: NOW });
		expect(detailCalls()).toBe(2);
	});
});

describe("review decision", () => {
	const base = { repo: "acme/api", number: 1, author: "alice" };
	it("without GitHub's (no required reviews), from the latest reviews", () => {
		const decision = (
			reviews: { login: string; state: string; at: string }[],
		) => mapPrNode("acme", "api", homePr({ ...base, reviews }))?.decision;
		expect(decision([{ login: "bob", state: "APPROVED", at: iso(NOW) }])).toBe(
			"approved",
		);
		expect(
			decision([
				{ login: "bob", state: "APPROVED", at: iso(NOW) },
				{ login: "carol", state: "CHANGES_REQUESTED", at: iso(NOW) },
			]),
		).toBe("changes-requested");
		expect(decision([{ login: "bob", state: "COMMENTED", at: iso(NOW) }])).toBe(
			null,
		);
		// The author's own review never decides.
		expect(
			decision([{ login: "alice", state: "APPROVED", at: iso(NOW) }]),
		).toBe(null);
	});
	it("GitHub's own decision wins when given", () => {
		const pr = homePr({
			...base,
			decision: "APPROVED",
			reviews: [{ login: "bob", state: "CHANGES_REQUESTED", at: iso(NOW) }],
		});
		expect(mapPrNode("acme", "api", pr)?.decision).toBe("approved");
	});
	it("marks bot reviewers: GitHub's Bot type, or a login ending [bot]", () => {
		const pr = homePr({
			...base,
			reviews: [
				{ login: "copilot-pull-request-reviewer", bot: true, at: iso(NOW) },
				{ login: "lint[bot]", at: iso(NOW) },
				{ login: "bob", at: iso(NOW) },
			],
		});
		const facts = mapPrNode("acme", "api", pr);
		expect(facts?.reviewers).toEqual([
			"copilot-pull-request-reviewer",
			"lint[bot]",
			"bob",
		]);
		expect(facts?.bots).toEqual(["copilot-pull-request-reviewer", "lint[bot]"]);
	});
	it("reads the head commit", () => {
		const pr = homePr({ ...base, head: "a".repeat(40) });
		expect(mapPrNode("acme", "api", pr)?.headOid).toBe("a".repeat(40));
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

describe("fetchViewerRepos", () => {
	it("reads every page; cut at the page cap, it says truncated", async () => {
		fx = createHomeFixture({
			viewerRepos: [
				{ name: "Acme/One", relation: "OWNER" },
				{ name: "acme/two", relation: "COLLABORATOR" },
				{ name: "acme/three", relation: "ORGANIZATION_MEMBER" },
				{ name: "zed/public", relation: "NONE" },
			],
			viewerReposPageSize: 1,
		});
		expect(await fetchViewerRepos()).toEqual({
			names: ["acme/one", "acme/two", "acme/three"],
			truncated: false,
		});
		expect(await fetchViewerRepos({ maxPages: 2 })).toEqual({
			names: ["acme/one", "acme/two"],
			truncated: true,
		});
		// Exactly at the cap with nothing left: not truncated.
		expect(await fetchViewerRepos({ maxPages: 3 })).toEqual({
			names: ["acme/one", "acme/two", "acme/three"],
			truncated: false,
		});
	});
});
