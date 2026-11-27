/*
 * The page's spans (CAR-288; docs/test-profiling.md, "Browser spans"):
 * only when the server traces, which its page says with a `crb-trace` meta
 * (src/server/browserTrace.ts). One trace per page load: the document's
 * navigation is its root, each page shown (a route) a span under it, and
 * under a page what the reviewer waits for: its milestones (milestones.ts),
 * its API requests (whose `traceparent` puts the server's request spans,
 * with their git and gh, under them), long tasks and layout shifts.
 * Batched to POST /api/trace every few seconds, at once when a page is
 * complete, and by sendBeacon when the page goes away.
 *
 * The document's trace stays the size of its loads: once a page's span
 * has ended, its reads (polls, refetches) aren't traced at all, and a
 * write (the reviewer's action) is a small trace of its own. A tab left
 * open for days adds nothing while it only polls.
 *
 * Attributes never carry a PR's text, paths or code: routes are templates,
 * a Home repo is its index in the view, a review is its id (a ULID).
 */

/** A span as POST /api/trace takes it (src/server/browserTrace.ts readBatch). */
export interface WireSpan {
	name: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	/** Epoch milliseconds. */
	startMs: number;
	endMs: number;
	attrs?: Record<string, string | number | boolean>;
	error?: string;
}

/** A batch as POST /api/trace takes it. */
export interface WireBatch {
	spans: WireSpan[];
	/** The page's clock when it was sent (epoch ms). */
	sentAt: number;
	/** The document's trace: the server keeps its clock offset by it. */
	doc: string;
	dropped?: number;
}

export type Attrs = Record<string, string | number | boolean>;

export interface TraceEnv {
	/** performance.timeOrigin (epoch ms). */
	timeOrigin: number;
	/** performance.now(). */
	now(): number;
	/** `bytes` random bytes as hex. */
	randomHex(bytes: number): string;
	/**
	 * Posts a batch's JSON (`count` spans in it). `beacon`: the page may be
	 * going away (hidden, or leaving): a beacon or a keepalive POST, which
	 * outlive it. `refused(count)` when the server turned it away (429).
	 */
	send(body: string, beacon: boolean, refused: (count: number) => void): void;
	setTimer(fn: () => void, ms: number): unknown;
	/** Whether the page is hidden now (document.visibilityState). */
	hidden(): boolean;
}

/** How often a batch goes out (ms) while spans wait. */
export const FLUSH_MS = 5000;
/** At most this many a POST (the server's MAX_SPANS). */
export const BATCH = 200;
/** At most this many a beacon (beacons share a small in-flight quota). */
export const BEACON_BATCH = 50;
/** Spans waiting beyond this many are dropped (a page left open for days). */
export const MAX_PENDING = 2000;
/** A page whose milestones never all show is given up after this long (ms). */
export const PAGE_GIVE_UP_MS = 5 * 60_000;
/** A layout shift at least this large is a span of its own. */
const SHIFT_MIN = 0.05;

/** A review's id (a ULID, as the server makes them). */
const REVIEW_ID = /^[0-9a-hjkmnp-tv-z]{26}$/i;

/**
 * What kind of page a path is, and its review id when it is a review's.
 * Never decodes: a malformed address (`/r/%zz`) is just a review page
 * with no id.
 */
export function routeOf(path: string): { route: string; review?: string } {
	const review = /^\/r\/([^/]+)(\/[^/]*)?\/?$/.exec(path);
	if (review) {
		const sub = review[2]?.slice(1) ?? "";
		const route =
			sub === ""
				? "overview"
				: sub === "files" || sub === "verdict"
					? sub
					: "review-other";
		const id = review[1] as string;
		return REVIEW_ID.test(id) ? { route, review: id } : { route };
	}
	if (path === "/" || path === "") return { route: "home" };
	if (path === "/settings") return { route: "settings" };
	if (path.startsWith("/pr/")) return { route: "opening" };
	return { route: "other" };
}

/**
 * An API request's address as a route template: the review's id, Home's
 * owner/repo, numbers and ids replaced; no query but a threads `stage`.
 */
