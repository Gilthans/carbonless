#!/usr/bin/env node
// CI's flake rate (docs/ci-flakes.md): every attempt of every CI run in a
// window, each failed one judged from the test-outcomes artifacts its test
// jobs upload (scripts/test-outcomes.mjs), and the tests behind the flakes.
// No dependencies: `gh` does the talking (its own login, or $GH_TOKEN).
//
//   pnpm ci-flakes [--since 7d|12h|<date>[,…]] [--branch <b>] [--repo <o/r>]
//       [--json | --markdown] [--fail-over <percent>]
//
// Several windows (`--since 7d,30d`) come from one collection of the
// widest. --fail-over: exit 1 when the shortest window's flake rate is over
// that percent. API cost: a listing per day of the window, then per run
// with a failed attempt one artifact listing (each artifact's name carries
// its job's verdict), the jobs only when they can change the verdict, and a
// download only for a flaky job's tests; it prints the calls used
// (stderr). Runs from forks are counted apart and never read.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { cell } from "./test-outcomes.mjs";

const WORKFLOW = "ci.yml";
/** Jobs that fail only because a test job did (`e2e` waits on the shards). */
export const DERIVED_JOBS = new Set(["e2e"]);
/** The step a summary job fails in when a shard failed (ci.yml's `e2e`). */
export const SHARDS_FAILED_STEP = "A shard failed";
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
/** Worst first: an attempt takes the worst of its failed jobs' verdicts. */
const SEVERITY = ["consistent", "non-test", "unknown", "flaky"];
const DOC_VERDICTS = new Set([
	"passed",
	"flaky",
	"consistent",
	"non-test",
	"not-rerun",
	"cancelled",
]);

/** A job's artifact slug: `e2e (2/4)` → `e2e-2`; others as they are. */
export const slugOf = (job) => {
	const m = /^e2e \((\d+)\/\d+\)$/.exec(String(job));
	return m ? `e2e-${m[1]}` : String(job);
};

/**
 * `test-outcomes-<slug>-<attempt>-<verdict>` (the verdict from the label
 * step; `none` when it didn't finish, absent on the first proof runs).
 */
export function parseArtifactName(name) {
	const m =
		/^test-outcomes-(.+?)-(\d+)(?:-(passed|flaky|consistent|non-test|not-rerun|cancelled|none))?$/.exec(
			String(name),
		);
	if (!m) return null;
	return {
		slug: m[1],
		attempt: Number(m[2]),
		verdict: m[3] && m[3] !== "none" ? m[3] : null,
	};
}

/**
 * An outcome document from an artifact, or null with a warning when its
 * shape is wrong or it names another run: artifacts are a run's own data,
 * which a fork's PR can shape too.
 */
export function checkDoc(doc, runId, warn = () => {}) {
	const bad = (why) => {
		warn(`run ${runId}: an outcome document ${why}: counted unknown`);
		return null;
	};
	if (!doc || typeof doc !== "object") return bad("isn't an object");
	if (doc.runId != null && doc.runId !== runId) return bad("names another run");
	if (!DOC_VERDICTS.has(doc.verdict)) return bad("has no known verdict");
	if (!Array.isArray(doc.failed)) return bad("has no list of failures");
	for (const t of doc.failed) {
		if (
			!t ||
			typeof t.file !== "string" ||
			typeof t.title !== "string" ||
			typeof t.verdict !== "string"
		) {
			return bad("has a malformed failure");
		}
	}
	return doc;
}

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

/** A failed job's verdict, from its outcome (or none). */
function jobVerdict(outcome) {
	switch (outcome?.verdict) {
		case "flaky":
		case "consistent":
		case "non-test":
			return outcome.verdict;
		// The tests passed, yet the job failed: a step after them.
		case "passed":
			return "non-test";
		// No outcome, a rerun not done (over the cap, cut short) or not
		// finished: nothing says flaky or not.
		default:
			return "unknown";
	}
}

/**
 * One failed attempt's verdict and why: "flaky" when every failed test job
 * failed only on tests that passed on rerun, or a later attempt of the run
 * (the same commit) passed; "consistent" when a test failed again;
 * "non-test" when something other than a test failed; "unknown" when a
 * failed job left no outcome, or one without a verdict (not rerun).
 * `attempt.outcomes`: [{ job or slug, verdict }]; `attempt.jobs` (when
 * listed): [{ name, conclusion }].
 */
