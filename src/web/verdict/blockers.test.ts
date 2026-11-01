import { describe, expect, it } from "vitest";
import type {
	PrOverview,
	ReviewThread,
	VerdictFacts,
} from "../../shared/types";
import {
	type BlockerRow,
	blockerCount,
	blockers,
	githubStatus,
	THREADS_SHOWN,
} from "./blockers";

const PR = "https://github.com/acme/widget/pull/12";

const overview = (more: Partial<PrOverview> = {}): PrOverview => ({
	title: "t",
	number: 12,
	url: PR,
	author: "alice",
	body: "",
	bodyHtml: "",
	isDraft: false,
	state: "OPEN",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	baseBranch: "main",
	headBranch: "f",
	mergeable: "MERGEABLE",
	requestedReviewers: [],
	reviews: [],
	commenters: [],
	humanStarted: false,
	youAuthor: false,
	checks: [],
	writes: "on",
	commentLeft: true,
	pendingReview: null,
	readId: "r1",
	fetchedAt: "2026-01-01T00:00:00Z",
	servedAt: "2026-01-01T00:00:00Z",
	...more,
});

const facts = (more: Partial<VerdictFacts> = {}): VerdictFacts => ({
	mergeStateStatus: "CLEAN",
	reviewDecision: null,
	checks: [],
	rule: { approvals: 0, codeOwners: false, strict: false },
	codeOwnerRequests: [],
	reviews: [],
	head: "h".repeat(40),
	fetchedAt: "2026-01-01T00:00:00Z",
	...more,
});

const check = (
	name: string,
	status: "failing" | "pending" | "passing",
	required: boolean | null,
) => ({ name, status, required, url: `https://ci/${name}` });

const review = (
	author: string,
	state: VerdictFacts["reviews"][number]["state"],
	more: Partial<VerdictFacts["reviews"][number]> = {},
) => ({
	author,
	state,
	submittedAt: "2026-01-02T00:00:00Z",
	commitId: "h".repeat(40),
	you: false,
	bot: false,
	...more,
});

function thread(id: string, more: Partial<ReviewThread> = {}): ReviewThread {
	return {
		id,
		loaded: true,
		path: `src/${id}.ts`,
		line: 3,
		currentLine: 3,
		excerpt: `About ${id}`,
		html: "",
		body: "",
		createdAt: "2026-01-01T00:00:00Z",
		lastActivityAt: "2026-01-01T00:00:00Z",
		author: "maya",
		bot: false,
		avatarUrl: "",
		participants: [],
		commentCount: 1,
		hasReply: false,
		outdated: false,
		resolved: false,
		code: null,
		anchor: null,
		commit: "",
		subject: "line",
		attention: [],
		yourTurn: false,
		viewerCan: { reply: true, resolve: true, unresolve: true },
		...more,
	};
}

const texts = (rows: BlockerRow[]) => rows.map((r) => r.text);
const tagged = (rows: BlockerRow[]) =>
	rows.filter((r) => r.required).map((r) => r.text);

