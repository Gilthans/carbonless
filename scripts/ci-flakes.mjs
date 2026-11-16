#!/usr/bin/env node
// CI's flake rate (docs/ci-flakes.md): every attempt of every CI run in a
// window, each failed one judged from the test-outcomes artifacts its test
// jobs upload (scripts/test-outcomes.mjs), and the tests behind the flakes.
// No dependencies: `gh` does the talking (its own login, or $GH_TOKEN).
//
//   pnpm ci-flakes [--since 7d|12h|<date>] [--branch <b>] [--repo <o/r>]
//       [--json | --markdown] [--fail-over <percent>]
//
// --fail-over: exit 1 when the flake rate is over that percent.
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW = "ci.yml";
/** Jobs that fail only because a test job did (`e2e` waits on the shards). */
export const DERIVED_JOBS = new Set(["e2e"]);
const FAILING_JOB = new Set(["failure", "timed_out", "startup_failure"]);
/** Worst first: an attempt takes the worst of its failed jobs' verdicts. */
const SEVERITY = ["consistent", "non-test", "unknown", "flaky"];

/** `7d`, `12h` or a date: the window's start. */
export function parseSince(since, now = new Date()) {
	const m = /^(\d+)([dh])$/.exec(since);
	if (m) {
		const ms = Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000);
		return new Date(now.getTime() - ms);
	}
	const d = new Date(since);
	if (Number.isNaN(d.getTime()))
		throw new Error(`--since: not a window: ${since}`);
	return d;
}

/** A failed job's verdict, from its outcome document (or none). */
function jobVerdict(doc) {
	if (!doc) return "unknown";
	switch (doc.verdict) {
		case "flaky":
		case "consistent":
		case "non-test":
			return doc.verdict;
		// The tests passed, yet the job failed: a step after them.
		case "passed":
			return "non-test";
		default:
			return "unknown";
	}
}

/**
 * One failed attempt's verdict and why: "flaky" when every failed test job
 * failed only on tests that passed on rerun, or a later attempt of the run
 * (the same commit) passed; "consistent" when a test failed again;
 * "non-test" when something other than a test failed; "unknown" when a
 * failed job left no outcome (a run from before the outcomes, a runner
 * lost, a rerun not done).
 */
export function judgeAttempt(attempt, laterPassed) {
	if (laterPassed)
		return { verdict: "flaky", reason: "a later attempt passed" };
	const outcomes = attempt.outcomes ?? [];
	const byJob = new Map(outcomes.map((d) => [d.job, d]));
	const failedJobs = attempt.jobs
		? attempt.jobs
				.filter(
					(j) => FAILING_JOB.has(j.conclusion) && !DERIVED_JOBS.has(j.name),
				)
				.map((j) => j.name)
		: outcomes.filter((d) => d.verdict !== "passed").map((d) => d.job);
	if (failedJobs.length === 0) {
		return { verdict: "unknown", reason: "no failed test job found" };
	}
	const verdicts = failedJobs.map((j) => ({
		job: j,
		verdict: jobVerdict(byJob.get(j)),
	}));
	const worst = SEVERITY.find((s) => verdicts.some((v) => v.verdict === s));
	return {
		verdict: worst ?? "unknown",
		reason: verdicts.map((v) => `${v.job}: ${v.verdict}`).join(", "),
	};
}

const pct = (n, d) => (d === 0 ? 0 : (100 * n) / d);

/**
 * The window's numbers from collected runs (`collect`): each run's
 * attempts with their status and conclusion, and for failed ones the jobs
 * and outcome documents.
 */
