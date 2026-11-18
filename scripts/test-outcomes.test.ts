import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cell,
	errorHead,
	jobVerdict,
	labelFailures,
	otherFailedSteps,
	playwrightResults,
	readResults,
	rerunArgs,
	run,
	summaryMarkdown,
	UNHANDLED,
	UNKNOWN_SOURCE,
	unhandledPath,
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

describe("autolinks", () => {
	it("a bare URL in a title is no link", () => {
		const out = cell("see https://evil.example/x and www.evil.example");
		expect(out).not.toMatch(/https:\/\/evil/);
		expect(out).not.toMatch(/www\.evil/);
	});
});

describe("Vitest's unhandled errors", () => {
	const report = (...files: string[]) => ({
		testResults: files.map((f) => ({
			name: `/repo/${f}`,
			status: "passed",
			assertionResults: [],
		})),
	});
	const first = (errors: { message: string; file?: string }[]) =>
		readResults("vitest", report("src/a.test.ts", "src/b.test.ts"), "/repo", {
			errors,
		})?.failed ?? [];
	/** The verdicts after a rerun that ran `files` and had `errors`. */
	const afterRerun = (
		failed: ReturnType<typeof first>,
		files: string[],
		errors: { message: string; file?: string }[] | null,
	) =>
		labelFailures(
			failed,
			readResults("vitest", report(...files), "/repo", errors && { errors }, {
				failed,
				files: ["src/a.test.ts", "src/b.test.ts"],
			}),
		).map((t) => [t.file, t.verdict]);

	it("each is a failure of the file it was traced to, or of the unknown file", () => {
		expect(
			first([
				{ message: "Unhandled Rejection: boom", file: "/repo/src/a.test.ts" },
				{ message: "again", file: "/repo/src/a.test.ts" },
				{ message: "who knows" },
			]).map((t) => [t.file, t.title]),
		).toEqual([
			["src/a.test.ts", UNHANDLED],
			[UNKNOWN_SOURCE, UNHANDLED],
		]);
	});

	it("gone on rerun: flaky; back on rerun: consistent", () => {
		const traced = first([{ message: "boom", file: "/repo/src/a.test.ts" }]);
		expect(afterRerun(traced, ["src/a.test.ts"], [])).toEqual([
			["src/a.test.ts", "flaky"],
		]);
		expect(
			afterRerun(
				traced,
				["src/a.test.ts"],
				[{ message: "boom", file: "/repo/src/a.test.ts" }],
			),
		).toEqual([["src/a.test.ts", "consistent"]]);
	});

	it("untraced first, traced on rerun: the same error came back, consistent", () => {
		const untraced = first([{ message: "boom" }]);
		expect(
			afterRerun(
				untraced,
				["src/a.test.ts", "src/b.test.ts"],
				[{ message: "boom", file: "/repo/src/a.test.ts" }],
			),
		).toEqual([[UNKNOWN_SOURCE, "consistent"]]);
	});

	it("traced first, untraced on rerun: consistent", () => {
		const traced = first([{ message: "boom", file: "/repo/src/a.test.ts" }]);
		expect(
			afterRerun(traced, ["src/a.test.ts"], [{ message: "boom" }]),
		).toEqual([["src/a.test.ts", "consistent"]]);
	});

	it("an untraced one clears only when the rerun ran every file the first run had", () => {
		const untraced = first([{ message: "boom" }]);
		// A rerun that found no test files (a filter that matched nothing).
		expect(afterRerun(untraced, [], [])).toEqual([
			[UNKNOWN_SOURCE, "not-rerun"],
		]);
		expect(afterRerun(untraced, ["src/a.test.ts"], [])).toEqual([
			[UNKNOWN_SOURCE, "not-rerun"],
		]);
		expect(
			afterRerun(untraced, ["src/a.test.ts", "src/b.test.ts"], []),
		).toEqual([[UNKNOWN_SOURCE, "flaky"]]);
	});

	it("a traced one clears only when its file reran; no reporter output: not rerun", () => {
		const traced = first([{ message: "boom", file: "/repo/src/a.test.ts" }]);
		expect(afterRerun(traced, ["src/b.test.ts"], [])).toEqual([
			["src/a.test.ts", "not-rerun"],
		]);
		expect(afterRerun(traced, ["src/a.test.ts"], null)).toEqual([
			["src/a.test.ts", "not-rerun"],
		]);
	});
});