describe("blockers", () => {
	it("lists GitHub's requirements first, tagged and red, then the rest in yellow", () => {
		const rows = blockers(
			facts({
				mergeStateStatus: "BLOCKED",
				reviewDecision: "CHANGES_REQUESTED",
				checks: [
					check("e2e", "pending", false),
					check("jira", "failing", true),
					check("lint", "failing", false),
					check("deploy", "pending", true),
					check("unit", "passing", true),
				],
				reviews: [review("ravi", "CHANGES_REQUESTED")],
			}),
			overview(),
			[thread("a")],
			"octo",
		);
		expect(texts(rows)).toEqual([
			"jira failing",
			"deploy running",
			"Changes requested by ravi",
			"lint failing",
			"e2e running",
			"About a",
			"1 check passing · no conflicts",
		]);
		expect(tagged(rows)).toEqual([
			"jira failing",
			"deploy running",
			"Changes requested by ravi",
		]);
		const tone = (t: string) => rows.find((r) => r.text === t)?.tone;
		expect(tone("jira failing")).toBe("bad");
		// Running, required: tagged, still yellow.
		expect(tone("deploy running")).toBe("warn");
		// Not required: never red.
		expect(tone("lint failing")).toBe("warn");
		expect(rows.find((r) => r.text === "jira failing")?.href).toBe(
			"https://ci/jira",
		);
		expect(rows.find((r) => r.text === "About a")).toMatchObject({
			kind: "thread",
			threadId: "a",
			detail: "src/a.ts:3",
			who: "maya",
		});
	});

	it("lists a failing required check once, as a required row", () => {
		const rows = blockers(
			facts({
				mergeStateStatus: "BLOCKED",
				checks: [check("jira", "failing", true)],
			}),
			overview(),
			[],
			"octo",
		);
		expect(rows.filter((r) => r.text.includes("jira"))).toHaveLength(1);
		expect(blockerCount(rows)).toBe(1);
	});

	it("tags no check GitHub's flag isn't known for (as of a cutoff), and claims none not required", () => {
		const rows = blockers(
			facts({
				mergeStateStatus: null,
				rule: null,
				checks: [check("jira", "failing", null)],
			}),
			overview({ asOf: "2026-01-03T00:00:00Z" }),
			[],
			"octo",
		);
		const row = rows.find((r) => r.text === "jira failing");
		expect(row?.required).toBe(false);
		expect(row?.tone).toBe("warn");
	});

	it("says review required, or N of M approvals when the rule is known", () => {
		const unknown = blockers(
			facts({
				mergeStateStatus: "BLOCKED",
				reviewDecision: "REVIEW_REQUIRED",
				rule: null,
			}),
			overview(),
			[],
			"octo",
		);
		expect(tagged(unknown)).toEqual(["Review required"]);
		const known = blockers(
			facts({
				mergeStateStatus: "BLOCKED",
				reviewDecision: "REVIEW_REQUIRED",
				rule: { approvals: 2, codeOwners: false, strict: false },
				reviews: [review("maya", "APPROVED")],
			}),
			overview(),
			[],
			"octo",
		);
		expect(tagged(known)).toEqual(["1 of 2 approvals"]);
		expect(known.at(-1)?.text).toContain("maya approved");
	});

	it("tags code owners only when the rule requires them; unknown, a detail of review required", () => {
		const owners = [{ name: "acme/platform", team: true }];
		const required = blockers(
			facts({
				mergeStateStatus: "BLOCKED",
				reviewDecision: "REVIEW_REQUIRED",
				rule: { approvals: 1, codeOwners: true, strict: false },
				codeOwnerRequests: owners,
			}),
			overview({ requestedReviewers: [{ name: "acme/platform", team: true }] }),
			[],
			"octo",
		);
		expect(tagged(required)).toEqual([
			"0 of 1 approvals",
			"@acme/platform · code owner",
		]);
		// Once: not again as a requested reviewer.
		expect(texts(required).filter((t) => t.includes("platform"))).toHaveLength(
			1,
		);
		const unknown = blockers(
			facts({
				mergeStateStatus: "BLOCKED",
				reviewDecision: "REVIEW_REQUIRED",
				rule: null,
				codeOwnerRequests: owners,
			}),
			overview(),
			[],
			"octo",
		);
		expect(unknown[0]).toMatchObject({
			text: "Review required",
			detail: "@acme/platform · code owner",
			required: true,
		});
		expect(texts(unknown).filter((t) => t.includes("platform"))).toHaveLength(
			0,
		);
		const notRequired = blockers(
			facts({ codeOwnerRequests: owners }),
			overview(),
			[],
			"octo",
		);
		expect(notRequired[0]).toMatchObject({
			text: "@acme/platform · code owner",
			required: false,
			tone: "warn",
		});
	});

	it("lists the branch's states: conflicts, behind, draft", () => {
		const of = (state: VerdictFacts["mergeStateStatus"]) =>
			tagged(blockers(facts({ mergeStateStatus: state }), overview(), [], "o"));
		expect(of("DIRTY")).toEqual(["Conflicts with main"]);
		expect(of("BEHIND")).toEqual(["Branch is behind main"]);
		expect(of("DRAFT")).toEqual(["Draft"]);
		// Blocked with no reason given: said, not left out.
		expect(of("BLOCKED")).toEqual(["Blocked by a branch rule"]);
		const dirty = blockers(
			facts({ mergeStateStatus: "DIRTY" }),
			overview(),
			[],
			"o",
		);
		expect(dirty[0]).toMatchObject({ kind: "branch", href: PR, tone: "bad" });
	});

	it("lists requested reviewers who haven't answered, not those in a required row", () => {
		const rows = blockers(
			facts({
				mergeStateStatus: "BLOCKED",
				reviewDecision: "CHANGES_REQUESTED",
				reviews: [
					review("ravi", "CHANGES_REQUESTED"),
					review("li", "COMMENTED"),
				],
			}),
			overview({
				requestedReviewers: [
					{ name: "ravi", team: false },
					{ name: "maya", team: false },
					{ name: "li", team: false },
					{ name: "acme/core", team: true },
				],
			}),
			[],
			"octo",
		);
		expect(texts(rows).filter((t) => t.startsWith("Waiting"))).toEqual([
			"Waiting on maya",
			"Waiting on @acme/core",
		]);
	});

	it("lists the reviewer's own threads first, bots counted apart, and folds after five", () => {
		const list = [
			thread("b1", { bot: true, author: "ci-bot" }),
			thread("m1"),
			thread("m2"),
			thread("o1", { author: "Octo_Cat" }),
			thread("m3"),
			thread("m4"),
			thread("m5"),
			thread("o2", { author: "octo-cat" }),
			thread("r1", { resolved: true }),
			thread("u1", { unavailable: "unreadable" }),
			thread("b2", { bot: true, author: "ci-bot" }),
		];
		// The viewer is a slug: "Octo_Cat" is "octo-cat".
		const rows = blockers(facts(), overview(), list, "octo-cat");
		const threadRows = rows.filter((r) => r.kind === "thread");
		expect(threadRows.map((r) => r.threadId ?? r.text)).toEqual([
			"o1",
			"o2",
			"m1",
			"m2",
			"m3",
			"2 unresolved bot threads",
		]);
		expect(threadRows[0]?.who).toBe("you");
		const more = rows.find((r) => r.kind === "more");
		expect(more?.text).toBe("2 more");
		expect(more?.more?.map((r) => r.threadId)).toEqual(["m4", "m5"]);
		expect(THREADS_SHOWN).toBe(5);
		// Folded ones still count.
		expect(blockerCount(rows)).toBe(8);
	});

	it("says the approvals requirement is unknown when GitHub doesn't tell", () => {
		const rows = blockers(
			facts({ mergeStateStatus: "CLEAN", rule: null, reviewDecision: null }),
			overview(),
			[],
			"octo",
		);
		expect(rows.find((r) => r.tone === "unknown")?.text).toBe(
			"Required approvals unknown",
		);
		expect(blockerCount(rows)).toBe(0);
	});

	it("says ready to merge only when nothing is unmet and GitHub says CLEAN or HAS_HOOKS", () => {
		const fine = facts({
			checks: [check("unit", "passing", true), check("lint", "passing", false)],
			reviews: [review("maya", "APPROVED")],
		});
		for (const state of ["CLEAN", "HAS_HOOKS"] as const) {
			const rows = blockers(
				{ ...fine, mergeStateStatus: state },
				overview(),
				[],
				"o",
			);
			expect(rows).toEqual([
				expect.objectContaining({
					kind: "ready",
					tone: "ok",
					text: "Ready to merge",
					href: PR,
					detail: "2 checks passing · maya approved · no conflicts",
				}),
			]);
		}
		// The rule unreadable and nothing listed as required: not ready by
		// an empty list alone.
		for (const state of ["UNKNOWN", null] as const) {
			const rows = blockers(
				{ ...fine, mergeStateStatus: state, rule: null },
				overview(),
				[],
				"o",
			);
			expect(rows.some((r) => r.kind === "ready")).toBe(false);
			expect(rows.at(-1)?.kind).toBe("summary");
		}
		// Something not required unmet: not ready either.
		const thread1 = blockers(fine, overview(), [thread("a")], "o");
		expect(thread1.some((r) => r.kind === "ready")).toBe(false);
	});

	it("lists nothing for a merged or closed PR", () => {
		const all = facts({
			mergeStateStatus: null,
			checks: [check("jira", "failing", true)],
		});
		expect(
			blockers(all, overview({ state: "MERGED" }), [thread("a")], "o"),
		).toEqual([]);
		expect(
			blockers(all, overview({ state: "CLOSED" }), [thread("a")], "o"),
		).toEqual([]);
	});
});

