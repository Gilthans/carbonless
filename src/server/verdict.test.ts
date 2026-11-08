import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../../test/fake-gh/atomic.mjs";
import { prView, release, type Scenario } from "../../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import type {
	RereviewAnswer,
	VerdictFacts,
	VerdictRequest,
} from "../shared/types";
import { GhError, WriteRefusedError } from "./errors";
import {
	dismissReview,
	type RestAnswer,
	type RestReview,
	type RuleReads,
	type VerdictRead,
} from "./gh";
import { markerFor } from "./marker";
import { parseHead } from "./pinnedHead";
import { Session } from "./session";
import { writeWaits } from "./threadWrites";
import {
	ATTEMPT_SLACK_MS,
	findLanded,
	mapVerdict,
	ruleOf,
	sinceOf,
	sinceTarget,
	standingOpinion,
	verdictBody,
	verdictProblem,
} from "./verdict";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const user = (login: string, bot = false) => ({
	login,
	__typename: bot ? "Bot" : "User",
});
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

describe("mapVerdict", () => {
	const read = (pr: Record<string, unknown> | null = {}): VerdictRead => ({
		pr: pr && {
			state: "OPEN",
			mergeStateStatus: "BLOCKED",
			reviewDecision: "CHANGES_REQUESTED",
			...pr,
		},
		reviews: [],
		checks: [],
		head: HEAD,
	});
	const RULE = { approvals: 1, codeOwners: false, strict: true };
	const map = (r: VerdictRead, asOf?: string) =>
		mapVerdict({
			read: r,
			rule: RULE,
			viewer: "octo-cat",
			asOf,
			fetchedAt: "2026-11-01T00:00:00Z",
		});

	it("passes every mergeStateStatus and reviewDecision through; anything else is null", () => {
		for (const status of [
			"BEHIND",
			"BLOCKED",
			"CLEAN",
			"DIRTY",
			"DRAFT",
			"HAS_HOOKS",
			"UNKNOWN",
			"UNSTABLE",
		]) {
			expect(map(read({ mergeStateStatus: status })).mergeStateStatus).toBe(
				status,
			);
		}
		for (const decision of [
			"APPROVED",
			"CHANGES_REQUESTED",
			"REVIEW_REQUIRED",
		]) {
			expect(map(read({ reviewDecision: decision })).reviewDecision).toBe(
				decision,
			);
		}
		const odd = map(read({ mergeStateStatus: "SOON", reviewDecision: null }));
		expect(odd.mergeStateStatus).toBeNull();
		expect(odd.reviewDecision).toBeNull();
		expect(map(read()).rule).toEqual(RULE);
		expect(map(read()).head).toBe(HEAD);
	});

	it("maps each check as the overview does, with GitHub's isRequired (unknown: null), failing first", () => {
		const facts = map({
			...read(),
			checks: [
				{
					__typename: "CheckRun",
					name: "build",
					status: "COMPLETED",
					conclusion: "SUCCESS",
					detailsUrl: "https://ci/build",
					isRequired: true,
				},
				{
					__typename: "StatusContext",
					context: "jira",
					state: "FAILURE",
					targetUrl: "https://ci/jira",
					isRequired: true,
				},
				{
					__typename: "CheckRun",
					name: "slow",
					status: "IN_PROGRESS",
					conclusion: null,
					isRequired: false,
				},
				{
					__typename: "StatusContext",
					context: "lint",
					state: "SUCCESS",
				},
			],
		});
		expect(facts.checks).toEqual([
			{
				name: "jira",
				status: "failing",
				url: "https://ci/jira",
				required: true,
			},
			{ name: "slow", status: "pending", required: false },
			{
				name: "build",
				status: "passing",
				url: "https://ci/build",
				required: true,
			},
			{ name: "lint", status: "passing", required: null },
		]);
	});

	it("each reviewer's latest opinionated review with its commit, newest first; pending ones left out", () => {
		const facts = map({
			...read(),
			reviews: [
				{
					author: user("ravi"),
					state: "APPROVED",
					submittedAt: "2026-01-02T00:00:00Z",
					commit: { oid: OLD },
				},
				{
					author: user("ravi"),
					state: "CHANGES_REQUESTED",
					submittedAt: "2026-01-03T00:00:00Z",
					commit: { oid: HEAD },
				},
				{
					author: user("Octo_Cat"),
					state: "APPROVED",
					submittedAt: "2026-01-01T00:00:00Z",
					commit: { oid: OLD },
				},
				{ author: user("Octo_Cat"), state: "PENDING", submittedAt: null },
				{
					author: user("renovate", true),
					state: "COMMENTED",
					submittedAt: "2026-01-04T00:00:00Z",
				},
			],
		});
		expect(facts.reviews).toEqual([
			{
				author: "renovate",
				state: "COMMENTED",
				submittedAt: "2026-01-04T00:00:00Z",
				commitId: "",
				you: false,
				bot: true,
			},
			{
				author: "ravi",
				state: "CHANGES_REQUESTED",
				submittedAt: "2026-01-03T00:00:00Z",
				commitId: HEAD,
				you: false,
				bot: false,
			},
			{
				author: "Octo_Cat",
				state: "APPROVED",
				submittedAt: "2026-01-01T00:00:00Z",
				commitId: OLD,
				you: true,
				bot: false,
			},
		]);
	});

	it("a reply after an approval (a COMMENTED review) leaves the approval: the opinion's time and commit", () => {
		const reviews = [
			{
				author: user("ravi"),
				state: "APPROVED",
				submittedAt: "2026-01-02T00:00:00Z",
				commit: { oid: OLD },
			},
			{
				author: user("ravi"),
				state: "COMMENTED",
				submittedAt: "2026-01-03T00:00:00Z",
				commit: { oid: HEAD },
			},
			{
				author: user("dima"),
				state: "COMMENTED",
				submittedAt: "2026-01-01T00:00:00Z",
				commit: { oid: OLD },
			},
			{
				author: user("dima"),
				state: "COMMENTED",
				submittedAt: "2026-01-04T00:00:00Z",
				commit: { oid: HEAD },
			},
			{
				author: user("Octo_Cat"),
				state: "CHANGES_REQUESTED",
				submittedAt: "2026-01-05T00:00:00Z",
				commit: { oid: HEAD },
			},
			{
				author: user("Octo_Cat"),
				state: "COMMENTED",
				submittedAt: "2026-01-06T00:00:00Z",
				commit: { oid: HEAD },
			},
		];
		const brief = (facts: VerdictFacts) =>
			facts.reviews.map((r) => [r.author, r.state, r.submittedAt, r.commitId]);
		expect(brief(map({ ...read(), reviews }))).toEqual([
			["Octo_Cat", "CHANGES_REQUESTED", "2026-01-05T00:00:00Z", HEAD],
			// Only replies: their latest comment.
			["dima", "COMMENTED", "2026-01-04T00:00:00Z", HEAD],
			["ravi", "APPROVED", "2026-01-02T00:00:00Z", OLD],
		]);
		// As of a cutoff, by the same rule among the reviews made by then.
		expect(
			brief(map({ ...read(), pr: null, reviews }, "2026-01-03T12:00:00Z")),
		).toEqual([
			["ravi", "APPROVED", "2026-01-02T00:00:00Z", OLD],
			["dima", "COMMENTED", "2026-01-01T00:00:00Z", OLD],
		]);
	});

	it("a dismissed review followed by a comment reads as the comment; a dismissal after the comment, or no comment, as dismissed", () => {
		const reviews = [
			// Octo_Cat requested changes, then commented (Comment withdrew it).
			{
				author: user("Octo_Cat"),
				state: "DISMISSED",
				submittedAt: "2026-01-01T00:00:00Z",
				commit: { oid: OLD },
				url: "https://github.com/acme/widget/pull/12#pullrequestreview-1",
			},
			{
				author: user("Octo_Cat"),
				state: "COMMENTED",
				submittedAt: "2026-01-02T00:00:00Z",
				commit: { oid: HEAD },
				url: "https://github.com/acme/widget/pull/12#pullrequestreview-2",
			},
			// ravi's approval dismissed by someone else, no comment after it.
			{
				author: user("ravi"),
				state: "COMMENTED",
				submittedAt: "2026-01-01T00:00:00Z",
				commit: { oid: OLD },
			},
			{
				author: user("ravi"),
				state: "DISMISSED",
				submittedAt: "2026-01-03T00:00:00Z",
				commit: { oid: HEAD },
			},
			// dima approved again after a withdrawn opinion: the approval.
			{
				author: user("dima"),
				state: "DISMISSED",
				submittedAt: "2026-01-01T00:00:00Z",
				commit: { oid: OLD },
			},
			{
				author: user("dima"),
				state: "COMMENTED",
				submittedAt: "2026-01-02T00:00:00Z",
				commit: { oid: OLD },
			},
			{
				author: user("dima"),
				state: "APPROVED",
				submittedAt: "2026-01-04T00:00:00Z",
				commit: { oid: HEAD },
			},
		];
		const facts = map({ ...read(), reviews });
		expect(
			facts.reviews.map((r) => [r.author, r.state, r.submittedAt, r.url]),
		).toEqual([
			["dima", "APPROVED", "2026-01-04T00:00:00Z", undefined],
			["ravi", "DISMISSED", "2026-01-03T00:00:00Z", undefined],
			[
				"Octo_Cat",
				"COMMENTED",
				"2026-01-02T00:00:00Z",
				"https://github.com/acme/widget/pull/12#pullrequestreview-2",
			],
		]);
	});

	it("yourVerdict: the viewer's opinion, else their latest Comment with a message; a review comment posted alone is no verdict", () => {
		const mine = (
			state: string,
			submittedAt: string,
			body: string,
			oid = HEAD,
		) => ({
			author: user("Octo_Cat"),
			state,
			submittedAt,
			body,
			commit: { oid },
		});
		// A Comment verdict on OLD, then a review comment on HEAD (a
		// COMMENTED review with no message): the verdict stays OLD's.
		const commented = map({
			...read(),
			reviews: [
				mine("COMMENTED", "2026-01-01T00:00:00Z", "Two questions", OLD),
				mine("COMMENTED", "2026-01-02T00:00:00Z", ""),
			],
		});
		expect(commented.reviews[0]).toMatchObject({ commitId: HEAD });
		expect(commented.yourVerdict).toMatchObject({
			state: "COMMENTED",
			commitId: OLD,
			submittedAt: "2026-01-01T00:00:00Z",
		});
		// An approval stands through later comments of either kind.
		const approved = map({
			...read(),
			reviews: [
				mine("APPROVED", "2026-01-01T00:00:00Z", "", OLD),
				mine("COMMENTED", "2026-01-02T00:00:00Z", "A nit"),
			],
		});
		expect(approved.yourVerdict).toMatchObject({
			state: "APPROVED",
			commitId: OLD,
		});
		// Withdrawn by a Comment (dismissed, then the comment): the comment.
		const withdrawn = map({
			...read(),
			reviews: [
				mine("DISMISSED", "2026-01-01T00:00:00Z", "", OLD),
				mine("COMMENTED", "2026-01-02T00:00:00Z", "Not yet"),
			],
		});
		expect(withdrawn.yourVerdict).toMatchObject({ state: "COMMENTED" });
		// Only review comments, or nothing of the viewer's: no verdict.
		expect(
			map({
				...read(),
				reviews: [
					mine("COMMENTED", "2026-01-02T00:00:00Z", " "),
					{
						...mine("APPROVED", "2026-01-03T00:00:00Z", ""),
						author: user("ravi"),
					},
				],
			}).yourVerdict,
		).toBeNull();
	});

	it("a request for changes withdrawn by a comment in the same second reads as the comment", () => {
		const facts = map({
			...read(),
			reviews: [
				{
					author: user("Octo_Cat"),
					state: "DISMISSED",
					submittedAt: "2026-01-01T00:00:00Z",
					commit: { oid: HEAD },
				},
				{
					author: user("Octo_Cat"),
					state: "COMMENTED",
					submittedAt: "2026-01-01T00:00:00Z",
					commit: { oid: HEAD },
				},
			],
		});
		expect(facts.reviews.map((r) => r.state)).toEqual(["COMMENTED"]);
	});

	it("code-owner requests only, users and teams", () => {
		const facts = map(
			read({
				reviewRequests: {
					nodes: [
						{
							asCodeOwner: true,
							requestedReviewer: {
								__typename: "Team",
								name: "platform",
								slug: "platform",
							},
						},
						{
							asCodeOwner: true,
							requestedReviewer: { __typename: "User", login: "dima" },
						},
						{
							asCodeOwner: false,
							requestedReviewer: { __typename: "User", login: "badyan" },
						},
					],
				},
			}),
		);
		expect(facts.codeOwnerRequests).toEqual([
			{ name: "platform", team: true },
			{ name: "dima", team: false },
		]);
	});

	it("as of a cutoff: GitHub's present-only facts are null, checks and reviews as of then", () => {
		const facts = map(
			{
				pr: null,
				reviews: [
					{
						author: user("ravi"),
						state: "APPROVED",
						submittedAt: "2026-01-02T00:00:00Z",
						commit: { oid: OLD },
					},
					{
						author: user("ravi"),
						state: "CHANGES_REQUESTED",
						submittedAt: "2026-01-09T00:00:00Z",
						commit: { oid: HEAD },
					},
				],
				checks: [
					{
						__typename: "CheckRun",
						name: "build",
						status: "COMPLETED",
						conclusion: "FAILURE",
						startedAt: "2026-01-02T00:00:00Z",
						completedAt: "2026-01-09T00:00:00Z",
						isRequired: true,
					},
					{
						__typename: "CheckRun",
						name: "later",
						status: "COMPLETED",
						conclusion: "SUCCESS",
						startedAt: "2026-01-08T00:00:00Z",
						completedAt: "2026-01-08T00:01:00Z",
					},
				],
				head: OLD,
			},
			"2026-01-05T00:00:00Z",
		);
		expect(facts).toMatchObject({
			mergeStateStatus: null,
			reviewDecision: null,
			rule: null,
			codeOwnerRequests: [],
			head: OLD,
		});
		// Finished after the cutoff: still running then; never required.
		expect(facts.checks).toEqual([
			{ name: "build", status: "pending", required: null },
		]);
		expect(facts.reviews.map((r) => [r.author, r.state])).toEqual([
			["ravi", "APPROVED"],
		]);
	});

	it("as of a cutoff, even a read that has today's facts shows none of them", () => {
		const facts = map(
			{
				...read(),
				checks: [
					{
						__typename: "StatusContext",
						context: "ci",
						state: "SUCCESS",
						createdAt: "2026-01-01T00:00:00Z",
						isRequired: true,
					},
				],
			},
			"2026-01-05T00:00:00Z",
		);
		expect(facts.mergeStateStatus).toBeNull();
		expect(facts.reviewDecision).toBeNull();
		expect(facts.rule).toBeNull();
		expect(facts.checks[0]?.required).toBeNull();
	});

	it("merged or closed: no merge state, decision or rule; checks (required too) and reviews stay", () => {
		for (const state of ["MERGED", "CLOSED"]) {
			const facts = map({
				...read({ state }),
				checks: [
					{
						__typename: "StatusContext",
						context: "ci",
						state: "FAILURE",
						isRequired: true,
					},
				],
				reviews: [
					{
						author: user("ravi"),
						state: "APPROVED",
						submittedAt: "2026-01-02T00:00:00Z",
					},
				],
			});
			expect(facts, state).toMatchObject({
				mergeStateStatus: null,
				reviewDecision: null,
				rule: null,
				checks: [{ name: "ci", status: "failing", required: true }],
				reviews: [{ author: "ravi", state: "APPROVED" }],
			});
		}
	});
});

