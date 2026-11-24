import type { FastifyInstance } from "fastify";
import {
	type Attrs,
	parseTraceparent,
	type RecordedSpan,
	type Tracer,
} from "./trace.js";

/*
 * The page's own spans (CAR-288, docs/test-profiling.md "Browser spans"):
 * when crb serve traces ($CRB_TRACE_DIR, and $CRB_TRACE_BROWSER isn't "0"),
 * the page it serves carries a `crb-trace` meta, records what the reviewer
 * waits for (src/web/trace/) and POSTs it here in batches; they go into the
 * server's trace file through the tracer's `record`, beside the request
 * spans its `traceparent` headers parent. Off, the route doesn't exist and
 * the page carries no meta: no requests, no cost.
 *
 * The body is anyone's input (any page holding the key): only known span
 * names, checked ids, timestamps clamped near now, a few short attributes,
 * at most MAX_SPANS a batch. A span that fails a check is dropped, never
 * the batch's others.
 */

/** The names the page may send (src/web/trace/collector.ts). */
export const BROWSER_SPANS: ReadonlySet<string> = new Set([
	"browser.navigation",
	"browser.page",
	"browser.fetch",
	"browser.ui.header",
	"browser.ui.diff_rows",
	"browser.ui.first_file",
	"browser.ui.threads",
	"browser.ui.threads_code",
	"browser.ui.home_rows",
	"browser.ui.home_done",
	"browser.ui.repo_rows",
	"browser.ui.repo_done",
	"browser.longtask",
	"browser.layout_shift",
	"browser.lcp",
]);

export const MAX_SPANS = 200;
export const MAX_ATTRS = 16;
export const MAX_STRING = 200;
/** The route's own body limit (a full batch is ~60 KB). */
export const BODY_LIMIT = 256 * 1024;
/** How far from the server's now a span may lie: a day back, a minute on. */
export const PAST_MS = 24 * 60 * 60 * 1000;
export const FUTURE_MS = 60 * 1000;
/** A page clock further off than this is moved onto the server's. */
export const SKEW_MS = 30;
/** Pages (documents) whose clock offset is kept, and requests' arrivals. */
export const CLOCK_PAGES = 256;
export const CLOCK_ARRIVALS = 4096;
/** The most spans a minute the route keeps (several tabs, a page in a loop). */
export const RATE_SPANS = 3000;
export const RATE_WINDOW_MS = 60_000;

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ATTR_KEY = /^[a-z][a-z0-9_.]{0,39}$/;
// Control characters (a log line's or a terminal's), never kept.
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** A W3C id as the page sent it, lowercased; null unless valid and not all zeros. */
function id(value: unknown, shape: RegExp): string | null {
	if (typeof value !== "string") return null;
	const v = value.toLowerCase();
	return shape.test(v) && /[^0]/.test(v) ? v : null;
}

/** `value` cleaned and cut to MAX_STRING code points (never half a pair). */
function text(value: string): string {
	const points = Array.from(value.replace(CONTROL, " "));
	return points.length > MAX_STRING
		? `${points.slice(0, MAX_STRING - 1).join("")}…`
		: points.join("");
}

/** A map that forgets its oldest entries past `cap`. */
class Lru<V> {
	#map = new Map<string, V>();
	constructor(readonly cap: number) {}
	get(key: string): V | undefined {
		return this.#map.get(key);
	}
	set(key: string, value: V): void {
		this.#map.delete(key);
		this.#map.set(key, value);
		if (this.#map.size > this.cap) {
			const oldest = this.#map.keys().next().value;
			if (oldest !== undefined) this.#map.delete(oldest);
		}
	}
}

/**
 * The page clocks' offsets from the server's. Each estimate is the
 * server's time minus the page's for one event the page timed and the
 * server saw arrive: a batch (its `sentAt`) or a traced request (its
 * `browser.fetch` span's start). Latency only ever adds to an estimate,
 * so the smallest one seen for a page is its best: a batch held up for
 * seconds never moves spans that a quick request already placed.
 */
export class PageClocks {
	#offsets = new Lru<number>(CLOCK_PAGES);
	#arrivals = new Lru<number>(CLOCK_ARRIVALS);

	/** A request carrying the page's span `spanId` arrived at `at`. */
	arrived(spanId: string, at: number): void {
		this.#arrivals.set(spanId, at);
	}