export function apiRoute(url: string): { api: string; stage?: string } {
	const [path = "", query = ""] = url.split("?");
	const api = path
		.replace(/^\/api\/r\/[^/]+/, "/api/r/:id")
		.replace(/^\/api\/home\/(repos|prs)\/[^/]+\/[^/]+/, "/api/home/$1/:repo")
		.split("/")
		.map((s) =>
			s === "" || s.startsWith(":") || /^[a-z][a-z_-]{0,30}$/.test(s)
				? s
				: /^\d+$/.test(s)
					? ":n"
					: ":x",
		)
		.join("/");
	let stage: string | null = null;
	try {
		stage = new URLSearchParams(query).get("stage");
	} catch {
		stage = null;
	}
	return stage && /^[A-Za-z]{1,16}$/.test(stage) ? { api, stage } : { api };
}

interface Page {
	spanId: string;
	/** performance.now() at its start. */
	start: number;
	attrs: Attrs;
	seen: Set<string>;
	ended: boolean;
	cls: number;
	/** The page was hidden at some point since its start. */
	hidden: boolean;
	/** When its last milestone was reached (performance.now()). */
	last: number | null;
}

export interface FetchSpan {
	/** The traceparent header for the request. */
	traceparent: string;
	/** The answer's headers came (or it failed: `error`). */
	answered(status: number | null, error?: string): void;
	/** Its body is read; then the next frame, when what it shows is painted. */
	read(): void;
	painted(): void;
	/** Records it now (no body read: at its headers). */
	finish(): void;
}

/** How a page's span ends (endPage). */
export type PageEnd =
	/** Its last milestone is in. */
	| "complete"
	/** Left (another page, the tab gone) with milestones pending. */
	| "left"
	/** Given up after PAGE_GIVE_UP_MS: ends at its last milestone. */
	| "abandoned"
	/** What it waited for failed (a threads read). */
	| "failed";

export class Collector {
	readonly traceId: string;
	readonly rootId: string;
	#env: TraceEnv;
	#pending: WireSpan[] = [];
	#dropped = 0;
	#timer: unknown = null;
	#page: Page;
	#pageKey: string;
	#pages = 0;
	#lcp: number | null = null;
	/** How often the page was hidden: a request across one says so. */
	#hides = 0;
	/** The page's late milestones are no longer looked for (given up). */
	#lateClosed = false;
	#lcpSent = false;

	constructor(env: TraceEnv, path: string) {
		this.#env = env;
		this.traceId = env.randomHex(16);
		this.rootId = env.randomHex(8);
		this.#pageKey = path;
		// The first page starts with the document.
		this.#page = this.#newPage(path, 0);
	}