export function judgeAttempt(attempt, laterPassed) {
	if (laterPassed) {
		return { verdict: "flaky", reason: "a later attempt passed" };
	}
	const outcomes = attempt.outcomes ?? [];
	const bySlug = new Map(outcomes.map((o) => [o.slug ?? slugOf(o.job), o]));
	let failedJobs;
	let derivedFailed = false;
	const own = [];
	if (attempt.jobs) {
		const failing = attempt.jobs.filter((j) => FAILED.has(j.conclusion));
		derivedFailed = failing.some((j) => DERIVED_JOBS.has(j.name));
		// A summary job that failed in a step other than "a shard failed"
		// (its trace merge or upload): a non-test failure of its own.
		for (const j of failing) {
			if (
				DERIVED_JOBS.has(j.name) &&
				Array.isArray(j.steps) &&
				!j.steps.some(
					(st) => st.conclusion === "failure" && st.name === SHARDS_FAILED_STEP,
				)
			) {
				own.push({ job: j.name, verdict: "non-test" });
			}
		}
		failedJobs = failing
			.filter((j) => !DERIVED_JOBS.has(j.name))
			.map((j) => slugOf(j.name));
	} else {
		failedJobs = outcomes
			.filter((o) => o.verdict !== "passed")
			.map((o) => o.slug ?? slugOf(o.job));
	}
	if (failedJobs.length === 0 && own.length === 0) {
		return derivedFailed
			? { verdict: "non-test", reason: "a summary job failed, no test job" }
			: { verdict: "unknown", reason: "no failed test job found" };
	}
	const verdicts = [
		...failedJobs.map((j) => ({ job: j, verdict: jobVerdict(bySlug.get(j)) })),
		...own,
	];
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
		runs: runs.filter((r) => !r.fork).length,
		forkRuns: 0,
		attempts: 0,
		passed: 0,
		failed: 0,
		notRun: 0,
		inProgress: 0,
		flaky: 0,
		consistent: 0,
		nonTest: 0,
		unknown: 0,
	};
	const failedAttempts = [];
	const tests = new Map();
	for (const run of runs) {
		if (run.fork) {
			counts.forkRuns++;
			continue;
		}
		const isMaster = run.branch === "master" && run.event === "push";
		const attempts = [...run.attempts].sort((a, b) => a.n - b.n);
		for (const [i, a] of attempts.entries()) {
			counts.attempts++;
			if (a.status !== "completed") {
				counts.inProgress++;
				continue;
			}
			// Cancelled, skipped, awaiting approval (action_required), neutral,
			// stale: the tests didn't run to an answer.
			if (a.conclusion !== "success" && !FAILED.has(a.conclusion)) {
				counts.notRun++;
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
				for (const t of Array.isArray(doc.failed) ? doc.failed : []) {
					if (t.verdict !== "flaky") continue;
					// Unit tests have no project: Linux (checks) and Windows
					// (windows-agent) flakes are told apart by job. An e2e test's
					// shard varies; its project doesn't.
					const job = doc.job ?? doc.slug;
					const key = `${t.file}\0${t.title}\0${t.project ?? job}`;
					const seen = a.createdAt ?? run.createdAt ?? "";
					const prev = tests.get(key);
					if (!prev) {
						tests.set(key, {
							file: t.file,
							title: t.title,
							project: t.project ?? null,
							count: 1,
							job,
							lastSeen: seen,
							lastRun: a.url ?? run.url,
						});
						continue;
					}
					prev.count++;
					if (seen >= prev.lastSeen) {
						Object.assign(prev, {
							job,
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

/** Text for a terminal: no control characters (escape sequences) from data. */
export const term = (text) =>
	Array.from(String(text ?? ""), (c) => {
		const n = c.charCodeAt(0);
		return n < 0x20 || (n >= 0x7f && n < 0xa0) ? "?" : c;
	}).join("");

/** The report, as text or Markdown (for a job summary). */
export function render(s, { title, markdown = false }) {
	const t = markdown ? cell : term;
	const lines = [];
	lines.push(markdown ? `### ${cell(title)}` : term(title));
	lines.push(
		"",
		`Runs ${s.runs}, attempts ${s.attempts}: ${s.passed} passed, ${s.failed} failed, ${s.notRun} cancelled or not run, ${s.inProgress} running (those last two not counted)`,
		"",
		`${markdown ? "**" : ""}Flake rate: ${fmt(s.flakeRate)}${markdown ? "**" : ""} (${s.flaky} of ${s.passed + s.failed} attempts); master: ${fmt(s.master.flakeRate)} (${s.master.flaky} of ${s.master.attempts})`,
		"",
		`Failed, not counted as flaky: ${s.consistent} consistent test failure, ${s.nonTest} non-test failure, ${s.unknown} unknown (no outcome, or not rerun)`,
	);
	if (s.forkRuns > 0) {
		lines.push("", `Runs from forks, not counted: ${s.forkRuns}`);
	}
	if (s.topFlaky.length > 0) {
		lines.push("");
		if (markdown) {
			lines.push(
				"| Flakes | Last seen | Job | Test | Project | Last run |",
				"| --- | --- | --- | --- | --- | --- |",
			);
		} else {
			lines.push("Top flaky tests:");
		}
		for (const f of s.topFlaky.slice(0, 20)) {
			lines.push(
				markdown
					? `| ${f.count} | ${day(f.lastSeen)} | ${t(f.job)} | ${t(f.title)} (${t(f.file)}) | ${t(f.project ?? "")} | ${f.lastRun ? `[run](${encodeURI(f.lastRun)})` : ""} |`
					: `  ${String(f.count).padStart(3)}  ${day(f.lastSeen)}  ${t(f.job)}  ${t(f.file)} › ${t(f.title)}${f.project ? ` [${t(f.project)}]` : ""}  ${t(f.lastRun ?? "")}`,
			);
		}
	}
	const notFlaky = s.failedAttempts.filter((a) => a.verdict !== "flaky");
	if (notFlaky.length > 0) {
		lines.push("", "Other failed attempts:");
		for (const a of notFlaky) {
			const where = `${day(a.createdAt)} ${a.branch} run ${a.run} attempt ${a.attempt}: ${a.verdict} (${a.reason})`;
			lines.push(
				markdown
					? `- ${cell(where)}${a.url ? ` [run](${encodeURI(a.url)})` : ""}`
					: `  ${term(where)} ${term(a.url ?? "")}`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** A GitHub API error worth another try: a 5xx or a dropped connection. */
export const transient = (stderr) =>
	/HTTP 5\d\d|ECONNRESET|ETIMEDOUT|timed out|connection reset/i.test(stderr);

/**
 * Runs `gh` and returns its stdout (a Buffer with `binary`); throws with
 * its stderr on failure, whatever it is (a rate limit, a 404): a report
 * missing data must fail, not count it unknown. A failure on GitHub's side
 * (a 502 now and then, over hundreds of calls) is tried up to three times.
 */
export function realGh(args, { binary = false } = {}) {
	for (let attempt = 1; ; attempt++) {
		const r = spawnSync("gh", args, {
			encoding: binary ? "buffer" : "utf8",
			maxBuffer: 256 * 1024 * 1024,
		});
		if (r.status === 0) return r.stdout;
		const err = String(r.stderr || r.error?.message || "");
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
	String(out)
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));

/** The largest outcome document read (bytes). */
const MAX_DOC = 1 << 20;

/** One file out of a zip (an artifact's download), or null if it isn't there. */
export function unzipFile(buf, name) {
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("not a zip");
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	for (let k = 0; k < count; k++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip");
		const method = buf.readUInt16LE(p + 10);
		const size = buf.readUInt32LE(p + 20);
		const plain = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const local = buf.readUInt32LE(p + 42);
		if (buf.toString("utf8", p + 46, p + 46 + nameLen) === name) {
			const start =
				local +
				30 +
				buf.readUInt16LE(local + 26) +
				buf.readUInt16LE(local + 28);
			// An outcome document is a few KiB: anything far larger (a zip
			// bomb from a fork's artifact) is refused, not inflated.
			if (plain > MAX_DOC) throw new Error(`${name}: ${plain} bytes`);
			const data = buf.subarray(start, start + size);
			if (method === 0) return data;
			if (method === 8) {
				return inflateRawSync(data, { maxOutputLength: MAX_DOC });
			}
			throw new Error(`zip method ${method}`);
		}
		p += 46 + nameLen + extraLen + commentLen;
	}
	return null;
}

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const DAY = 86_400_000;
/** The runs API answers at most this many runs for one `created` filter. */
const RUNS_CAP = 1000;

/**
 * The workflow's runs created in [from, to], a day at a time: the API
 * answers at most 1,000 runs per filter, so a range over that is halved
 * until it fits (down to a minute, else it fails).
 */
function listRuns({ repo, from, to, branch, gh }) {
	const runs = [];
	const page = (a, b, n) =>
		JSON.parse(
			gh([
				"api",
				"-X",
				"GET",
				`repos/${repo}/actions/workflows/${WORKFLOW}/runs`,
				"-f",
				`created=${iso(a)}..${iso(b)}`,
				"-f",
				"per_page=100",
				"-f",
				`page=${n}`,
				...(branch ? ["-f", `branch=${branch}`] : []),
				"--jq",
				"{total: .total_count, runs: [.workflow_runs[] | {id, run_attempt, status, conclusion, head_branch, head_repo: .head_repository.full_name, event, html_url, created_at, run_started_at}]}",
			]),
		);
	const range = (a, b) => {
		// The count first: a range over the cap is halved before its pages
		// are read.
		const first = page(a, b, 1);
		const total = first.total ?? 0;
		if (total > RUNS_CAP) {
			if (b - a <= 60_000) {
				throw new Error(`${total} runs between ${iso(a)} and ${iso(b)}`);
			}
			const mid = new Date(a.getTime() + Math.floor((b - a) / 2000) * 1000);
			range(a, mid);
			range(new Date(mid.getTime() + 1000), b);
			return;
		}
		const got = new Map((first.runs ?? []).map((r) => [r.id, r]));
		for (let n = 2; n <= Math.ceil(total / 100); n++) {
			for (const r of page(a, b, n).runs ?? []) got.set(r.id, r);
		}
		// Missing runs would quietly leave failures out: fail instead (a
		// run created while its range was read shifts the pages; run again).
		if (got.size < total) {
			throw new Error(
				`runs between ${iso(a)} and ${iso(b)}: ${got.size} of ${total} listed; run again`,
			);
		}
		runs.push(...got.values());
	};
	for (let a = from; a < to; a = new Date(a.getTime() + DAY)) {
		const end = new Date(Math.min(a.getTime() + DAY - 1000, to.getTime()));
		range(a, end);
	}
	const seen = new Set();
	return runs.filter((r) => !seen.has(r.id) && seen.add(r.id));
}

/**
 * The window's CI runs, every attempt of each; for a failed attempt its
 * test jobs' outcomes (verdicts from the artifacts' names; a flaky job's
 * tests from its document) and, when those don't cover every test job, the
 * jobs. `gh(args, { binary })` returns gh's stdout: injectable, for tests.
 * Any failure to read fails the collection: data missing is never counted
 * as an unknown outcome. Only a run with no outcome artifacts (one from
 * before them, or expired) has none.
 */
export function collect({
	repo,
	since,
	until = new Date(),
	branch,
	gh = realGh,
	warn = (m) => console.error(`ci-flakes: ${m}`),
}) {
	const runs = [];
	for (const r of listRuns({
		repo,
		from: since,
		to: until,
		branch,
		gh,
	})) {
		// A fork's PR runs the fork's own ci.yml, which can name or fail
		// anything: counted apart, never read.
		if (r.head_repo && r.head_repo !== repo) {
			runs.push({
				id: r.id,
				branch: r.head_branch,
				event: r.event,
				url: r.html_url,
				createdAt: r.created_at,
				fork: true,
				attempts: [],
			});
			continue;
		}
		const last = r.run_attempt ?? 1;
		const attempts = [];
		for (let n = 1; n <= last; n++) {
			const a =
				n === last
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
			(a) => a.status === "completed" && FAILED.has(a.conclusion),
		);
		if (failed.length > 0) {
			const artifacts = jsonLines(
				gh([
					"api",
					`repos/${repo}/actions/runs/${r.id}/artifacts?per_page=100`,
					"--paginate",
					"--jq",
					".artifacts[] | {id, name, expired}",
				]),
			)
				.map((a) => ({ ...a, parsed: parseArtifactName(a.name) }))
				.filter((a) => a.parsed);
			let jobs = null;
			for (const a of failed) {
				const mine = artifacts.filter((x) => x.parsed.attempt === a.n);
				a.outcomes = [];
				for (const x of mine) {
					const o = { slug: x.parsed.slug, verdict: x.parsed.verdict };
					// Its document only when the name can't say enough: no verdict
					// in it, or a flaky job's tests for the top flaky list.
					if ((o.verdict === null || o.verdict === "flaky") && !x.expired) {
						const zip = gh(
							["api", `repos/${repo}/actions/artifacts/${x.id}/zip`],
							{ binary: true },
						);
						// undefined: unreadable (said here); else checked.
						let doc;
						try {
							const file = unzipFile(Buffer.from(zip), "test-outcomes.json");
							doc = file ? JSON.parse(file.toString("utf8")) : null;
						} catch (e) {
							warn(
								`run ${r.id}: artifact ${x.name}: ${e.message}: counted unknown`,
							);
						}
						doc = doc === undefined ? null : checkDoc(doc, r.id, warn);
						if (doc && o.verdict && doc.verdict !== o.verdict) {
							warn(
								`run ${r.id}: artifact ${x.name} says ${doc.verdict} inside: counted unknown`,
							);
							doc = null;
						}
						if (doc) {
							Object.assign(o, {
								job: doc.job,
								verdict: o.verdict ?? doc.verdict,
								failed: doc.failed,
							});
						} else o.verdict = null;
					}
					a.outcomes.push(o);
				}
				// The jobs only when they can change the verdict: not when a later
				// attempt passed (flaky whatever they say), nor when an outcome
				// already says consistent or non-test (they can't lower that).
				// Otherwise they show a failed job with no outcome, one that
				// failed after its label step, or the summary job failing alone.
				const laterPassed = attempts.some(
					(b) =>
						b.n > a.n && b.status === "completed" && b.conclusion === "success",
				);
				const decided =
					laterPassed ||
					a.outcomes.some(
						(o) => o.verdict === "consistent" || o.verdict === "non-test",
					);
				if (!decided) {
					jobs ??= jsonLines(
						gh([
							"api",
							`repos/${repo}/actions/runs/${r.id}/jobs?filter=all&per_page=100`,
							"--paginate",
							"--jq",
							".jobs[] | {name, conclusion, run_attempt, steps: [.steps[]? | {name, conclusion}]}",
						]),
					);
					a.jobs = jobs.filter((j) => (j.run_attempt ?? 1) === a.n);
				}
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

/** The runs created at or after `since`. */
export const within = (runs, since) =>
	runs.filter((r) => !r.createdAt || new Date(r.createdAt) >= since);

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

/** The core API calls this token has used (rate_limit itself is free). */
function used() {
	try {
		return Number(
			realGh(["api", "rate_limit", "--jq", ".resources.core.used"]).trim(),
		);
	} catch {
		return Number.NaN;
	}
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
	const now = new Date();
	const windows = o.since.split(",").map((w) => ({
		label: w.trim(),
		since: parseSince(w.trim(), now),
	}));
	const widest = windows.reduce((a, b) => (b.since < a.since ? b : a));
	const before = used();
	const runs = collect({
		repo,
		since: widest.since,
		until: now,
		branch: o.branch,
	});
	const calls = used() - before;
	const reports = windows.map((w) => ({
		...w,
		summary: aggregate(within(runs, w.since)),
	}));
	if (o.format === "json") {
		console.log(
			JSON.stringify(
				{
					repo,
					apiCalls: calls,
					windows: reports.map((r) => ({
						window: r.label,
						since: r.since.toISOString(),
						...r.summary,
					})),
				},
				null,
				2,
			),
		);
	} else {
		for (const r of reports) {
			const title = `CI flakes since ${r.since.toISOString().slice(0, 16)}Z (${r.label})${o.branch ? `, ${o.branch}` : ""}`;
			process.stdout.write(
				`${render(r.summary, { title, markdown: o.format === "markdown" })}\n`,
			);
		}
	}
	console.error(
		`ci-flakes: ${Number.isNaN(calls) ? "?" : calls} GitHub API calls (core, this token)`,
	);
	const shortest = reports.reduce((a, b) => (b.since > a.since ? b : a));
	if (o.failOver !== undefined && shortest.summary.flakeRate > o.failOver) {
		console.error(
			`flake rate ${fmt(shortest.summary.flakeRate)} (${shortest.label}) is over ${o.failOver}%`,
		);
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
