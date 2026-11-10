import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
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
	traceRoot,
} from "../../test/trace-run";
import { compactRun, readRequests, type Span, spansOf, viewRun } from "./load";
import { findRun, resolveRun } from "./runs";
import { type StepLike, testSpans } from "./spans";
import { fmt, formatCompare, formatSummary, summarize } from "./summary";

/** This worker's own trace run, which no test may change. */
const RUN_BEFORE = process.env.CRB_TRACE_RUN;
const DIR_BEFORE = process.env.CRB_TRACE_DIR;

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
function e2eRun(
	run: string,
	testId: string,
	extraGh = 0,
	repeat = 0,
): RecordedSpan[] {
	const ctx = testSpanContext(run, testId, 0, repeat);
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
			repeat,
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
				repeat: 0,
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

	it("sets the first wave (tests started before any ended) against the rest, and the warm-up", () => {
		/** Test `id` started `at` ms late, its crb listening after `listen` ms. */
		const shifted = (id: string, at: number, listen: number) => {
			const spans = e2eRun("r", id).map((sp) => ({
				...sp,
				startMs: sp.startMs + at,
				endMs: sp.endMs + at,
			}));
			const root = spans.find((sp) => sp.name === "crb serve");
			spans.push({
				name: "crb serve: listening",
				context: {
					traceId: root?.context.traceId ?? "",
					spanId: `l${id}`.padEnd(16, "0"),
				},
				parent: root?.context ?? null,
				startMs: T0 + at + 1700,
				endMs: T0 + at + 1700 + listen,
			});
			return spans;
		};
		const warmup: RecordedSpan = {
			name: "e2e: warm-up",
			context: { traceId: "w".repeat(32), spanId: "w".repeat(16) },
			parent: null,
			startMs: T0 - 3000,
			endMs: T0 - 500,
			attrs: { "crb.kind": "warmup" },
		};
		const s = summarize(
			asRead([
				warmup,
				...shifted("a", 0, 9000),
				...shifted("b", 500, 7000),
				// Starts once a has ended (10 s): the rest.
				...shifted("c", 10_000, 1000),
				...shifted("d", 12_000, 1400),
				...shifted("e", 14_000, 1200),
			]),
		);
		expect(s.warmupMs).toBe(2500);
		expect(s.firstWave).toEqual({
			first: { tests: 2, testMs: 10_000, listenMs: 8000 },
			rest: { tests: 3, testMs: 10_000, listenMs: 1200 },
		});
		// Not a test: the warm-up counts in no phase or file.
		expect(s.tests).toBe(5);
		const text = formatSummary("r", s);
		expect(text).toContain("warm-up (before the workers) 2.5s");
		expect(text).toMatch(/first wave\s+2\s+10\.0s\s+8\.0s/);
		expect(text).toMatch(/rest\s+3\s+10\.0s\s+1\.2s/);
		const compared = formatCompare("A", s, "B", {
			...s,
			firstWave: {
				first: { tests: 2, testMs: 10_000, listenMs: 2000 },
				rest: { tests: 3, testMs: 10_000, listenMs: 1200 },
			},
		});
		expect(compared).toMatch(/listen {5}8\.0s → 2\.0s {2}-6\.0s \(-75%\)/);
	});

	it("a run without a warm-up, rest tests or listen spans shows – there, never 0", () => {
		// Both start at once: all first wave. No `crb serve: listening` spans.
		const s = summarize(asRead([...e2eRun("r", "a"), ...e2eRun("r", "b")]));
		expect(s.warmupMs).toBeUndefined();
		expect(s.firstWave).toEqual({
			first: { tests: 2, testMs: 10_000, listenMs: null },
			rest: { tests: 0, testMs: null, listenMs: null },
		});
		const text = formatSummary("r", s);
		expect(text).not.toContain("warm-up");
		expect(text).toMatch(/first wave\s+2\s+10\.0s\s+–\n/);
		expect(text).toMatch(/rest\s+0\s+–\s+–\n/);
		// Compared with a run that has no first wave: no -100% lines.
		const { firstWave: _, ...without } = s;
		expect(formatCompare("A", without, "B", s)).not.toContain("first wave");
		// Missing listen on one side: both shown as they are.
		const listened = {
			...s,
			firstWave: {
				first: { tests: 2, testMs: 10_000, listenMs: 900 },
				rest: s.firstWave?.rest ?? { tests: 0, testMs: null, listenMs: null },
			},
		};
		expect(formatCompare("A", s, "B", listened)).toMatch(
			/listen {5}– → 900ms\n/,
		);
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

	it("keeps --repeat-each repeats of a test apart", () => {
		const before = summarize(
			asRead([...e2eRun("r", "a", 0, 0), ...e2eRun("r", "a", 0, 1)]),
		);
		const after = summarize(
			asRead([...e2eRun("r", "a", 0, 0), ...e2eRun("r", "a", 0, 1)]),
		);
		expect(new Set(before.slowest.map((t) => t.key)).size).toBe(2);
		// Each repeat is compared with its own: nothing moved.
		const moved = formatCompare("A", before, "B", after).split(
			"tests that moved most\n",
		)[1];
		expect(moved?.split("\n")).toEqual([
			expect.stringMatching(/^ +\+0ms {2}files\.spec\.ts › test a$/),
			expect.stringMatching(/^ +\+0ms {2}files\.spec\.ts › test a$/),
		]);
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
		// CI sets it (.github/workflows/ci.yml); this test is about the default.
		vi.stubEnv("CRB_TEST_TRACE_ROOT", "");
		vi.stubEnv("CRB_TRACE_DIR", "");
		// startTraceRun sets both; stubbed, they are restored after.
		vi.stubEnv("CRB_TRACE_RUN", "");
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

	it("leaves this worker's own run as it was (after the test above)", () => {
		expect(process.env.CRB_TRACE_RUN).toBe(RUN_BEFORE);
		expect(process.env.CRB_TRACE_DIR).toBe(DIR_BEFORE);
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
			expect.stringMatching(/^packed-\d+-[0-9a-f]{8}\.jsonl\.gz$/),
			"run.json",
			"vitest-200-cccccc.jsonl",
		]);
		expect(
			spansOf(readRequests(dir))
				.map((s) => s.name)
				.sort(),
		).toEqual(["live", "one", "three", "two"]);
	});

	/** A run dir with an exited process's file of span `names`, per file. */
	function exited(dir: string, files: Record<string, string[]>): void {
		for (const [file, names] of Object.entries(files)) {
			writeFileSync(
				join(dir, file),
				names
					.map(
						(name) =>
							`${otlpLine("crb", {}, [
								{
									name,
									context: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
									parent: null,
									startMs: T0,
									endMs: T0 + 1,
								},
							])}\n`,
					)
					.join(""),
			);
		}
	}
	const names = (dir: string) =>
		spansOf(readRequests(dir))
			.map((s) => s.name)
			.sort();

	it("two packers never pack a file twice: a claimed file is the claimer's", () => {
		const dir = tempDir();
		exited(dir, {
			"crb-101-aaaaaa.jsonl": ["one"],
			"fake-gh-102-bbbbbb.jsonl": ["two"],
		});
		let inner = -1;
		// The processes are done; the packers (this process) run.
		const alive = (pid: number) => pid === process.pid;
		// A second packer (pnpm test-profile) runs while the first has read its files.
		const outer = compactRun(dir, alive, () => {
			inner = compactRun(dir, alive);
		});
		expect([outer, inner]).toEqual([2, 0]);
		expect(names(dir)).toEqual(["one", "two"]);
		expect(readdirSync(dir)).toEqual([
			expect.stringMatching(/^packed-\d+-[0-9a-f]{8}\.jsonl\.gz$/),
		]);
	});

	it("a failed pack puts its claimed files back and leaves no temp file", () => {
		const dir = tempDir();
		exited(dir, { "crb-101-aaaaaa.jsonl": ["one"] });
		const n = compactRun(
			dir,
			() => false,
			() => {
				throw new Error("disk full");
			},
		);
		expect(n).toBe(0);
		expect(readdirSync(dir)).toEqual(["crb-101-aaaaaa.jsonl"]);
		expect(names(dir)).toEqual(["one"]);
	});

	it("keeps a killed process's torn last line from swallowing the next file's first", () => {
		const dir = tempDir();
		exited(dir, {
			"crb-101-aaaaaa.jsonl": ["one"],
			"crb-102-bbbbbb.jsonl": ["two"],
		});
		// SIGKILLed mid-write: a last line with no end.
		writeFileSync(
			join(dir, "crb-101-aaaaaa.jsonl"),
			`${readFileSync(join(dir, "crb-101-aaaaaa.jsonl"), "utf8")}{"resourceSpans":[{"reso`,
		);
		expect(compactRun(dir, () => false)).toBe(2);
		expect(names(dir)).toEqual(["one", "two"]);
	});

	it("doesn't extend a run's retention when it packs it", () => {
		const dir = tempDir();
		exited(dir, { "crb-101-aaaaaa.jsonl": ["one"] });
		const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
		utimesSync(dir, old, old);
		expect(compactRun(dir, () => false)).toBe(1);
		expect(Math.round(statSync(dir).mtimeMs / 1000)).toBe(
			Math.round(old.getTime() / 1000),
		);
	});

	it("reads past a file that vanished between listing and reading", () => {
		const dir = tempDir();
		exited(dir, { "crb-101-aaaaaa.jsonl": ["one"] });
		// Listed, but gone when read (a packer took it).
		symlinkSync(join(dir, "nowhere"), join(dir, "crb-102-bbbbbb.jsonl"));
		expect(names(dir)).toEqual(["one"]);
	});

	it("finds the newest run of this tree that has traces", () => {
		const root = tempDir();
		const run = (name: string, cwd: string, traces: boolean) => {
			mkdirSync(join(root, name));
			writeFileSync(join(root, name, "run.json"), JSON.stringify({ cwd }));
			if (traces) exited(join(root, name), { "crb-1-aaaaaa.jsonl": ["x"] });
		};
		run("2026-11-01-e2e-1", "/here", true);
		run("2026-11-02-unit-2", "/here", true);
		run("2026-11-03-e2e-3", "/elsewhere", true);
		run("2026-11-04-e2e-4", "/here", false);
		const pick = (name?: string, cwd = "/here") =>
			findRun(root, name, cwd).name;
		expect(pick()).toBe("2026-11-02-unit-2");
		expect(pick("e2e")).toBe("2026-11-01-e2e-1");
		expect(pick("latest", "/other")).toBe("2026-11-03-e2e-3");
		expect(pick("2026-11-04-e2e-4")).toBe("2026-11-04-e2e-4");
		expect(findRun(root, "unit", "/here").cwd).toBe("/here");
		expect(() => findRun(root, "nothing")).toThrow(/no test traces match/);
	});

	it("takes over the claims of a packer that died, and packs each once", () => {
		const dir = tempDir();
		exited(dir, {
			"crb-101-aaaaaa.jsonl": ["one"],
			"crb-102-bbbbbb.jsonl": ["two"],
		});
		// Packer 900 died after claiming one file; packer 901 still works on the other.
		renameSync(
			join(dir, "crb-101-aaaaaa.jsonl"),
			join(dir, "crb-101-aaaaaa.jsonl.packing-900-deadbeef"),
		);
		renameSync(
			join(dir, "crb-102-bbbbbb.jsonl"),
			join(dir, "crb-102-bbbbbb.jsonl.packing-901-cafecafe"),
		);
		writeFileSync(join(dir, "packed-900-deadbeef.jsonl.gz.tmp"), "half");
		const alive = (pid: number) => pid === 901;
		expect(compactRun(dir, alive)).toBe(1);
		expect(names(dir)).toEqual(["one"]);
		expect(readdirSync(dir).sort()).toEqual([
			"crb-102-bbbbbb.jsonl.packing-901-cafecafe",
			expect.stringMatching(/^packed-\d+-[0-9a-f]{8}\.jsonl\.gz$/),
		]);
		// Packed once: a second pass finds nothing more to take.
		expect(compactRun(dir, alive)).toBe(0);
		expect(names(dir)).toEqual(["one"]);
	});

	it("a reader doesn't pack a run whose runner still runs", () => {
		const root = tempDir();
		const live = join(root, `2026-11-09T00-00-00-000Z-e2e-${process.pid}`);
		const done = join(root, "2026-11-09T00-00-00-000Z-e2e-999999");
		for (const dir of [live, done]) {
			mkdirSync(dir);
			exited(dir, { "crb-101-aaaaaa.jsonl": ["one"] });
		}
		const alive = (pid: number) => pid === process.pid;
		expect(viewRun(live, alive).map((s) => s.name)).toEqual(["one"]);
		expect(readdirSync(live)).toEqual(["crb-101-aaaaaa.jsonl"]);
		expect(viewRun(done, alive).map((s) => s.name)).toEqual(["one"]);
		expect(readdirSync(done)).toEqual([
			expect.stringMatching(/^packed-.*\.jsonl\.gz$/),
		]);
	});

	it("skips a run pruned between listing the runs and looking at it", () => {
		const root = tempDir();
		for (const name of ["2026-11-01-e2e-1", "2026-11-02-e2e-2"]) {
			mkdirSync(join(root, name));
			writeFileSync(
				join(root, name, "run.json"),
				JSON.stringify({ cwd: "/here" }),
			);
			exited(join(root, name), { "crb-1-aaaaaa.jsonl": ["x"] });
		}
		const run = findRun(root, "latest", "/here", () =>
			rmSync(join(root, "2026-11-02-e2e-2"), { recursive: true }),
		);
		expect(run.name).toBe("2026-11-01-e2e-1");
	});

	it("puts runs under $CRB_TEST_TRACE_ROOT when set (CI uploads it)", () => {
		expect(
			traceRoot({ CRB_TEST_TRACE_ROOT: "/ci/traces", XDG_CACHE_HOME: "/x" }),
		).toBe("/ci/traces");
		expect(traceRoot({ XDG_CACHE_HOME: "/x" })).toBe(
			"/x/carbonless/test-traces",
		);
	});

	it("reads a downloaded CI artifact by path: a run, or a directory of runs", () => {
		const artifact = tempDir();
		const name = "2026-11-09T10-00-00-000Z-e2e-4242";
		mkdirSync(join(artifact, name));
		writeFileSync(
			join(artifact, name, "run.json"),
			JSON.stringify({ cwd: "/home/runner/work/carbonless" }),
		);
		exited(join(artifact, name), { "crb-1-aaaaaa.jsonl": ["x"] });
		const local = tempDir();
		const fromDir = resolveRun(local, artifact, "/here");
		expect(fromDir).toEqual({
			dir: join(artifact, name),
			name,
			cwd: "/home/runner/work/carbonless",
		});
		expect(resolveRun(local, join(artifact, name), "/here")).toEqual(fromDir);
		// A name is still looked up under the traces root.
		expect(() => resolveRun(local, "e2e", "/here")).toThrow(
			/no test traces match/,
		);
	});
});
