import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRequests, spansOf } from "../../scripts/test-profile/load";
import { createTracer, parseTraceparent, toNanos, traceparent } from "./trace";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "crb-trace-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	vi.unstubAllEnvs();
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
			await new Promise((r) => setTimeout(r, 1));
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
