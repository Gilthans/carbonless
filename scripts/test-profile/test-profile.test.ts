import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { otlpLine, type RecordedSpan } from "../../src/server/trace";
import {
	KEEP_MS,
	pruneRuns,
	startTraceRun,
	testSpanContext,
} from "../../test/trace-run";
import { compactRun, readRequests, type Span, spansOf } from "./load";
import { type StepLike, testSpans } from "./spans";
import { fmt, formatCompare, formatSummary, summarize } from "./summary";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "crb-profile-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

const T0 = Date.UTC(2026, 10, 9, 12);
/** A step `ms` after T0 lasting `d`. */
const step = (
	title: string,
	category: string,
	ms: number,
	d: number,
	steps: StepLike[] = [],
): StepLike => ({
	title,
	category,
	startTime: new Date(T0 + ms),
	duration: d,
	steps,
});

/**
 * A test of 10 s as Playwright reports it (e2e/fixtures.ts steps): browser
 * 1 s of 1.2 s of before hooks, fixture 0.5 s, serve 2 s, open 1.5 s,
 * first navigation 0.8 s (a later one isn't setup), after hooks 0.6 s
 * with a crb stop of 0.4 s.
 */
function e2eSteps(): StepLike[] {
	return [
		step("Before Hooks", "hook", 0, 1200, [
			step('Fixture "browser"', "fixture", 0, 600, [
				step("Launch browser", "pw:api", 0, 600),
			]),
			step('Fixture "context"', "fixture", 600, 100),
			// A spec's beforeEach: the fixtures it needs nest in it.
			step("beforeEach hook", "hook", 700, 500, [
				step('Fixture "page"', "fixture", 700, 300),
				// Not crb's page: before the review opens.
				step("Navigate", "pw:api", 1000, 50),
			]),
			step('Fixture "workdir"', "fixture", 1050, 150),
		]),
		step("setup: fixture repo", "test.step", 1200, 500),
		step("setup: crb serve", "test.step", 1700, 2000),
		step("setup: crb open", "test.step", 3700, 1500),
		step("Navigate", "pw:api", 5200, 800),
		step('Expect "toBeVisible"', "expect", 6000, 300),
		step("Navigate", "pw:api", 7000, 300),
		step("After Hooks", "hook", 9400, 600, [
			step('Fixture "startCrb"', "fixture", 9400, 400, [
				step("teardown: crb stop", "test.step", 9400, 400),
			]),
		]),
	];
}

/** One e2e test's spans plus crb's and the fake gh's under it. */
function e2eRun(run: string, testId: string, extraGh = 0): RecordedSpan[] {
	const ctx = testSpanContext(run, testId, 0, 0);
	let n = 0;
	const id = () => (n++).toString(16).padStart(16, "0");
	const spans = testSpans(
		{
			file: "e2e/files.spec.ts",
			title: `test ${testId}`,
			project: "chromium",
			worker: 0,
			status: "passed",
			retry: 0,
			startTime: new Date(T0),
			duration: 10_000,
			steps: e2eSteps(),
		},
		ctx,
		id,
	);
	const crbRoot = {
		traceId: ctx.traceId,
		spanId: `c${testId}`.padEnd(16, "0"),
	};
	const at = (
		name: string,
		parent: { traceId: string; spanId: string },
		s: number,
		d: number,
		attrs = {},
	) => {
		const context = { traceId: ctx.traceId, spanId: id() };
		spans.push({
			name,
			context,
			parent,
			startMs: T0 + s,
			endMs: T0 + s + d,
			attrs,
		});
		return context;
	};
	spans.push({
		name: "crb serve",
		context: crbRoot,
		parent: ctx,
		startMs: T0 + 1700,
		endMs: T0 + 9800,
		attrs: {},
	});
	for (let i = 0; i < 2 + extraGh; i++) {
		const gh = at("gh api graphql", crbRoot, 4000 + i * 10, 300);
		at("fake gh api graphql", gh, 4010 + i * 10, 250);
	}
	at("git rev-parse", crbRoot, 4500, 20);
	at("git init", ctx, 1200, 30, { "crb.fixture": true });
	return spans;
}

/** Spans as the summary reads them back from OTLP lines, `fake gh` ones from its service. */
function asRead(spans: RecordedSpan[]): Span[] {
	const fake = spans.filter((s) => s.name.startsWith("fake gh"));
	const crb = spans.filter(
		(s) =>
			s.name.startsWith("crb") ||
			(/^(gh|git) /.test(s.name) && !s.attrs?.["crb.fixture"]),
	);
	const rest = spans.filter(
		(s) => !fake.includes(s) && !crb.includes(s) && s.attrs?.["crb.fixture"],
	);
	const e2e = spans.filter(
		(s) => !fake.includes(s) && !crb.includes(s) && !rest.includes(s),
	);
	return spansOf(
		[
			otlpLine("e2e", {}, e2e),
			otlpLine("crb", {}, crb),
			otlpLine("fake-gh", {}, fake),
			otlpLine("playwright-worker", {}, rest),
		].map((l) => JSON.parse(l)),
	);
}

