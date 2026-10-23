import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GhError } from "./errors";
import { mapOverview } from "./overview";

const load = (name: string): any =>
	JSON.parse(readFileSync(`test/fixtures/gh/${name}`, "utf8"));
const view = () => load("pr-view.json");
const graph = () => ({
	reviewThreads: load("review-threads.json") as any[],
	comments: load("pr-activity.json").comments as any[],
	reviews: load("pr-activity.json").reviews as any[],
});
// The viewer's login has an underscore; callers may pass the login or its slug.
const VIEWER = "jdoe_acme";

describe("mapOverview", () => {
	const o = mapOverview(view(), graph(), VIEWER);

	it("maps the plain fields", () => {
		expect(o).toMatchObject({
			title: "Add widget cache",
			number: 12,
			author: "octo-author",
			state: "OPEN",
			isDraft: false,
			baseBranch: "main",
			headBranch: "feature/cache",
			mergeable: "MERGEABLE",
		});
		expect(o.requestedReviewers).toEqual([
			{ name: "rev2", team: false },
			{ name: "Core Team", team: true },
		]);
	});

	it("keeps the latest activity and the latest opinion per reviewer, newest first, and marks you", () => {
		expect(o.reviews).toEqual([
			{
				author: "rev1",
				state: "COMMENTED",
				opinion: "CHANGES_REQUESTED",
				submittedAt: "2026-01-04T09:00:00Z",
				you: false,
			},
			{
				author: "jdoe_acme",
				state: "CHANGES_REQUESTED",
				opinion: "CHANGES_REQUESTED",
				submittedAt: "2026-01-03T10:00:00Z",
				you: true,
			},
			{
				author: "github-actions",
				state: "COMMENTED",
				submittedAt: "2026-01-02T11:00:00Z",
				you: false,
			},
		]);
	});

	it("recognises the viewer by login or by slug", () => {
		for (const viewer of ["jdoe_acme", "jdoe-acme", "JDoe_Acme"]) {
			const r = mapOverview(view(), graph(), viewer);
			expect(r.reviews.find((x) => x.you)?.author).toBe("jdoe_acme");
			expect(r.commenters.find((x) => x.you)?.author).toBe("jdoe_acme");
		}
	});

	it("lists commenters with last time, bot and you flags", () => {
		expect(o.commenters).toEqual([
			{
				author: "jdoe_acme",
				lastAt: "2026-01-04T10:00:00Z",
				bot: false,
				you: true,
			},
			{
				author: "codecov",
				lastAt: "2026-01-04T08:00:00Z",
				bot: true,
				you: false,
			},
			{
				author: "octo-author",
				lastAt: "2026-01-03T08:00:00Z",
				bot: false,
				you: false,
			},
		]);
	});

	it("orders checks failing, pending, passing", () => {
		expect(o.checks.map((c) => c.status)).toEqual([
			"failing",
			"pending",
			"passing",
			"passing",
		]);
		expect(o.checks[0]).toEqual({
			name: "lint",
			status: "failing",
			url: "https://ci.example/lint",
		});
		expect(o.checks[3]).toEqual({ name: "license/check", status: "passing" });
	});

	it("lists unresolved threads with bot and reply flags", () => {
		expect(o.threads).toEqual([
			{
				path: "src/cache.ts",
				line: 42,
				excerpt: "Should this expire?",
				author: "rev1",
				bot: false,
				hasReply: true,
				outdated: false,
			},
			{
				path: "src/old.ts",
				line: null,
				excerpt: "Coverage dropped",
				author: "ci-bot",
				bot: true,
				hasReply: false,
				outdated: true,
			},
			{
				path: "src/self.ts",
				line: 3,
				excerpt: "First",
				author: "rev1",
				bot: false,
				hasReply: false,
				outdated: false,
			},
		]);
	});

	it("cuts thread excerpts at 200 characters", () => {
		const g = graph();
		g.reviewThreads[0].comments.nodes[0].body = "x".repeat(300);
		expect(mapOverview(view(), g, VIEWER).threads[0]?.excerpt).toHaveLength(
			200,
		);
	});

	it("humanStarted ignores the author, the viewer and bots (by __typename)", () => {
		expect(o.humanStarted).toBe(true); // rev1
		const g = graph();
		g.reviews = g.reviews.filter((r) => r.author.login !== "rev1");
		expect(mapOverview(view(), g, VIEWER).humanStarted).toBe(false);
		g.comments.push({
			author: { login: "rev3", __typename: "User" },
			createdAt: "2026-01-05T00:00:00Z",
		});
		expect(mapOverview(view(), g, VIEWER).humanStarted).toBe(true);
	});

	it("does not count the viewer's own underscore login as another human", () => {
		const g = graph();
		g.reviews = g.reviews.filter((r) => r.author.login !== "rev1");
		expect(mapOverview(view(), g, "jdoe-acme").humanStarted).toBe(false);
	});

	it("falls back to login spellings for bots without a __typename", () => {
		const g = graph();
		g.reviews = [];
		g.comments = [
			{
				author: { login: "app/dependabot" },
				createdAt: "2026-01-05T00:00:00Z",
			},
			{ author: { login: "x[bot]" }, createdAt: "2026-01-05T00:00:00Z" },
		];
		const r = mapOverview(view(), g, VIEWER);
		expect(r.commenters.every((c) => c.bot)).toBe(true);
		expect(r.humanStarted).toBe(false);
	});

	it("does not throw on missing optional fields", () => {
		const r = mapOverview(
			{ number: 1, title: "t" },
			{ reviewThreads: [], comments: [], reviews: [] },
			"me",
		);
		expect(r).toMatchObject({
			number: 1,
			title: "t",
			reviews: [],
			checks: [],
			threads: [],
			mergeable: "UNKNOWN",
			state: "OPEN",
		});
	});

	it("fails closed when the GraphQL connections are missing", () => {
		expect(() => mapOverview(view(), null, VIEWER)).toThrow(GhError);
		expect(() => mapOverview(view(), {}, VIEWER)).toThrow(
			"unexpected response",
		);
		expect(() =>
			mapOverview(view(), { ...graph(), reviewThreads: undefined }, VIEWER),
		).toThrow(GhError);
	});

	it("rejects a non-object view", () => {
		expect(() => mapOverview("nope", graph(), VIEWER)).toThrow(
			"unexpected response",
		);
	});
});