describe("ruleOf", () => {
	const ok = (json: unknown): RestAnswer => ({ ok: true, json });
	const no = (status: number | null, message = "Not Found"): RestAnswer => ({
		ok: false,
		status,
		message,
	});
	const reads = (over: Partial<RuleReads>): RuleReads => ({
		branch: ok({ protected: true }),
		protection: no(404),
		rules: ok([[]]),
		...over,
	});
	const RULESET = [
		[
			{ type: "deletion" },
			{
				type: "pull_request",
				parameters: {
					required_approving_review_count: 2,
					require_code_owner_review: true,
				},
			},
			{
				type: "required_status_checks",
				parameters: { strict_required_status_checks_policy: true },
			},
		],
	];

	it("protection hidden (404 or 403) on a protected branch: unknown, even with rulesets read", () => {
		expect(ruleOf(reads({}))).toBeNull();
		expect(ruleOf(reads({ protection: no(403, "Forbidden") }))).toBeNull();
		expect(ruleOf(reads({ rules: ok(RULESET) }))).toBeNull();
	});

	it("an unprotected branch: its rules alone, an empty list none at all", () => {
		const unprotected = { branch: ok({ protected: false }) };
		expect(ruleOf(reads(unprotected))).toEqual({
			approvals: 0,
			codeOwners: false,
			strict: false,
		});
		expect(
			ruleOf(reads({ ...unprotected, protection: no(403, "Upgrade") })),
		).toEqual({ approvals: 0, codeOwners: false, strict: false });
	});

	it("rulesets read: their values; GitHub's 'Branch not protected' means no classic protection", () => {
		expect(
			ruleOf(
				reads({
					protection: no(404, "Branch not protected"),
					rules: ok(RULESET),
				}),
			),
		).toEqual({ approvals: 2, codeOwners: true, strict: true });
	});

	it("branch protection read: its values, joined with the rulesets' (the most either asks)", () => {
		const protection = ok({
			required_pull_request_reviews: {
				required_approving_review_count: 3,
				require_code_owner_reviews: false,
			},
			required_status_checks: { strict: false },
		});
		expect(ruleOf(reads({ protection }))).toEqual({
			approvals: 3,
			codeOwners: false,
			strict: false,
		});
		expect(ruleOf(reads({ protection, rules: ok(RULESET) }))).toEqual({
			approvals: 3,
			codeOwners: true,
			strict: true,
		});
		// Protected without review or check rules (say, no force-pushes).
		expect(ruleOf(reads({ protection: ok({}) }))).toEqual({
			approvals: 0,
			codeOwners: false,
			strict: false,
		});
	});

	it("any read failing or malformed: unknown", () => {
		const unprotected = { branch: ok({ protected: false }) };
		for (const bad of [
			{ branch: no(500, "Server Error") },
			{ branch: no(null, "not JSON") },
			{ branch: ok({}) },
			{ ...unprotected, rules: no(403, "Upgrade") },
			{ ...unprotected, rules: no(500, "Server Error") },
			{ ...unprotected, rules: ok({ nope: 1 }) },
			{ ...unprotected, protection: no(500, "Server Error") },
			{
				...unprotected,
				rules: ok([[{ type: "pull_request", parameters: {} }]]),
			},
			{
				protection: ok({
					required_pull_request_reviews: {
						required_approving_review_count: "2",
					},
				}),
			},
		] satisfies Partial<RuleReads>[]) {
			expect(ruleOf(reads(bad)), JSON.stringify(bad)).toBeNull();
		}
	});
});

