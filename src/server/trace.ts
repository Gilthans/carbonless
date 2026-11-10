import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

/*
 * Opt-in tracing (docs/test-profiling.md): when $CRB_TRACE_DIR names a
 * directory, spans go to an OTLP JSON Lines file of this process there
 * (`<service>-<pid>-<random>.jsonl`, each line an ExportTraceServiceRequest,
 * as the OpenTelemetry collector's file exporter writes them). Unset, every
 * call is a no-op on a disabled tracer: no file, no ids, no context.
 *
 * Hand-rolled on purpose: crb ships no OpenTelemetry SDK. Test harnesses
 * (Playwright, Vitest) use the same writer. A write that fails is reported
 * once on stderr and tracing stops; it never throws into the caller.
 */

export interface SpanContext {
	traceId: string;
	spanId: string;
}

export type Attrs = Record<string, string | number | boolean | undefined>;

export interface Span {
	/** Its ids; null on the disabled tracer. */
	readonly context: SpanContext | null;
	/** Adds attributes before it ends. */
	set(attrs: Attrs): void;
	/** Ends it (once; later calls do nothing). `error` marks it failed. */
	end(attrs?: Attrs, error?: string): void;
}

/** A finished span written as is (a test reporter's, after the fact). */
export interface RecordedSpan {
	name: string;
	context: SpanContext;
	parent: SpanContext | null;
	/** Epoch milliseconds (fractions kept). */
	startMs: number;
	endMs: number;
	attrs?: Attrs;
	error?: string;
	kind?: SpanKind;
}

export type SpanKind = "internal" | "server" | "client";

export interface StartOptions {
	/** The parent; null for a new trace. Default: the current span. */
	parent?: SpanContext | null;
	/** Epoch milliseconds; default now. */
	startMs?: number;
	kind?: SpanKind;
}

export interface Tracer {
	readonly enabled: boolean;
	start(name: string, attrs?: Attrs, opts?: StartOptions): Span;
	/** Writes a finished span with the ids given. */
	record(span: RecordedSpan): void;
	/** Runs `fn` with `span` as the current span (async continuations too). */
	run<T>(span: Span, fn: () => T): T;
	/** Makes `span` current for the rest of this async context. */
	enter(span: Span): void;
	/** The current span: run()'s, else the default parent, else $TRACEPARENT's. */
	current(): SpanContext | null;
	/** The parent of spans started outside any run() (a test's span). */
	setDefaultParent(context: SpanContext | null): void;
	/**
	 * The process's own span, from its start (performance.timeOrigin) to its
	 * exit, under $TRACEPARENT; it becomes the default parent.
	 */
	root(name: string, attrs?: Attrs): Span;
	/** Writes what is buffered. */
	flush(): void;
	/** Renames its service, unless it has written already. */
	name(service: string): void;
}

const NOOP_SPAN: Span = {
	context: null,
	set() {},
	end() {},
};

const DISABLED: Tracer = {
	enabled: false,
	start: () => NOOP_SPAN,
	record() {},
	run: (_span, fn) => fn(),
	enter() {},
	current: () => null,
	setDefaultParent() {},
	root: () => NOOP_SPAN,
	flush() {},
	name() {},
};

/** A W3C traceparent header for `context`. */
export function traceparent(context: SpanContext): string {
	return `00-${context.traceId}-${context.spanId}-01`;
}

/** The context in a W3C traceparent header; null when it isn't one. */
export function parseTraceparent(
	value: string | undefined,
): SpanContext | null {
	const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(value ?? "");
	return m ? { traceId: m[1] as string, spanId: m[2] as string } : null;
}

/** Epoch milliseconds (fractions kept) as OTLP's nanosecond string. */
export function toNanos(ms: number): string {
	const whole = Math.floor(ms);
	const frac = Math.min(999_999, Math.round((ms - whole) * 1e6));
	return `${whole}${String(frac).padStart(6, "0")}`;
}

/** Now, in epoch milliseconds with sub-millisecond precision. */
export function nowMs(): number {
	return performance.timeOrigin + performance.now();
}

const KIND = { internal: 1, server: 2, client: 3 } as const;

function otlpValue(v: string | number | boolean) {
	if (typeof v === "string") return { stringValue: v };
	if (typeof v === "boolean") return { boolValue: v };
	return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
}

function otlpAttrs(attrs: Attrs | undefined) {
	const out: { key: string; value: ReturnType<typeof otlpValue> }[] = [];
	for (const [key, v] of Object.entries(attrs ?? {})) {
		if (v !== undefined) out.push({ key, value: otlpValue(v) });
	}
	return out;
}

