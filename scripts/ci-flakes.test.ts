import { describe, expect, it } from "vitest";
import {
	type Attempt,
	aggregate,
	collect,
	judgeAttempt,
	type OutcomeDoc,
	parseSince,
	type Run,
	render,
	transient,
} from "./ci-flakes.mjs";

const doc = (
	job: string,
	verdict: string,
	failed: OutcomeDoc["failed"] = [],
	attempt = 1,
): OutcomeDoc => ({ job, verdict, failed, attempt });
const flakyTest = (title: string, project: string | null = "chromium") => ({
	file: "e2e/a.spec.ts",
	title,
	project,
	verdict: "flaky",
});
const jobs = (failed: string[]) =>
	["checks", "windows-agent", "e2e (1/4)", "e2e (2/4)", "e2e"].map((name) => ({
		name,
		conclusion:
			failed.includes(name) ||
			(name === "e2e" && failed.some((f) => f.startsWith("e2e (")))
				? "failure"
				: "success",
	}));
const ok = (n = 1): Attempt => ({
	n,
	status: "completed",
	conclusion: "success",
});
const failedAttempt = (
	outcomes: OutcomeDoc[] | undefined,
	failedJobs: string[] | undefined,
	n = 1,
): Attempt => ({
	n,
	status: "completed",
	conclusion: "failure",
	createdAt: `2026-11-1${n}T10:00:00Z`,
	url: `https://example.invalid/run/attempts/${n}`,
	...(outcomes ? { outcomes } : {}),
	...(failedJobs ? { jobs: jobs(failedJobs) } : {}),
});
let nextId = 1;
const run = (
	attempts: Attempt[],
	branch = "feature",
	event = "pull_request",
): Run => ({
	id: nextId++,
	branch,
	event,
	attempts,
});

describe("judging a failed attempt", () => {
	it("one flaky job: flaky; the e2e summary job doesn't count", () => {
		const a = failedAttempt(
			[doc("e2e (2/4)", "flaky", [flakyTest("t")])],
			["e2e (2/4)"],
		);
		expect(judgeAttempt(a, false).verdict).toBe("flaky");
	});
	it("one consistent: consistent, even next to flaky ones", () => {
		const a = failedAttempt(
			[doc("e2e (2/4)", "flaky"), doc("checks", "consistent")],
			["e2e (2/4)", "checks"],
		);
		expect(judgeAttempt(a, false).verdict).toBe("consistent");
	});
	it("a non-test failure (lint, build): non-test", () => {
		const a = failedAttempt([doc("checks", "non-test")], ["checks"]);
		expect(judgeAttempt(a, false).verdict).toBe("non-test");
	});
	it("a failed job with no outcome (runner lost) makes a flaky one unknown", () => {
		const a = failedAttempt(
			[doc("e2e (1/4)", "flaky")],
			["e2e (1/4)", "windows-agent"],
		);
		expect(judgeAttempt(a, false)).toEqual({
			verdict: "unknown",
			reason: "windows-agent: unknown, e2e (1/4): flaky",
		});
	});
	it("not rerun (too many failures): unknown", () => {
		const a = failedAttempt([doc("checks", "not-rerun")], ["checks"]);
		expect(judgeAttempt(a, false).verdict).toBe("unknown");
	});
	it("a later attempt that passed makes it flaky", () => {
		const a = failedAttempt([doc("checks", "consistent")], ["checks"]);
		expect(judgeAttempt(a, true)).toEqual({
			verdict: "flaky",
			reason: "a later attempt passed",
		});
	});
	it("no jobs listed: the outcomes alone", () => {
		expect(
			judgeAttempt(failedAttempt([doc("checks", "flaky")], undefined), false)
				.verdict,
		).toBe("flaky");
		expect(judgeAttempt(failedAttempt([], undefined), false).verdict).toBe(
			"unknown",
		);
	});
});