describe("testSpans (the Playwright reporter's)", () => {
	it("tags setup phases: browser fixtures, our steps, the first navigation only", () => {
		const ctx = testSpanContext("run", "t1", 0, 0);
		const spans = testSpans(
			{
				file: "e2e/a.spec.ts",
				title: "t",
				project: "phone",
				worker: 1,
				status: "failed",
				retry: 0,
				startTime: new Date(T0),
				duration: 10_000,
				steps: e2eSteps(),
				error: "nope",
			},
			ctx,
		);
		const [test] = spans;
		expect(test).toMatchObject({
			context: ctx,
			parent: null,
			error: "nope",
			attrs: {
				"crb.kind": "test",
				"test.project": "phone",
				"test.status": "failed",
			},
		});
		const phases = spans.map((s) => [s.name, s.attrs?.["crb.phase"]]);
		expect(phases).toEqual([
			["test: t", undefined],
			["Before Hooks", "setup.other"],
			['Fixture "browser"', "setup.browser"],
			['Fixture "context"', "setup.browser"],
			["beforeEach hook", undefined],
			['Fixture "page"', "setup.browser"],
			["Navigate", undefined],
			['Fixture "workdir"', undefined],
			["setup: fixture repo", "setup.fixture"],
			["setup: crb serve", "setup.crb_serve"],
			["setup: crb open", "setup.crb_open"],
			["Navigate", "setup.first_load"],
			["Navigate", undefined],
			["After Hooks", "teardown.other"],
			['Fixture "startCrb"', undefined],
			["teardown: crb stop", "teardown.crb_stop"],
		]);
		// Children point at their step; everything is in the test's trace.
		const browser = spans[2];
		expect(spans[1]?.parent).toEqual(ctx);
		expect(browser?.parent).toEqual(spans[1]?.context);
		expect(new Set(spans.map((s) => s.context.traceId))).toEqual(
			new Set([ctx.traceId]),
		);
	});

	it("derives the same ids in the worker and the reporter, distinct per retry", () => {
		const a = testSpanContext("run", "id", 0, 0);
		expect(testSpanContext("run", "id", 0, 0)).toEqual(a);
		expect(testSpanContext("run", "id", 1, 0)).not.toEqual(a);
		expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(a.spanId).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("summarize", () => {
	it("sums exclusive phase time, calls per test and crb's hot spots", () => {
		const s = summarize(asRead([...e2eRun("r", "a"), ...e2eRun("r", "b", 2)]));
		expect(s.tests).toBe(2);
		expect(s.testMs).toBe(20_000);
		// Per test: before hooks 1.2 s minus browser 1 s; after 0.6 minus stop 0.4.
		expect(s.phases).toEqual({
			"setup.other": 400,
			"setup.browser": 2000,
			"setup.fixture": 1000,
			"setup.crb_serve": 4000,
			"setup.crb_open": 3000,
			"setup.first_load": 1600,
			"teardown.other": 400,
			"teardown.crb_stop": 800,
			body: 20_000 - 400 - 2000 - 1000 - 4000 - 3000 - 1600 - 400 - 800,
		});
		expect(Object.values(s.phases).reduce((a, b) => a + b)).toBe(s.testMs);
		expect(s.calls.gh).toEqual({ n: 6, ms: 1800, medianN: 3, medianMs: 900 });
		expect(s.calls["fake gh (process)"]).toMatchObject({ n: 6, ms: 1500 });
		expect(s.calls["git (crb)"]).toMatchObject({ n: 2, medianN: 1 });
		expect(s.calls["git (fixture)"]).toMatchObject({ n: 2, ms: 60 });
		expect(s.files).toEqual([
			{ file: "e2e/files.spec.ts", ms: 20_000, tests: 2 },
		]);
		expect(s.hot.map((h) => [h.name, h.n])).toEqual([
			["gh api graphql", 6],
			["git rev-parse", 2],
		]);
		const text = formatSummary("r", s);
		expect(text).toContain("wall 10.0s · 2 tests · test time 20.0s");
		expect(text).toMatch(/setup\.crb_serve\s+4\.0s\s+20\.0%\s+2\.0s/);
		expect(text).toMatch(/gh\s+6\s+1\.8s\s+300ms\s+3\s+900ms/);
	});

	it("counts a unit file's time outside its tests as `file`", () => {
		const file = { traceId: "f".repeat(32), spanId: "1".repeat(16) };
		const spans: RecordedSpan[] = [
			{
				name: "file: a.test.ts",
				context: file,
				parent: null,
				startMs: T0,
				endMs: T0 + 5000,
				attrs: { "crb.kind": "file", "test.file": "a.test.ts" },
			},
			{
				name: "test: x",
				context: { ...file, spanId: "2".repeat(16) },
				parent: file,
				startMs: T0 + 1000,
				endMs: T0 + 4000,
				attrs: {
					"crb.kind": "test",
					"test.file": "a.test.ts",
					"test.title": "x",
					"test.status": "pass",
				},
			},
			{
				name: "git diff",
				context: { ...file, spanId: "3".repeat(16) },
				parent: { ...file, spanId: "2".repeat(16) },
				startMs: T0 + 1000,
				endMs: T0 + 1100,
			},
		];
		const s = summarize(spansOf([JSON.parse(otlpLine("vitest", {}, spans))]));
		expect(s.phases).toEqual({ body: 3000, file: 2000 });
		expect(s.files).toEqual([{ file: "a.test.ts", ms: 5000, tests: 1 }]);
		expect(s.calls["git (crb)"]).toMatchObject({ n: 1, ms: 100, medianN: 1 });
		expect(s.hot).toEqual([
			{ name: "git diff", n: 1, ms: 100, p50: 100, max: 100 },
		]);
	});

	it("compares two runs: totals, phases, calls and the tests that moved", () => {
		const a = summarize(asRead(e2eRun("r", "a")));
		const b = summarize(asRead(e2eRun("r", "a", 4)));
		const text = formatCompare("A", a, "B", b);
		expect(text).toContain("▶ A → B");
		expect(text).toMatch(
			/gh\s+2 → 6 {2}\+4 \(\+200%\); 600ms → 1\.8s {2}\+1\.2s \(\+200%\)/,
		);
		expect(text).toMatch(/test time {2}10\.0s → 10\.0s {2}\+0ms \(\+0%\)/);
	});

	it("formats durations short", () => {
		expect([
			fmt(420),
			fmt(4200),
			fmt(192_000),
			fmt(3_780_000),
			fmt(-1500),
		]).toEqual(["420ms", "4.2s", "3m12s", "1h03m", "-1.5s"]);
	});
});

describe("the run directory", () => {
	it("prunes runs older than 7 days and keeps newer ones", () => {
		const root = tempDir();
		const now = Date.now();
		for (const [name, age] of [
			["old", KEEP_MS + 60_000],
			["new", KEEP_MS - 60_000],
		] as const) {
			mkdirSync(join(root, name));
			const t = (now - age) / 1000;
			utimesSync(join(root, name), t, t);
		}
		expect(pruneRuns(root, now)).toEqual(["old"]);
		expect(readdirSync(root)).toEqual(["new"]);
		expect(pruneRuns(join(root, "missing"), now)).toEqual([]);
	});

	it("is made once in the main process and passed down; CRB_TEST_TRACES=0 turns it off", () => {
		const cache = tempDir();
		vi.stubEnv("XDG_CACHE_HOME", cache);
		vi.stubEnv("CRB_TRACE_DIR", "");
		vi.stubEnv("CRB_TEST_TRACES", "0");
		expect(startTraceRun("unit")).toBeNull();
		vi.stubEnv("CRB_TEST_TRACES", "");
		const dir = startTraceRun("unit");
		expect(dir).toMatch(
			new RegExp(`^${cache}/carbonless/test-traces/.*-unit-\\d+$`),
		);
		expect(process.env.CRB_TRACE_DIR).toBe(dir);
		expect(readdirSync(dir as string)).toEqual(["run.json"]);
		// A worker re-reading the config keeps it.
		expect(startTraceRun("e2e")).toBe(dir);
	});

	it("packs the files of exited processes, leaves live ones, and reads both", () => {
		const dir = tempDir();
		const span = (name: string): RecordedSpan => ({
			name,
			context: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
			parent: null,
			startMs: T0,
			endMs: T0 + 1,
		});
		writeFileSync(
			join(dir, "fake-gh-100-aaaaaa.jsonl"),
			`${otlpLine("fake-gh", {}, [span("one")])}\n`,
		);
		writeFileSync(
			join(dir, "crb-101-bbbbbb.jsonl"),
			`${otlpLine("crb", {}, [span("two")])}\n${otlpLine("crb", {}, [span("three")])}\n`,
		);
		writeFileSync(
			join(dir, "vitest-200-cccccc.jsonl"),
			`${otlpLine("vitest", {}, [span("live")])}\n`,
		);
		writeFileSync(join(dir, "run.json"), "{}\n");
		expect(compactRun(dir, (pid) => pid === 200)).toBe(2);
		const files = readdirSync(dir).sort();
		expect(files).toEqual([
			expect.stringMatching(/^packed-[0-9a-f]{8}\.jsonl\.gz$/),
			"run.json",
			"vitest-200-cccccc.jsonl",
		]);
		expect(
			spansOf(readRequests(dir))
				.map((s) => s.name)
				.sort(),
		).toEqual(["live", "one", "three", "two"]);
	});
});
