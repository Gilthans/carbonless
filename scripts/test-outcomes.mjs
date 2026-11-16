#!/usr/bin/env node
// Gives each CI test failure a verdict, flaky or consistent, without hiding
// it (docs/ci-flakes.md). The last step of each test job in ci.yml runs it,
// whatever happened before: when the tests step failed, it reruns only the
// failed tests once, at the same commit, and labels each one "flaky"
// (passed on rerun) or "consistent" (failed again). It never changes the
// job's result: the tests step already failed it, and this step's own
// status is ignored (continue-on-error). No automatic retry turns a job
// green. It writes test-outcomes.json, for the artifact `pnpm ci-flakes`
// reads, and a table of the failures to the job summary.
//
//   node scripts/test-outcomes.mjs --runner vitest|playwright --job <name>
//       --report <json> --out <dir>
//
// The tests step writes its JSON report to --report ($CRB_TEST_JSON, read by
// vitest.config.ts and playwright.config.ts). From the workflow: $STEPS
// (`toJSON(steps)`, the tests step's id is `tests`), $JOB_STATUS
// (`job.status`), and GitHub's own GITHUB_* variables.
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** A rerun of more failed tests than this would take long: a real bug. */
export const RERUN_CAP = 10;
const ERROR_HEAD = 300;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** An error message's first lines, without colors, at most ERROR_HEAD chars. */
export function errorHead(message) {
	if (!message) return "";
	const text = String(message).replace(ANSI, "").trim();
	return text.length > ERROR_HEAD ? `${text.slice(0, ERROR_HEAD)}…` : text;
}

const posix = (p) => p.split(sep).join("/").replaceAll("\\", "/");

/** The key a failure and its rerun share. */
export const testKey = (t) => `${t.file}\0${t.title}\0${t.project ?? ""}`;

/** A file that failed as a whole (it didn't load, a hook threw). */
export const WHOLE_FILE = "(file)";

/**
 * Vitest's JSON report (`--reporter=json`): its failed tests, file paths
 * relative to `cwd`. A file that failed without a failed test (it didn't
 * load, a hook threw) is one failure titled WHOLE_FILE. `ran`: tests it
 * ran, for telling a rerun's pass from a test it never got to.
 */
export function vitestResults(report, cwd) {
	const failed = [];
	const passed = [];
	for (const file of report?.testResults ?? []) {
		const path = posix(relative(cwd, file.name));
		let fileFailed = false;
		for (const a of file.assertionResults ?? []) {
			const title = [...(a.ancestorTitles ?? []), a.title].join(" > ");
			const t = { file: path, title, project: null };
			if (a.status === "failed") {
				fileFailed = true;
				failed.push({ ...t, error: errorHead(a.failureMessages?.[0]) });
			} else if (a.status === "passed") passed.push(t);
		}
		const whole = { file: path, title: WHOLE_FILE, project: null };
		if (file.status === "failed" && !fileFailed) {
			failed.push({ ...whole, error: errorHead(file.message) });
		} else if (file.status === "passed") passed.push(whole);
	}
	return { failed, passed };
}

/**
 * Playwright's JSON report: tests whose outcome was unexpected (failed,
 * timed out, interrupted) per project, with the line to rerun them by.
 * `file` is under the config's testDir (`e2e/`).
 */
export function playwrightResults(report, testDir = "e2e") {
	const failed = [];
	const passed = [];
	const walk = (suite, titles) => {
		for (const spec of suite.specs ?? []) {
			const title = [...titles, spec.title].join(" › ");
			const file = posix(join(testDir, spec.file ?? suite.file ?? ""));
			for (const test of spec.tests ?? []) {
				const t = { file, title, project: test.projectName ?? null };
				if (test.status === "unexpected") {
					const result = (test.results ?? []).find((r) => r.error);
					failed.push({
						...t,
						line: spec.line,
						error: errorHead(result?.error?.message),
					});
				} else if (test.status === "expected" || test.status === "flaky") {
					passed.push(t);
				}
			}
		}
		for (const child of suite.suites ?? []) {
			walk(child, [...titles, child.title]);
		}
	};
	// A file's suite carries the file name as its title: not part of a test's.
	for (const file of report?.suites ?? []) walk(file, []);
	return { failed, passed };
}

/** Errors outside any test (a global setup that threw): a non-test failure. */
export function reportErrors(runner, report) {
	if (runner === "playwright") {
		return (report?.errors ?? []).map((e) => errorHead(e.message));
	}
	return [];
}