	/** When a request of the page's span `spanId` arrived, if seen. */
	arrival(spanId: string): number | undefined {
		return this.#arrivals.get(spanId);
	}

	/** Takes an estimate for page `doc`; its best offset so far. */
	estimate(doc: string, offset: number): number {
		const best = Math.min(this.#offsets.get(doc) ?? offset, offset);
		this.#offsets.set(doc, best);
		return best;
	}

	/** The best offset known for page `doc`. */
	offset(doc: string): number | undefined {
		return this.#offsets.get(doc);
	}
}

function attrs(value: unknown): Attrs | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const out: Attrs = {};
	let n = 0;
	for (const [key, v] of Object.entries(value)) {
		if (n >= MAX_ATTRS) break;
		if (!ATTR_KEY.test(key)) continue;
		if (typeof v === "string") out[key] = text(v);
		else if (typeof v === "boolean") out[key] = v;
		else if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
		else continue;
		n++;
	}
	return n > 0 ? out : undefined;
}

export interface Batch {
	spans: RecordedSpan[];
	/** Spans the batch had that weren't kept (bad, unknown, over the cap). */
	dropped: number;
}

/**
 * The spans of a batch `body` worth keeping, at the server's `now`
 * (epoch ms); null when the body isn't a batch at all. The page's clock is
 * moved onto the server's by its page's best offset (PageClocks), when
 * that is more than SKEW_MS.
 */
export function readBatch(
	body: unknown,
	now: number,
	clocks: PageClocks = new PageClocks(),
): Batch | null {
	let value = body;
	if (typeof value === "string" || Buffer.isBuffer(value)) {
		try {
			value = JSON.parse(String(value));
		} catch {
			return null;
		}
	}
	if (typeof value !== "object" || value === null) return null;
	const { spans, sentAt, doc } = value as {
		spans?: unknown;
		sentAt?: unknown;
		doc?: unknown;
	};
	if (!Array.isArray(spans)) return null;
	const page = id(doc, TRACE_ID);
	let shift = 0;
	if (page) {
		if (typeof sentAt === "number" && Number.isFinite(sentAt)) {
			clocks.estimate(page, now - sentAt);
		}
		for (const raw of spans.slice(0, MAX_SPANS)) {
			const s = raw as Record<string, unknown> | null;
			if (s?.name !== "browser.fetch" || typeof s.startMs !== "number")
				continue;
			const spanId = id(s.spanId, SPAN_ID);
			const at = spanId ? clocks.arrival(spanId) : undefined;
			if (at !== undefined && Number.isFinite(s.startMs)) {
				clocks.estimate(page, at - s.startMs);
			}
		}
		const best = clocks.offset(page) ?? 0;
		shift = Math.abs(best) > SKEW_MS ? best : 0;
	}
	const clamp = (ms: number) =>
		Math.min(now + FUTURE_MS, Math.max(now - PAST_MS, ms + shift));
	const out: RecordedSpan[] = [];
	for (const raw of spans.slice(0, MAX_SPANS)) {
		if (typeof raw !== "object" || raw === null) continue;
		const s = raw as Record<string, unknown>;
		if (typeof s.name !== "string" || !BROWSER_SPANS.has(s.name)) continue;
		const traceId = id(s.traceId, TRACE_ID);
		const spanId = id(s.spanId, SPAN_ID);
		if (!traceId || !spanId) continue;
		const parentId =
			s.parentSpanId === undefined ? null : id(s.parentSpanId, SPAN_ID);
		if (s.parentSpanId !== undefined && !parentId) continue;
		if (typeof s.startMs !== "number" || !Number.isFinite(s.startMs)) continue;
		if (typeof s.endMs !== "number" || !Number.isFinite(s.endMs)) continue;
		const startMs = clamp(s.startMs);
		const endMs = Math.max(startMs, clamp(s.endMs));
		const a = attrs(s.attrs);
		out.push({
			name: s.name,
			context: { traceId, spanId },
			parent: parentId ? { traceId, spanId: parentId } : null,
			startMs,
			endMs,
			...(a ? { attrs: a } : {}),
			...(typeof s.error === "string" && s.error
				? { error: text(s.error) }
				: {}),
			kind: s.name === "browser.fetch" ? "client" : "internal",
		});
	}
	return { spans: out, dropped: spans.length - out.length };
}