describe("verdictProblem and verdictBody", () => {
	const ok: VerdictRequest = {
		clientId: "v1",
		event: "APPROVE",
		commit: HEAD,
		attemptedAt: "2026-11-01T00:00:00Z",
		retry: false,
	};
	const room = 65536 - markerFor("v1").length;

	it("takes an approval without a message, and every event with one", () => {
		expect(verdictProblem(ok)).toBeNull();
		expect(verdictProblem({ ...ok, body: "LGTM" })).toBeNull();
		expect(verdictProblem({ ...ok, body: "  " })).toBeNull();
		expect(verdictProblem({ ...ok, event: "COMMENT", body: "Hm" })).toBeNull();
		expect(
			verdictProblem({
				...ok,
				event: "REQUEST_CHANGES",
				body: "x".repeat(room),
			}),
		).toBeNull();
	});

	it("refuses an unknown event, no message for Comment or Request changes, too long a message, bad fields", () => {
		const bad: unknown[] = [
			{ ...ok, event: "MERGE" },
			{ ...ok, event: "approve" },
			{ ...ok, event: "COMMENT" },
			{ ...ok, event: "COMMENT", body: " \n" },
			{ ...ok, event: "REQUEST_CHANGES" },
			{ ...ok, event: "REQUEST_CHANGES", body: "" },
			{ ...ok, body: "x".repeat(room + 1) },
			{ ...ok, body: 7 },
			{ ...ok, clientId: "has space" },
			{ ...ok, clientId: "" },
			{ ...ok, clientId: "x".repeat(101) },
			{ ...ok, clientId: "a-->b" },
			{ ...ok, commit: "main" },
			{ ...ok, commit: undefined },
			{ ...ok, attemptedAt: "soon" },
			{ ...ok, retry: "no" },
			null,
		];
		for (const req of bad) {
			expect(verdictProblem(req), JSON.stringify(req)).not.toBeNull();
		}
	});

	it("the body carries the marker only when there is a message", () => {
		expect(verdictBody(ok)).toBeUndefined();
		expect(verdictBody({ ...ok, body: " " })).toBeUndefined();
		expect(verdictBody({ ...ok, body: "LGTM" })).toBe(
			"LGTM\n\n<!-- crb:v1 id=v1 -->",
		);
	});
});

describe("findLanded", () => {
	const review = (over: Partial<RestReview>): RestReview => ({
		nodeId: "PRR_1",
		restId: 1,
		login: "Octo_Cat",
		state: "APPROVED",
		body: "",
		submittedAt: "2026-11-01T10:00:00Z",
		commitId: HEAD,
		url: "",
		...over,
	});
	const at = Date.parse("2026-11-01T10:00:00Z");

	it("with a message: the viewer's review in the event's state carrying this client id's marker", () => {
		const req = {
			clientId: "v1",
			commit: HEAD,
			event: "COMMENT" as const,
			body: "Hm",
		};
		const mine = review({
			nodeId: "PRR_mine",
			state: "COMMENTED",
			body: `Hm${markerFor("v1")}`,
		});
		expect(
			findLanded(
				[
					review({ state: "COMMENTED", body: "Hm" }),
					review({ state: "COMMENTED", body: `Hm${markerFor("v2")}` }),
					review({ state: "APPROVED", body: `Hm${markerFor("v1")}` }),
					review({
						login: "ravi",
						state: "COMMENTED",
						body: `Hm${markerFor("v1")}`,
					}),
					mine,
				],
				req,
				"octo-cat",
				Number.POSITIVE_INFINITY,
			),
		).toBe(mine);
		// Time doesn't count where the marker says.
		expect(findLanded([mine], req, "octo-cat", at + 60_000)).toBe(mine);
	});

	it("a marker typed in the message is the reviewer's text: only the trailing one is carbonless's", () => {
		const typed = "See <!-- crb:v1 id=v1 -->";
		const req = {
			clientId: "v2",
			commit: HEAD,
			event: "COMMENT" as const,
			body: typed,
		};
		const posted = review({
			state: "COMMENTED",
			body: typed + markerFor("v2"),
		});
		expect(findLanded([posted], req, "octo-cat", 0)).toBe(posted);
		// The typed one alone (someone else's review with that text) isn't v1's landing.
		expect(
			findLanded(
				[review({ state: "COMMENTED", body: "See this" })],
				{ clientId: "v1", commit: HEAD, event: "COMMENT", body: "See" },
				"octo-cat",
				0,
			),
		).toBeNull();
	});

	it("without a message: the viewer's empty review in the event's state submitted since the first attempt, not one claimed", () => {
		const req = { clientId: "v1", commit: HEAD, event: "APPROVE" as const };
		const before = review({
			nodeId: "PRR_old",
			submittedAt: "2026-11-01T09:59:59Z",
		});
		const withText = review({ nodeId: "PRR_text", body: "Nice" });
		const claimed = review({
			nodeId: "PRR_claimed",
			submittedAt: "2026-11-01T10:00:01Z",
		});
		const landed = review({
			nodeId: "PRR_new",
			submittedAt: "2026-11-01T10:00:02Z",
		});
		expect(
			findLanded(
				[before, withText, claimed, landed],
				req,
				"octo-cat",
				at,
				new Set(["PRR_claimed"]),
			),
		).toBe(landed);
		expect(findLanded([before, withText], req, "octo-cat", at)).toBeNull();
		expect(
			findLanded([review({ state: "COMMENTED" })], req, "octo-cat", at),
		).toBeNull();
		// An empty approval on another commit (GitHub's web, another crb) isn't this one.
		expect(
			findLanded(
				[review({ submittedAt: "2026-11-01T10:00:02Z", commitId: OLD })],
				req,
				"octo-cat",
				at,
			),
		).toBeNull();
	});
});

/**
 * PR acme/widget#12 (test/pr-fixture.ts), its author octo-author; the
 * viewer is Octo_Cat.
 */