/** The rerun's command line (after `node`), for the failed tests. */
export function rerunArgs(runner, failed, { scripts, outputDir }) {
	const queue = join(scripts, "queue.mjs");
	if (runner === "vitest") {
		const files = [...new Set(failed.map((t) => t.file))];
		return [
			queue,
			process.execPath,
			join("node_modules", "vitest", "vitest.mjs"),
			"run",
			...files,
		];
	}
	// file:line for each; every project a failure was in. The report's JSON
	// goes to PLAYWRIGHT_JSON_OUTPUT_FILE, test results to their own
	// directory: the first run's report and results stay as they were.
	const lines = [...new Set(failed.map((t) => `${t.file}:${t.line}`))];
	const projects = [...new Set(failed.map((t) => t.project).filter(Boolean))];
	return [
		queue,
		process.execPath,
		join(scripts, "dist-lock.mjs"),
		"--shared",
		process.execPath,
		join("node_modules", "@playwright", "test", "cli.js"),
		"test",
		...projects.map((p) => `--project=${p}`),
		"--reporter=list,json",
		`--output=${outputDir}`,
		...lines,
	];
}

/**
 * Each failure's verdict from the rerun's results: "flaky" when it passed
 * on rerun, "consistent" when it failed again, "not-rerun" when the rerun
 * never ran it (or didn't happen: `rerun` null).
 */
export function labelFailures(failed, rerun) {
	const again = new Map((rerun?.failed ?? []).map((t) => [testKey(t), t]));
	const passed = new Set((rerun?.passed ?? []).map(testKey));
	return failed.map((t) => {
		const { line: _line, ...rest } = t;
		const k = testKey(t);
		if (again.has(k)) {
			return {
				...rest,
				verdict: "consistent",
				rerunError: again.get(k)?.error ?? "",
			};
		}
		if (passed.has(k)) return { ...rest, verdict: "flaky" };
		return { ...rest, verdict: "not-rerun" };
	});
}

/**
 * The job's verdict, worst first: "consistent" (a test failed again: a
 * bug, or a flake that fails twice), "non-test" (something other than a
 * test failed: install, lint, typecheck, build, a setup error, a hang),
 * "not-rerun", "flaky" (every failure passed on rerun), else "passed".
 */
export function jobVerdict({ jobStatus, testsStep, failed, otherFailed }) {
	if (jobStatus === "cancelled") return "cancelled";
	if (failed.some((t) => t.verdict === "consistent")) return "consistent";
	if (otherFailed.length > 0) return "non-test";
	if (testsStep !== "success" && failed.length === 0) {
		return jobStatus === "success" && testsStep === "skipped"
			? "passed"
			: "non-test";
	}
	if (failed.some((t) => t.verdict === "not-rerun")) return "not-rerun";
	if (failed.length > 0) return "flaky";
	return jobStatus === "failure" ? "non-test" : "passed";
}

/** Steps (`toJSON(steps)`) other than the tests that failed. */
export function otherFailedSteps(steps) {
	return Object.entries(steps ?? {})
		.filter(([id, s]) => id !== "tests" && s?.outcome === "failure")
		.map(([id]) => id);
}

const VERDICT_TEXT = {
	flaky: "flaky: passed on rerun",
	consistent: "consistent: failed again",
	"not-rerun": "not rerun",
};