describe("labelling a job (run)", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	/** A failed tests step whose Vitest report has `failed` failing tests. */
	const setup = (failed: number, unhandled?: unknown) => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "test-outcomes-"));
		const reportPath = join(dir, "report.json");
		writeFileSync(
			reportPath,
			JSON.stringify({
				testResults: [
					{
						name: join(dir, "src/a.test.ts"),
						status: failed > 0 ? "failed" : "passed",
						assertionResults: Array.from({ length: failed }, (_, i) => ({
							ancestorTitles: [],
							title: `t${i}`,
							status: "failed",
							failureMessages: ["boom"],
						})),
					},
				],
			}),
		);
		if (unhandled) {
			writeFileSync(unhandledPath(reportPath), JSON.stringify(unhandled));
		}
		const out = join(dir, "out");
		const env = {
			STEPS: JSON.stringify({ tests: { outcome: "failure" } }),
			JOB_STATUS: "failure",
			GITHUB_RUN_ID: "5",
			GITHUB_OUTPUT: join(dir, "github-output"),
		};
		const argv = [
			"--runner",
			"vitest",
			"--job",
			"checks",
			"--report",
			reportPath,
			"--out",
			out,
		];
		const docPath = join(out, "test-outcomes.json");
		return { argv, env, out, docPath };
	};
	/** A rerun that writes `report` as its JSON report. */
	const rerunWriting =
		(report: unknown, unhandled?: unknown) =>
		(_args: string[], env: Record<string, string | undefined>) => {
			const path = env.CRB_TEST_JSON ?? "";
			writeFileSync(path, JSON.stringify(report));
			if (unhandled)
				writeFileSync(unhandledPath(path), JSON.stringify(unhandled));
		};
	const log = () => {};

	it("over 10 failures: no rerun, each failure not rerun", () => {
		const { argv, env } = setup(11);
		let spawned = 0;
		const doc = run({ argv, env, cwd: dir, log, spawn: () => spawned++ });
		expect(spawned).toBe(0);
		expect(doc.verdict).toBe("not-rerun");
		expect(doc.failed.every((t) => t.verdict === "not-rerun")).toBe(true);
		expect(doc.note).toMatch(/11 failed tests, over 10: not rerun/);
	});

	it("the outcome is written before the rerun, so a rerun cut short leaves the failures not rerun", () => {
		const { argv, env, docPath } = setup(1);
		let seen: { verdict: string; note: string } | null = null;
		run({
			argv,
			env,
			cwd: dir,
			log,
			spawn: () => {
				seen = JSON.parse(readFileSync(docPath, "utf8"));
			},
		});
		expect(seen).toMatchObject({
			verdict: "not-rerun",
			note: "the rerun didn't finish",
		});
	});

	it("a rerun that writes no report: not rerun; one that passes: flaky; one that fails: consistent", () => {
		let s = setup(1);
		expect(run({ ...s, cwd: dir, log, spawn: () => {} })).toMatchObject({
			verdict: "not-rerun",
			note: "the rerun wrote no report",
		});
		s = setup(1);
		const pass = {
			testResults: [
				{
					name: join(dir, "src/a.test.ts"),
					status: "passed",
					assertionResults: [
						{ ancestorTitles: [], title: "t0", status: "passed" },
					],
				},
			],
		};
		const doc = run({ ...s, cwd: dir, log, spawn: rerunWriting(pass) });
		expect(doc.verdict).toBe("flaky");
		expect(readFileSync(s.env.GITHUB_OUTPUT, "utf8")).toBe("verdict=flaky\n");
		s = setup(1);
		const fail = {
			testResults: [
				{
					name: join(dir, "src/a.test.ts"),
					status: "failed",
					assertionResults: [
						{
							ancestorTitles: [],
							title: "t0",
							status: "failed",
							failureMessages: ["again"],
						},
					],
				},
			],
		};
		expect(
			run({ ...s, cwd: dir, log, spawn: rerunWriting(fail) }),
		).toMatchObject({
			verdict: "consistent",
			failed: [{ verdict: "consistent", rerunError: "again" }],
		});
	});

	it("the rerun goes to its own report, without GitHub annotations", () => {
		const s = setup(1);
		let env: Record<string, string | undefined> = {};
		run({
			...s,
			cwd: dir,
			log,
			spawn: (_a, e) => {
				env = e;
			},
		});
		expect(env.CRB_TEST_JSON).toBe(join(s.out, "rerun-report.json"));
		expect(env.GITHUB_ACTIONS).toBe("");
	});

	it("tests failed with no report: non-test, nothing rerun", () => {
		const s = setup(0);
		rmSync(s.argv[5] ?? "");
		let spawned = 0;
		const doc = run({ ...s, cwd: dir, log, spawn: () => spawned++ });
		expect(spawned).toBe(0);
		expect(doc).toMatchObject({
			verdict: "non-test",
			note: "the tests step failed and wrote no report",
		});
		expect(existsSync(s.docPath)).toBe(true);
	});

	it("an unhandled error with every test passing: its file reruns, labelled like a test", () => {
		let s = setup(0);
		// The error came from src/a.test.ts.
		const fromA = {
			errors: [
				{ message: "Unhandled Rejection", file: join(dir, "src/a.test.ts") },
			],
		};
		writeFileSync(unhandledPath(s.argv[5] ?? ""), JSON.stringify(fromA));
		const clean = {
			testResults: [
				{
					name: join(dir, "src/a.test.ts"),
					status: "passed",
					assertionResults: [],
				},
			],
		};
		let args: string[] = [];
		const doc = run({
			...s,
			cwd: dir,
			log,
			spawn: (a, e) => {
				args = a;
				rerunWriting(clean, { errors: [] })(a, e);
			},
		});
		expect(args.at(-1)).toBe("src/a.test.ts");
		expect(doc).toMatchObject({
			verdict: "flaky",
			failed: [{ file: "src/a.test.ts", title: UNHANDLED, verdict: "flaky" }],
		});
		// Again on rerun: consistent.
		s = setup(0);
		writeFileSync(
			unhandledPath(s.argv[5] ?? ""),
			JSON.stringify({
				errors: [{ message: "x", file: join(dir, "src/a.test.ts") }],
			}),
		);
		expect(
			run({
				...s,
				cwd: dir,
				log,
				spawn: rerunWriting(clean, {
					errors: [{ message: "x", file: join(dir, "src/a.test.ts") }],
				}),
			}).verdict,
		).toBe("consistent");
	});

	it("an unhandled error from an unknown file reruns every file the run had, within the cap", () => {
		const s = setup(0);
		writeFileSync(
			unhandledPath(s.argv[5] ?? ""),
			JSON.stringify({ errors: [{ message: "x" }] }),
		);
		let args: string[] = [];
		const doc = run({
			...s,
			cwd: dir,
			log,
			spawn: (a, e) => {
				args = a;
				rerunWriting(
					{
						testResults: [
							{
								name: join(dir, "src/a.test.ts"),
								status: "passed",
								assertionResults: [],
							},
						],
					},
					{ errors: [] },
				)(a, e);
			},
		});
		expect(args.at(-1)).toBe("src/a.test.ts");
		expect(doc.failed).toEqual([
			expect.objectContaining({ file: UNKNOWN_SOURCE, verdict: "flaky" }),
		]);
	});
});
