import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewThread, threadComment } from "../../test/fake-gh/scenario";
import { GhError } from "./errors";
import { mapComments, mapOverview, mapThreads, withContent } from "./overview";

/** The overview and its threads, as one read used to give them. */
const withThreads = (
	view: unknown,
	graph: unknown,
	viewer: string,
	asOf?: string,
) => ({
	...mapOverview(view, graph, viewer, asOf),
	threads: mapThreads((graph as { reviewThreads: unknown[] }).reviewThreads, {
		asOf,
		prAuthor: "octo-author",
		viewer,
	}),
});

interface Actor {
	login: string;
	__typename?: string;
}
interface Review {
	author: Actor;
	state: string;
	submittedAt: string;
}
interface Comment {
	author: Actor;
	createdAt: string;
}
interface Thread {
	isResolved: boolean;
	first: { nodes: { bodyText?: string; bodyHTML?: string; body?: string }[] };
	comments: { totalCount?: number; nodes: { author: Actor }[] };
}

const load = <T>(name: string): T =>
	JSON.parse(readFileSync(`test/fixtures/gh/${name}`, "utf8"));
const view = () => load("pr-view.json");
const graph = () => {
	const activity = load<{ comments: Comment[]; reviews: Review[] }>(
		"pr-activity.json",
	);
	return {
		bodyHTML: "<h2>Widget cache</h2><p>Caches widgets.</p>",
		reviewThreads: load<Thread[]>("review-threads.json"),
		comments: activity.comments,
		reviews: activity.reviews,
	};
};
// The viewer's login has an underscore; callers may pass the login or its slug.
const VIEWER = "jdoe_acme";
/** The threads' context with no PR author or viewer. */
const CTX = { prAuthor: "", viewer: "" };

