import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";
import {
	BROWSER_SERVICE,
	Budgets,
	FUTURE_MS,
	MAX_ATTRS,
	MAX_SPANS,
	MAX_STRING,
	PAST_MS,
	PageClocks,
	readBatch,
	registerBrowserTrace,
	SKEW_MS,
	SpanBudget,
	TRACE_META,
} from "./browserTrace";
import { SessionRegistry } from "./registry";
import { createTracer } from "./trace";

const NOW = 1_800_000_000_000;
const TRACE = "0123456789abcdef0123456789abcdef";
const span = (over: Record<string, unknown> = {}) => ({
	name: "browser.fetch",
	traceId: TRACE,
	spanId: "0011223344556677",
	parentSpanId: "8899aabbccddeeff",
	startMs: NOW - 100,
	endMs: NOW - 50,
	attrs: { api: "/api/r/:id/review", status: 200 },
	...over,
});

describe("readBatch", () => {
	it("keeps a well-formed span as the tracer records it", () => {
		const batch = readBatch({ spans: [span()], sentAt: NOW }, NOW);
		expect(batch).toEqual({
			dropped: 0,
			doc: null,
			lost: 0,
			spans: [
				{
					name: "browser.fetch",
					context: { traceId: TRACE, spanId: "0011223344556677" },
					parent: { traceId: TRACE, spanId: "8899aabbccddeeff" },
					startMs: NOW - 100,
					endMs: NOW - 50,
					attrs: { api: "/api/r/:id/review", status: 200 },
					kind: "client",
					service: BROWSER_SERVICE,
				},
			],
		});
	});

	it("reads a beacon's text body; refuses what isn't a batch", () => {
		expect(
			readBatch(JSON.stringify({ spans: [span()] }), NOW)?.spans,
		).toHaveLength(1);
		for (const body of [
			"{not json",
			null,
			42,
			"[]",
			{},
			{ spans: "x" },
			{ spans: {} },
		]) {
			expect(readBatch(body, NOW), JSON.stringify(body)).toBeNull();
		}
	});

	it("drops spans of unknown names, bad ids and bad times, keeping the rest", () => {
		const bad = [
			span({ name: "evil" }),
			span({ name: "browser.anything" }),
			span({ name: 7 }),
			span({ traceId: "nothex".padEnd(32, "z") }),
			span({ traceId: "0".repeat(32) }),
			span({ spanId: "abc" }),
			span({ parentSpanId: "<script>" }),
			span({ startMs: "soon" }),
			span({ endMs: Number.NaN }),
			span({ startMs: Number.POSITIVE_INFINITY }),
			null,
			"x",
			[],
		];
		const batch = readBatch({ spans: [...bad, span()] }, NOW);
		expect(batch?.spans).toHaveLength(1);
		expect(batch?.dropped).toBe(bad.length);
	});

	it("coerces ids to lowercase; a span with no parent is a root", () => {
		const [s] =
			readBatch(
				{
					spans: [
						span({
							name: "browser.navigation",
							traceId: TRACE.toUpperCase(),
							parentSpanId: undefined,
						}),
					],
				},
				NOW,
			)?.spans ?? [];
		expect(s?.context.traceId).toBe(TRACE);
		expect(s?.parent).toBeNull();
		expect(s?.kind).toBe("internal");
	});

	it("caps a batch at MAX_SPANS", () => {
		const spans = Array.from({ length: MAX_SPANS + 50 }, () => span());
		const batch = readBatch({ spans }, NOW);
		expect(batch?.spans).toHaveLength(MAX_SPANS);
		expect(batch?.dropped).toBe(50);
	});

	it("clamps times near now, and an end before its start to the start", () => {
		const [early, late, backwards] =
			readBatch(
				{
					spans: [
						span({ startMs: 0, endMs: 1 }),
						span({ startMs: NOW + 1e12, endMs: NOW + 2e12 }),
						span({ startMs: NOW - 10, endMs: NOW - 500 }),
					],
				},
				NOW,
			)?.spans ?? [];
		expect(early).toMatchObject({
			startMs: NOW - PAST_MS,
			endMs: NOW - PAST_MS,
		});
		expect(late).toMatchObject({
			startMs: NOW + FUTURE_MS,
			endMs: NOW + FUTURE_MS,
		});
		expect(backwards).toMatchObject({ startMs: NOW - 10, endMs: NOW - 10 });
	});

	it("moves a page clock off by more than SKEW_MS onto the server's (900 ms)", () => {
		const off = 900;
		const latency = 5;
		const [s] =
			readBatch(
				{
					spans: [span({ startMs: NOW - off - 100, endMs: NOW - off - 50 })],
					sentAt: NOW - off - latency,
					doc: TRACE,
				},
				NOW,
			)?.spans ?? [];
		expect(s).toMatchObject({
			startMs: NOW - 100 + latency,
			endMs: NOW - 50 + latency,
		});
		// A few ms off is the request's own way: left alone.
		const [near] =
			readBatch(
				{ spans: [span()], sentAt: NOW - SKEW_MS + 10, doc: TRACE },
				NOW,
			)?.spans ?? [];
		expect(near?.startMs).toBe(NOW - 100);
	});

	it("a page's smallest offset wins: a batch held up never moves spans before their server children", () => {
		const clocks = new PageClocks();
		// The page's /review request reached the server 3 ms after the page
		// started it: its clock is right.
		const fetchStart = NOW - 20_000;
		clocks.arrived("0011223344556677", fetchStart + 3);
		// Its batch is held up 10 s (a reconnect): sentAt is 10 s behind.
		const [s] =
			readBatch(
				{
					spans: [span({ startMs: fetchStart, endMs: fetchStart + 40 })],
					sentAt: NOW - 10_000,
					doc: TRACE,
				},
				NOW,
				clocks,
			)?.spans ?? [];
		// Not moved: the server's child (at fetchStart + 3) stays inside it.
		expect(s?.startMs).toBe(fetchStart);
		expect(s?.startMs).toBeLessThanOrEqual(fetchStart + 3);
		// Two batches of one page, 10 s and 50 ms late: both by the 50 ms.
		const later = new PageClocks();
		const at = (sentLate: number, n: string) =>
			readBatch(
				{
					spans: [span({ spanId: n.repeat(16) })],
					sentAt: NOW - sentLate,
					doc: TRACE,
				},
				NOW,
				later,
			)?.spans[0]?.startMs;
		at(50, "1");
		expect(at(10_000, "2")).toBe(NOW - 100 + 50);
		// Another page has its own offset.
		const [other] =
			readBatch(
				{
					spans: [span()],
					sentAt: NOW - 10_000,
					doc: "f".repeat(32),
				},
				NOW,
				later,
			)?.spans ?? [];
		expect(other?.startMs).toBe(NOW - 100 + 10_000);
	});

	it("keeps few, short, plain attributes", () => {
		const many = Object.fromEntries(
			Array.from({ length: MAX_ATTRS + 10 }, (_, i) => [`k${i}`, i]),
		);
		const [s] =
			readBatch(
				{
					spans: [
						span({
							attrs: {
								long: "x".repeat(5000),
								ctl: "a\u0000b\nc\u001bd",
								"Bad Key": 1,
								["k".repeat(80)]: 1,
								obj: { a: 1 },
								arr: [1],
								nan: Number.NaN,
								ok: true,
								...many,
							},
						}),
						span({ attrs: "nope" }),
					],
				},
				NOW,
			)?.spans ?? [];
		const attrs = s?.attrs ?? {};
		expect(Object.keys(attrs)).toHaveLength(MAX_ATTRS);
		expect(String(attrs.long)).toHaveLength(MAX_STRING);
		expect(attrs.ctl).toBe("a b c d");
		for (const key of ["Bad Key", "k".repeat(80), "obj", "arr", "nan"]) {
			expect(attrs).not.toHaveProperty(key);
		}
		expect(attrs.ok).toBe(true);
	});

	it("after a sleep (the page's clock stood still for an hour) the page is placed again", () => {
		const clocks = new PageClocks();
		// Before: the page's clock was right.
		readBatch({ spans: [span()], sentAt: NOW - 5, doc: TRACE }, NOW, clocks);
		expect(clocks.offset(TRACE)).toBe(5);
		// An hour later by the server; the page's clock lags an hour. Its
		// /review request reached the server 3 ms after the page started it.
		const later = NOW + 3_600_000;
		const lag = 3_600_000;
		const fetchStart = later - lag - 2000;
		clocks.arrived("0011223344556677", fetchStart + lag + 3);
		const [s] =
			readBatch(
				{
					spans: [span({ startMs: fetchStart, endMs: fetchStart + 40 })],
					// Sent 10 ms before it arrived.
					sentAt: later - lag - 10,
					doc: TRACE,
				},
				later,
				clocks,
			)?.spans ?? [];
		// Moved by the hour: its server child (at arrival) lands inside it.
		expect(s?.startMs).toBe(fetchStart + lag + 3);
		expect(s?.endMs).toBeGreaterThanOrEqual(fetchStart + lag + 3);
	});

	it("a malformed doc or a non-finite sentAt leaves the clocks alone", () => {
		const clocks = new PageClocks();
		for (const body of [
			{ spans: [span()], sentAt: NOW - 50_000, doc: "nope" },
			{ spans: [span()], sentAt: Number.POSITIVE_INFINITY, doc: TRACE },
			{ spans: [span()], sentAt: "soon", doc: TRACE },
		]) {
			const [s] = readBatch(body, NOW, clocks)?.spans ?? [];
			expect(s?.startMs).toBe(NOW - 100);
		}
		expect(clocks.offset(TRACE)).toBeUndefined();
	});

	it("cuts on code points, never half a surrogate pair", () => {
		const [s] =
			readBatch(
				{ spans: [span({ attrs: { e: "😀".repeat(MAX_STRING + 5) } })] },
				NOW,
			)?.spans ?? [];
		const cut = String(s?.attrs?.e);
		expect(Array.from(cut)).toHaveLength(MAX_STRING);
		expect(cut.endsWith("😀…")).toBe(true);
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
	});

	it("keeps an error, cleaned and short", () => {
		const [s] =
			readBatch({ spans: [span({ error: `x\n${"y".repeat(900)}` })] }, NOW)
				?.spans ?? [];
		expect(s?.error).toHaveLength(MAX_STRING);
		expect(s?.error?.startsWith("x y")).toBe(true);
	});
});

