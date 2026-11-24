import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRequests, spansOf } from "../../scripts/test-profile/load";
import {
	createTracer,
	DEFAULT_ROTATION,
	FLUSH_AFTER_MS,
	isServiceFile,
	parseTraceparent,
	pruneTraces,
	rotationFromEnv,
	toNanos,
	traceparent,
} from "./trace";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "crb-trace-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

const PARENT = "00-0123456789abcdef0123456789abcdef-0011223344556677-01";

describe("createTracer", () => {
	it("is a no-op without a directory: no ids, no file", () => {
		const t = createTracer({ dir: undefined, service: "x" });
		expect(t.enabled).toBe(false);
		const span = t.start("a");
		expect(span.context).toBeNull();
		span.end();
		expect(t.root("r").context).toBeNull();
		expect(t.run(span, () => 7)).toBe(7);
		t.flush();
	});

	it("writes valid OTLP JSON lines, one file for the process", () => {
		const dir = tempDir();
		const t = createTracer({
			dir,
			service: "svc",
			flushOnExit: false,
			resource: { "crb.run": "r1" },
		});
		const span = t.start("git status", { args: "status --porcelain", n: 2 });
		span.end({ exit: 0, ratio: 0.5, ok: true }, undefined);
		t.start("failing").end(undefined, "boom");
		t.flush();
		const files = readdirSync(dir);
		expect(files).toEqual([
			expect.stringMatching(/^svc-\d+-[0-9a-f]{6}\.jsonl$/),
		]);
		const lines = readFileSync(join(dir, files[0] as string), "utf8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(1);
		const req = JSON.parse(lines[0] as string);
		const rs = req.resourceSpans[0];
		expect(rs.resource.attributes).toEqual(
			expect.arrayContaining([
				{ key: "service.name", value: { stringValue: "svc" } },
				{ key: "crb.run", value: { stringValue: "r1" } },
			]),
		);
		const [a, b] = rs.scopeSpans[0].spans;
		expect(a).toMatchObject({
			traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
			spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
			name: "git status",
			kind: 1,
			startTimeUnixNano: expect.stringMatching(/^\d{19}$/),
			endTimeUnixNano: expect.stringMatching(/^\d{19}$/),
		});
		expect(a.parentSpanId).toBeUndefined();
		expect(a.attributes).toEqual([
			{ key: "args", value: { stringValue: "status --porcelain" } },
			{ key: "n", value: { intValue: 2 } },
			{ key: "exit", value: { intValue: 0 } },
			{ key: "ratio", value: { doubleValue: 0.5 } },
			{ key: "ok", value: { boolValue: true } },
		]);
		expect(BigInt(a.endTimeUnixNano)).toBeGreaterThanOrEqual(
			BigInt(a.startTimeUnixNano),
		);
		expect(b.status).toEqual({ code: 2, message: "boom" });
	});

	it("nests under $TRACEPARENT: the root, then spans under it and under run()", async () => {
		const dir = tempDir();
		const t = createTracer({
			dir,
			service: "crb",
			traceparent: PARENT,
			flushOnExit: false,
		});
		const root = t.root("crb serve");
		const outer = t.start("POST /api/reviews");
		const inner = await t.run(outer, async () => {
			await new Promise((r) => setTimeout(r, 0));
			return t.start("git fetch");
		});
		inner.end();
		outer.end();
		const loose = t.start("git gc");
		loose.end();
		root.end();
		t.flush();
		const spans = spansOf(readRequests(dir));
		const by = (n: string) => spans.find((s) => s.name === n);
		expect(by("crb serve")).toMatchObject({
			traceId: "0123456789abcdef0123456789abcdef",
			parent: "0011223344556677",
		});
		expect(by("POST /api/reviews")?.parent).toBe(root.context?.spanId);
		expect(by("git fetch")?.parent).toBe(outer.context?.spanId);
		expect(by("git gc")?.parent).toBe(root.context?.spanId);
		expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
	});

	it("a failing write never throws: it warns once and stops", () => {
		const dir = tempDir();
		const notADir = join(dir, "file");
		writeFileSync(notADir, "");
		const warn = vi.fn();
		const t = createTracer({
			dir: notADir,
			service: "x",
			flushOnExit: false,
			warn,
		});
		expect(() => {
			for (let i = 0; i < 600; i++) t.start(`s${i}`).end();
			t.flush();
			t.start("more").end();
			t.flush();
		}).not.toThrow();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toMatch(/trace write .* failed/);
	});

	it("is off in crb when $CRB_TRACE_DIR is unset", async () => {
		vi.stubEnv("CRB_TRACE_DIR", "");
		const key = Symbol.for("carbonless.tracer");
		const g = globalThis as Record<symbol, unknown>;
		const saved = g[key];
		delete g[key];
		vi.resetModules();
		try {
			const fresh = await import("./trace");
			expect(fresh.tracer().enabled).toBe(false);
			const { runGit } = await import("./git");
			// Runs git with tracing off: nothing to write, nothing in its way.
			await expect(runGit(process.cwd(), ["--version"])).resolves.toMatch(
				/git version/,
			);
			expect(fresh.tracer().start("x").context).toBeNull();
		} finally {
			g[key] = saved;
			vi.resetModules();
		}
	});
});

const MiB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Timers the test's fake clock drives, handed to the tracer (which uses
 * the real ones by default), each checked to be unref'd.
 */