describe("mapOverview", () => {
	const o = withThreads(view(), graph(), VIEWER);

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
				bot: false,
			},
			{
				author: "jdoe_acme",
				state: "CHANGES_REQUESTED",
				opinion: "CHANGES_REQUESTED",
				submittedAt: "2026-01-03T10:00:00Z",
				you: true,
				bot: false,
			},
			{
				author: "github-actions",
				state: "COMMENTED",
				submittedAt: "2026-01-02T11:00:00Z",
				you: false,
				bot: true,
			},
		]);
	});

	it("recognises the viewer by login or by slug", () => {
		for (const viewer of ["jdoe_acme", "jdoe-acme", "JDoe_Acme"]) {
			const r = withThreads(view(), graph(), viewer);
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

	it("lists every thread, latest activity first, with bot, reply and resolved flags", () => {
		expect(o.threads).toEqual([
			{
				id: "",
				loaded: true,
				path: "src/cache.ts",
				anchor: {
					path: "src/cache.ts",
					commit: "",
					side: "RIGHT",
					line: 42,
					startSide: "RIGHT",
					startLine: 42,
					at: "2026-01-03T09:00:00Z",
				},
				// The author replied last: back to the reviewer.
				attention: ["rev1"],
				yourTurn: false,
				line: 42,
				currentLine: 42,
				excerpt: "Should this expire?",
				html: '<p dir="auto">Should this <strong>expire</strong>?</p>',
				body: "",
				createdAt: "2026-01-03T09:00:00Z",
				lastActivityAt: "2026-01-03T11:00:00Z",
				author: "rev1",
				bot: false,
				commentCount: 2,
				hasReply: true,
				outdated: false,
				resolved: false,
				// GitHub's hunk, the fallback to the clone's (threadCode.ts).
				code: {
					anchor: {
						path: "src/cache.ts",
						commit: "",
						side: "RIGHT",
						line: 42,
						startSide: "RIGHT",
						startLine: 42,
						at: "2026-01-03T09:00:00Z",
					},
					rows: [
						expect.objectContaining({ newNo: 39, marked: false }),
						expect.objectContaining({ newNo: 40, marked: false }),
						expect.objectContaining({ newNo: 41, marked: false }),
						expect.objectContaining({ newNo: 42, marked: true }),
					],
					source: "github",
					snapshot: { same: true },
				},
			},
			{
				id: "",
				loaded: true,
				path: "src/self.ts",
				anchor: {
					path: "src/self.ts",
					commit: "",
					side: "RIGHT",
					line: 3,
					startSide: "RIGHT",
					startLine: 3,
					at: "2026-01-03T09:00:00Z",
				},
				attention: ["octo-author"],
				yourTurn: false,
				line: 3,
				currentLine: 3,
				excerpt: "First",
				html: '<p dir="auto">First</p>',
				body: "",
				createdAt: "2026-01-03T09:00:00Z",
				lastActivityAt: "2026-01-03T11:00:00Z",
				author: "rev1",
				bot: false,
				commentCount: 2,
				hasReply: false,
				outdated: false,
				resolved: false,
				code: null,
			},
			{
				id: "",
				loaded: true,
				path: "src/done.ts",
				anchor: {
					path: "src/done.ts",
					commit: "",
					side: "RIGHT",
					line: 1,
					startSide: "RIGHT",
					startLine: 1,
					at: "2026-01-03T09:00:00Z",
				},
				// Resolved: nobody.
				attention: [],
				yourTurn: false,
				line: 1,
				currentLine: 1,
				excerpt: "Nit",
				html: '<p dir="auto">Nit</p>',
				body: "",
				createdAt: "2026-01-03T09:00:00Z",
				lastActivityAt: "2026-01-03T09:00:00Z",
				author: "rev1",
				bot: false,
				commentCount: 1,
				hasReply: false,
				outdated: false,
				resolved: true,
				code: null,
			},
			{
				id: "",
				loaded: true,
				path: "src/old.ts",
				anchor: {
					path: "src/old.ts",
					commit: "",
					side: "LEFT",
					line: 7,
					startSide: "LEFT",
					startLine: 7,
					at: "2026-01-02T12:00:00Z",
				},
				// A bot never counts as the latest: the PR author.
				attention: ["octo-author"],
				yourTurn: false,
				// Outdated: where it was written.
				line: 7,
				currentLine: null,
				excerpt: "Coverage dropped",
				html: '<p dir="auto">Coverage dropped</p>',
				body: "",
				createdAt: "2026-01-02T12:00:00Z",
				lastActivityAt: "2026-01-02T12:00:00Z",
				author: "ci-bot",
				bot: true,
				commentCount: 1,
				hasReply: false,
				outdated: true,
				resolved: false,
				code: {
					anchor: expect.objectContaining({
						side: "LEFT",
						line: 7,
						startSide: "LEFT",
						startLine: 7,
					}),
					rows: expect.arrayContaining([
						{
							kind: "del",
							oldNo: 7,
							newNo: null,
							text: "  // legacy path",
							marked: true,
						},
					]),
					source: "github",
					snapshot: { same: true },
				},
			},
		]);
	});

	it("takes last activity past the first 100 comments from the latest one", () => {
		const g = graph();
		const thread = g.reviewThreads[3] as unknown as {
			latest: { nodes: { createdAt: string }[] };
		};
		thread.latest = { nodes: [{ createdAt: "2026-01-09T00:00:00Z" }] };
		const r = withThreads(view(), g, VIEWER);
		expect(r.threads[0]).toMatchObject({
			path: "src/self.ts",
			lastActivityAt: "2026-01-09T00:00:00Z",
		});
	});

	it("takes the commented range from the original lines, multi-line and across sides", () => {
		const g = graph();
		const t = g.reviewThreads[0] as unknown as Record<string, unknown>;
		Object.assign(t, {
			line: null,
			originalLine: 42,
			originalStartLine: 41,
			startDiffSide: "RIGHT",
		});
		expect(withThreads(view(), g, VIEWER).threads[0]).toMatchObject({
			line: 42,
			code: {
				anchor: { side: "RIGHT", startSide: "RIGHT", startLine: 41, line: 42 },
			},
		});
		Object.assign(t, { originalStartLine: 39, startDiffSide: "LEFT" });
		expect(
			withThreads(view(), g, VIEWER).threads[0]?.code?.anchor,
		).toMatchObject({
			startSide: "LEFT",
			startLine: 39,
		});
		// A start after the end on the same side is nonsense: just the line.
		Object.assign(t, { originalStartLine: 50, startDiffSide: "RIGHT" });
		expect(
			withThreads(view(), g, VIEWER).threads[0]?.code?.anchor,
		).toMatchObject({
			startLine: 42,
			line: 42,
		});
		// Carried forward: the header follows the code's own numbering.
		Object.assign(t, {
			line: 17,
			originalLine: 42,
			originalStartLine: null,
			startLine: 42,
		});
		expect(withThreads(view(), g, VIEWER).threads[0]).toMatchObject({
			line: 42,
			code: { anchor: { startLine: 42, line: 42 } },
		});
		// GraphQL's thread-level startLine can name a line past the current
		// one (synthetic: line 120, startLine 124, no REST start_line): just
		// the line, never a range made backwards.
		Object.assign(t, { originalLine: null, line: 120, startLine: 124 });
		expect(
			withThreads(view(), g, VIEWER).threads[0]?.code?.anchor,
		).toMatchObject({
			startLine: 120,
			line: 120,
		});
		// No original line: the current pair, both ends of it.
		Object.assign(t, { originalLine: null, line: 42, startLine: 41 });
		expect(
			withThreads(view(), g, VIEWER).threads[0]?.code?.anchor,
		).toMatchObject({
			startLine: 41,
			line: 42,
		});
		// No code: the current line.
		const noHunk = structuredClone(g);
		const nt = noHunk.reviewThreads[0] as unknown as {
			first: { nodes: { diffHunk?: string }[] };
		};
		const firstNode = nt.first.nodes[0];
		if (firstNode) firstNode.diffHunk = "";
		Object.assign(nt, { line: 17, originalLine: 30 });
		expect(withThreads(view(), noHunk, VIEWER).threads[0]).toMatchObject({
			line: 17,
			code: null,
		});
		// GitHub kept no hunk for a line comment: no rows, but the anchor on
		// its original commit, for the clone's code (threadCode.ts).
		const oid = "a".repeat(40);
		if (firstNode) Object.assign(firstNode, { originalCommit: { oid } });
		expect(withThreads(view(), noHunk, VIEWER).threads[0]).toMatchObject({
			line: 30,
			code: {
				anchor: { commit: oid, side: "RIGHT", line: 30 },
				rows: [],
				source: "github",
			},
		});
		// A file comment by subject has no code, whatever its fields say.
		Object.assign(t, { subjectType: "FILE" });
		expect(withThreads(view(), g, VIEWER).threads[0]?.code).toBeNull();
		Object.assign(t, { subjectType: "LINE" });
		// A file comment: no line, no code.
		Object.assign(t, { line: null, originalLine: null });
		expect(withThreads(view(), g, VIEWER).threads[0]).toMatchObject({
			line: null,
			code: null,
		});
	});

	it("counts a thread's comments from the total, past the 100 authors listed", () => {
		const g = graph();
		const thread = g.reviewThreads[0];
		if (!thread) throw new Error("fixture has no thread");
		thread.comments.totalCount = 140;
		expect(withThreads(view(), g, VIEWER).threads[0]?.commentCount).toBe(140);
		const { totalCount: _, ...noTotal } = thread.comments;
		thread.comments = noTotal as typeof thread.comments;
		expect(withThreads(view(), g, VIEWER).threads[0]?.commentCount).toBe(2);
	});

	it("passes the opener's markdown on for suggested changes", () => {
		const g = graph();
		const t = g.reviewThreads[0] as unknown as {
			first: { nodes: { body?: string }[] };
		};
		const node = t.first.nodes[0];
		if (node) node.body = "```suggestion\r\nx\r\n```";
		expect(withThreads(view(), g, VIEWER).threads[0]?.body).toBe(
			"```suggestion\r\nx\r\n```",
		);
	});

	it("cuts thread excerpts at 200 characters", () => {
		const g = graph();
		const first = g.reviewThreads[0]?.first.nodes[0];
		if (first) first.bodyText = "x".repeat(300);
		expect(withThreads(view(), g, VIEWER).threads[0]?.excerpt).toHaveLength(
			200,
		);
	});

	it("builds the excerpt from bodyText with whitespace collapsed, else from the body", () => {
		const g = graph();
		const first = g.reviewThreads[0]?.first.nodes[0];
		if (!first) throw new Error("fixture has no thread");
		first.bodyText = "  Line one\n\n  line\ttwo  ";
		expect(withThreads(view(), g, VIEWER).threads[0]?.excerpt).toBe(
			"Line one line two",
		);
		delete first.bodyText;
		delete first.bodyHTML;
		first.body = "Should this **expire**?";
		const t = withThreads(view(), g, VIEWER).threads[0];
		expect(t?.excerpt).toBe("Should this **expire**?");
		expect(t?.html).toBe("");
	});

	it("takes the opener's text from the aliased first comment and replies from the author list", () => {
		const g = graph();
		const thread = g.reviewThreads[0];
		if (!thread) throw new Error("fixture has no thread");
		// Without the alias, the first node of the full list still names the opener.
		const { first: _, ...noAlias } = thread;
		g.reviewThreads[0] = noAlias as typeof thread;
		const t = withThreads(view(), g, VIEWER).threads[0];
		expect(t).toMatchObject({ author: "rev1", hasReply: true, html: "" });
	});

	it("passes the description as GitHub's HTML next to the markdown", () => {
		expect(o.body).toBe("Caches widgets.\n\nFixes a slow path.");
		expect(o.bodyHtml).toBe("<h2>Widget cache</h2><p>Caches widgets.</p>");
		const g = { ...graph(), bodyHTML: undefined };
		expect(withThreads(view(), g, VIEWER).bodyHtml).toBe("");
	});

	it("humanStarted ignores the author, the viewer and bots (by __typename)", () => {
		expect(o.humanStarted).toBe(true); // rev1
		const g = graph();
		g.reviews = g.reviews.filter((r) => r.author.login !== "rev1");
		expect(withThreads(view(), g, VIEWER).humanStarted).toBe(false);
		g.comments.push({
			author: { login: "rev3", __typename: "User" },
			createdAt: "2026-01-05T00:00:00Z",
		});
		expect(withThreads(view(), g, VIEWER).humanStarted).toBe(true);
	});

	it("does not count the viewer's own underscore login as another human", () => {
		const g = graph();
		g.reviews = g.reviews.filter((r) => r.author.login !== "rev1");
		expect(withThreads(view(), g, "jdoe-acme").humanStarted).toBe(false);
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
		const r = withThreads(view(), g, VIEWER);
		expect(r.commenters.every((c) => c.bot)).toBe(true);
		expect(r.humanStarted).toBe(false);
	});

	it("does not throw on missing optional fields", () => {
		const r = withThreads(
			{ number: 1, title: "t" },
			{ bodyHTML: "", reviewThreads: [], comments: [], reviews: [] },
			"me",
		);
		expect(r).toMatchObject({
			number: 1,
			title: "t",
			bodyHtml: "",
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
			mapOverview(view(), { ...graph(), reviews: undefined }, VIEWER),
		).toThrow(GhError);
	});

	it("rejects a non-object view", () => {
		expect(() => mapOverview("nope", graph(), VIEWER)).toThrow(
			"unexpected response",
		);
	});
});

describe("mapOverview as of a cutoff", () => {
	const CUTOFF = "2026-01-03T10:30:00Z";
	const checks = [
		{
			__typename: "CheckRun",
			name: "done-before",
			status: "COMPLETED",
			conclusion: "FAILURE",
			startedAt: "2026-01-03T08:00:00Z",
			completedAt: "2026-01-03T08:05:00Z",
		},
		{
			__typename: "CheckRun",
			name: "running-then",
			status: "COMPLETED",
			conclusion: "SUCCESS",
			startedAt: "2026-01-03T10:00:00Z",
			completedAt: "2026-01-03T11:00:00Z",
		},
		{
			__typename: "CheckRun",
			name: "started-later",
			status: "COMPLETED",
			conclusion: "SUCCESS",
			startedAt: "2026-01-04T00:00:00Z",
			completedAt: "2026-01-04T00:05:00Z",
		},
		{
			__typename: "StatusContext",
			context: "status-before",
			state: "SUCCESS",
			createdAt: "2026-01-03T09:00:00Z",
		},
		{
			__typename: "StatusContext",
			context: "status-later",
			state: "SUCCESS",
			createdAt: "2026-01-05T09:00:00Z",
		},
	];
	const merged = () => ({
		...(view() as object),
		state: "MERGED",
		mergeable: "MERGEABLE",
	});
	const o = withThreads(merged(), { ...graph(), checks }, VIEWER, CUTOFF);

	it("keeps only reviews and comments made by then", () => {
		expect(o.reviews.map((r) => [r.author, r.state, r.submittedAt])).toEqual([
			["jdoe_acme", "CHANGES_REQUESTED", "2026-01-03T10:00:00Z"],
			["rev1", "CHANGES_REQUESTED", "2026-01-03T09:00:00Z"],
			["github-actions", "COMMENTED", "2026-01-02T11:00:00Z"],
		]);
		expect(o.commenters.map((c) => [c.author, c.lastAt])).toEqual([
			["octo-author", "2026-01-03T08:00:00Z"],
			["codecov", "2026-01-02T11:30:00Z"],
		]);
	});

	it("shows every thread opened by then as unresolved, counting only comments made by then", () => {
		expect(
			o.threads.map((t) => [
				t.path,
				t.commentCount,
				t.hasReply,
				t.outdated,
				t.resolved,
				t.lastActivityAt,
			]),
		).toEqual([
			// The author's reply came at 11:00, after the cutoff.
			["src/cache.ts", 1, false, false, false, "2026-01-03T09:00:00Z"],
			// Resolved today; when isn't known, so it shows.
			["src/done.ts", 1, false, false, false, "2026-01-03T09:00:00Z"],
			["src/self.ts", 1, false, false, false, "2026-01-03T09:00:00Z"],
			["src/old.ts", 1, false, false, false, "2026-01-02T12:00:00Z"],
		]);
		const g = { ...graph(), checks };
		const later = structuredClone(g.reviewThreads[0]);
		if (!later) throw new Error("no thread");
		const first = later.first.nodes[0] as { createdAt?: string };
		first.createdAt = "2026-01-03T10:31:00Z";
		g.reviewThreads.push(later);
		expect(withThreads(view(), g, VIEWER, CUTOFF).threads).toHaveLength(4);
	});

	it("never shows today's line as of a cutoff: where it was written, and no current line", () => {
		const g = { ...graph(), checks };
		// Carried forward since, no code pane.
		Object.assign(g.reviewThreads[3] as object, { line: 17, originalLine: 3 });
		const t = withThreads(view(), g, VIEWER, CUTOFF).threads.find(
			(x) => x.path === "src/self.ts",
		);
		expect(t).toMatchObject({ line: 3, currentLine: null, code: null });
		const now = withThreads(view(), graph(), VIEWER).threads.find(
			(x) => x.path === "src/self.ts",
		);
		expect(now?.currentLine).toBe(3);
	});

	it("shows the PR open, mergeability unknown, and updated at its last activity by then", () => {
		expect(o.state).toBe("OPEN");
		expect(o.mergeable).toBe("UNKNOWN");
		expect(o.updatedAt).toBe("2026-01-03T10:00:00Z");
		expect(o.asOf).toBe(CUTOFF);
	});

	it("takes the snapshot head's checks as they stood then", () => {
		expect(o.checks.map((c) => [c.name, c.status])).toEqual([
			["done-before", "failing"],
			["running-then", "pending"],
			["status-before", "passing"],
		]);
	});

	it("fails closed without the head's checks", () => {
		expect(() => withThreads(view(), graph(), VIEWER, CUTOFF)).toThrow(GhError);
	});
});

describe("mapThreads on a summary, then with its content", () => {
	const node = () => {
		const t = load<Thread[]>("review-threads.json")[0] as unknown as Record<
			string,
			unknown
		>;
		const first = (t.first as { nodes: Record<string, unknown>[] }).nodes[0];
		const { body, bodyText, bodyHTML, diffHunk, ...rest } = first ?? {};
		return {
			summary: {
				...t,
				id: "T1",
				first: {
					nodes: [{ ...rest, originalCommit: { oid: "a".repeat(40) } }],
				},
			},
			content: {
				id: "T1",
				first: { nodes: [{ body, bodyText, bodyHTML, diffHunk }] },
			},
		};
	};

	it("lists a summarised thread whole but its text and code, which are pending", () => {
		const [t] = mapThreads([node().summary], CTX);
		expect(t).toMatchObject({
			id: "T1",
			path: "src/cache.ts",
			loaded: false,
			excerpt: "",
			html: "",
			body: "",
			commentCount: 2,
			hasReply: true,
			code: {
				anchor: { path: "src/cache.ts", line: 42, commit: "a".repeat(40) },
				rows: [],
				source: "pending",
			},
		});
	});

	it("fills its text and GitHub's rows once the content is merged in", () => {
		const { summary, content } = node();
		const [t] = mapThreads([withContent(summary, content)], CTX);
		expect(t?.loaded).toBe(true);
		expect(t?.html).toContain("expire");
		expect(t?.code?.source).toBe("github");
		expect(t?.code?.rows.some((r) => r.marked)).toBe(true);
	});
});

describe("mapThreads: the attention set and the anchor", () => {
	const at = (m: number) => `2026-01-03T10:${String(m).padStart(2, "0")}:00Z`;
	const said = (login: string, m: number, extra = {}) =>
		threadComment({ login, text: `${login} ${m}`, createdAt: at(m), ...extra });
	const ctx = { prAuthor: "octo-author", viewer: "octo-cat" };
	const one = (
		node: unknown,
		over: Partial<typeof ctx> & { asOf?: string } = {},
	) => mapThreads([node], { ...ctx, ...over })[0];

	it("leaves a pending reply out of the set", () => {
		const t = one(
			reviewThread({ path: "a.ts" }, [
				said("rev", 1),
				said("octo-author", 2, { pending: true }),
			]),
		);
		expect(t?.attention).toEqual(["octo-author"]);
	});

	it("as of a cutoff, uses only the comments published by then", () => {
		const node = reviewThread({ path: "a.ts" }, [
			said("rev", 1),
			said("octo-author", 2),
			said("third", 30),
		]);
		expect(one(node, { asOf: at(10) })?.attention).toEqual(["rev"]);
		expect(one(node)?.attention.sort()).toEqual(["octo-author", "rev"]);
	});

	it("is the viewer's turn by slug: octo-cat is Octo_Cat", () => {
		const t = one(
			reviewThread({ path: "a.ts" }, [
				said("Octo_Cat", 1),
				said("octo-author", 2),
			]),
		);
		expect(t?.attention).toEqual(["Octo_Cat"]);
		expect(t?.yourTurn).toBe(true);
		const mine = one(reviewThread({ path: "a.ts" }, [said("Octo_Cat", 1)]));
		expect(mine?.attention).toEqual(["octo-author"]);
		expect(mine?.yourTurn).toBe(false);
	});

	it("a viewer who is the PR author: their turn once someone else comments", () => {
		const t = one(reviewThread({ path: "a.ts" }, [said("rev", 1)]), {
			viewer: "octo-author",
		});
		expect(t?.yourTurn).toBe(true);
	});

	it("a resolved thread waits on nobody", () => {
		const t = one(
			reviewThread({ path: "a.ts", isResolved: true }, [said("rev", 1)]),
		);
		expect(t?.attention).toEqual([]);
		expect(t?.yourTurn).toBe(false);
	});

	it("a file comment has no anchor", () => {
		const t = one(
			reviewThread({ path: "a.ts", subjectType: "FILE", line: null }, [
				said("rev", 1, { commit: "a".repeat(40) }),
			]),
		);
		expect(t?.anchor).toBeNull();
	});

	it("a line comment's anchor is the code's: GitHub's original range on the opener's commit", () => {
		const node = reviewThread(
			{
				path: "a.ts",
				line: 12,
				originalLine: 9,
				startLine: 10,
				originalStartLine: 7,
				diffSide: "LEFT",
				startDiffSide: "LEFT",
			},
			[said("rev", 1, { commit: "b".repeat(40), diffHunk: "@@ -1 +1 @@\n-x" })],
		);
		const summary = one(node);
		expect(summary?.anchor).toEqual({
			path: "a.ts",
			commit: "b".repeat(40),
			side: "LEFT",
			line: 9,
			startSide: "LEFT",
			startLine: 7,
			at: at(1),
		});
		expect(summary?.anchor).toEqual(summary?.code?.anchor);
	});

	it("uses every comment's author past the first 100 (paged in)", () => {
		const comments = [
			said("rev", 0),
			...Array.from({ length: 148 }, (_, i) =>
				said(i % 2 ? "octo-author" : "third", 1 + (i % 50)),
			),
			said("late", 59),
		];
		const node = reviewThread({ path: "a.ts" }, comments);
		expect(node.comments.totalCount).toBe(150);
		expect(one(node)?.attention.sort()).toEqual([
			"octo-author",
			"rev",
			"third",
		]);
		expect(one(node)?.commentCount).toBe(150);
	});

	it("past 100 not paged in, the latest comment still counts as the latest", () => {
		const node = reviewThread({ path: "a.ts" }, [said("rev", 1)]);
		node.comments.totalCount = 150;
		node.latest = {
			nodes: [
				{
					...said("octo-author", 50),
					author: { login: "octo-author", __typename: "User" },
				},
			],
		};
		expect(one(node)?.attention).toEqual(["rev"]);
	});
});

describe("mapComments", () => {
	const node = (
		comments: { id: string; login: string; bot?: boolean; at: string | null }[],
		extra: Record<string, unknown>[] = [],
	) => {
		const c = (x: (typeof comments)[number]) => ({
			id: x.id,
			author: { login: x.login, __typename: x.bot ? "Bot" : "User" },
			createdAt: x.at ?? "2026-01-03T23:00:00Z",
			publishedAt: x.at,
			state: x.at === null ? "PENDING" : "SUBMITTED",
		});
		return {
			summary: {
				id: "T1",
				comments: { totalCount: comments.length, nodes: comments.map(c) },
			},
			content: {
				id: "T1",
				comments: {
					totalCount: comments.length + extra.length,
					nodes: [
						...comments.map((x) => ({
							...c(x),
							body: `**${x.id}**`,
							bodyText: x.id,
							bodyHTML: `<p><strong>${x.id}</strong></p>`,
						})),
						...extra,
					],
				},
			},
		};
	};
	const thread = node([
		{ id: "c1", login: "rev", at: "2026-01-03T09:00:00Z" },
		{ id: "c2", login: "ci", bot: true, at: "2026-01-03T10:00:00Z" },
		{ id: "c3", login: "octo-author", at: "2026-01-03T12:00:00Z" },
		{ id: "c4", login: "Octo_Cat", at: null },
	]);

	it("gives every comment oldest first, a bot flagged, the pending one marked", () => {
		const comments = mapComments(thread.summary, thread.content);
		expect(comments.map((c) => [c.id, c.author, c.bot, c.pending])).toEqual([
			["c1", "rev", false, false],
			["c2", "ci", true, false],
			["c3", "octo-author", false, false],
			["c4", "Octo_Cat", false, true],
		]);
		expect(comments[0]).toEqual({
			id: "c1",
			author: "rev",
			bot: false,
			publishedAt: "2026-01-03T09:00:00Z",
			pending: false,
			html: "<p><strong>c1</strong></p>",
			body: "**c1**",
			text: "c1",
		});
		expect(comments[3]?.publishedAt).toBeNull();
	});

	it("as of a cutoff: only those published by then, none pending", () => {
		const comments = mapComments(
			thread.summary,
			thread.content,
			"2026-01-03T11:00:00Z",
		);
		expect(comments.map((c) => c.id)).toEqual(["c1", "c2"]);
	});

	it("leaves out a comment added after the summary: the count agrees", () => {
		const t = node(
			[{ id: "c1", login: "rev", at: "2026-01-03T09:00:00Z" }],
			[
				{
					id: "late",
					author: { login: "x", __typename: "User" },
					createdAt: "2026-01-04T00:00:00Z",
					publishedAt: "2026-01-04T00:00:00Z",
					state: "SUBMITTED",
					bodyText: "late",
				},
			],
		);
		expect(mapComments(t.summary, t.content).map((c) => c.id)).toEqual(["c1"]);
	});
});