/** One ExportTraceServiceRequest line of `spans` from `service`. */
export function otlpLine(
	service: string,
	resource: Attrs,
	spans: RecordedSpan[],
): string {
	return JSON.stringify({
		resourceSpans: [
			{
				resource: {
					attributes: otlpAttrs({ "service.name": service, ...resource }),
				},
				scopeSpans: [
					{
						scope: { name: "carbonless" },
						spans: spans.map((s) => ({
							traceId: s.context.traceId,
							spanId: s.context.spanId,
							...(s.parent ? { parentSpanId: s.parent.spanId } : {}),
							name: s.name,
							kind: KIND[s.kind ?? "internal"],
							startTimeUnixNano: toNanos(s.startMs),
							endTimeUnixNano: toNanos(s.endMs),
							attributes: otlpAttrs(s.attrs),
							...(s.error ? { status: { code: 2, message: s.error } } : {}),
						})),
					},
				],
			},
		],
	});
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** Buffered spans are written once this many wait (and at exit). */
const FLUSH_AT = 256;

export interface TracerOptions {
	/** Where the file goes; no tracing when unset or empty. */
	dir: string | undefined;
	/** service.name, and the file name's start. */
	service: string;
	/** The parent of the root and of spans with no other ($TRACEPARENT). */
	traceparent?: string;
	/** Extra resource attributes (the test run's id). */
	resource?: Attrs;
	/** Flush when the process exits (default true). */
	flushOnExit?: boolean;
	/** Where the one write failure goes (default stderr). */
	warn?: (message: string) => void;
}

export function createTracer(opts: TracerOptions): Tracer {
	if (!opts.dir) return DISABLED;
	const dir = opts.dir;
	let service = opts.service;
	// Named at the first write, so the entry point may still rename it.
	let file = "";
	const resource: Attrs = { "process.pid": process.pid, ...opts.resource };
	const warn =
		opts.warn ??
		((m: string) => {
			process.stderr.write(`${m}\n`);
		});
	const envParent = parseTraceparent(opts.traceparent);
	const store = new AsyncLocalStorage<SpanContext>();
	let defaultParent: SpanContext | null = null;
	let buffer: RecordedSpan[] = [];
	let broken = false;
	let made = false;
	let root: { span: Span } | null = null;

	const flush = () => {
		if (buffer.length === 0) return;
		const spans = buffer;
		buffer = [];
		if (broken) return;
		try {
			if (!made) {
				mkdirSync(dir, { recursive: true });
				made = true;
				file = join(
					dir,
					`${service.replace(/[^\w.-]/g, "_")}-${process.pid}-${hex(3)}.jsonl`,
				);
			}
			appendFileSync(file, `${otlpLine(service, resource, spans)}\n`);
		} catch (error) {
			broken = true;
			warn(
				`crb: trace write to ${file || dir} failed, tracing stops: ${(error as Error).message}`,
			);
		}
	};
	const push = (span: RecordedSpan) => {
		buffer.push(span);
		if (buffer.length >= FLUSH_AT) flush();
	};
	const current = () =>
		store.getStore() ?? defaultParent ?? (root ? null : envParent);

	const tracer: Tracer = {
		enabled: true,
		start(name, attrs, startOpts = {}) {
			const parent =
				startOpts.parent !== undefined ? startOpts.parent : current();
			const context = {
				traceId: parent?.traceId ?? hex(16),
				spanId: hex(8),
			};
			const startMs = startOpts.startMs ?? nowMs();
			let all: Attrs | undefined = attrs;
			let done = false;
			return {
				context,
				set(more) {
					all = { ...all, ...more };
				},
				end(more, error) {
					if (done) return;
					done = true;
					push({
						name,
						context,
						parent,
						startMs,
						endMs: nowMs(),
						attrs: more ? { ...all, ...more } : all,
						error,
						kind: startOpts.kind,
					});
				},
			};
		},
		record: push,
		run(span, fn) {
			return span.context ? store.run(span.context, fn) : fn();
		},
		enter(span) {
			if (span.context) store.enterWith(span.context);
		},
		current,
		setDefaultParent(context) {
			defaultParent = context;
		},
		root(name, attrs) {
			if (root) return root.span;
			const span = tracer.start(name, attrs, {
				parent: envParent,
				startMs: performance.timeOrigin,
			});
			root = { span };
			defaultParent = span.context;
			return span;
		},
		flush,
		name(name) {
			if (!made) service = name;
		},
	};
	if (opts.flushOnExit !== false) {
		process.on("exit", () => {
			root?.span.end();
			flush();
		});
	}
	return tracer;
}

const KEY = Symbol.for("carbonless.tracer");

/**
 * This process's tracer, made on first use from $CRB_TRACE_DIR and
 * $TRACEPARENT. `service` names it (renamed until it first writes; default: the script's
 * name).
 */
export function tracer(service?: string): Tracer {
	const g = globalThis as { [KEY]?: Tracer };
	if (g[KEY]) {
		if (service) g[KEY].name(service);
		return g[KEY];
	}
	g[KEY] = createTracer({
		dir: process.env.CRB_TRACE_DIR,
		service:
			service ?? basename(process.argv[1] ?? "node").replace(/\.\w+$/, ""),
		traceparent: process.env.TRACEPARENT,
		resource: process.env.CRB_TRACE_RUN
			? { "crb.run": process.env.CRB_TRACE_RUN }
			: undefined,
	});
	return g[KEY];
}

/** `args` shortened for a span attribute: each ≤ 40 chars, all ≤ 160. */
export function argsSummary(args: readonly string[]): string {
	const text = args
		.map((a) => (a.length > 40 ? `${a.slice(0, 39)}…` : a))
		.join(" ");
	return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}
