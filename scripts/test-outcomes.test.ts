import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	cell,
	errorHead,
	jobVerdict,
	labelFailures,
	otherFailedSteps,
	playwrightResults,
	rerunArgs,
	summaryMarkdown,
	vitestResults,
	WHOLE_FILE,
} from "./test-outcomes.mjs";

const cwd = "/repo";

// Vitest's JSON report, cut to what the labelling reads.
const vitestReport = {
	testResults: [
		{
			name: "/repo/src/a.test.ts",
			status: "failed",
			assertionResults: [
				{
					ancestorTitles: ["a"],
					title: "fails",
					status: "failed",
					failureMessages: [
						"\u001b[31mAssertionError: expected 1 to be 2\u001b[39m",
					],
				},
				{ ancestorTitles: ["a"], title: "passes", status: "passed" },
			],
		},
		{
			name: "/repo/src/b.test.ts",
			status: "failed",
			message: "Cannot find module './gone'",
			assertionResults: [],
		},
		{
			name: "/repo/src/c.test.ts",
			status: "passed",
			assertionResults: [{ ancestorTitles: [], title: "ok", status: "passed" }],
		},
	],
};

// Playwright's JSON report: a file suite, a describe, two projects.
const playwrightReport = {
	errors: [],
	suites: [
		{
			title: "files.spec.ts",
			file: "files.spec.ts",
			specs: [
				{
					title: "top level",
					file: "files.spec.ts",
					line: 5,
					tests: [
						{ projectName: "chromium", status: "expected", results: [] },
						{
							projectName: "phone",
							status: "unexpected",
							results: [
								{ status: "timedOut", error: { message: "Timeout 10000ms" } },
							],
						},
					],
				},
			],
			suites: [
				{
					title: "a describe",
					file: "files.spec.ts",
					specs: [
						{
							title: "nested",
							file: "files.spec.ts",
							line: 20,
							tests: [
								{
									projectName: "chromium",
									status: "unexpected",
									results: [
										{ status: "failed", error: { message: "expect(locator)" } },
									],
								},
							],
						},
					],
				},
			],
		},
	],
};

describe("reading reports", () => {
	it("vitest: failed tests by file and full title; a file that failed to load as a whole", () => {
		const r = vitestResults(vitestReport, cwd);
		expect(r.failed).toEqual([
			{
				file: "src/a.test.ts",
				title: "a > fails",
				project: null,
				error: "AssertionError: expected 1 to be 2",
			},
			{
				file: "src/b.test.ts",
				title: WHOLE_FILE,
				project: null,
				error: "Cannot find module './gone'",
			},
		]);
		expect(r.passed).toContainEqual({
			file: "src/c.test.ts",
			title: WHOLE_FILE,
			project: null,
		});
	});

	it("playwright: unexpected tests per project, titles under describes, the line to rerun", () => {
		const r = playwrightResults(playwrightReport);
		expect(r.failed).toEqual([
			{
				file: "e2e/files.spec.ts",
				title: "top level",
				project: "phone",
				line: 5,
				error: "Timeout 10000ms",
			},
			{
				file: "e2e/files.spec.ts",
				title: "a describe › nested",
				project: "chromium",
				line: 20,
				error: "expect(locator)",
			},
		]);
		expect(r.passed).toEqual([
			{ file: "e2e/files.spec.ts", title: "top level", project: "chromium" },
		]);
	});

	it("an error head has no colors and a bounded length", () => {
		expect(errorHead("\u001b[2mdim\u001b[22m")).toBe("dim");
		expect(errorHead("x".repeat(1000)).length).toBeLessThan(310);
		expect(errorHead(undefined)).toBe("");
	});
});