export function aggregate(runs) {
	const all = { attempts: 0, flaky: 0 };
	const master = { attempts: 0, flaky: 0 };
	const counts = {
		runs: runs.length,
		attempts: 0,
		passed: 0,
		failed: 0,
		cancelled: 0,
		inProgress: 0,
		flaky: 0,
		consistent: 0,
		nonTest: 0,
		unknown: 0,
	};
	const failedAttempts = [];
	const tests = new Map();
	for (const run of runs) {
		const isMaster = run.branch === "master" && run.event === "push";
		const attempts = [...run.attempts].sort((a, b) => a.n - b.n);
		for (const [i, a] of attempts.entries()) {
			counts.attempts++;
			if (a.status !== "completed") {
				counts.inProgress++;
				continue;
			}
			if (a.conclusion === "cancelled" || a.conclusion === "skipped") {
				counts.cancelled++;
				continue;
			}
			all.attempts++;
			if (isMaster) master.attempts++;
			if (a.conclusion === "success") {
				counts.passed++;
				continue;
			}
			counts.failed++;
			const laterPassed = attempts
				.slice(i + 1)
				.some((b) => b.status === "completed" && b.conclusion === "success");
			const { verdict, reason } = judgeAttempt(a, laterPassed);
			if (verdict === "flaky") {
				counts.flaky++;
				all.flaky++;
				if (isMaster) master.flaky++;
			} else if (verdict === "consistent") counts.consistent++;
			else if (verdict === "non-test") counts.nonTest++;
			else counts.unknown++;
			failedAttempts.push({
				run: run.id,
				attempt: a.n,
				branch: run.branch,
				event: run.event,
				createdAt: a.createdAt ?? run.createdAt,
				url: a.url ?? run.url,
				verdict,
				reason,
			});
			for (const doc of a.outcomes ?? []) {
				for (const t of doc.failed ?? []) {
					if (t.verdict !== "flaky") continue;
					// Unit tests have no project: Linux (checks) and Windows
					// (windows-agent) flakes are told apart by job. An e2e test's
					// shard varies; its project doesn't.
					const key = `${t.file}\0${t.title}\0${t.project ?? doc.job}`;
					const seen = a.createdAt ?? run.createdAt ?? "";
					const prev = tests.get(key);
					if (!prev) {
						tests.set(key, {
							file: t.file,
							title: t.title,
							project: t.project ?? null,
							count: 1,
							job: doc.job,
							lastSeen: seen,
							lastRun: a.url ?? run.url,
						});
						continue;
					}
					prev.count++;
					if (seen >= prev.lastSeen) {
						Object.assign(prev, {
							job: doc.job,
							lastSeen: seen,
							lastRun: a.url ?? run.url,
						});
					}
				}
			}
		}
	}
	// Most flakes first, then the most recent; ties in a fixed order.
	const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
	const topFlaky = [...tests.values()].sort(
		(x, y) =>
			y.count - x.count ||
			cmp(y.lastSeen, x.lastSeen) ||
			cmp(x.job, y.job) ||
			cmp(x.file, y.file) ||
			cmp(x.title, y.title) ||
			cmp(x.project ?? "", y.project ?? ""),
	);
	return {
		...counts,
		flakeRate: pct(all.flaky, all.attempts),
		master: { ...master, flakeRate: pct(master.flaky, master.attempts) },
		failedAttempts,
		topFlaky,
	};
}

const fmt = (n) => `${n.toFixed(1)}%`;
const day = (iso) => (iso ? String(iso).slice(0, 10) : "");

