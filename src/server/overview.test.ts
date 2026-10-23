import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapOverview } from "./overview";

const load = (name: string): unknown =>
	JSON.parse(readFileSync(`test/fixtures/gh/${name}`, "utf8"));
const view = () => load("pr-view.json") as Record<string, unknown>;
const threads = () => load("review-threads.json");

describe("mapOverview", () => {
	const o = mapOverview(view(), threads(), "me");

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

	it("keeps the latest review per reviewer, newest first, and marks you", () => {
		expect(o.reviews).toEqual([
			{
				author: "rev1",
				state: "APPROVED",
				submittedAt: "2026-01-04T09:00:00Z",
				you: false,
			},
			{
				author: "me",
				state: "CHANGES_REQUESTED",
				submittedAt: "2026-01-03T10:00:00Z",
				you: true,
			},
			{
				author: "ci-bot[bot]",
				state: "COMMENTED",
				submittedAt: "2026-01-02T11:00:00Z",
				you: false,
			},
		]);
	});

	it("lists commenters with last time, bot and you flags", () => {
		expect(o.commenters).toEqual([
			{ author: "me", lastAt: "2026-01-04T10:00:00Z", bot: false, you: true },
			{
				author: "ci-bot[bot]",
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
		]);
	});

	it("cuts thread excerpts at 200 characters", () => {
		const t = threads() as any;
		t.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].body =
			"x".repeat(300);
		expect(mapOverview(view(), t, "me").threads[0]?.excerpt).toHaveLength(200);
	});

	it("humanStarted ignores the author, the viewer and bots", () => {
		expect(o.humanStarted).toBe(true); // rev1
		const v = view() as any;
		v.reviews = v.reviews.filter((r: any) => r.author.login !== "rev1");
		expect(mapOverview(v, threads(), "me").humanStarted).toBe(false);
		v.comments.push({
			author: { login: "rev3" },
			createdAt: "2026-01-05T00:00:00Z",
		});
		expect(mapOverview(v, threads(), "me").humanStarted).toBe(true);
	});

	it("treats app/ logins as bots", () => {
		const v = view() as any;
		v.comments = [
			{
				author: { login: "app/dependabot" },
				createdAt: "2026-01-05T00:00:00Z",
			},
		];
		v.reviews = [];
		const r = mapOverview(v, threads(), "me");
		expect(r.commenters[0]?.bot).toBe(true);
		expect(r.humanStarted).toBe(false);
	});

	it("does not throw on missing optional fields", () => {
		const r = mapOverview({ number: 1, title: "t" }, null, "me");
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

	it("rejects a non-object view", () => {
		expect(() => mapOverview("nope", null, "me")).toThrow(
			"unexpected response",
		);
	});
});
