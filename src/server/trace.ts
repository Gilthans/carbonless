import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
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
 *
 * Spans are written in batches: at 256 waiting, a few seconds after the
 * first of a batch ends (an unref'd timer: a crash loses seconds at most),
 * and at exit. A long-running process (crb serve, `rotate()`) rolls its
 * file at a size limit and at the UTC day change
 * (`<service>-<pid>-<random>.<yyyymmdd>.<seq>.jsonl`) and prunes the
 * directory's files of its service by age and total size.
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
	/**
	 * Rolls its file by size and day and prunes its service's old files
	 * (crb serve), from its next write on.
	 */
	rotate(options: RotationOptions): void;
}

/** Rotation and retention of a long-running process's trace files. */
export interface RotationOptions {
	/** A file rolls to a new one before it would grow past this. */
	maxFileBytes: number;
	/** Files of the service older than this (by mtime) are deleted. */
	keepDays: number;
	/** Beyond that, the oldest go while the service's files exceed this. */
	maxTotalBytes: number;
}

const MiB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * Defaults. Measured 2026-11-24 on a traced crb serve: ~400 bytes a span,
 * a few thousand spans an hour of active reviewing, so tens of MB on a busy
 * day. 32 MiB keeps a file quick to read (and a day usually in one file);
 * 14 days covers two weeks of RCs to compare; 1 GiB is the hard bound on
 * disk whatever the traffic.
 */
export const DEFAULT_ROTATION: RotationOptions = {
	maxFileBytes: 32 * MiB,
	keepDays: 14,
	maxTotalBytes: 1024 * MiB,
};

/**
 * Rotation from $CRB_TRACE_FILE_MB, $CRB_TRACE_KEEP_DAYS and
 * $CRB_TRACE_MAX_MB; an unset or invalid one keeps its default (tracing
 * never stops crb from starting). Each is raised to a floor: files of at
 * least 1 MiB, a day kept, a total of at least one file (a tiny file size
 * would roll and prune on every flush; a tiny total would delete every
 * other file on each roll).
 */
export function rotationFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): RotationOptions {
	const num = (name: string, fallback: number) => {
		const v = Number(env[name]);
		return env[name]?.trim() && Number.isFinite(v) && v > 0 ? v : fallback;
	};
	const maxFileBytes = Math.max(
		MiB,
		Math.round(
			num("CRB_TRACE_FILE_MB", DEFAULT_ROTATION.maxFileBytes / MiB) * MiB,
		),
	);
	return {
		maxFileBytes,
		keepDays: Math.max(
			1,
			num("CRB_TRACE_KEEP_DAYS", DEFAULT_ROTATION.keepDays),
		),
		maxTotalBytes: Math.max(
			maxFileBytes,
			Math.round(
				num("CRB_TRACE_MAX_MB", DEFAULT_ROTATION.maxTotalBytes / MiB) * MiB,
			),
		),
	};
}

/** The file-name start of `service`'s files. */
const fileService = (service: string) => service.replace(/[^\w.-]/g, "_");

/** Whether `name` is a trace file `service` wrote (rotated or not). */
export function isServiceFile(service: string, name: string): boolean {
	const prefix = `${fileService(service)}-`;
	return (
		name.startsWith(prefix) &&
		/^\d+-[0-9a-f]+(?:\.\d{8}\.\d+)?\.jsonl$/.test(name.slice(prefix.length))
	);
}

/**
 * A file written to this recently may be another live process's current
 * one (two crb serves during an update's restart, several in an e2e run):
 * the cap never deletes it.
 */
export const RECENT_MS = 5 * 60 * 1000;

/**
 * Deletes `service`'s trace files in `dir` older than `keepDays`, then the
 * oldest while they total more than `maxTotalBytes`; never `keep` (the
 * file being written) nor one written in the last RECENT_MS. Other files
 * (another service's, a test run's) are left alone. Never throws; returns
 * the names deleted.
 */
export function pruneTraces(
	dir: string,
	service: string,
	options: RotationOptions,
	nowMs = Date.now(),
	keep?: string,
): string[] {
	const deleted: string[] = [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return deleted;
	}
	const files: { name: string; size: number; mtimeMs: number }[] = [];
	for (const name of names) {
		if (!isServiceFile(service, name)) continue;
		try {
			const st = statSync(join(dir, name));
			if (st.isFile()) files.push({ name, size: st.size, mtimeMs: st.mtimeMs });
		} catch {
			// Gone meanwhile.
		}
	}
	files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
	const drop = (name: string) => {
		try {
			rmSync(join(dir, name), { force: true });
			deleted.push(name);
			return true;
		} catch {
			return false;
		}
	};
	const cutoff = nowMs - options.keepDays * DAY_MS;
	let total = 0;
	const left: typeof files = [];
	for (const f of files) {
		if (f.mtimeMs < cutoff && join(dir, f.name) !== keep && drop(f.name)) {
			continue;
		}
		left.push(f);
		total += f.size;
	}
	for (const f of left) {
		if (total <= options.maxTotalBytes) break;
		if (join(dir, f.name) === keep || nowMs - f.mtimeMs < RECENT_MS) continue;
		if (drop(f.name)) total -= f.size;
	}
	return deleted;
}