function testTimers() {
	const unrefs: ReturnType<typeof vi.fn>[] = [];
	const timers = {
		setTimeout(fn: () => void, ms: number) {
			const handle = setTimeout(fn, ms);
			const unref = vi.fn(() => handle);
			unrefs.push(unref);
			return Object.assign(handle, { unref });
		},
		clearTimeout(handle: { unref?(): unknown }) {
			clearTimeout(handle as ReturnType<typeof setTimeout>);
		},
	};
	return { timers, unrefs };
}

describe("a long-running process's files", () => {
	it("writes a span a few seconds after it ends, by an unref'd timer", () => {
		vi.useFakeTimers();
		const dir = tempDir();
		const { timers, unrefs } = testTimers();
		const t = createTracer({
			dir,
			service: "crb",
			flushOnExit: false,
			timers,
		});
		t.start("GET /api/x").end();
		t.start("git fetch").end();
		vi.advanceTimersByTime(FLUSH_AFTER_MS - 1);
		expect(readdirSync(dir)).toEqual([]);
		vi.advanceTimersByTime(1);
		const names = spansOf(readRequests(dir)).map((s) => s.name);
		expect(names).toEqual(["GET /api/x", "git fetch"]);
		// One write for both; nothing pending after it.
		expect(vi.getTimerCount()).toBe(0);
		t.start("later").end();
		vi.advanceTimersByTime(FLUSH_AFTER_MS);
		expect(spansOf(readRequests(dir)).map((s) => s.name)).toContain("later");
		// Never keeps the process alive.
		expect(unrefs).toHaveLength(2);
		for (const unref of unrefs) expect(unref).toHaveBeenCalled();
	});

	it("uses the real timers: a test's fake clock neither sees nor holds them", async () => {
		vi.useFakeTimers();
		const dir = tempDir();
		const t = createTracer({
			dir,
			service: "crb",
			flushOnExit: false,
			flushAfterMs: 5,
		});
		t.start("a").end();
		expect(vi.getTimerCount()).toBe(0);
		vi.useRealTimers();
		await vi.waitFor(() =>
			expect(spansOf(readRequests(dir)).map((s) => s.name)).toEqual(["a"]),
		);
	});

	it("makes its directory again when it was deleted while running", () => {
		const dir = join(tempDir(), "traces");
		const warn = vi.fn();
		const t = createTracer({
			dir,
			service: "crb",
			flushOnExit: false,
			rotation: DEFAULT_ROTATION,
			warn,
		});
		t.start("before").end();
		t.flush();
		rmSync(dir, { recursive: true, force: true });
		t.start("after").end();
		t.flush();
		expect(warn).not.toHaveBeenCalled();
		expect(spansOf(readRequests(dir)).map((s) => s.name)).toEqual(["after"]);
	});

	it("rolls to a new file before one would pass the size limit", () => {
		const dir = tempDir();
		const t = createTracer({
			dir,
			service: "crb",
			flushOnExit: false,
			rotation: { ...DEFAULT_ROTATION, maxFileBytes: 1500 },
		});
		for (let i = 0; i < 12; i++) {
			t.start(`span ${i}`, { pad: "x".repeat(300) }).end();
			t.flush();
		}
		const files = readdirSync(dir).sort();
		expect(files.length).toBeGreaterThan(2);
		for (const f of files) {
			expect(f).toMatch(/^crb-\d+-[0-9a-f]{6}\.\d{8}\.\d{6}\.jsonl$/);
			expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(1500);
		}
		// One stem, numbered in order: nothing lost or reordered.
		expect(new Set(files.map((f) => f.split(".")[0])).size).toBe(1);
		expect(files.map((f) => f.split(".")[2])).toEqual(
			files.map((_, i) => String(i).padStart(6, "0")),
		);
		expect(spansOf(readRequests(dir)).map((s) => s.name)).toEqual(
			Array.from({ length: 12 }, (_, i) => `span ${i}`),
		);
	});

	it("rolls at the UTC day change", () => {
		let now = Date.parse("2026-11-24T23:59:58Z");
		const dir = tempDir();
		const t = createTracer({
			dir,
			service: "crb",
			flushOnExit: false,
			clock: () => now,
			rotation: DEFAULT_ROTATION,
		});
		t.start("before midnight").end();
		t.flush();
		now += 1000;
		t.start("still before").end();
		t.flush();
		now += 2000;
		t.start("after midnight").end();
		t.flush();
		const files = readdirSync(dir).sort();
		expect(files).toEqual([
			expect.stringMatching(/\.20261124\.000000\.jsonl$/),
			expect.stringMatching(/\.20261125\.000001\.jsonl$/),
		]);
		expect(readFileSync(join(dir, files[0] as string), "utf8")).toContain(
			"still before",
		);
		expect(readFileSync(join(dir, files[1] as string), "utf8")).toContain(
			"after midnight",
		);
	});

	it("rotate() switches a tracer on from its next write", () => {
		const dir = tempDir();
		const t = createTracer({ dir, service: "crb", flushOnExit: false });
		t.start("a").end();
		t.flush();
		t.rotate(DEFAULT_ROTATION);
		t.start("b").end();
		t.flush();
		const files = readdirSync(dir).sort();
		expect(files).toEqual([
			expect.stringMatching(/^crb-\d+-[0-9a-f]{6}\.\d{8}\.000000\.jsonl$/),
			expect.stringMatching(/^crb-\d+-[0-9a-f]{6}\.jsonl$/),
		]);
	});

	const old = (dir: string, name: string, size: number, ageMs: number) => {
		const path = join(dir, name);
		writeFileSync(path, "x".repeat(size));
		const t = new Date(Date.now() - ageMs);
		utimesSync(path, t, t);
	};

	it("deletes its service's files older than the days kept, at start", () => {
		const dir = tempDir();
		old(dir, "crb-1-aaaaaa.jsonl", 10, 20 * DAY);
		old(dir, "crb-2-bbbbbb.20261101.000.jsonl", 10, 15 * DAY);
		old(dir, "crb-3-cccccc.20261120.000.jsonl", 10, 4 * DAY);
		const t = createTracer({
			dir,
			service: "crb",
			flushOnExit: false,
			rotation: DEFAULT_ROTATION,
		});
		t.start("now").end();
		t.flush();
		const files = readdirSync(dir);
		expect(files).toHaveLength(2);
		expect(files).toEqual(
			expect.arrayContaining([
				"crb-3-cccccc.20261120.000.jsonl",
				expect.stringMatching(new RegExp(`^crb-${process.pid}-`)),
			]),
		);
	});

	it("deletes the oldest while its files pass the total cap, on rotation too", () => {
		const dir = tempDir();
		old(dir, "crb-1-aaaaaa.20261120.000.jsonl", 400, 4 * DAY);
		old(dir, "crb-1-aaaaaa.20261121.001.jsonl", 400, 3 * DAY);
		old(dir, "crb-2-bbbbbb.20261122.000.jsonl", 400, 2 * DAY);
		const t = createTracer({
			dir,
			service: "crb",
			flushOnExit: false,
			rotation: { maxFileBytes: 600, keepDays: 14, maxTotalBytes: 1000 },
		});
		t.start("first", { pad: "y".repeat(300) }).end();
		t.flush();
		// At start: 1200 bytes of old files > 1000, so the oldest went.
		expect(readdirSync(dir)).not.toContain("crb-1-aaaaaa.20261120.000.jsonl");
		expect(readdirSync(dir)).toContain("crb-1-aaaaaa.20261121.001.jsonl");
		t.start("second", { pad: "y".repeat(300) }).end();
		t.flush();
		// A rotation: the next oldest goes, never the file being written.
		const files = readdirSync(dir).sort();
		expect(files).not.toContain("crb-1-aaaaaa.20261121.001.jsonl");
		expect(
			files.filter((f) => f.startsWith(`crb-${process.pid}-`)),
		).toHaveLength(2);
	});

	it("never touches files it didn't write: other services, test runs, packs", () => {
		const dir = tempDir();
		const foreign = [
			"fake-gh-1-aaaaaa.jsonl",
			"crb-client-2-bbbbbb.jsonl",
			"vitest-3-cccccc.jsonl",
			"packed-4-dddddddd.jsonl.gz",
			"crb-5-eeeeee.jsonl.packing-6-ffffffff",
			"notes.txt",
		];
		for (const f of foreign) old(dir, f, 5000, 100 * DAY);
		const deleted = pruneTraces(
			dir,
			"crb",
			{ maxFileBytes: 100, keepDays: 1, maxTotalBytes: 1 },
			Date.now(),
		);
		expect(deleted).toEqual([]);
		expect(readdirSync(dir).sort()).toEqual([...foreign].sort());
		expect(isServiceFile("crb", "crb-5-eeeeee.jsonl")).toBe(true);
		expect(isServiceFile("crb", "crb-5-eeeeee.20261124.012.jsonl")).toBe(true);
		expect(isServiceFile("crb", "crb-client-5-eeeeee.jsonl")).toBe(false);
	});

	it("a write failure on a rotating tracer still warns once and stops", () => {
		vi.useFakeTimers();
		const dir = tempDir();
		const notADir = join(dir, "file");
		writeFileSync(notADir, "");
		const warn = vi.fn();
		const t = createTracer({
			dir: notADir,
			service: "crb",
			flushOnExit: false,
			rotation: DEFAULT_ROTATION,
			warn,
			timers: testTimers().timers,
		});
		expect(() => {
			t.start("a").end();
			vi.advanceTimersByTime(FLUSH_AFTER_MS);
			t.start("b").end();
			vi.advanceTimersByTime(FLUSH_AFTER_MS);
			t.flush();
		}).not.toThrow();
		expect(warn).toHaveBeenCalledTimes(1);
		// Stopped: no timer left waiting for spans that go nowhere.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("the disabled tracer starts no timer and writes nothing", () => {
		vi.useFakeTimers();
		const t = createTracer({
			dir: "",
			service: "crb",
			timers: testTimers().timers,
		});
		t.rotate(DEFAULT_ROTATION);
		t.start("a").end();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("takes rotation from the environment, defaults for what's unset or bad", () => {
		expect(rotationFromEnv({})).toEqual(DEFAULT_ROTATION);
		expect(
			rotationFromEnv({
				CRB_TRACE_FILE_MB: "8",
				CRB_TRACE_KEEP_DAYS: "3",
				CRB_TRACE_MAX_MB: "abc",
			}),
		).toEqual({
			maxFileBytes: 8 * MiB,
			keepDays: 3,
			maxTotalBytes: DEFAULT_ROTATION.maxTotalBytes,
		});
		expect(rotationFromEnv({ CRB_TRACE_KEEP_DAYS: "-1" }).keepDays).toBe(14);
	});

	it("raises tiny settings to a floor: 1 MiB files, a day, one file in all", () => {
		expect(
			rotationFromEnv({
				CRB_TRACE_FILE_MB: "0.0000001",
				CRB_TRACE_KEEP_DAYS: "0.01",
				CRB_TRACE_MAX_MB: "0.5",
			}),
		).toEqual({ maxFileBytes: MiB, keepDays: 1, maxTotalBytes: MiB });
		expect(
			rotationFromEnv({ CRB_TRACE_FILE_MB: "64", CRB_TRACE_MAX_MB: "10" }),
		).toEqual({
			maxFileBytes: 64 * MiB,
			keepDays: 14,
			maxTotalBytes: 64 * MiB,
		});
	});

	it("prunes at start, before anything is written", () => {
		const dir = tempDir();
		old(dir, "crb-1-aaaaaa.20261101.000000.jsonl", 10, 20 * DAY);
		const t = createTracer({ dir, service: "crb", flushOnExit: false });
		t.rotate(DEFAULT_ROTATION);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("the cap never deletes a file written in the last minutes (another live crb's)", () => {
		const dir = tempDir();
		old(dir, "crb-1-aaaaaa.20261124.000000.jsonl", 600, 60_000);
		old(dir, "crb-2-bbbbbb.20261123.000000.jsonl", 600, DAY);
		const deleted = pruneTraces(
			dir,
			"crb",
			{ maxFileBytes: 100, keepDays: 14, maxTotalBytes: 100 },
			Date.now(),
		);
		expect(deleted).toEqual(["crb-2-bbbbbb.20261123.000000.jsonl"]);
		expect(readdirSync(dir)).toEqual(["crb-1-aaaaaa.20261124.000000.jsonl"]);
	});
});

describe("traceparent", () => {
	it("round-trips and rejects anything else", () => {
		const ctx = parseTraceparent(PARENT);
		expect(ctx).toEqual({
			traceId: "0123456789abcdef0123456789abcdef",
			spanId: "0011223344556677",
		});
		expect(traceparent(ctx as never)).toBe(PARENT);
		expect(parseTraceparent("garbage")).toBeNull();
		expect(parseTraceparent(undefined)).toBeNull();
	});

	it("keeps sub-millisecond time in nanoseconds", () => {
		expect(toNanos(1_700_000_000_123.25)).toBe("1700000000123250000");
		expect(toNanos(5)).toBe("5000000");
	});
});

describe("the fake gh's span (test/fake-gh/trace.mjs)", () => {
	it("is a span like trace.ts writes, under $TRACEPARENT, with its exit code", () => {
		const dir = tempDir();
		const script = resolve(import.meta.dirname, "../../test/fake-gh/trace.mjs");
		const code = `const { traceCall } = await import(${JSON.stringify(script)}); traceCall(["pr", "view", "7", "--json", "x".repeat(80)]); process.exitCode = 3;`;
		expect(() =>
			execFileSync(process.execPath, ["--input-type=module", "-e", code], {
				env: { ...process.env, CRB_TRACE_DIR: dir, TRACEPARENT: PARENT },
				stdio: "ignore",
			}),
		).toThrow();
		expect(readdirSync(dir)).toEqual([
			expect.stringMatching(/^fake-gh-\d+-[0-9a-f]{6}\.jsonl$/),
		]);
		const [span, ...rest] = spansOf(readRequests(dir));
		expect(rest).toEqual([]);
		expect(span).toMatchObject({
			traceId: "0123456789abcdef0123456789abcdef",
			parent: "0011223344556677",
			name: "fake gh pr view",
			service: "fake-gh",
			attrs: {
				exit: 3,
				args: expect.stringMatching(/^pr view 7 --json x{39}…$/),
			},
		});
		expect(span?.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(span?.endMs).toBeGreaterThanOrEqual(span?.startMs ?? Infinity);
	});
});