describe("the rerun", () => {
	it("vitest reruns each failed file once, in the queue", () => {
		const failed = vitestResults(vitestReport, cwd).failed;
		const args = rerunArgs("vitest", [...failed, ...failed], {
			scripts: "/s",
			outputDir: "/o",
		});
		expect(args[0]).toBe(join("/s", "queue.mjs"));
		expect(args.slice(-3)).toEqual(["run", "src/a.test.ts", "src/b.test.ts"]);
	});

	it("playwright reruns file:line in the failures' projects, no shard, its own output", () => {
		const failed = playwrightResults(playwrightReport).failed;
		const args = rerunArgs("playwright", failed, {
			scripts: "/s",
			outputDir: "/o",
		});
		expect(args).toContain("--project=phone");
		expect(args).toContain("--project=chromium");
		expect(args).toContain("--output=/o");
		expect(args).toContain("--reporter=list,json");
		expect(args).toContain("e2e/files.spec.ts:5");
		expect(args).toContain("e2e/files.spec.ts:20");
		expect(args.some((a) => a.startsWith("--shard"))).toBe(false);
	});

	it("labels: passed on rerun is flaky, failed again consistent, not run not-rerun", () => {
		const failed = playwrightResults(playwrightReport).failed;
		const rerun = {
			failed: [{ ...failed[1]!, error: "again" }],
			passed: [
				{ file: "e2e/files.spec.ts", title: "top level", project: "phone" },
			],
		};
		expect(
			labelFailures(failed, rerun).map((t) => [t.verdict, t.rerunError]),
		).toEqual([
			["flaky", undefined],
			["consistent", "again"],
		]);
		// The same test in another project is another test.
		const otherProject = {
			failed: [],
			passed: [
				{ file: "e2e/files.spec.ts", title: "top level", project: "chromium" },
			],
		};
		expect(labelFailures(failed, otherProject).map((t) => t.verdict)).toEqual([
			"not-rerun",
			"not-rerun",
		]);
		expect(labelFailures(failed, null).map((t) => t.verdict)).toEqual([
			"not-rerun",
			"not-rerun",
		]);
		expect(labelFailures(failed, null)[0]).not.toHaveProperty("line");
	});
});

describe("the job's verdict", () => {
	const t = (verdict: "flaky" | "consistent" | "not-rerun") => ({
		file: "f",
		title: verdict,
		project: null,
		error: "",
		verdict,
	});
	const v = (o: Partial<Parameters<typeof jobVerdict>[0]>) =>
		jobVerdict({
			jobStatus: "failure",
			testsStep: "failure",
			failed: [],
			otherFailed: [],
			...o,
		});

	it("all green", () => {
		expect(v({ jobStatus: "success", testsStep: "success" })).toBe("passed");
	});
	it("every failure passed on rerun: flaky", () => {
		expect(v({ failed: [t("flaky"), t("flaky")] })).toBe("flaky");
	});
	it("one failed again: consistent, whatever else", () => {
		expect(v({ failed: [t("flaky"), t("consistent"), t("not-rerun")] })).toBe(
			"consistent",
		);
	});
	it("a failure not rerun keeps it from counting as flaky", () => {
		expect(v({ failed: [t("flaky"), t("not-rerun")] })).toBe("not-rerun");
	});
	it("lint, typecheck, install or build failed (tests skipped): non-test", () => {
		expect(v({ testsStep: "skipped", otherFailed: ["lint"] })).toBe("non-test");
		expect(v({ testsStep: "skipped" })).toBe("non-test");
	});
	it("tests failed with no failed test (a setup error, a hang): non-test", () => {
		expect(v({})).toBe("non-test");
	});
	it("flaky tests and a later step failed too: non-test", () => {
		expect(v({ failed: [t("flaky")], otherFailed: ["pack"] })).toBe("non-test");
	});
	it("tests passed, a later step failed: non-test", () => {
		expect(v({ testsStep: "success", otherFailed: ["pack"] })).toBe("non-test");
	});
	it("cancelled", () => {
		expect(v({ jobStatus: "cancelled" })).toBe("cancelled");
	});
	it("failed steps from the steps context, the tests aside", () => {
		expect(
			otherFailedSteps({
				tests: { outcome: "failure" },
				lint: { outcome: "success" },
				pack: { outcome: "failure" },
			}),
		).toEqual(["pack"]);
	});
});

describe("the job summary", () => {
	it("a table of each failure and its verdict", () => {
		const md = summaryMarkdown({
			job: "e2e (2/4)",
			verdict: "flaky",
			failed: [
				{
					file: "e2e/a.spec.ts",
					title: "loads",
					project: "phone",
					error: "Timeout",
					verdict: "flaky",
				},
			],
		});
		expect(md).toContain("flaky: passed on rerun");
		expect(md).toContain("| loads | e2e/a.spec.ts | phone | Timeout |");
	});

	it("a test title can't add markup, links, HTML or table cells", () => {
		const title = "a | b <img src=x> [x](http://evil) `c`\nnext";
		const out = cell(title);
		expect(out).not.toMatch(/[|<>[\]`\n]/);
		const md = summaryMarkdown({
			job: "checks",
			verdict: "consistent",
			failed: [
				{ file: "f", title, project: null, error: "", verdict: "consistent" },
			],
		});
		const row = md.split("\n").find((l) => l.startsWith("| consistent"));
		expect(row?.split("|").length).toBe(7);
		expect(md).not.toContain("<img");
	});

	it("all passed: one line", () => {
		expect(
			summaryMarkdown({ job: "checks", verdict: "passed", failed: [] }),
		).toContain("All tests passed.");
	});
});