describe("POST /api/trace and the page's meta", () => {
	let dir: string;
	let web: string;
	let registry: SessionRegistry;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-browser-trace-"));
		web = mkdtempSync(join(tmpdir(), "crb-web-"));
		writeFileSync(
			join(web, "index.html"),
			"<html><head><title>t</title></head><body>spa</body></html>",
		);
		registry = new SessionRegistry();
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await registry.closeAll();
		rmSync(dir, { recursive: true, force: true });
		rmSync(web, { recursive: true, force: true });
	});

	interface Written {
		name: string;
		traceId: string;
		spanId: string;
		parentSpanId?: string;
		service: string;
		attributes: { key: string; value: Record<string, unknown> }[];
	}
	const written = (): Written[] =>
		readdirSync(dir).flatMap((f) =>
			readFileSync(join(dir, f), "utf8")
				.trim()
				.split("\n")
				.flatMap((line) =>
					(
						JSON.parse(line).resourceSpans as {
							resource: {
								attributes: { key: string; value: { stringValue?: string } }[];
							};
							scopeSpans: { spans: Omit<Written, "service">[] }[];
						}[]
					).flatMap((r) => {
						const service =
							r.resource.attributes.find((a) => a.key === "service.name")?.value
								.stringValue ?? "";
						return r.scopeSpans.flatMap((sc) =>
							sc.spans.map((x) => ({ ...x, service })),
						);
					}),
				),
		);
	const host = { host: "127.0.0.1" };

	it("tracing: the page has the meta, and a batch lands in the trace file", async () => {
		// test/setup.ts turns them off for every other test.
		vi.stubEnv("CRB_TRACE_BROWSER", "1");
		const tracer = createTracer({ dir, service: "crb", flushOnExit: false });
		const app = await buildApp(registry, {
			accessKey: "k3y",
			tracer,
			webRoot: web,
		});
		try {
			for (const url of [
				"/?key=k3y",
				"/r/abc/files?key=k3y",
				// A client route whose last segment has a dot: a page too.
				"/pr/acme/next.js?key=k3y",
			]) {
				const page = await app.inject({
					url,
					headers: {
						...host,
						accept: "text/html",
						"if-none-match": "*",
						"if-modified-since": new Date().toUTCString(),
					},
				});
				expect(page.statusCode, url).not.toBe(304);
				// Fresh each time, yet kept for back/forward (no-store isn't).
				expect(page.headers["cache-control"], url).toBe("no-cache");
				expect(page.headers["content-type"], url).toMatch(/text\/html/);
				expect(page.body, url).toContain(`${TRACE_META}</head>`);
				expect(page.headers.etag, url).toBeUndefined();
			}
			// The key guards it like any route.
			const locked = await app.inject({
				method: "POST",
				url: "/api/trace",
				headers: host,
				payload: { spans: [span()] },
			});
			expect(locked.statusCode).toBe(401);
			const res = await app.inject({
				method: "POST",
				url: "/api/trace?key=k3y",
				headers: host,
				payload: {
					spans: [span(), span({ name: "nope" })],
					sentAt: Date.now(),
				},
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({ kept: 1, dropped: 1 });
			// A beacon's text/plain body.
			const beacon = await app.inject({
				method: "POST",
				url: "/api/trace?key=k3y",
				headers: { ...host, "content-type": "text/plain;charset=UTF-8" },
				payload: JSON.stringify({
					spans: [span({ spanId: "1111111111111111" })],
				}),
			});
			expect(beacon.json()).toEqual({ kept: 1, dropped: 0 });
			const bad = await app.inject({
				method: "POST",
				url: "/api/trace?key=k3y",
				headers: { ...host, "content-type": "text/plain" },
				payload: "garbage",
			});
			expect(bad.statusCode).toBe(400);
			const huge = await app.inject({
				method: "POST",
				url: "/api/trace?key=k3y",
				headers: host,
				payload: { spans: [span({ attrs: { a: "x".repeat(400_000) } })] },
			});
			expect(huge.statusCode).toBe(413);
		} finally {
			await app.close();
		}
		// Its own posts aren't traced: a span each would trace the tracing.
		expect(written().some((s) => s.name === "POST /api/trace")).toBe(false);
		const spans = written().filter((s) => s.name === "browser.fetch");
		expect(spans.map((s) => s.spanId).sort()).toEqual([
			"0011223344556677",
			"1111111111111111",
		]);
		expect(spans[0]).toMatchObject({
			traceId: TRACE,
			parentSpanId: "8899aabbccddeeff",
		});
		// The page's spans are a service of their own beside the server's.
		expect(new Set(spans.map((x) => x.service))).toEqual(
			new Set([BROWSER_SERVICE]),
		);
	});

	it("caps the spans a minute it keeps (429 past it)", async () => {
		vi.stubEnv("CRB_TRACE_BROWSER", "1");
		const tracer = createTracer({ dir, service: "crb", flushOnExit: false });
		const { default: Fastify } = await import("fastify");
		const app = Fastify();
		let now = NOW;
		registerBrowserTrace(app, tracer, {
			now: () => now,
			budget: new Budgets(new SpanBudget(3, 60_000)),
		});
		const post = (n: number) =>
			app.inject({
				method: "POST",
				url: "/api/trace",
				payload: {
					spans: Array.from({ length: n }, (_, i) =>
						span({ spanId: `${i + 1}`.padStart(16, "a") }),
					),
				},
			});
		try {
			expect((await post(2)).statusCode).toBe(200);
			expect((await post(2)).statusCode).toBe(429);
			expect((await post(1)).statusCode).toBe(200);
			now += 60_000;
			expect((await post(3)).statusCode).toBe(200);
		} finally {
			await app.close();
		}
	});

	it("caps one page load apart: a tab in a loop can't starve the others", async () => {
		vi.stubEnv("CRB_TRACE_BROWSER", "1");
		const tracer = createTracer({ dir, service: "crb", flushOnExit: false });
		const { default: Fastify } = await import("fastify");
		const app = Fastify();
		registerBrowserTrace(app, tracer, {
			now: () => NOW,
			budget: new Budgets(
				new SpanBudget(100, 60_000),
				() => new SpanBudget(2, 60_000),
			),
		});
		const post = (doc: string) =>
			app.inject({
				method: "POST",
				url: "/api/trace",
				payload: { doc, spans: [span(), span({ spanId: "2".repeat(16) })] },
			});
		try {
			expect((await post("a".repeat(32))).statusCode).toBe(200);
			expect((await post("a".repeat(32))).statusCode).toBe(429);
			expect((await post("b".repeat(32))).statusCode).toBe(200);
		} finally {
			await app.close();
		}
	});

	it("what the page says it lost (turned away) is one span, so the gap shows", async () => {
		vi.stubEnv("CRB_TRACE_BROWSER", "1");
		const tracer = createTracer({ dir, service: "crb", flushOnExit: false });
		const { default: Fastify } = await import("fastify");
		const app = Fastify();
		registerBrowserTrace(app, tracer, { now: () => NOW });
		try {
			const res = await app.inject({
				method: "POST",
				url: "/api/trace",
				payload: { doc: TRACE, dropped: 37, spans: [] },
			});
			expect(res.statusCode).toBe(200);
			// Nonsense counts are no count.
			for (const dropped of [-1, 1.5, "9", 1e300]) {
				await app.inject({
					method: "POST",
					url: "/api/trace",
					payload: { doc: TRACE, dropped, spans: [] },
				});
			}
		} finally {
			await app.close();
		}
		const lost = written().filter((x) => x.name === "browser.dropped");
		expect(lost).toHaveLength(1);
		expect(lost[0]).toMatchObject({ traceId: TRACE, service: BROWSER_SERVICE });
		expect(lost[0]?.attributes).toEqual([
			{ key: "count", value: { intValue: 37 } },
		]);
	});

	it("not tracing: no meta, no route", async () => {
		const tracer = createTracer({ dir: undefined, service: "crb" });
		const app = await buildApp(registry, {
			accessKey: "k3y",
			tracer,
			webRoot: web,
		});
		try {
			const page = await app.inject({ url: "/?key=k3y", headers: host });
			expect(page.body).toContain("spa");
			expect(page.body).not.toContain("crb-trace");
			const res = await app.inject({
				method: "POST",
				url: "/api/trace?key=k3y",
				headers: host,
				payload: { spans: [span()] },
			});
			expect(res.statusCode).toBe(404);
		} finally {
			await app.close();
		}
	});

	it("tracing with $CRB_TRACE_BROWSER=0: no meta, no route", async () => {
		vi.stubEnv("CRB_TRACE_BROWSER", "0");
		const tracer = createTracer({ dir, service: "crb", flushOnExit: false });
		const app = await buildApp(registry, {
			accessKey: "k3y",
			tracer,
			webRoot: web,
		});
		try {
			const page = await app.inject({ url: "/?key=k3y", headers: host });
			expect(page.body).not.toContain("crb-trace");
			const res = await app.inject({
				method: "POST",
				url: "/api/trace?key=k3y",
				headers: host,
				payload: { spans: [span()] },
			});
			expect(res.statusCode).toBe(404);
		} finally {
			await app.close();
		}
	});
});