/** Text in a Markdown table cell: no markup, links or HTML from a title. */
function cell(text) {
	return String(text ?? "")
		.replace(/[\\`*_[\]<>|#~!&]/g, (c) => `&#${c.charCodeAt(0)};`)
		.replace(/\s*\n\s*/g, " ");
}

/** The report, as text or Markdown (for a job summary). */
export function render(s, { title, markdown = false }) {
	const lines = [];
	const h = (t) => lines.push(markdown ? `### ${t}` : t);
	h(title);
	lines.push(
		"",
		`Runs ${s.runs}, attempts ${s.attempts}: ${s.passed} passed, ${s.failed} failed, ${s.cancelled} cancelled, ${s.inProgress} running (cancelled and running not counted)`,
		"",
		`${markdown ? "**" : ""}Flake rate: ${fmt(s.flakeRate)}${markdown ? "**" : ""} (${s.flaky} of ${s.passed + s.failed} attempts); master: ${fmt(s.master.flakeRate)} (${s.master.flaky} of ${s.master.attempts})`,
		"",
		`Failed, not counted as flaky: ${s.consistent} consistent test failure, ${s.nonTest} non-test failure, ${s.unknown} unknown (no outcome)`,
	);
	if (s.topFlaky.length > 0) {
		lines.push("");
		if (markdown) {
			lines.push(
				"| Flakes | Last seen | Job | Test | Project | Last run |",
				"| --- | --- | --- | --- | --- | --- |",
			);
			for (const t of s.topFlaky.slice(0, 20)) {
				lines.push(
					`| ${t.count} | ${day(t.lastSeen)} | ${cell(t.job)} | ${cell(t.title)} (${cell(t.file)}) | ${cell(t.project ?? "")} | ${t.lastRun ? `[run](${encodeURI(t.lastRun)})` : ""} |`,
				);
			}
		} else {
			lines.push("Top flaky tests:");
			for (const t of s.topFlaky.slice(0, 20)) {
				lines.push(
					`  ${String(t.count).padStart(3)}  ${day(t.lastSeen)}  ${t.job}  ${t.file} › ${t.title}${t.project ? ` [${t.project}]` : ""}  ${t.lastRun ?? ""}`,
				);
			}
		}
	}
	const notFlaky = s.failedAttempts.filter((a) => a.verdict !== "flaky");
	if (notFlaky.length > 0) {
		lines.push(
			"",
			markdown ? "Other failed attempts:" : "Other failed attempts:",
		);
		for (const a of notFlaky) {
			const where = `${day(a.createdAt)} ${a.branch} run ${a.run} attempt ${a.attempt}: ${a.verdict} (${a.reason})`;
			lines.push(
				markdown
					? `- ${cell(where)}${a.url ? ` [run](${encodeURI(a.url)})` : ""}`
					: `  ${where} ${a.url ?? ""}`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** A GitHub API error worth another try: a 5xx or a dropped connection. */
export const transient = (stderr) =>
	/HTTP 5\d\d|ECONNRESET|ETIMEDOUT|timed out|connection reset/i.test(stderr);

/**
 * Runs `gh` and returns its stdout; throws with its stderr on failure. An
 * API read that failed on GitHub's side (a 502 now and then, over hundreds
 * of calls) is tried up to three times.
 */
function realGh(args) {
	for (let attempt = 1; ; attempt++) {
		const r = spawnSync("gh", args, {
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
		});
		if (r.status === 0) return r.stdout;
		const err = r.stderr || r.error?.message || "";
		if (attempt >= 3 || !transient(err)) {
			throw new Error(`gh ${args.join(" ")}: ${err}`);
		}
		Atomics.wait(
			new Int32Array(new SharedArrayBuffer(4)),
			0,
			0,
			2000 * attempt,
		);
	}
}

const jsonLines = (out) =>
	out
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));

/** A run's test-outcomes documents (every attempt's), via `gh run download`. */
function realOutcomes(repo, runId, gh) {
	const dir = mkdtempSync(join(tmpdir(), "ci-flakes-"));
	try {
		try {
			gh([
				"run",
				"download",
				String(runId),
				"-R",
				repo,
				"-p",
				"test-outcomes-*",
				"-D",
				dir,
			]);
		} catch {
			// No such artifacts (a run from before them, or expired).
			return [];
		}
		const docs = [];
		for (const name of readdirSync(dir)) {
			const f = join(dir, name, "test-outcomes.json");
			if (!existsSync(f)) continue;
			try {
				docs.push(JSON.parse(readFileSync(f, "utf8")));
			} catch {}
		}
		return docs;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The window's CI runs, every attempt of each; for a failed attempt its
 * jobs and outcome documents. `gh(args)` returns gh's stdout and
 * `outcomes(runId)` a run's documents: both injectable, for tests.
 */
export function collect({
	repo,
	since,
	branch,
	gh = realGh,
	outcomes = (id) => realOutcomes(repo, id, gh),
}) {
	const query = [
		"api",
		"-X",
		"GET",
		`repos/${repo}/actions/workflows/${WORKFLOW}/runs`,
		"-f",
		`created=>=${since.toISOString()}`,
		"-f",
		"per_page=100",
		...(branch ? ["-f", `branch=${branch}`] : []),
		"--paginate",
		"--jq",
		".workflow_runs[] | {id, run_attempt, status, conclusion, head_branch, event, html_url, created_at, run_started_at}",
	];
	const runs = [];
	for (const r of jsonLines(gh(query))) {
		const attempts = [];
		for (let n = 1; n <= (r.run_attempt ?? 1); n++) {
			const a =
				n === (r.run_attempt ?? 1)
					? r
					: JSON.parse(
							gh(["api", `repos/${repo}/actions/runs/${r.id}/attempts/${n}`]),
						);
			attempts.push({
				n,
				status: a.status,
				conclusion: a.conclusion,
				url: `${r.html_url}/attempts/${n}`,
				createdAt: a.run_started_at ?? a.created_at,
			});
		}
		const failed = attempts.filter(
			(a) =>
				a.status === "completed" &&
				a.conclusion !== "success" &&
				a.conclusion !== "cancelled" &&
				a.conclusion !== "skipped",
		);
		if (failed.length > 0) {
			const docs = outcomes(r.id);
			for (const a of failed) {
				a.outcomes = docs.filter((d) => (d.attempt ?? 1) === a.n);
				a.jobs = jsonLines(
					gh([
						"api",
						`repos/${repo}/actions/runs/${r.id}/attempts/${a.n}/jobs?per_page=100`,
						"--paginate",
						"--jq",
						".jobs[] | {name, conclusion}",
					]),
				);
			}
		}
		runs.push({
			id: r.id,
			branch: r.head_branch,
			event: r.event,
			url: r.html_url,
			createdAt: r.created_at,
			attempts,
		});
	}
	return runs;
}

function parseArgs(argv) {
	const o = { since: "7d", format: "text" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const [k, inline] = a.includes("=") ? a.split(/=(.*)/s) : [a, undefined];
		const value = () => inline ?? argv[++i];
		if (k === "--since") o.since = value();
		else if (k === "--branch") o.branch = value();
		else if (k === "--repo") o.repo = value();
		else if (k === "--fail-over") o.failOver = Number(value());
		else if (k === "--json") o.format = "json";
		else if (k === "--markdown") o.format = "markdown";
		else throw new Error(`unknown argument: ${a}`);
	}
	return o;
}

function main() {
	const o = parseArgs(process.argv.slice(2));
	const repo =
		o.repo ??
		process.env.GITHUB_REPOSITORY ??
		realGh([
			"repo",
			"view",
			"--json",
			"nameWithOwner",
			"-q",
			".nameWithOwner",
		]).trim();
	const since = parseSince(o.since);
	const s = aggregate(collect({ repo, since, branch: o.branch }));
	const title = `CI flakes since ${since.toISOString().slice(0, 16)}Z (${o.since})${o.branch ? `, ${o.branch}` : ""}`;
	if (o.format === "json") {
		console.log(
			JSON.stringify({ repo, since: since.toISOString(), ...s }, null, 2),
		);
	} else {
		process.stdout.write(
			render(s, { title, markdown: o.format === "markdown" }),
		);
	}
	if (o.failOver !== undefined && s.flakeRate > o.failOver) {
		console.error(`flake rate ${fmt(s.flakeRate)} is over ${o.failOver}%`);
		process.exit(1);
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
