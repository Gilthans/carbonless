import { describe, expect, it } from "vitest";
import { checkHotfixPrs, parseCommits } from "./hotfix-prs.mjs";

const BRANCH = "hotfix/0.4.1";
const M1 = "1".repeat(40);
const M2 = "2".repeat(40);
const P = "a".repeat(40);
const Q = "b".repeat(40);

/** A PR as GitHub's list API answers it. */
const pull = (
	number: number,
	sha: string,
	over: Record<string, unknown> = {},
) => ({
	number,
	merged_at: "2026-11-27T10:00:00Z",
	merge_commit_sha: sha,
	base: { ref: BRANCH },
	...over,
});
const RULES = [
	{ type: "pull_request" },
	{ type: "non_fast_forward" },
	{ type: "deletion" },
	{ type: "update" },
];
const commits = [
	{ sha: M1, parents: [P, Q], subject: "Fix a (CAR-30) (#30)" },
	{
		sha: M2,
		parents: [M1, Q],
		subject: "Merge pull request #31 from Gilthans/fix-b",
	},
];

describe("only merged PRs enter a hotfix", () => {
	it("reads git log's first-parent commits", () => {
		expect(
			parseCommits(
				`${M1} ${P} ${Q}\tFix a (CAR-30) (#30)\n${M2} ${M1}\tdirect\n`,
			),
		).toEqual([
			{ sha: M1, parents: [P, Q], subject: "Fix a (CAR-30) (#30)" },
			{ sha: M2, parents: [M1], subject: "direct" },
		]);
	});

	it("passes merges of PRs merged into the branch, each at its merge commit", () => {
		expect(
			checkHotfixPrs({
				commits,
				pulls: [[pull(30, M1), pull(31, M2)]],
				rules: RULES,
				branch: BRANCH,
			}),
		).toBe("2 PR merge(s) into hotfix/0.4.1: #30, #31");
	});

	it("refuses a commit that isn't a PR merge", () => {
		const check = (c: { sha: string; parents: string[]; subject: string }) =>
			checkHotfixPrs({
				commits: [c],
				pulls: [pull(30, M1)],
				rules: RULES,
				branch: BRANCH,
			});
		// A direct push (one parent), even with a PR-like subject.
		expect(() =>
			check({ sha: M1, parents: [P], subject: "Fix a (CAR-30) (#30)" }),
		).toThrow(/1{40} is not a PR merge/);
		// A merge with no PR number.
		expect(() =>
			check({ sha: M1, parents: [P, Q], subject: "Merge branch 'x'" }),
		).toThrow(/is not a PR merge/);
		expect(() =>
			checkHotfixPrs({ commits: [], pulls: [], rules: RULES, branch: BRANCH }),
		).toThrow(/nothing on hotfix\/0\.4\.1/);
	});

	it("refuses a PR that isn't merged, merged elsewhere, or merged at another commit", () => {
		const check = (p: Record<string, unknown> | null) =>
			checkHotfixPrs({
				commits: [commits[0] as (typeof commits)[0]],
				pulls: p ? [p] : [],
				rules: RULES,
				branch: BRANCH,
			});
		expect(() => check(null)).toThrow(
			/#30 is not a PR merged into hotfix\/0\.4\.1/,
		);
		expect(() => check(pull(30, M1, { merged_at: null }))).toThrow(
			/#30 is not merged/,
		);
		expect(() => check(pull(30, M1, { base: { ref: "master" } }))).toThrow(
			/#30 was merged into master, not hotfix\/0\.4\.1/,
		);
		expect(() => check(pull(30, M2))).toThrow(
			/#30's merge commit is 2{40}, not 1{40}/,
		);
	});

	it("refuses a branch the rulesets don't protect (setup step 12)", () => {
		for (const missing of [
			"pull_request",
			"non_fast_forward",
			"deletion",
			// Restrict updates: only the bypass (the owner) merges into it.
			"update",
		]) {
			expect(() =>
				checkHotfixPrs({
					commits,
					pulls: [pull(30, M1), pull(31, M2)],
					rules: RULES.filter((r) => r.type !== missing),
					branch: BRANCH,
				}),
			).toThrow(new RegExp(`no ${missing} rule.*setup step 12`));
		}
		expect(() =>
			checkHotfixPrs({ commits, pulls: [], rules: {}, branch: BRANCH }),
		).toThrow(/not a list of rules/);
	});
});