	#epoch(t: number): number {
		return this.#env.timeOrigin + t;
	}

	#newPage(path: string, start: number, extra?: Attrs): Page {
		this.#lateClosed = false;
		const { route, review } = routeOf(path);
		// Pages after the document's first are SPA moves: the app's shell
		// (its header) is already up, so they aggregate apart (a page back
		// from the back-forward cache is `restored`, not a move).
		const spa = this.#pages++ > 0 && !extra?.restored;
		return {
			spanId: this.#env.randomHex(8),
			start,
			attrs: {
				route,
				...(review ? { review } : {}),
				...(spa ? { spa: true } : {}),
				...extra,
			},
			seen: new Set(),
			ended: false,
			cls: 0,
			hidden: this.#env.hidden(),
			last: null,
		};
	}

	/** The page being shown: its route and review. */
	get page(): Readonly<{ route: string; review?: string; start: number }> {
		return {
			route: String(this.#page.attrs.route),
			...(this.#page.attrs.review !== undefined
				? { review: String(this.#page.attrs.review) }
				: {}),
			start: this.#page.start,
		};
	}

	/** Whether the current page's span is still open (milestones pending). */
	get pageOpen(): boolean {
		return !this.#page.ended;
	}

	#push(span: WireSpan): void {
		if (this.#pending.length >= MAX_PENDING) {
			this.#dropped++;
			return;
		}
		this.#pending.push(span);
		this.#timer ??= this.#env.setTimer(() => {
			this.#timer = null;
			this.flush();
		}, FLUSH_MS);
	}

	/** A span `start`..`end` (performance.now()) under `parent`. */
	span(
		name: string,
		start: number,
		end: number,
		attrs?: Attrs,
		parent: string | null = this.#page.spanId,
		spanId: string = this.#env.randomHex(8),
		error?: string,
		traceId: string = this.traceId,
	): void {
		this.#push({
			name,
			traceId,
			spanId,
			...(parent ? { parentSpanId: parent } : {}),
			startMs: this.#epoch(start),
			endMs: this.#epoch(Math.max(start, end)),
			...(attrs && Object.keys(attrs).length ? { attrs } : {}),
			...(error ? { error } : {}),
		});
	}

	/**
	 * The document's navigation (PerformanceNavigationTiming's numbers, ms
	 * since its start): the trace's root, from 0 to `loadEventEnd`.
	 */
	navigation(timing: {
		type?: string;
		responseStart?: number;
		domInteractive?: number;
		domContentLoadedEventEnd?: number;
		loadEventEnd?: number;
		transferSize?: number;
		viewportWidth?: number;
	}): void {
		const end = timing.loadEventEnd || this.#env.now();
		const attrs: Attrs = { route: String(this.#page.attrs.route) };
		const put = (key: string, v: number | string | undefined) => {
			if (typeof v === "string" && v) attrs[key] = v;
			else if (typeof v === "number" && v > 0) attrs[key] = Math.round(v);
		};
		put("type", timing.type);
		put("ttfb_ms", timing.responseStart);
		put("dom_interactive_ms", timing.domInteractive);
		put("dcl_ms", timing.domContentLoadedEventEnd);
		put("load_ms", timing.loadEventEnd);
		put("transfer_bytes", timing.transferSize);
		put("viewport_w", timing.viewportWidth);
		this.#push({
			name: "browser.navigation",
			traceId: this.traceId,
			spanId: this.rootId,
			startMs: this.#epoch(0),
			endMs: this.#epoch(end),
			attrs,
		});
	}

	/** The address is `path` now: another page starts unless it's the same. */
	route(path: string): void {
		if (path === this.#pageKey) return;
		this.#pageKey = path;
		this.endPage("left");
		this.#page = this.#newPage(path, this.#env.now());
	}

	/** The page came back from the back-forward cache: a page of its own. */
	restored(path: string): void {
		this.endPage("left");
		this.#pageKey = path;
		this.#page = this.#newPage(path, this.#env.now(), { restored: true });
	}

	/** The page's visibility changed: a page ever hidden says so. */
	visibility(): void {
		if (!this.#env.hidden()) return;
		this.#page.hidden = true;
		this.#hides++;
	}

	/**
	 * A milestone of the page (once per `key`, default its name): a span
	 * from the page's start to now. `user`: one the reviewer's own pace
	 * sets (a click), never what ends the page. Also after the page's span
	 * ended (a late milestone, milestones.ts), until another page starts.
	 */
	milestone(
		name: string,
		attrs?: Attrs,
		key: string = name,
		opts: { user?: boolean; error?: string } = {},
	): void {
		const page = this.#page;
		if (page.seen.has(key)) return;
		page.seen.add(key);
		const now = this.#env.now();
		if (!opts.user) page.last = now;
		this.span(
			name,
			page.start,
			now,
			{
				...page.attrs,
				...attrs,
				...(page.hidden ? { hidden: true } : {}),
				...(opts.user ? { user: true } : {}),
				...(page.ended ? { late: true } : {}),
			},
			page.spanId,
			undefined,
			opts.error,
		);
	}

	/** Whether the page has reached milestone `key`. */
	reached(key: string): boolean {
		return this.#page.seen.has(key);
	}

	/**
	 * Ends the page's span (once). `complete`: at its last milestone, and
	 * what waits is sent at once (a beacon on leaving may not arrive);
	 * `left` and `failed`: now; `abandoned`: at its last milestone reached
	 * (its start without one), so a given-up page is never a long one.
	 */
	endPage(how: PageEnd): void {
		const page = this.#page;
		if (page.ended) return;
		page.ended = true;
		const attrs: Attrs = { ...page.attrs, complete: how === "complete" };
		if (how === "abandoned") attrs.abandoned = true;
		if (page.hidden) attrs.hidden = true;
		if (page.cls > 0) attrs.cls = Math.round(page.cls * 1000) / 1000;
		const end =
			how === "abandoned" ? (page.last ?? page.start) : this.#env.now();
		this.span(
			"browser.page",
			page.start,
			end,
			attrs,
			this.rootId,
			page.spanId,
			how === "failed" ? "failed" : undefined,
		);
		if (how === "complete") {
			this.#sendLcp();
			this.flush();
		}
	}

	#sendLcp(): void {
		if (this.#lcp === null || this.#lcpSent) return;
		this.#lcpSent = true;
		this.span("browser.lcp", 0, this.#lcp, undefined, this.rootId);
	}

	/** The latest largest-contentful-paint candidate (ms since the start). */
	lcp(at: number): void {
		if (!this.#lcpSent) this.#lcp = at;
	}

	longTask(start: number, duration: number): void {
		if (this.#page.ended) return;
		this.span("browser.longtask", start, start + duration, {
			...this.#page.attrs,
			duration_ms: Math.round(duration),
		});
	}

	layoutShift(start: number, value: number): void {
		if (this.#page.ended) return;
		this.#page.cls += value;
		if (value < SHIFT_MIN) return;
		this.span("browser.layout_shift", start, start, {
			...this.#page.attrs,
			value: Math.round(value * 1000) / 1000,
		});
	}

	/**
	 * A span for an API request `method url`, started now; null when it
	 * isn't traced: a read once the page's span has ended (a poll, a
	 * refetch). A write then is a trace of its own (the reviewer's action),
	 * never the document's.
	 */
	fetch(method: string, url: string): FetchSpan | null {
		const verb = method.toUpperCase();
		const after = this.#page.ended;
		if (after && (verb === "GET" || verb === "HEAD")) return null;
		const traceId = after ? this.#env.randomHex(16) : this.traceId;
		const parent = after ? null : this.#page.spanId;
		const spanId = this.#env.randomHex(8);
		const start = this.#env.now();
		// Hidden at any point from its start to its end, as pages are.
		const hiddenAtStart = this.#env.hidden();
		const hides = this.#hides;
		const attrs: Attrs = {
			"http.method": verb,
			...apiRoute(url),
			route: String(this.#page.attrs.route),
			...(after ? { after_page: true } : {}),
		};
		let end: number | null = null;
		let error: string | undefined;
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			if (hiddenAtStart || this.#hides !== hides || this.#env.hidden())
				attrs.hidden = true;
			this.span(
				"browser.fetch",
				start,
				end ?? this.#env.now(),
				attrs,
				parent,
				spanId,
				error,
				traceId,
			);
		};
		return {
			traceparent: `00-${traceId}-${spanId}-01`,
			answered: (status, why) => {
				end = this.#env.now();
				if (status !== null) attrs.status = status;
				if (why) {
					error = why;
					finish();
				}
			},
			read: () => {
				if (done) return;
				attrs.body_ms = Math.round(this.#env.now() - start);
			},
			painted: () => {
				if (done) return;
				attrs.painted_ms = Math.round(this.#env.now() - start);
				finish();
			},
			finish,
		};
	}

	/** The server turned `count` spans away: the next batch says so. */
	lost(count: number): void {
		this.#dropped += count;
	}

	/** Whether the page's late milestones are still looked for. */
	get lateOpen(): boolean {
		return !this.#lateClosed;
	}

	/**
	 * Gives the page up (PAGE_GIVE_UP_MS): its span ends `abandoned`, and
	 * its late milestones aren't looked for any more.
	 */
	giveUp(): void {
		this.endPage("abandoned");
		this.#lateClosed = true;
	}

	/**
	 * Sends what waits, in batches. `plain`: the page's life (plain
	 * POSTs). `hidden`: the tab is hidden and may be closed without another
	 * event: beacon-sized batches that outlive it, the page left open.
	 * `final`: the page goes away: it ends, its LCP is sent, then as
	 * `hidden`.
	 */
	flush(mode: "plain" | "hidden" | "final" = "plain"): void {
		if (mode === "final") {
			this.endPage("left");
			this.#sendLcp();
		}
		const beacon = mode !== "plain";
		while (this.#pending.length > 0) {
			const spans = this.#pending.splice(0, beacon ? BEACON_BATCH : BATCH);
			const body: WireBatch = {
				spans,
				sentAt: this.#epoch(this.#env.now()),
				doc: this.traceId,
			};
			if (this.#dropped) {
				body.dropped = this.#dropped;
				this.#dropped = 0;
			}
			this.#env.send(JSON.stringify(body), beacon, (n) => this.lost(n));
		}
	}
}
