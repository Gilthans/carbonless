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
// vitest.config.ts and playwright.config.ts), and Vitest its unhandled
// errors next to it (scripts/vitest-unhandled-reporter.mjs): each is
// labelled like a test, by rerunning the file it came from. From the workflow: $STEPS
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
export function rerunArgs(runner, failed, { scripts, outputDir, files }) {
	const queue = join(scripts, "queue.mjs");
	if (runner === "vitest") {
		files ??= [...new Set(failed.map((t) => t.file))];
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

/**
 * Steps (`toJSON(steps)`) other than the tests that failed. GitHub's
 * `steps` context lists only steps with an `id`: in ci.yml every step that
 * runs after the tests and before this one has one (pack, the uploads), and
 * a failure before the tests skips them (non-test either way).
 */
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

/**
 * Text in a Markdown table cell: no markup, links or HTML from a title.
 * Bare URLs (GFM autolinks `https://…`, `www.…`) get a zero-width space
 * that keeps them from being links.
 */
export function cell(text) {
	return String(text ?? "")
		.replace(/[\\`*_[\]<>|#~!&]/g, (c) => `&#${c.charCodeAt(0)};`)
		.replace(/:\/\//g, ":/\u200b/")
		.replace(/\bwww\./gi, (w) => `${w.slice(0, 3)}\u200b.`)
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

/** Unhandled errors (scripts/vitest-unhandled-reporter.mjs) as failures. */
export const UNHANDLED = "(unhandled error)";
/** An unhandled error Vitest couldn't trace to a test file. */
export const UNKNOWN_SOURCE = "(unknown file)";

/** Where the unhandled-errors reporter writes, next to the JSON report. */
export const unhandledPath = (report) => `${report}.unhandled.json`;
/**
 * The error of the failure that stands for a Vitest run whose
 * unhandled-errors reporter wrote no file (it always writes one, if empty):
 * unhandled errors may be lost, so the job is never flaky or passed.
 */
export const UNHANDLED_LOST = "the unhandled-errors reporter wrote no file";

const filesOf = (report, cwd) =>
	(report?.testResults ?? []).map((f) => posix(relative(cwd, f.name)));

/**
 * The first run's unhandled errors (a rejection or a timer after a test
 * ended: they fail the run with every test passed) as failures: one per
 * file they were traced to, or of UNKNOWN_SOURCE. `unhandled` null: the
 * reporter didn't run.
 */
export function unhandledResults(unhandled) {
	const failed = [];
	const files = new Set();
	for (const e of unhandled?.errors ?? []) {
		const file = e?.file ? String(e.file) : UNKNOWN_SOURCE;
		if (files.has(file)) continue;
		files.add(file);
		failed.push({
			file,
			title: UNHANDLED,
			project: null,
			error: errorHead(e?.message),
		});
	}
	return { failed, passed: [] };
}

/**
 * The rerun's answer for the first run's unhandled-error failures. Vitest
 * traces an error to its file only when the timing lets it, so the same
 * error may be traced on one run and not the other: any unhandled error in
 * the rerun counts against every failure it could be (an untraced one
 * against all; a traced one against its file's and UNKNOWN_SOURCE's), so a
 * recurring error is never flaky. A file's passes only when the rerun ran
 * it; UNKNOWN_SOURCE's only when the rerun ran every file the first run
 * had. No reporter output: none answered (not rerun). `unhandled` and
 * `ranFiles` (the rerun's) are relative to the same root as the failures.
 */
export function rerunUnhandled(failures, unhandled, ranFiles, firstFiles) {
	const failed = [];
	const passed = [];
	if (!unhandled || !ranFiles) return { failed, passed };
	const ran = new Set(ranFiles);
	const errors = (unhandled.errors ?? []).map((e) => ({
		file: e?.file ? String(e.file) : UNKNOWN_SOURCE,
		error: errorHead(e?.message),
	}));
	for (const t of failures) {
		if (t.title !== UNHANDLED) continue;
		const key = { file: t.file, title: UNHANDLED, project: null };
		const again = errors.find(
			(e) =>
				e.file === UNKNOWN_SOURCE ||
				t.file === UNKNOWN_SOURCE ||
				e.file === t.file,
		);
		if (again) {
			failed.push({ ...key, error: again.error });
			continue;
		}
		const covered =
			t.file === UNKNOWN_SOURCE
				? firstFiles.length > 0 && firstFiles.every((f) => ran.has(f))
				: ran.has(t.file);
		if (covered) passed.push(key);
	}
	return { failed, passed };
}

/** Unhandled errors' files made relative to `cwd`, like the tests'. */
const relativeErrors = (unhandled, cwd) =>
	unhandled
		? {
				errors: (unhandled.errors ?? []).map((e) => ({
					...e,
					file: e?.file ? posix(relative(cwd, e.file)) : null,
				})),
			}
		: null;

/**
 * Reads a report into its failures (and errors outside tests). For a
 * Vitest rerun, pass `rerunOf` (the first run's failures and files): its
 * unhandled errors answer those failures (rerunUnhandled).
 */
export function readResults(runner, report, cwd, unhandled = null, rerunOf) {
	if (!report) return null;
	if (runner === "playwright") {
		return {
			...playwrightResults(report),
			errors: reportErrors(runner, report),
		};
	}
	const tests = vitestResults(report, cwd);
	const rel = relativeErrors(unhandled, cwd);
	const u = rerunOf
		? rerunUnhandled(rerunOf.failed, rel, filesOf(report, cwd), rerunOf.files)
		: unhandledResults(rel);
	return {
		failed: [...tests.failed, ...u.failed],
		passed: [...tests.passed, ...u.passed],
		errors: [],
	};
}

/**
 * The test files a Vitest rerun takes: each failure's, and for an unhandled
 * error of unknown source every file the first run had.
 */
export function rerunFiles(failed, report, cwd) {
	const files = new Set();
	for (const t of failed) {
		if (t.file !== UNKNOWN_SOURCE) {
			files.add(t.file);
			continue;
		}
		for (const f of report?.testResults ?? []) {
			files.add(posix(relative(cwd, f.name)));
		}
	}
	return [...files];
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

const spawnNode = (args, env) =>
	spawnSync(process.execPath, args, { stdio: "inherit", env });

/**
 * Labels this job's failures and writes test-outcomes.json, the job
 * summary and the verdict (`verdict=` in $GITHUB_OUTPUT, for the artifact's
 * name). `spawn(args, env)` runs the rerun (`node args…`); injectable for
 * tests. Returns the outcome document.
 */
export function run({
	argv,
	env = process.env,
	cwd = process.cwd(),
	spawn = spawnNode,
	scripts = import.meta.dirname,
	log = console.log,
}) {
	const o = parseArgs(argv);
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
	// Set below: a Vitest report with no unhandled-errors file.
	let lost = [];
	const write = (labelled, note) => {
		const failed = [...labelled, ...lost];
		const doc = {
			...base,
			verdict: jobVerdict({ jobStatus, testsStep, failed, otherFailed }),
			note,
			failed,
		};
		writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`);
		return doc;
	};
	const join2 = (...parts) => parts.filter(Boolean).join("; ");

	const report = testsStep === "failure" ? readJson(o.report) : null;
	const unhandled =
		testsStep === "failure" ? readJson(unhandledPath(o.report)) : null;
	const first =
		testsStep === "failure"
			? readResults(o.runner, report, cwd, unhandled)
			: null;
	const failed = first?.failed ?? [];
	let note = "";
	if (otherFailed.length > 0) note = `failed steps: ${otherFailed.join(", ")}`;
	// The reporter always writes its file: none means it failed to, and an
	// unhandled error may be lost. Not one to rerun (nothing says what to
	// rerun), so it stays not-rerun and the job can't read as flaky.
	if (o.runner === "vitest" && report && !unhandled) {
		lost = [
			{
				file: UNKNOWN_SOURCE,
				title: UNHANDLED,
				project: null,
				error: UNHANDLED_LOST,
				verdict: "not-rerun",
			},
		];
		note = join2(note, UNHANDLED_LOST);
	}
	if (testsStep === "failure" && failed.length === 0) {
		note = join2(
			note,
			first
				? first.errors.length > 0
					? `errors outside tests: ${first.errors.join("; ")}`
					: "the tests step failed with no failed test"
				: "the tests step failed and wrote no report",
		);
	}
	if (testsStep === "skipped" && jobStatus === "failure" && !note) {
		note = "the job failed before the tests ran";
	}
	// Written before the rerun: a rerun cut short (the step's time limit)
	// still leaves the failures, as not rerun.
	let doc = write(
		labelFailures(failed, null),
		failed.length > 0 ? join2(note, "the rerun didn't finish") : note,
	);
	const files = o.runner === "vitest" ? rerunFiles(failed, report, cwd) : [];
	if (failed.length > RERUN_CAP || files.length > RERUN_CAP) {
		doc = write(
			labelFailures(failed, null),
			join2(
				note,
				failed.length > RERUN_CAP
					? `${failed.length} failed tests, over ${RERUN_CAP}: not rerun`
					: `${files.length} test files to rerun, over ${RERUN_CAP}: not rerun`,
			),
		);
	} else if (failed.length > 0) {
		const jsonOut = join(o.out, "rerun-report.json");
		const args = rerunArgs(o.runner, failed, {
			scripts,
			outputDir: join(o.out, "rerun-results"),
			files,
		});
		log(
			`test-outcomes: rerunning ${failed.length} failed test(s) once, to label them; the job stays failed`,
		);
		spawn(args, {
			...env,
			CRB_TEST_JSON: jsonOut,
			PLAYWRIGHT_JSON_OUTPUT_FILE: jsonOut,
			// Not into the uploaded traces: those are the first run's.
			CRB_TEST_TRACE_ROOT: join(o.out, "rerun-traces"),
			// No second set of PR annotations from Vitest's github-actions
			// reporter (Playwright's rerun has its own reporters).
			GITHUB_ACTIONS: "",
		});
		const rerun = existsSync(jsonOut)
			? readResults(
					o.runner,
					readJson(jsonOut),
					cwd,
					readJson(unhandledPath(jsonOut)),
					{ failed, files: filesOf(report, cwd) },
				)
			: null;
		doc = write(
			labelFailures(failed, rerun),
			rerun ? note : join2(note, "the rerun wrote no report"),
		);
	}
	log(
		`test-outcomes: ${doc.verdict}${doc.failed.length ? ` (${doc.failed.map((t) => `${t.verdict}: ${t.title}`).join("; ")})` : ""}`,
	);
	if (env.GITHUB_STEP_SUMMARY) {
		appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(doc));
	}
	if (env.GITHUB_OUTPUT) {
		appendFileSync(env.GITHUB_OUTPUT, `verdict=${doc.verdict}\n`);
	}
	return doc;
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
if (isMain) run({ argv: process.argv.slice(2) });