describe("githubStatus", () => {
	const of = (
		state: VerdictFacts["mergeStateStatus"],
		more: Partial<VerdictFacts> = {},
	) =>
		githubStatus(facts({ mergeStateStatus: state, ...more }), overview()).text;

	it("maps every merge state", () => {
		expect(of("CLEAN")).toBe("GitHub: ready to merge");
		expect(of("HAS_HOOKS")).toBe("GitHub: ready to merge");
		expect(of("BLOCKED")).toBe("GitHub: blocked");
		expect(of("DIRTY")).toBe("GitHub: blocked");
		expect(of("BEHIND")).toBe("GitHub: blocked");
		expect(of("DRAFT")).toBe("GitHub: blocked");
		expect(of("UNKNOWN")).toBe("GitHub: checking…");
		expect(of(null)).toBe("GitHub: unknown");
		expect(of("UNSTABLE")).toBe("GitHub: ready to merge");
		expect(of("UNSTABLE", { checks: [check("jira", "failing", true)] })).toBe(
			"GitHub: blocked",
		);
	});

	it("waits when only required checks still run", () => {
		const running = [check("e2e", "pending", true)];
		expect(of("BLOCKED", { checks: running })).toBe("GitHub: waiting");
		expect(of("UNSTABLE", { checks: running })).toBe("GitHub: waiting");
		expect(
			of("BLOCKED", { checks: running, reviewDecision: "REVIEW_REQUIRED" }),
		).toBe("GitHub: blocked");
		expect(
			of("BLOCKED", {
				checks: [...running, check("jira", "failing", true)],
			}),
		).toBe("GitHub: blocked");
	});

	it("says merged, closed, or as of the cutoff", () => {
		const f = facts({ mergeStateStatus: null });
		expect(githubStatus(f, overview({ state: "MERGED" })).text).toBe("Merged");
		expect(githubStatus(f, overview({ state: "CLOSED" })).text).toBe("Closed");
		expect(githubStatus(f, overview({ asOf: "2026-01-03T00:00:00Z" }))).toEqual(
			{ tone: "asof", text: "As of", asOf: "2026-01-03T00:00:00Z" },
		);
	});
});