/** Whether the page records spans: the server traces, and they aren't turned off. */
export function browserTraceOn(traced: Tracer): boolean {
	return traced.enabled && process.env.CRB_TRACE_BROWSER !== "0";
}

/** The meta that turns the page's spans on (src/web/trace/collector.ts). */
export const TRACE_META = '<meta name="crb-trace" content="1">';

const isApi = (url: string) => {
	const path = url.split("?")[0] ?? "";
	return /^\/api(\/|$)/.test(path) || path === "/mcp";
};

/**
 * Whether a GET may be answered with a page: a navigation (it accepts
 * HTML), or an address that names no file. Hashed assets keep their
 * caching.
 */
const mayBePage = (url: string, accept: string | undefined) => {
	if (isApi(url)) return false;
	if (accept?.includes("text/html")) return true;
	const path = url.split("?")[0] ?? "";
	const last = path.slice(path.lastIndexOf("/") + 1);
	return !last.includes(".") || last === "index.html";
};

/** A fixed window's span budget (RATE_SPANS a RATE_WINDOW_MS). */
export class SpanBudget {
	#start = 0;
	#used = 0;
	constructor(
		readonly spans: number = RATE_SPANS,
		readonly windowMs: number = RATE_WINDOW_MS,
	) {}
	/** Takes `n` at `now`; false when the window's budget is spent. */
	take(n: number, now: number): boolean {
		if (now - this.#start >= this.windowMs) {
			this.#start = now;
			this.#used = 0;
		}
		if (this.#used + n > this.spans) return false;
		this.#used += n;
		return true;
	}
}

async function readAll(payload: unknown): Promise<string | null> {
	if (typeof payload === "string") return payload;
	if (Buffer.isBuffer(payload)) return payload.toString("utf8");
	if (
		payload &&
		typeof (payload as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
			"function"
	) {
		const chunks: Buffer[] = [];
		for await (const chunk of payload as AsyncIterable<Buffer | string>) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		}
		return Buffer.concat(chunks).toString("utf8");
	}
	return null;
}

/**
 * POST /api/trace, and the `crb-trace` meta in every page the server
 * answers (its index.html, however it is reached); nothing when off.
 * Registered after the host and key checks: they guard it like any route.
 */
export function registerBrowserTrace(
	app: FastifyInstance,
	traced: Tracer,
	opts: { now?: () => number; budget?: SpanBudget; clocks?: PageClocks } = {},
): void {
	const now = opts.now ?? Date.now;
	const budget = opts.budget ?? new SpanBudget();
	const clocks = opts.clocks ?? new PageClocks();
	app.addHook("onRequest", async (request) => {
		// A page a browser kept from before tracing has no meta: while
		// tracing, a page is never answered "not modified".
		const accept = request.headers.accept;
		if (request.method === "GET" && mayBePage(request.url, accept)) {
			delete request.headers["if-none-match"];
			delete request.headers["if-modified-since"];
		}
		// A page's traced request: when it arrived, for its clock.
		const header = request.headers.traceparent;
		if (typeof header === "string" && isApi(request.url)) {
			const context = parseTraceparent(header);
			if (context) clocks.arrived(context.spanId, now());
		}
	});
	app.addHook("onSend", async (_request, reply, payload) => {
		const type = String(reply.getHeader("content-type") ?? "");
		if (!type.startsWith("text/html")) return payload;
		const html = await readAll(payload);
		if (html === null || !html.includes("</head>")) return html ?? payload;
		reply.removeHeader("content-length");
		reply.removeHeader("etag");
		reply.removeHeader("last-modified");
		reply.header("cache-control", "no-store");
		return html.replace("</head>", `${TRACE_META}</head>`);
	});
	app.post("/api/trace", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
		const at = now();
		const batch = readBatch(request.body, at, clocks);
		if (!batch) {
			return reply.status(400).send({ error: "Not a batch of spans" });
		}
		if (!budget.take(batch.spans.length, at)) {
			return reply.status(429).send({ error: "Too many spans" });
		}
		for (const span of batch.spans) traced.record(span);
		if (batch.spans.length > 0) traced.flush();
		return { kept: batch.spans.length, dropped: batch.dropped };
	});
}