describe("standingOpinion", () => {
	const review = (over: Partial<RestReview>): RestReview => ({
		nodeId: "PRR_1",
		restId: 1,
		login: "Octo_Cat",
		state: "APPROVED",
		body: "",
		submittedAt: "2026-11-01T10:00:00Z",
		commitId: HEAD,
		url: "",
		...over,
	});
	const comment = review({
		nodeId: "C",
		restId: 9,
		state: "COMMENTED",
		submittedAt: "2026-11-01T11:00:00Z",
	});
	const standing = (reviews: RestReview[]) =>
		standingOpinion(reviews, "octo-cat", "C", comment.submittedAt)?.nodeId ??
		null;

	it("the viewer's latest approval or change request before the comment", () => {
		expect(
			standing([
				review({ nodeId: "A" }),
				review({ nodeId: "R", state: "CHANGES_REQUESTED" }),
				review({ nodeId: "X", state: "COMMENTED" }),
				comment,
			]),
		).toBe("R");
	});

	it("none: never anyone else's, nor a dismissed one, nor one after the comment, nor a pending one", () => {
		expect(standing([review({ login: "ravi" }), comment])).toBeNull();
		expect(
			standing([
				review({ nodeId: "A" }),
				review({ nodeId: "D", state: "DISMISSED" }),
				comment,
			]),
		).toBeNull();
		expect(
			standing([
				review({ nodeId: "R", state: "CHANGES_REQUESTED" }),
				comment,
				review({ nodeId: "A2", submittedAt: comment.submittedAt }),
			]),
		).toBeNull();
		expect(
			standing([review({ nodeId: "P", state: "PENDING" }), comment]),
		).toBeNull();
		// The comment not listed: by time.
		expect(
			standing([review({ nodeId: "A", submittedAt: "2026-11-01T12:00:00Z" })]),
		).toBeNull();
		expect(standing([review({ nodeId: "A" })])).toBe("A");
	});
});

describe("sinceTarget and sinceOf (VerdictFacts.since)", () => {
	const PS1 = "1".repeat(40);
	const PS2 = "2".repeat(40);
	const NEW = "3".repeat(40);
	const review = (
		commitId: string,
		more: Partial<VerdictFacts["reviews"][number]> = {},
	): VerdictFacts["reviews"][number] => ({
		author: "Octo_Cat",
		state: "APPROVED",
		submittedAt: "2026-11-05T10:00:00Z",
		commitId,
		you: true,
		bot: false,
		...more,
	});
	const T = Date.parse("2026-11-05T09:00:00Z");
	const patchsets = [
		{ number: 1, head: PS1, startedAt: T },
		{ number: 2, head: PS2, startedAt: T + 3_600_000 },
	];

	it("a verdict on PS1 with PS2 the latest: compared with PS2", () => {
		expect(sinceTarget({ verdict: review(PS1), patchsets, head: PS2 })).toEqual(
			{
				state: "APPROVED",
				head: PS1,
				at: "2026-11-05T10:00:00Z",
				patchset: 1,
				to: { head: PS2, patchset: 2 },
			},
		);
		// No head shown (pinned, as-of, merged): the latest patch set too.
		expect(
			sinceTarget({ verdict: review(PS1), patchsets, head: null })?.to,
		).toEqual({ head: PS2, patchset: 2 });
	});

	it("the PR's head past the latest patch set is where a verdict goes now", () => {
		expect(
			sinceTarget({ verdict: review(PS2), patchsets, head: NEW })?.to,
		).toEqual({ head: NEW, patchset: null });
		// Moved back onto PS1's head: that patch set.
		expect(
			sinceTarget({ verdict: review(PS2), patchsets, head: PS1 })?.to,
		).toEqual({ head: PS1, patchset: 1 });
	});

	it("null without a verdict of the reviewer's (yourVerdict), on the head a verdict goes on now, or on a head that is no patch set", () => {
		expect(sinceTarget({ verdict: null, patchsets, head: NEW })).toBeNull();
		expect(
			sinceTarget({ verdict: review(PS2), patchsets, head: PS2 }),
		).toBeNull();
		expect(
			sinceTarget({ verdict: review(NEW), patchsets, head: NEW }),
		).toBeNull();
		// Given before any patch set (on GitHub, say): nothing to compare from.
		expect(
			sinceTarget({ verdict: review("4".repeat(40)), patchsets, head: NEW }),
		).toBeNull();
		expect(
			sinceTarget({ verdict: review(PS1), patchsets: [], head: NEW }),
		).toBeNull();
		expect(
			sinceTarget({ verdict: review(""), patchsets, head: NEW }),
		).toBeNull();
	});

	it("of the patch sets on the verdict's head, the one started by the verdict's time names it", () => {
		// A retarget keeps the head and starts PS3 on it, after the verdict.
		const retargeted = [
			...patchsets,
			{ number: 3, head: PS1, startedAt: Date.parse("2026-11-06T00:00:00Z") },
		];
		expect(
			sinceTarget({ verdict: review(PS1), patchsets: retargeted, head: NEW })
				?.patchset,
		).toBe(1);
		// Given after PS3 started: PS3.
		const later = review(PS1, { submittedAt: "2026-11-07T00:00:00Z" });
		expect(
			sinceTarget({ verdict: later, patchsets: retargeted, head: NEW })
				?.patchset,
		).toBe(3);
		// The verdict started PS3 and GitHub's whole second reads before
		// PS3's start: still PS3.
		const sameSecond = review(PS1, {
			submittedAt: new Date(T + 3_600_000)
				.toISOString()
				.replace(/\.\d+Z$/, "Z"),
		});
		const startedMidSecond = [
			{ number: 1, head: PS1, startedAt: T },
			{ number: 3, head: PS1, startedAt: T + 3_600_400 },
		];
		expect(
			sinceTarget({
				verdict: sameSecond,
				patchsets: startedMidSecond,
				head: NEW,
			})?.patchset,
		).toBe(3);
	});

	const target = {
		state: "APPROVED" as const,
		head: PS1,
		at: "2026-11-05T10:00:00Z",
		patchset: 1,
		to: { head: NEW, patchset: null },
	};
	const answer = (
		kinds: ("carried" | "reworked" | "new" | "gone")[],
		shape: Partial<RereviewAnswer["shape"]> = {},
	): RereviewAnswer => ({
		from: 1,
		toHead: NEW,
		toRevision: "r",
		shape: {
			code: "S1",
			commits: 3,
			identical: false,
			conflicts: [],
			virtualRebase: "ok",
			virtualHead: null,
			...shape,
		},
		interdiff: "available",
		files: [
			{
				index: 0,
				path: "a.ts",
				conflict: false,
				clusters: kinds.map((kind, i) => ({ key: `k${i}`, kind })),
			},
		],
		toRead: { files: 2, clusters: 2 },
		threads: [],
	});

	it("counts every kind from the engine's answer", () => {
		expect(
			sinceOf(target, answer(["carried", "reworked", "new", "new", "gone"]))
				.changes,
		).toEqual({
			status: "done",
			shape: "S1",
			commits: 3,
			files: 2,
			reworked: 1,
			new: 2,
			gone: 1,
			identical: false,
		});
	});

	it("an identical rebase says so with nothing counted; an unreviewed cluster still counts as new", () => {
		const same = sinceOf(
			target,
			answer(["carried"], { code: "S4a", commits: 2, identical: true }),
		);
		expect(same.changes).toMatchObject({
			status: "done",
			shape: "S4a",
			identical: true,
			reworked: 0,
			new: 0,
			gone: 0,
		});
		expect(
			sinceOf(target, answer(["new"], { identical: true })).changes,
		).toMatchObject({ identical: true, new: 1 });
	});

	it("pending and failed say so, never counts", () => {
		expect(sinceOf(target, { pending: true })).toEqual({
			...target,
			changes: { status: "pending" },
		});
		expect(sinceOf(target, { error: "merge-tree failed" }).changes).toEqual({
			status: "failed",
			message: "merge-tree failed",
		});
	});
});