/** Text in a Markdown table cell: no markup, links or HTML from a title. */
export function cell(text) {
	return String(text ?? "")
		.replace(/[\\`*_[\]<>|#~!&]/g, (c) => `&#${c.charCodeAt(0)};`)
		.replace(/\s*\n\s*/g, " ");
}

/** The job summary's section for this job. */
export function summaryMarkdown(doc) {
	const head = `### Test outcomes: ${cell(doc.job)}`;
	if (doc.verdict === "passed") return `${head}\n\nAll tests passed.\n`;
	const lines = [head, "", `Verdict: **${doc.verdict}**`];
	if (doc.note) lines.push("", cell(doc.note));
	if (doc.failed.length > 0) {
		lines.push(
			"",
			"| Verdict | Test | File | Project | Error |",
			"| --- | --- | --- | --- | --- |",
		);
		for (const t of doc.failed) {
			lines.push(
				`| ${VERDICT_TEXT[t.verdict] ?? t.verdict} | ${cell(t.title)} | ${cell(t.file)} | ${cell(t.project ?? "")} | ${cell(t.rerunError || t.error)} |`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

const readJson = (path) => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
};

/** Reads a report into its failures (and errors outside tests). */
export function readResults(runner, report, cwd) {
	if (!report) return null;
	const r =
		runner === "vitest"
			? vitestResults(report, cwd)
			: playwrightResults(report);
	return { ...r, errors: reportErrors(runner, report) };
}

function parseArgs(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a?.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
		o[a.slice(2)] = argv[++i];
	}
	for (const k of ["runner", "job", "report", "out"]) {
		if (!o[k]) throw new Error(`--${k} is required`);
	}
	if (o.runner !== "vitest" && o.runner !== "playwright") {
		throw new Error(`--runner: vitest or playwright, not ${o.runner}`);
	}
	return o;
}

function main() {
	const o = parseArgs(process.argv.slice(2));
	const cwd = process.cwd();
	const env = process.env;
	let steps = {};
	try {
		steps = JSON.parse(env.STEPS || "{}");
	} catch {}
	const testsStep = steps.tests?.outcome ?? "skipped";
	const jobStatus = env.JOB_STATUS || "success";
	const otherFailed = otherFailedSteps(steps);
	const base = {
		version: 1,
		runId: Number(env.GITHUB_RUN_ID) || null,
		attempt: Number(env.GITHUB_RUN_ATTEMPT) || 1,
		job: o.job,
		runner: o.runner,
		sha: env.GITHUB_SHA ?? null,
		branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null,
		event: env.GITHUB_EVENT_NAME ?? null,
		testsStep,
		jobStatus,
		otherFailedSteps: otherFailed,
	};
	mkdirSync(o.out, { recursive: true });
	const outFile = join(o.out, "test-outcomes.json");
	const write = (failed, note) => {
		const doc = {
			...base,
			verdict: jobVerdict({ jobStatus, testsStep, failed, otherFailed }),
			note,
			failed,
		};
		writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`);
		return doc;
	};

	const first =
		testsStep === "failure"
			? readResults(o.runner, readJson(o.report), cwd)
			: null;
	const failed = first?.failed ?? [];
	let note = "";
	if (otherFailed.length > 0) note = `failed steps: ${otherFailed.join(", ")}`;
	if (testsStep === "failure" && failed.length === 0) {
		const why = first
			? first.errors.length > 0
				? `errors outside tests: ${first.errors.join("; ")}`
				: "the tests step failed with no failed test"
			: "the tests step failed and wrote no report";
		note = note ? `${note}; ${why}` : why;
	}
	if (testsStep === "skipped" && jobStatus === "failure" && !note) {
		note = "the job failed before the tests ran";
	}
	// Written before the rerun: a rerun cut short still leaves the failures,
	// as not rerun.
	let doc = write(
		labelFailures(failed, null),
		failed.length > 0
			? [note, "the rerun didn't finish"].filter(Boolean).join("; ")
			: note,
	);
	if (failed.length > RERUN_CAP) {
		doc = write(
			labelFailures(failed, null),
			[note, `${failed.length} failed tests, over ${RERUN_CAP}: not rerun`]
				.filter(Boolean)
				.join("; "),
		);
	} else if (failed.length > 0) {
		const jsonOut = join(o.out, "rerun-report.json");
		const outputDir = join(o.out, "rerun-results");
		const args = rerunArgs(o.runner, failed, {
			scripts: import.meta.dirname,
			outputDir,
		});
		console.log(
			`test-outcomes: rerunning ${failed.length} failed test(s) once, to label them; the job stays failed`,
		);
		spawnSync(process.execPath, args, {
			stdio: "inherit",
			env: {
				...env,
				CRB_TEST_JSON: jsonOut,
				PLAYWRIGHT_JSON_OUTPUT_FILE: jsonOut,
				// Not into the uploaded traces: those are the first run's.
				CRB_TEST_TRACE_ROOT: join(o.out, "rerun-traces"),
			},
		});
		const rerun = existsSync(jsonOut)
			? readResults(o.runner, readJson(jsonOut), cwd)
			: null;
		doc = write(
			labelFailures(failed, rerun),
			rerun
				? note
				: [note, "the rerun wrote no report"].filter(Boolean).join("; "),
		);
	}
	console.log(
		`test-outcomes: ${doc.verdict}${doc.failed.length ? ` (${doc.failed.map((t) => `${t.verdict}: ${t.title}`).join("; ")})` : ""}`,
	);
	if (env.GITHUB_STEP_SUMMARY) {
		appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(doc));
	}
}

const isMain = (() => {
	try {
		return (
			realpathSync(process.argv[1] ?? "") ===
			realpathSync(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
})();
if (isMain) main();
