import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	type Attempt,
	aggregate,
	checkDoc,
	collect,
	judgeAttempt,
	type OutcomeDoc,
	parseArtifactName,
	parseSince,
	type Run,
	render,
	term,
	transient,
	unzipFile,
	within,
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
			reason: "windows-agent: unknown, e2e-1: flaky",
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
	it("only the summary job failed (every shard passed): non-test", () => {
		const a: Attempt = {
			...failedAttempt([doc("e2e (1/4)", "passed")], undefined),
			jobs: [
				{ name: "e2e (1/4)", conclusion: "success" },
				{ name: "e2e", conclusion: "failure" },
			],
		};
		expect(judgeAttempt(a, false).verdict).toBe("non-test");
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
			// Cancelled, awaiting approval and running: not counted.
			run([{ n: 1, status: "completed", conclusion: "cancelled" }]),
			run([{ n: 1, status: "completed", conclusion: "action_required" }]),
			run([{ n: 1, status: "in_progress", conclusion: null }]),
			run([ok()], "master", "push"),
			run([ok()]),
		];
		const s = aggregate(runs);
		expect(s).toMatchObject({
			runs: 11,
			attempts: 12,
			passed: 3,
			failed: 6,
			notRun: 2,
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
			"1 consistent test failure, 1 non-test failure, 1 unknown (no outcome, or not rerun)",
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

/** A zip of one file, as GitHub serves an artifact. */
function zip(name: string, content: string, deflate = true): Buffer {
	const data = Buffer.from(content);
	const body = deflate ? deflateRawSync(data) : data;
	const n = Buffer.from(name);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(deflate ? 8 : 0, 8);
	local.writeUInt32LE(body.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(n.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(deflate ? 8 : 0, 10);
	central.writeUInt32LE(body.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(n.length, 28);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(1, 8);
	eocd.writeUInt16LE(1, 10);
	eocd.writeUInt32LE(46 + n.length, 12);
	eocd.writeUInt32LE(30 + n.length + body.length, 16);
	return Buffer.concat([local, n, body, central, n, eocd]);
}

type FakeRun = {
	id: number;
	created_at: string;
	run_attempt?: number;
	conclusion: string;
	attempts?: Record<number, string>;
	artifacts?: { id: number; name: string; expired?: boolean }[];
	jobs?: { name: string; conclusion: string; run_attempt: number }[];
};

/**
 * GitHub's API as `gh api` answers it (with the --jq the code passes,
 * applied by hand), for the runs given; `fail` maps a path to an error.
 */
function fakeGitHub(
	runs: FakeRun[],
	{
		zips = {},
		fail = {},
		total,
	}: {
		zips?: Record<number, Buffer>;
		fail?: Record<string, string>;
		total?: (from: string, to: string, n: number) => number;
	} = {},
) {
	const calls: string[] = [];
	const lines = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n");
	const gh = (args: string[]): string => {
		const path = args.find((a) => a.startsWith("repos/")) ?? "";
		calls.push(path);
		for (const [p, err] of Object.entries(fail)) {
			if (path.includes(p)) throw new Error(`gh api ${path}: ${err}`);
		}
		if (path.endsWith("/workflows/ci.yml/runs")) {
			const created = args.find((a) => a.startsWith("created="));
			const [from = "", to = ""] = (created ?? "").slice(8).split("..");
			const inRange = runs.filter(
				(r) => r.created_at >= from && r.created_at <= to,
			);
			return JSON.stringify({
				total: total?.(from, to, inRange.length) ?? inRange.length,
				runs: inRange.map((r) => ({
					id: r.id,
					run_attempt: r.run_attempt ?? 1,
					status: "completed",
					conclusion: r.conclusion,
					head_branch: "b",
					event: "pull_request",
					html_url: `https://example.invalid/runs/${r.id}`,
					created_at: r.created_at,
				})),
			});
		}
		const m = /runs\/(\d+)\/(attempts\/(\d+)|artifacts|jobs)/.exec(path);
		const r = runs.find((x) => x.id === Number(m?.[1]));
		if (r && m?.[3]) {
			return JSON.stringify({
				status: "completed",
				conclusion: r.attempts?.[Number(m[3])],
			});
		}
		if (r && m?.[2] === "artifacts") return lines(r.artifacts ?? []);
		if (r && m?.[2] === "jobs") return lines(r.jobs ?? []);
		throw new Error(`unexpected gh ${args.join(" ")}`);
	};
	const ghAny = ((args: string[], o?: { binary?: boolean }) => {
		const path = args.find((a) => a.startsWith("repos/")) ?? "";
		const z = /artifacts\/(\d+)\/zip$/.exec(path);
		if (z) {
			calls.push(path);
			for (const [p, err] of Object.entries(fail)) {
				if (path.includes(p)) throw new Error(`gh api ${path}: ${err}`);
			}
			const buf = zips[Number(z[1])];
			if (!buf || !o?.binary) throw new Error(`no zip ${path}`);
			return buf;
		}
		return gh(args);
	}) as (args: string[], o?: { binary?: boolean }) => string;
	return { gh: ghAny, calls };
}

const since = new Date("2026-11-14T00:00:00Z");
const until = new Date("2026-11-15T23:59:59Z");
const allJobs = (verdicts: Record<string, string>, attempt = 1) =>
	["checks", "windows-agent", "e2e-1", "e2e-2", "e2e-3", "e2e-4"].map(
		(slug, i) => ({
			id: 100 * attempt + i,
			name: `test-outcomes-${slug}-${attempt}-${verdicts[slug] ?? "passed"}`,
		}),
	);
const outcomeZip = (runId: number, job: string, failed: unknown[]) =>
	zip(
		"test-outcomes.json",
		JSON.stringify({ runId, attempt: 1, job, verdict: "flaky", failed }),
	);

describe("collecting runs", () => {
	it("reads verdicts from artifact names: a download only for a flaky job, the jobs only when the outcomes don't cover every test job", () => {
		const flaky = {
			file: "e2e/a.spec.ts",
			title: "t",
			project: "phone",
			verdict: "flaky",
		};
		const { gh, calls } = fakeGitHub(
			[
				// Every test job has an outcome; the shard flaked; a rerun passed.
				{
					id: 10,
					created_at: "2026-11-14T10:00:00Z",
					run_attempt: 2,
					conclusion: "success",
					attempts: { 1: "failure" },
					artifacts: allJobs({ "e2e-2": "flaky" }),
				},
				// Green: no artifact listing at all.
				{ id: 11, created_at: "2026-11-15T10:00:00Z", conclusion: "success" },
				// Only checks has an outcome: the jobs say windows-agent failed too.
				{
					id: 12,
					created_at: "2026-11-15T11:00:00Z",
					conclusion: "failure",
					artifacts: [{ id: 7, name: "test-outcomes-checks-1-consistent" }],
					jobs: [
						{ name: "checks", conclusion: "failure", run_attempt: 1 },
						{ name: "windows-agent", conclusion: "failure", run_attempt: 1 },
					],
				},
				// From before the outcomes: no artifacts.
				{
					id: 13,
					created_at: "2026-11-15T12:00:00Z",
					conclusion: "failure",
					jobs: [{ name: "checks", conclusion: "failure", run_attempt: 1 }],
				},
			],
			{ zips: { 103: outcomeZip(10, "e2e (2/4)", [flaky]) } },
		);
		const runs = collect({ repo: "o/r", since, until, gh });
		expect(calls.filter((c) => c.endsWith("/zip"))).toEqual([
			"repos/o/r/actions/artifacts/103/zip",
		]);
		expect(calls.filter((c) => c.includes("/jobs"))).toEqual([
			"repos/o/r/actions/runs/12/jobs?filter=all&per_page=100",
			"repos/o/r/actions/runs/13/jobs?filter=all&per_page=100",
		]);
		expect(calls.some((c) => c.includes("runs/11/"))).toBe(false);
		// A listing per day of the window.
		expect(calls.filter((c) => c.endsWith("/runs"))).toHaveLength(2);
		const s = aggregate(runs);
		expect(s).toMatchObject({
			attempts: 5,
			passed: 2,
			flaky: 1,
			consistent: 1,
			unknown: 1,
		});
		expect(s.topFlaky).toEqual([
			expect.objectContaining({ title: "t", job: "e2e (2/4)", count: 1 }),
		]);
	});

	it("a rate limit or any read error fails the collection, never counts as no outcome", () => {
		const failing = (path: string) =>
			fakeGitHub(
				[
					{
						id: 20,
						created_at: "2026-11-14T10:00:00Z",
						conclusion: "failure",
						artifacts: allJobs({ checks: "flaky" }),
					},
				],
				{
					zips: { 100: outcomeZip(20, "checks", []) },
					fail: { [path]: "HTTP 403: API rate limit exceeded" },
				},
			).gh;
		for (const path of ["runs/20/artifacts", "artifacts/100/zip", "/runs"]) {
			expect(
				() => collect({ repo: "o/r", since, until, gh: failing(path) }),
				path,
			).toThrow(/rate limit/);
		}
	});

	it("a malformed or foreign outcome document: a warning, the job unknown, no crash", () => {
		const warnings: string[] = [];
		for (const content of [
			'{"runId":30,"verdict":"flaky","failed":1}',
			'{"runId":99,"verdict":"flaky","failed":[]}',
			"not json",
		]) {
			const { gh } = fakeGitHub(
				[
					{
						id: 30,
						created_at: "2026-11-14T10:00:00Z",
						conclusion: "failure",
						artifacts: allJobs({ checks: "none" }),
					},
				],
				{ zips: { 100: zip("test-outcomes.json", content) } },
			);
			const runs = collect({
				repo: "o/r",
				since,
				until,
				gh,
				warn: (m) => warnings.push(m),
			});
			expect(aggregate(runs).unknown).toBe(1);
		}
		expect(warnings).toHaveLength(3);
	});

	it("a range over the API's 1,000 runs is halved until it fits; fewer listed than counted is said", () => {
		const warnings: string[] = [];
		const { gh, calls } = fakeGitHub(
			[{ id: 40, created_at: "2026-11-14T10:00:00Z", conclusion: "success" }],
			{
				// The first day "has" 1,500 runs as a whole, 500 in each half.
				total: (from, to, n) =>
					from.startsWith("2026-11-14T00:00:00") &&
					to.startsWith("2026-11-14T23:59:59")
						? 1500
						: from.startsWith("2026-11-14")
							? Math.max(n, 500)
							: n,
			},
		);
		const runs = collect({
			repo: "o/r",
			since,
			until,
			gh,
			warn: (m) => warnings.push(m),
		});
		expect(runs.map((r) => r.id)).toEqual([40]);
		expect(calls.filter((c) => c.endsWith("/runs"))).toHaveLength(4);
		expect(warnings).toEqual([
			expect.stringMatching(/1 of 500 listed/),
			expect.stringMatching(/0 of 500 listed/),
		]);
	});

	it("artifact names, documents, zips, windows and terminal text", () => {
		expect(parseArtifactName("test-outcomes-windows-agent-2-flaky")).toEqual({
			slug: "windows-agent",
			attempt: 2,
			verdict: "flaky",
		});
		expect(parseArtifactName("test-outcomes-e2e-3-1-non-test")).toEqual({
			slug: "e2e-3",
			attempt: 1,
			verdict: "non-test",
		});
		expect(parseArtifactName("test-outcomes-checks-1-none")?.verdict).toBe(
			null,
		);
		expect(parseArtifactName("test-outcomes-checks-1")?.verdict).toBe(null);
		expect(parseArtifactName("test-traces-unit")).toBe(null);
		expect(checkDoc({ verdict: "flaky", failed: [] }, 1)).not.toBe(null);
		expect(
			checkDoc({ verdict: "flaky", failed: [{ file: 1 }] }, 1, () => {}),
		).toBe(null);
		for (const deflate of [true, false]) {
			expect(
				unzipFile(
					zip("test-outcomes.json", '{"a":1}', deflate),
					"test-outcomes.json",
				)?.toString(),
			).toBe('{"a":1}');
		}
		expect(unzipFile(zip("other.json", "{}"), "test-outcomes.json")).toBe(null);
		const runs = [
			{
				id: 1,
				branch: "b",
				event: "push",
				createdAt: "2026-11-01T00:00:00Z",
				attempts: [],
			},
			{
				id: 2,
				branch: "b",
				event: "push",
				createdAt: "2026-11-15T00:00:00Z",
				attempts: [],
			},
		];
		expect(within(runs, since).map((r) => r.id)).toEqual([2]);
		expect(term("a\u001b[2Jb\u0007c")).toBe("a?[2Jb?c");
	});

	it("only GitHub's own failures are tried again", () => {
		expect(transient("gh: Server Error (HTTP 502)")).toBe(true);
		expect(transient("read: connection reset by peer")).toBe(true);
		expect(transient("gh: Not Found (HTTP 404)")).toBe(false);
		expect(transient("HTTP 403: API rate limit exceeded")).toBe(false);
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