/** The UTC day of `ms`, as yyyymmdd. */
const utcDay = (ms: number) =>
	new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

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
	rotate() {},
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

/**
 * The timer functions as the process started with: a test that fakes
 * timers (Vitest's) never holds the tracer's flush, nor sees it among its
 * own timers.
 */
const realTimers = {
	setTimeout: globalThis.setTimeout,
	clearTimeout: globalThis.clearTimeout,
};

/** A scheduler for the timed flush (tests pass their own). */
export interface FlushTimers {
	setTimeout(fn: () => void, ms: number): { unref?(): unknown };
	clearTimeout(handle: { unref?(): unknown }): void;
}

/** Buffered spans are written once this many wait (and at exit). */
const FLUSH_AT = 256;
/** …and this long after the first of them ended. */
export const FLUSH_AFTER_MS = 2000;

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
	/** Writes waiting spans this long after the first (default 2 s; 0: never by time). */
	flushAfterMs?: number;
	/** Rolls and prunes its files (as `rotate()` does). */
	rotation?: RotationOptions;
	/** Epoch milliseconds now, for the day and retention (tests). */
	clock?: () => number;
	/** The timed flush's scheduler (tests); default the real timers. */
	timers?: FlushTimers;
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

	const flushAfterMs = opts.flushAfterMs ?? FLUSH_AFTER_MS;
	const clock = opts.clock ?? Date.now;
	let rotation = opts.rotation ?? null;
	let stem = "";
	let seq = 0;
	let fileDay = "";
	let fileBytes = 0;
	const timers: FlushTimers = opts.timers ?? (realTimers as FlushTimers);
	let timer: { unref?(): unknown } | null = null;

	// A new file: the first, or the next one of a rotation (then pruned).
	const open = (now: number) => {
		if (!made) {
			mkdirSync(dir, { recursive: true });
			made = true;
			stem = `${fileService(service)}-${process.pid}-${hex(3)}`;
		}
		fileDay = utcDay(now);
		fileBytes = 0;
		if (rotation) {
			// Six digits: sorts as text far past any real day's count.
			file = join(
				dir,
				`${stem}.${fileDay}.${String(seq++).padStart(6, "0")}.jsonl`,
			);
			pruneTraces(dir, service, rotation, now, file);
		} else {
			file = join(dir, `${stem}.jsonl`);
		}
	};
	const flush = () => {
		if (timer) {
			timers.clearTimeout(timer);
			timer = null;
		}
		if (buffer.length === 0) return;
		const spans = buffer;
		buffer = [];
		if (broken) return;
		try {
			const line = `${otlpLine(service, resource, spans)}\n`;
			const bytes = Buffer.byteLength(line);
			const now = clock();
			if (
				!file ||
				(rotation &&
					(utcDay(now) !== fileDay ||
						(fileBytes > 0 && fileBytes + bytes > rotation.maxFileBytes)))
			) {
				open(now);
			}
			try {
				appendFileSync(file, line);
			} catch (error) {
				// The directory was deleted under it (traces cleared by hand):
				// made again, once, rather than tracing off until a restart.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				mkdirSync(dir, { recursive: true });
				appendFileSync(file, line);
			}
			fileBytes += bytes;
		} catch (error) {
			broken = true;
			warn(
				`crb: trace write to ${file || dir} failed, tracing stops: ${(error as Error).message}`,
			);
		}
	};
	const push = (span: RecordedSpan) => {
		if (broken) return;
		buffer.push(span);
		if (buffer.length >= FLUSH_AT) flush();
		else if (!timer && flushAfterMs > 0) {
			timer = timers.setTimeout(flush, flushAfterMs);
			timer.unref?.();
		}
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
		rotate(options) {
			// The file named before rotation ends here.
			if (!rotation) file = "";
			rotation = options;
			// Retention at start, not at the first write: a server with no
			// traffic prunes too.
			pruneTraces(dir, service, options, clock());
		},
	};
	if (rotation) pruneTraces(dir, service, rotation, clock());
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