describe("the verdict, through the session and the fake gh", () => {
	let pr: PrFixture;
	let session: Session;
	let ids = 0;
	let waited: number[] = [];
	const realSleep = writeWaits.sleep;

	const scenario = (
		over: Partial<Scenario> = {},
		view: Record<string, unknown> = {},
		reviews: unknown[] = [],
		more: Partial<Scenario["prs"][string]> = {},
	) =>
		pr.scenario({
			prs: {
				12: {
					view: prView({
						headRefOid: pr.head(),
						baseRefName: "main",
						mergeStateStatus: "BLOCKED",
						reviewDecision: "REVIEW_REQUIRED",
						...view,
					}),
					graphql: { reviewThreads: [], reviews, comments: [] },
					...more,
				},
			},
			...over,
		});
	/** Sets scenario fields, keeping what the fake gh stored (its writes). */
	const tweak = (edit: (s: Scenario) => void) => {
		const path = process.env.CRB_FAKE_GH ?? "";
		const s = JSON.parse(readFileSync(path, "utf8")) as Scenario;
		edit(s);
		writeFileAtomic(path, JSON.stringify(s, null, "\t"));
	};
	const stored = () =>
		(
			JSON.parse(
				readFileSync(process.env.CRB_FAKE_GH ?? "", "utf8"),
			) as Scenario
		).prs[12]?.graphql?.reviews as {
			state: string;
			body: string;
			submittedAt: string;
			commit: { oid: string };
		}[];
	const posts = () =>
		pr
			.ghLog()
			.split("\n")
			.filter((l) =>
				/^api -X POST repos\/acme\/widget\/pulls\/12\/reviews /.test(l),
			);
	const request = (more: Partial<VerdictRequest> = {}): VerdictRequest => ({
		clientId: `v${++ids}`,
		event: "APPROVE",
		commit: pr.head(),
		attemptedAt: new Date().toISOString(),
		retry: false,
		...more,
	});
	const refused = async (p: Promise<unknown>) => {
		const error = await p.then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(WriteRefusedError);
		return error as WriteRefusedError;
	};

	beforeEach(async () => {
		waited = [];
		writeWaits.sleep = async (ms) => {
			waited.push(ms);
		};
		pr = createPrFixture();
		scenario();
		session = await Session.open(pr.arg, process.cwd());
	});
	afterEach(async () => {
		writeWaits.sleep = realSleep;
		// Never with comments: the verdict is its own review.
		await pr.cleanup();
	});

	describe("GET", () => {
		it("reads GitHub's facts in one GraphQL call, with the rule beside it", async () => {
			scenario(
				{},
				{
					reviewRequests: [
						{ __typename: "User", login: "rev2" },
						{
							__typename: "Team",
							name: "platform",
							slug: "platform",
							asCodeOwner: true,
						},
					],
					statusCheckRollup: [
						{
							__typename: "StatusContext",
							context: "jira",
							state: "FAILURE",
							targetUrl: "https://ci/jira",
							required: true,
						},
						{
							__typename: "CheckRun",
							name: "build",
							status: "COMPLETED",
							conclusion: "SUCCESS",
						},
					],
				},
				[
					{
						author: user("ravi"),
						state: "CHANGES_REQUESTED",
						submittedAt: "2026-01-03T00:00:00Z",
						commit: { oid: pr.head() },
					},
				],
				{ rule: { approvals: 1, codeOwners: true, strict: false } },
			);
			const facts = await session.verdict();
			expect(facts).toMatchObject({
				mergeStateStatus: "BLOCKED",
				reviewDecision: "REVIEW_REQUIRED",
				rule: { approvals: 1, codeOwners: true, strict: false },
				codeOwnerRequests: [{ name: "platform", team: true }],
				checks: [
					{
						name: "jira",
						status: "failing",
						url: "https://ci/jira",
						required: true,
					},
					{ name: "build", status: "passing", required: false },
				],
				reviews: [
					{
						author: "ravi",
						state: "CHANGES_REQUESTED",
						commitId: pr.head(),
						you: false,
						bot: false,
					},
				],
				head: pr.head(),
			});
			expect(Date.parse(facts.fetchedAt)).not.toBeNaN();
			const graphql = pr
				.ghLog()
				.match(/state mergeStateStatus reviewDecision/g);
			expect(graphql).toHaveLength(1);
		});

		it("is never read on first open or with the overview", async () => {
			await session.threads((await session.overview()).readId, "full");
			await session.timeline((await session.overview()).readId);
			expect(pr.ghLog()).not.toMatch(
				/mergeStateStatus|protection|rules\/branches/,
			);
		});

		it("pages reviews and checks past the first page, each check's isRequired kept", async () => {
			const checks = Array.from({ length: 5 }, (_, i) => ({
				__typename: "StatusContext",
				context: `c${i}`,
				state: "SUCCESS",
				required: i === 4,
			}));
			scenario({ pageSize: 2 }, { statusCheckRollup: checks }, [
				{
					author: user("a"),
					state: "APPROVED",
					submittedAt: "2026-01-01T00:00:00Z",
				},
				{
					author: user("b"),
					state: "APPROVED",
					submittedAt: "2026-01-02T00:00:00Z",
				},
				{
					author: user("c"),
					state: "APPROVED",
					submittedAt: "2026-01-03T00:00:00Z",
				},
			]);
			const facts = await session.verdict();
			expect(facts.checks.map((c) => [c.name, c.required])).toEqual([
				["c0", false],
				["c1", false],
				["c2", false],
				["c3", false],
				["c4", true],
			]);
			expect(facts.reviews.map((r) => r.author)).toEqual(["c", "b", "a"]);
		});

		it("GitHub refusing isRequired: read again without it, required unknown (null), the rest as read", async () => {
			scenario(
				{ failGraphql: "isRequired" },
				{
					statusCheckRollup: [
						{
							__typename: "StatusContext",
							context: "jira",
							state: "FAILURE",
							required: true,
						},
					],
				},
			);
			const facts = await session.verdict();
			expect(facts.checks).toEqual([
				{ name: "jira", status: "failing", required: null },
			]);
			expect(facts.mergeStateStatus).toBe("BLOCKED");
		});

		it("no checks at all: an empty list", async () => {
			scenario({}, { statusCheckRollup: [] });
			expect((await session.verdict()).checks).toEqual([]);
		});

		it("the rule: hidden on a protected branch → null; an unprotected branch → zeros; branch protection read → its values", async () => {
			scenario();
			expect((await session.verdict(0)).rule).toBeNull();
			scenario({}, {}, [], {
				rule: { approvals: 0, codeOwners: false, strict: false },
			});
			expect((await session.verdict(0)).rule).toEqual({
				approvals: 0,
				codeOwners: false,
				strict: false,
			});
			scenario({}, {}, [], {
				rule: { approvals: 2, codeOwners: false, strict: true, classic: true },
			});
			expect((await session.verdict(0)).rule).toEqual({
				approvals: 2,
				codeOwners: false,
				strict: true,
			});
		});

		it("a failed rule read (403, 404, 500, not JSON, on any of its reads) is no rule, never a failed verdict", async () => {
			const rule = { approvals: 1, codeOwners: false, strict: false };
			for (const read of ["branch", "protection", "rules"] as const) {
				for (const fail of [
					{ status: 403 },
					{ status: 404 },
					{ status: 500 },
					{ malformed: true },
				]) {
					scenario({ ruleFail: { read, ...fail } }, {}, [], { rule });
					const facts = await session.verdict(0);
					const what = `${read} ${JSON.stringify(fail)}`;
					expect(facts.rule, what).toBeNull();
					expect(facts.mergeStateStatus, what).toBe("BLOCKED");
				}
			}
		});

		it("kept like the overview: served again, read anew at maxAge 0 or after a Refresh; a failed read isn't kept", async () => {
			const first = await session.verdict();
			const calls = () =>
				(pr.ghLog().match(/state mergeStateStatus reviewDecision/g) ?? [])
					.length;
			expect(await session.verdict()).toEqual(first);
			expect(await session.verdict(600_000)).toEqual(first);
			expect(calls()).toBe(1);
			await session.verdict(0);
			expect(calls()).toBe(2);
			await session.refresh();
			await session.verdict();
			expect(calls()).toBe(3);
			scenario({ failGraphql: "mergeStateStatus" });
			await expect(session.verdict(0)).rejects.toBeInstanceOf(GhError);
			scenario();
			await session.verdict();
			// The failed read was asked twice: with isRequired, then without.
			expect(calls()).toBe(6);
		});

		it("merged or closed: GitHub's merge facts and the rule are null; checks and reviews stay", async () => {
			scenario(
				{},
				{ state: "MERGED" },
				[
					{
						author: user("ravi"),
						state: "APPROVED",
						submittedAt: "2026-01-03T00:00:00Z",
					},
				],
				{ rule: { approvals: 1, codeOwners: false, strict: false } },
			);
			const facts = await session.verdict(0);
			expect(facts).toMatchObject({
				mergeStateStatus: null,
				reviewDecision: null,
				rule: null,
				reviews: [{ author: "ravi" }],
			});
			expect(facts.checks.length).toBeGreaterThan(0);
		});

		it("as of a cutoff: the cutoff's head's checks and reviews by then; nothing of today's, and the rule isn't read", async () => {
			const CUTOFF = "2098-01-01T00:00:00Z";
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			pr.scenario({
				prs: {
					12: {
						view: prView({
							headRefOid: now,
							baseRefName: "main",
							mergeStateStatus: "CLEAN",
							reviewDecision: "APPROVED",
							reviewRequests: [
								{ __typename: "User", login: "dima", asCodeOwner: true },
							],
						}),
						rule: { approvals: 1, codeOwners: false, strict: false },
						graphql: {
							commits: [
								{
									commit: { oid: then, committedDate: "2026-01-02T00:00:00Z" },
								},
								{ commit: { oid: now, committedDate: "2099-01-01T00:00:00Z" } },
							],
							reviews: [
								{
									author: user("Octo_Cat"),
									state: "CHANGES_REQUESTED",
									submittedAt: "2026-01-03T00:00:00Z",
									commit: { oid: then },
								},
								{
									author: user("ravi"),
									state: "APPROVED",
									submittedAt: "2099-01-02T00:00:00Z",
									commit: { oid: now },
								},
							],
							reviewThreads: [],
							comments: [],
						},
					},
				},
				commits: {
					[then]: {
						contexts: [
							{
								__typename: "StatusContext",
								context: "ci",
								state: "SUCCESS",
								createdAt: "2026-01-02T01:00:00Z",
								required: true,
							},
						],
					},
				},
			});
			const s = await Session.open(pr.arg, process.cwd(), () => {}, {
				asOf: CUTOFF,
			});
			expect(await s.verdict()).toEqual({
				mergeStateStatus: null,
				reviewDecision: null,
				rule: null,
				codeOwnerRequests: [],
				checks: [{ name: "ci", status: "passing", required: null }],
				reviews: [
					{
						author: "Octo_Cat",
						state: "CHANGES_REQUESTED",
						submittedAt: "2026-01-03T00:00:00Z",
						commitId: then,
						url: "https://github.com/acme/widget/pull/12#pullrequestreview-9000",
						you: true,
						bot: false,
					},
				],
				yourVerdict: {
					author: "Octo_Cat",
					state: "CHANGES_REQUESTED",
					submittedAt: "2026-01-03T00:00:00Z",
					commitId: then,
					url: "https://github.com/acme/widget/pull/12#pullrequestreview-9000",
					you: true,
					bot: false,
				},
				head: then,
				fetchedAt: expect.any(String),
				// No patch set: nothing to compare the verdict with.
				since: null,
			});
			expect(pr.ghLog()).not.toMatch(
				/mergeStateStatus|isRequired|protection|rules\/branches/,
			);
		});
	});

	describe("POST", () => {
		it("approves without a message: the event and the snapshot's head, no body, no comments", async () => {
			const answer = await session.submitVerdict(request());
			expect(answer).toEqual({
				review: {
					id: "PRR_12_0",
					state: "APPROVED",
					submittedAt: expect.any(String),
					commitId: pr.head(),
					body: "",
					url: "https://github.com/acme/widget/pull/12#pullrequestreview-9000",
				},
			});
			expect(posts()).toHaveLength(1);
			expect(stored()).toEqual([
				expect.objectContaining({
					state: "APPROVED",
					body: "",
					commit: { oid: pr.head() },
				}),
			]);
		});

		it("a message goes with the marker; the answer, the overview and the timeline never show it", async () => {
			const answer = await session.submitVerdict(
				request({ clientId: "c1", event: "COMMENT", body: "Looks fine." }),
			);
			expect(stored()[0]?.body).toBe("Looks fine.\n\n<!-- crb:v1 id=c1 -->");
			expect(answer.review).toMatchObject({
				state: "COMMENTED",
				body: "Looks fine.",
			});
			const changes = await session.submitVerdict(
				request({ clientId: "c2", event: "REQUEST_CHANGES", body: "Fix it." }),
			);
			expect(changes.review).toMatchObject({
				state: "CHANGES_REQUESTED",
				body: "Fix it.",
			});
			const overview = await session.overview();
			expect(JSON.stringify(overview)).not.toContain("crb:");
			expect(
				JSON.stringify(await session.timeline(overview.readId)),
			).not.toContain("crb:");
			expect(JSON.stringify(await session.verdict())).not.toContain("crb:");
		});

		it("a marker typed into the message is kept as the reviewer's text", async () => {
			const typed = "Keep <!-- crb:v1 id=x -->";
			const answer = await session.submitVerdict(
				request({ clientId: "t1", event: "COMMENT", body: typed }),
			);
			expect(answer.review.body).toBe(typed);
			expect(stored()[0]?.body).toBe(`${typed}${markerFor("t1")}`);
		});

		it("lands: the overview and the verdict read GitHub again when next asked, the POST not waiting", async () => {
			const before = await session.overview();
			await session.verdict();
			const reads = () =>
				(pr.ghLog().match(/state mergeStateStatus reviewDecision/g) ?? [])
					.length;
			await session.submitVerdict(request());
			// Not read again by the POST itself.
			expect(reads()).toBe(1);
			const after = await session.overview();
			expect(after.readId).not.toBe(before.readId);
			expect(after.reviews).toEqual([
				expect.objectContaining({
					author: "Octo_Cat",
					state: "APPROVED",
					you: true,
				}),
			]);
			const facts = await session.verdict();
			expect(reads()).toBe(2);
			expect(facts.reviews[0]).toMatchObject({ state: "APPROVED", you: true });
		});

		it("a commit other than the snapshot's head → stale, nothing sent", async () => {
			const error = await refused(
				session.submitVerdict(request({ commit: "f".repeat(40) })),
			);
			expect(error.code).toBe("stale");
			expect(posts()).toHaveLength(0);
		});

		it("a pinned head older than the PR's: the snapshot's head is accepted and sent as commit_id", async () => {
			const then = pr.head();
			const now = pr.moveHead({ "later.txt": "later\n" });
			scenario({}, { headRefOid: now }, [], {
				graphql: {
					commits: [
						{ commit: { oid: then, committedDate: "2026-01-02T00:00:00Z" } },
						{ commit: { oid: now, committedDate: "2026-01-04T00:00:00Z" } },
					],
					reviews: [],
					reviewThreads: [],
					comments: [],
				},
			});
			const pinned = await Session.open(pr.arg, process.cwd(), () => {}, {
				head: parseHead(then),
			});
			expect(pinned.info().snapshotHead).toBe(then);
			const answer = await pinned.submitVerdict(request({ commit: then }));
			expect(answer.review.commitId).toBe(then);
			expect(stored()[0]?.commit).toEqual({ oid: then });
			expect(
				(await refused(pinned.submitVerdict(request({ commit: now })))).code,
			).toBe("stale");
		});

		it("a pending review → pending-review with the files link, nothing sent; the overview warns", async () => {
			scenario({}, {}, [{ author: user("Octo_Cat"), state: "PENDING" }]);
			await session.overview(0);
			const error = await refused(session.submitVerdict(request()));
			expect(error.code).toBe("pending-review");
			expect(error.url).toBe("https://github.com/acme/widget/pull/12/files");
			expect(stored()).toHaveLength(1);
			expect((await session.overview()).pendingReview).toEqual({
				url: "https://github.com/acme/widget/pull/12/files",
			});
		});

		it("on one's own PR: approving or requesting changes is forbidden with GitHub's message; a comment goes", async () => {
			scenario({}, { author: { login: "Octo_Cat" } });
			const approve = await refused(session.submitVerdict(request()));
			expect(approve.code).toBe("forbidden");
			expect(approve.message).toBe("Can not approve your own pull request");
			const changes = await refused(
				session.submitVerdict(
					request({ event: "REQUEST_CHANGES", body: "No." }),
				),
			);
			expect(changes.code).toBe("forbidden");
			expect(changes.message).toBe(
				"Can not request changes on your own pull request",
			);
			const comment = await session.submitVerdict(
				request({ event: "COMMENT", body: "Note to self" }),
			);
			expect(comment.review.state).toBe("COMMENTED");
		});

		it("invalid requests are refused before GitHub", async () => {
			for (const bad of [
				request({ event: "COMMENT" }),
				request({ event: "REQUEST_CHANGES", body: "  " }),
				request({ clientId: "no spaces" }),
				request({ event: "SHIP" as never }),
			]) {
				expect((await refused(session.submitVerdict(bad))).code).toBe(
					"invalid",
				);
			}
			expect(posts()).toHaveLength(0);
		});

		it("as someone else (--viewer): writes-off, nothing sent", async () => {
			const other = await Session.open(pr.arg, process.cwd(), () => {}, {
				viewer: "someone-else",
			});
			expect((await refused(other.submitVerdict(request()))).code).toBe(
				"writes-off",
			);
			expect(posts()).toHaveLength(0);
		});

		it("a client id already sent is answered as it was, nothing posted again; another event under it is refused", async () => {
			const req = request();
			const first = await session.submitVerdict(req);
			expect(await session.submitVerdict(req)).toEqual(first);
			expect(await session.submitVerdict({ ...req, retry: true })).toEqual(
				first,
			);
			expect(posts()).toHaveLength(1);
			expect(
				(
					await refused(
						session.submitVerdict({ ...req, event: "COMMENT", body: "Hm" }),
					)
				).code,
			).toBe("invalid");
		});

		it("a resend while the first attempt runs waits for it, then is answered without posting", async () => {
			tweak((s) => {
				s.hold = ["verdict"];
			});
			const req = request();
			const first = session.submitVerdict(req);
			const again = session.submitVerdict({ ...req, retry: true });
			await vi.waitFor(() => expect(posts()).toHaveLength(1), {
				timeout: 10_000,
			});
			release(process.env.CRB_FAKE_GH ?? "", "verdict");
			expect(await again).toEqual(await first);
			expect(posts()).toHaveLength(1);
			expect(stored()).toHaveLength(1);
		});

		it("the answer lost after an approval without a message landed: the retry finds it by time, and posts nothing", async () => {
			scenario({ failNext: { op: "verdict", status: 502, afterWrite: true } });
			expect((await session.overview()).reviews).toEqual([]);
			const req = request();
			await expect(session.submitVerdict(req)).rejects.toBeInstanceOf(GhError);
			expect(stored()).toHaveLength(1);
			const answer = await session.submitVerdict({ ...req, retry: true });
			expect(answer.review).toMatchObject({
				id: "PRR_12_0",
				state: "APPROVED",
			});
			expect(posts()).toHaveLength(1);
			expect(stored()).toHaveLength(1);
			// Found landed: the next overview reads GitHub again.
			expect((await session.overview()).reviews).toEqual([
				expect.objectContaining({ state: "APPROVED", you: true }),
			]);
		});

		it("the answer lost after a message landed: the retry finds it by its marker, after a restart too", async () => {
			scenario({ failNext: { op: "verdict", status: 502, afterWrite: true } });
			const req = request({ event: "REQUEST_CHANGES", body: "Please fix." });
			await expect(session.submitVerdict(req)).rejects.toBeInstanceOf(GhError);
			const restarted = await Session.open(pr.arg, process.cwd());
			const answer = await restarted.submitVerdict({ ...req, retry: true });
			expect(answer.review).toMatchObject({
				state: "CHANGES_REQUESTED",
				body: "Please fix.",
			});
			expect(posts()).toHaveLength(1);
		});

		it("an approval without a message after a restart: found by the client's attempt time less two minutes", async () => {
			scenario({ failNext: { op: "verdict", status: 502, afterWrite: true } });
			const req = request();
			await expect(session.submitVerdict(req)).rejects.toBeInstanceOf(GhError);
			const restarted = await Session.open(pr.arg, process.cwd());
			// The client's clock a minute fast: still within the slack.
			const fast = new Date(Date.now() + ATTEMPT_SLACK_MS / 2).toISOString();
			const answer = await restarted.submitVerdict({
				...req,
				attemptedAt: fast,
				retry: true,
			});
			expect(answer.review.state).toBe("APPROVED");
			expect(posts()).toHaveLength(1);
		});

		it("an older approval of the viewer's isn't this one: a retry that finds none posts once", async () => {
			scenario({}, {}, [
				{
					author: user("Octo_Cat"),
					state: "APPROVED",
					submittedAt: "2026-01-03T00:00:00Z",
					body: "",
				},
			]);
			const answer = await session.submitVerdict(request({ retry: true }));
			expect(answer.review.id).toBe("PRR_12_1");
			expect(posts()).toHaveLength(1);
			expect(stored()).toHaveLength(2);
		});

		it("an empty approval of the viewer's on another commit, just now (GitHub's web), isn't this one: the retry posts once", async () => {
			scenario({}, {}, [
				{
					author: user("Octo_Cat"),
					state: "APPROVED",
					submittedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
					body: "",
					commit: { oid: OLD },
				},
			]);
			const answer = await session.submitVerdict(request({ retry: true }));
			expect(answer.review).toMatchObject({
				id: "PRR_12_1",
				commitId: pr.head(),
			});
			expect(posts()).toHaveLength(1);
		});

		it("an unknown outcome: the retry lists again after each wait before posting", async () => {
			scenario({ failNext: { op: "verdict", status: 502 } });
			const req = request();
			await expect(session.submitVerdict(req)).rejects.toBeInstanceOf(GhError);
			expect(stored()).toHaveLength(0);
			const lists = () =>
				(
					pr
						.ghLog()
						.match(
							/^api repos\/acme\/widget\/pulls\/12\/reviews --paginate/gm,
						) ?? []
				).length;
			await session.submitVerdict({ ...req, retry: true });
			expect(waited).toEqual([300, 1000]);
			expect(lists()).toBe(3);
			expect(posts()).toHaveLength(2);
			expect(stored()).toHaveLength(1);
		});

		it("GitHub's refusals: 422 and others as the write mapping has them; transient ones stay 502", async () => {
			scenario({ failNext: { op: "verdict", status: 422, message: "Nope" } });
			expect((await refused(session.submitVerdict(request()))).code).toBe(
				"invalid",
			);
			scenario({ failNext: { op: "verdict", status: 403 } });
			expect((await refused(session.submitVerdict(request()))).code).toBe(
				"forbidden",
			);
			scenario({ failNext: { op: "verdict", status: 503 } });
			const transient = await session
				.submitVerdict(request())
				.catch((e: unknown) => e);
			expect(transient).toBeInstanceOf(GhError);
			expect(transient).not.toBeInstanceOf(WriteRefusedError);
		});
	});

	describe("since your verdict (VerdictFacts.since)", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
		/** a.txt as the PR has it, with line 2 as given. */
		const aTxt = (line2: string) =>
			`${lines.map((l, i) => (i === 1 ? line2 : i === 25 ? "line 26 changed" : l)).join("\n")}\n`;
		/** Every cluster of the session's snapshot reviewed: PS1 starts. */
		const reviewAll = async () => {
			const snap = session.snapshot();
			await session.setStates(
				snap.revision,
				snap.files.flatMap((f) =>
					f.clusters.map((c) => ({ key: c.key, state: "reviewed" as const })),
				),
			);
		};
		/** Approves `commit` through the session; the reviews as the fake gh keeps them. */
		const approve = async (commit: string) => {
			await session.submitVerdict(request({ commit }));
			return stored();
		};
		/** The facts' since once the engine has answered. */
		const settled = async () => {
			for (;;) {
				const { since } = await session.verdict();
				if (since?.changes.status !== "pending") return since;
				await new Promise((r) => setTimeout(r, 20));
			}
		};
		/** A head with PS1's tree on the merge base: a rebase with the same diff. */
		const rebaseSame = () => {
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: pr.repo.path,
					encoding: "utf8",
					env: testGitEnv(),
				}).trim();
			const sha = git(
				"commit-tree",
				`${pr.head()}^{tree}`,
				"-p",
				pr.mergeBase,
				"-m",
				"PR change, rebased",
			);
			git("update-ref", "refs/pull/12/head", sha);
			return sha;
		};

		it("a verdict on PS1 with PS2 differing: pending, then the engine's counts; PS2 started keeps them; a verdict on the head ends it", async () => {
			await reviewAll();
			const ps1 = session.snapshot().head;
			const kept = await approve(ps1);
			const head = pr.moveHead({
				"a.txt": aTxt("line 2 reworked"),
				"later.txt": "later\n",
			});
			scenario({}, {}, kept);
			await session.checkHead();
			const first = await session.verdict();
			expect(first.since).toMatchObject({
				state: "APPROVED",
				head: ps1,
				at: kept[0]?.submittedAt,
				patchset: 1,
				to: { head, patchset: null },
				changes: { status: "pending" },
			});
			const done = await settled();
			expect(done?.changes).toEqual({
				status: "done",
				shape: "S1",
				commits: 1,
				files: 2,
				reworked: 1,
				new: 1,
				gone: 0,
				identical: false,
			});
			// The reviewer reads on the head: PS2 starts, the since goes to it.
			const view = await session.viewHead(head);
			const later = view.files.find((f) => f.path === "later.txt");
			const key = later?.clusters[0]?.key ?? "";
			await session.setStates(view.revision, [{ key, state: "reviewed" }]);
			expect(session.info().patchset).toBe(2);
			const onPs2 = await settled();
			expect(onPs2?.to).toEqual({ head, patchset: 2 });
			expect(onPs2?.changes).toMatchObject({ reworked: 1, new: 1 });
			// A verdict on the head the PR is on: nothing since.
			await approve(head);
			expect(stored().at(-1)?.commit.oid).toBe(head);
			expect((await session.verdict()).since).toBeNull();
		});

		it("an identical rebase: nothing counted; Approve again posts on the new head and starts PS2 with every mark carried", async () => {
			await reviewAll();
			const ps1 = session.snapshot().head;
			const kept = await approve(ps1);
			const head = rebaseSame();
			scenario({}, { headRefOid: head }, kept);
			await session.checkHead();
			const done = await settled();
			expect(done).toMatchObject({
				head: ps1,
				patchset: 1,
				to: { head, patchset: null },
			});
			expect(done?.changes).toMatchObject({
				status: "done",
				identical: true,
				reworked: 0,
				new: 0,
				gone: 0,
			});
			await approve(head);
			expect(stored().map((r) => r.commit.oid)).toEqual([ps1, head]);
			expect(session.info().patchsets.map((p) => p.head)).toEqual([ps1, head]);
			const { clusters } = (await session.review()).progress;
			expect(clusters.reviewed).toBe(clusters.total);
			expect((await session.verdict()).since).toBeNull();
		});

		it("a verdict on the PR's new head needs no answer first: its snapshot is built", async () => {
			await reviewAll();
			const kept = await approve(session.snapshot().head);
			const head = pr.moveHead({ "later.txt": "later\n" });
			scenario({}, {}, kept);
			await session.checkHead();
			await approve(head);
			expect(stored().at(-1)?.commit.oid).toBe(head);
			expect(session.info().patchset).toBe(2);
		});

		it("no verdict, or one on the current head: no since", async () => {
			await reviewAll();
			expect((await session.verdict()).since).toBeNull();
			await approve(session.snapshot().head);
			expect((await session.verdict()).since).toBeNull();
		});

		it("no verdict of the reviewer's while the PR moved on: no since", async () => {
			await reviewAll();
			pr.moveHead({ "later.txt": "later\n" });
			scenario();
			await session.checkHead();
			expect((await session.verdict()).since).toBeNull();
		});
	});

	describe("Comment withdraws a standing opinion", () => {
		const mine = (state: string) => ({
			author: user("Octo_Cat"),
			state,
			submittedAt: "2026-01-03T00:00:00Z",
			commit: { oid: pr.head() },
			body: "",
		});
		const dismissals = () =>
			pr
				.ghLog()
				.split("\n")
				.filter((l) =>
					/^api -X PUT repos\/acme\/widget\/pulls\/12\/reviews\/\d+\/dismissals /.test(
						l,
					),
				);
		const comment = (more: Partial<VerdictRequest> = {}) =>
			request({ event: "COMMENT", body: "Fine by me", ...more });

		it("over a request for changes: posts the comment, then dismisses it; reads as commented, GitHub no longer blocks", async () => {
			scenario({}, { reviewDecision: "CHANGES_REQUESTED" }, [
				mine("CHANGES_REQUESTED"),
			]);
			const answer = await session.submitVerdict(comment());
			expect(answer).toMatchObject({
				review: { state: "COMMENTED", body: "Fine by me" },
				dismissed: "CHANGES_REQUESTED",
			});
			expect(answer.stillStands).toBeUndefined();
			expect(posts()).toHaveLength(1);
			expect(dismissals()).toEqual([
				"api -X PUT repos/acme/widget/pulls/12/reviews/9000/dismissals --input -",
			]);
			// The comment first, then the dismissal.
			const log = pr.ghLog();
			expect(log.indexOf("-X POST")).toBeLessThan(log.indexOf("-X PUT"));
			expect(stored().map((r) => r.state)).toEqual(["DISMISSED", "COMMENTED"]);
			const facts = await session.verdict();
			expect(facts.reviews).toEqual([
				expect.objectContaining({ state: "COMMENTED", you: true }),
			]);
			expect(facts.reviewDecision).toBe("REVIEW_REQUIRED");
			const [you] = (await session.overview()).reviews;
			expect(you).toMatchObject({ state: "COMMENTED", you: true });
			expect(you?.opinion).toBeUndefined();
		});

		it("over an approval: the same; GitHub's approval goes", async () => {
			scenario({}, { reviewDecision: "APPROVED" }, [mine("APPROVED")]);
			const answer = await session.submitVerdict(comment());
			expect(answer.dismissed).toBe("APPROVED");
			expect(dismissals()).toHaveLength(1);
			expect(stored().map((r) => r.state)).toEqual(["DISMISSED", "COMMENTED"]);
			expect((await session.verdict()).reviewDecision).toBe("REVIEW_REQUIRED");
		});

		it("the fresh read after the comment fails: the resend posts nothing and finishes the dismissal", async () => {
			scenario({ failNext: { op: "reviews", status: 502 } }, {}, [
				mine("CHANGES_REQUESTED"),
			]);
			const req = comment();
			await expect(session.submitVerdict(req)).rejects.toBeInstanceOf(GhError);
			expect(posts()).toHaveLength(1);
			expect(dismissals()).toEqual([]);
			const answer = await session.submitVerdict({ ...req, retry: true });
			expect(answer).toMatchObject({
				review: { state: "COMMENTED", body: "Fine by me" },
				dismissed: "CHANGES_REQUESTED",
			});
			expect(posts()).toHaveLength(1);
			expect(dismissals()).toHaveLength(1);
			expect(stored().map((r) => r.state)).toEqual(["DISMISSED", "COMMENTED"]);
		});

		it("no standing opinion of the viewer's: nothing dismissed, never someone else's", async () => {
			scenario({}, {}, [
				{ ...mine("CHANGES_REQUESTED"), author: user("ravi") },
				mine("COMMENTED"),
			]);
			const answer = await session.submitVerdict(comment());
			expect(answer.dismissed).toBeUndefined();
			expect(answer.stillStands).toBeUndefined();
			expect(dismissals()).toEqual([]);
			expect(stored().map((r) => r.state)).toEqual([
				"CHANGES_REQUESTED",
				"COMMENTED",
				"COMMENTED",
			]);
		});

		it("Approve and Request changes never dismiss (they replace each other on GitHub)", async () => {
			scenario({}, {}, [mine("CHANGES_REQUESTED")]);
			await session.submitVerdict(request());
			expect(dismissals()).toEqual([]);
		});

		it("a refused dismissal: the comment landed, the answer says the opinion still stands with GitHub's message; a resend posts nothing", async () => {
			scenario({ failNext: { op: "dismiss", status: 403 } }, {}, [
				mine("CHANGES_REQUESTED"),
			]);
			const req = comment();
			const answer = await session.submitVerdict(req);
			expect(answer).toMatchObject({
				review: { state: "COMMENTED" },
				stillStands: {
					state: "CHANGES_REQUESTED",
					message: "Resource not accessible by integration",
				},
			});
			expect(answer.dismissed).toBeUndefined();
			expect(stored().map((r) => r.state)).toEqual([
				"CHANGES_REQUESTED",
				"COMMENTED",
			]);
			expect(await session.submitVerdict({ ...req, retry: true })).toEqual(
				answer,
			);
			expect(posts()).toHaveLength(1);
			expect(dismissals()).toHaveLength(1);
			// GitHub's view: the request for changes stands.
			expect((await session.verdict()).reviews).toEqual([
				expect.objectContaining({ state: "CHANGES_REQUESTED", you: true }),
			]);
		});

		it("the comment landed but its answer was lost: the retry posts nothing and still dismisses, after a restart too", async () => {
			scenario(
				{ failNext: { op: "verdict", status: 502, afterWrite: true } },
				{},
				[mine("APPROVED")],
			);
			const req = comment();
			await expect(session.submitVerdict(req)).rejects.toBeInstanceOf(GhError);
			expect(stored().map((r) => r.state)).toEqual(["APPROVED", "COMMENTED"]);
			expect(dismissals()).toEqual([]);
			const restarted = await Session.open(pr.arg, process.cwd());
			const answer = await restarted.submitVerdict({ ...req, retry: true });
			expect(answer).toMatchObject({
				review: { state: "COMMENTED", body: "Fine by me" },
				dismissed: "APPROVED",
			});
			expect(posts()).toHaveLength(1);
			expect(dismissals()).toHaveLength(1);
			expect(stored().map((r) => r.state)).toEqual(["DISMISSED", "COMMENTED"]);
		});

		it("a retry never dismisses a verdict given after the comment", async () => {
			scenario(
				{ failNext: { op: "verdict", status: 502, afterWrite: true } },
				{},
				[mine("CHANGES_REQUESTED")],
			);
			const req = comment();
			await expect(session.submitVerdict(req)).rejects.toBeInstanceOf(GhError);
			// Approved since (another press, GitHub's UI).
			await session.submitVerdict(request());
			const answer = await session.submitVerdict({ ...req, retry: true });
			expect(answer.dismissed).toBeUndefined();
			expect(dismissals()).toEqual([]);
			expect(stored().map((r) => r.state)).toEqual([
				"CHANGES_REQUESTED",
				"COMMENTED",
				"APPROVED",
			]);
		});

		it("dismissing a review already dismissed counts as done", async () => {
			scenario({}, {}, [mine("DISMISSED")]);
			await expect(
				dismissReview({ owner: "acme", repo: "widget", number: 12 }, 9000),
			).resolves.toBeUndefined();
			// GitHub's own text for it, not this function's.
			expect(dismissals()).toHaveLength(1);
			scenario({}, {}, [mine("COMMENTED")]);
			await expect(
				dismissReview({ owner: "acme", repo: "widget", number: 12 }, 9000),
			).rejects.toThrow("Can not dismiss a commented pull request review");
		});
	});
});