describe("aggregating a window", () => {
	it("all green: no flakes", () => {
		const s = aggregate([run([ok()]), run([ok()], "master", "push")]);
		expect(s).toMatchObject({
			runs: 2,
			attempts: 2,
			passed: 2,
			failed: 0,
			flakeRate: 0,
		});
		expect(s.topFlaky).toEqual([]);
	});

	it("mixed: the rate counts flaky attempts over completed ones; others apart", () => {
		const runs = [
			// Flaky on a PR.
			run([
				failedAttempt(
					[doc("e2e (1/4)", "flaky", [flakyTest("t1")])],
					["e2e (1/4)"],
				),
			]),
			// Flaky on master, the same test.
			run(
				[
					failedAttempt(
						[doc("e2e (2/4)", "flaky", [flakyTest("t1")])],
						["e2e (2/4)"],
					),
				],
				"master",
				"push",
			),
			// Consistent: a bug.
			run([failedAttempt([doc("checks", "consistent")], ["checks"])]),
			// Non-test: lint failed.
			run([failedAttempt([doc("checks", "non-test")], ["checks"])]),
			// From before the outcomes: no artifacts.
			run([failedAttempt([], ["checks"])]),
			// A rerun of the workflow turned green: attempt 1 flaky, 2 passed.
			run([failedAttempt([], ["windows-agent"], 1), ok(2)], "master", "push"),
			// Cancelled and running: not counted.
			run([{ n: 1, status: "completed", conclusion: "cancelled" }]),
			run([{ n: 1, status: "in_progress", conclusion: null }]),
			run([ok()], "master", "push"),
			run([ok()]),
		];
		const s = aggregate(runs);
		expect(s).toMatchObject({
			runs: 10,
			attempts: 11,
			passed: 3,
			failed: 6,
			cancelled: 1,
			inProgress: 1,
			flaky: 3,
			consistent: 1,
			nonTest: 1,
			unknown: 1,
		});
		expect(s.flakeRate).toBeCloseTo((100 * 3) / 9);
		expect(s.master).toEqual({ attempts: 4, flaky: 2, flakeRate: 50 });
		expect(s.topFlaky).toEqual([
			expect.objectContaining({ title: "t1", count: 2, job: "e2e (2/4)" }),
		]);
		const text = render(s, { title: "CI flakes" });
		expect(text).toContain(
			"Flake rate: 33.3% (3 of 9 attempts); master: 50.0% (2 of 4)",
		);
		expect(text).toContain(
			"1 consistent test failure, 1 non-test failure, 1 unknown (no outcome)",
		);
		expect(text).toContain("e2e/a.spec.ts › t1 [chromium]");
	});

	it("a test flaky in two projects is two entries; the newest run is the link", () => {
		const s = aggregate([
			run([
				failedAttempt(
					[
						doc("e2e (1/4)", "flaky", [
							flakyTest("t", "chromium"),
							flakyTest("t", "phone"),
						]),
					],
					["e2e (1/4)"],
					1,
				),
				failedAttempt(
					[doc("e2e (3/4)", "flaky", [flakyTest("t", "phone")], 2)],
					["e2e (3/4)"],
					2,
				),
			]),
		]);
		expect(
			s.topFlaky.map((t) => [t.project, t.count, t.job, t.lastRun]),
		).toEqual([
			["phone", 2, "e2e (3/4)", "https://example.invalid/run/attempts/2"],
			["chromium", 1, "e2e (1/4)", "https://example.invalid/run/attempts/1"],
		]);
	});

	it("a unit test flaky on Linux and on Windows is two entries", () => {
		const unit = { ...flakyTest("u", null), file: "src/a.test.ts" };
		const s = aggregate([
			run([
				failedAttempt(
					[
						doc("checks", "flaky", [unit]),
						doc("windows-agent", "flaky", [unit]),
					],
					["checks", "windows-agent"],
				),
			]),
		]);
		expect(s.topFlaky.map((t) => [t.job, t.count])).toEqual([
			["checks", 1],
			["windows-agent", 1],
		]);
	});

	it("markdown escapes test titles", () => {
		const s = aggregate([
			run([
				failedAttempt(
					[doc("checks", "flaky", [flakyTest("a | <b>")])],
					["checks"],
				),
			]),
		]);
		const md = render(s, { title: "x", markdown: true });
		expect(md).not.toContain("<b>");
		expect(md).toContain("| 1 |");
	});
});

describe("collecting runs", () => {
	it("every attempt, and jobs and outcomes for the failed ones only", () => {
		const calls: string[][] = [];
		const gh = (args: string[]) => {
			calls.push(args);
			const path = args.find((a) => a.startsWith("repos/")) ?? "";
			if (path.endsWith("/runs")) {
				return [
					{
						id: 10,
						run_attempt: 2,
						status: "completed",
						conclusion: "success",
						head_branch: "master",
						event: "push",
						html_url: "https://example.invalid/runs/10",
						created_at: "2026-11-15T00:00:00Z",
					},
					{
						id: 11,
						run_attempt: 1,
						status: "completed",
						conclusion: "success",
						head_branch: "b",
						event: "pull_request",
						html_url: "https://example.invalid/runs/11",
					},
				]
					.map((r) => JSON.stringify(r))
					.join("\n");
			}
			if (path === "repos/o/r/actions/runs/10/attempts/1") {
				return JSON.stringify({ status: "completed", conclusion: "failure" });
			}
			if (path.startsWith("repos/o/r/actions/runs/10/attempts/1/jobs")) {
				return `${JSON.stringify({ name: "checks", conclusion: "failure" })}\n`;
			}
			throw new Error(`unexpected gh ${args.join(" ")}`);
		};
		const downloads: number[] = [];
		const runs = collect({
			repo: "o/r",
			since: new Date("2026-11-09T00:00:00Z"),
			gh,
			outcomes: (id) => {
				downloads.push(id);
				return [doc("checks", "flaky", [], 1), doc("checks", "passed", [], 2)];
			},
		});
		expect(downloads).toEqual([10]);
		expect(
			runs[0]?.attempts.map((a) => [a.n, a.conclusion, a.outcomes?.length]),
		).toEqual([
			[1, "failure", 1],
			[2, "success", undefined],
		]);
		expect(calls[0]).toContain("created=>=2026-11-09T00:00:00.000Z");
		const s = aggregate(runs);
		expect(s).toMatchObject({ attempts: 3, passed: 2, flaky: 1 });
	});

	it("only GitHub's own failures are tried again", () => {
		expect(transient("gh: Server Error (HTTP 502)")).toBe(true);
		expect(transient("read: connection reset by peer")).toBe(true);
		expect(transient("gh: Not Found (HTTP 404)")).toBe(false);
	});

	it("--since takes days, hours or a date", () => {
		const now = new Date("2026-11-16T12:00:00Z");
		expect(parseSince("7d", now).toISOString()).toBe(
			"2026-11-09T12:00:00.000Z",
		);
		expect(parseSince("12h", now).toISOString()).toBe(
			"2026-11-16T00:00:00.000Z",
		);
		expect(parseSince("2026-11-01", now).toISOString()).toBe(
			"2026-11-01T00:00:00.000Z",
		);
		expect(() => parseSince("soon", now)).toThrow();
	});
});
