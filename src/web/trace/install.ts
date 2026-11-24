import { Collector, PAGE_GIVE_UP_MS, type TraceEnv } from "./collector";
import { checkMilestones, watching } from "./milestones";
import { tracingOn } from "./on";

/*
 * Starts the page's spans (collector.ts) when the server traces: its page
 * carries the `crb-trace` meta (src/server/browserTrace.ts). Without it
 * nothing is installed: no observer, no wrapped fetch, no listener, no
 * request (main.tsx doesn't even load this module).
 *
 * Tracing never breaks the page: every callback runs guarded, and the
 * first error turns tracing off for the page's life (the observers
 * disconnected, `fetch` given back, the listeners inert).
 */

export { tracingOn };

const TRACE_URL = "/api/trace";
/** A request whose painted frame doesn't come by then is recorded without it. */
const PAINT_WAIT_MS = 2000;

function randomHex(bytes: number): string {
	const a = crypto.getRandomValues(new Uint8Array(bytes));
	return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The API path of a fetch's `input` on this origin; null for any other. */
export function apiPath(
	input: RequestInfo | URL,
	origin: string = window.location.origin,
): string | null {
	const raw =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	let url: URL;
	try {
		url = new URL(raw, origin);
	} catch {
		return null;
	}
	if (url.origin !== origin || !/^\/api\//.test(url.pathname)) return null;
	if (url.pathname === TRACE_URL) return null;
	return `${url.pathname}${url.search}`;
}

/** How many spans a batch's JSON holds (for a refused one). */
function spanCount(body: string): number {
	try {
		const spans = (JSON.parse(body) as { spans?: unknown }).spans;
		return Array.isArray(spans) ? spans.length : 0;
	} catch {
		return 0;
	}
}

/** Runs tracing's own code; an error in it turns tracing off. */
export type Guard = <T>(fn: () => T) => T | undefined;

/**
 * A fetch that gives each API request a span and its `traceparent`; the
 * span ends at the frame after its body is read (what it shows painted),
 * or at its headers when nobody reads the body. Tracing's own work runs
 * in `guard`: the request itself goes out, and fails, as it would.
 */
export function tracedFetch(
	trace: Collector,
	inner: typeof fetch,
	frame: (fn: () => void) => void,
	guard: Guard = (fn) => fn(),
	on: () => boolean = () => true,
): typeof fetch {
	return async (input, init) => {
		if (!on()) return inner(input, init);
		const prepared = guard(() => {
			const path = apiPath(input);
			if (path === null) return null;
			const method =
				init?.method ??
				(typeof input === "object" && "method" in input ? input.method : "GET");
			const span = trace.fetch(method, path);
			if (!span) return null;
			const headers = new Headers(
				init?.headers ??
					(typeof input === "object" && "headers" in input
						? input.headers
						: undefined),
			);
			headers.set("traceparent", span.traceparent);
			return { span, init: { ...init, headers } };
		});
		if (!prepared) return inner(input, init);
		const { span } = prepared;
		let response: Response;
		try {
			response = await inner(input, prepared.init);
		} catch (error) {
			guard(() =>
				span.answered(
					null,
					init?.signal?.aborted ? "aborted" : "network error",
				),
			);
			throw error;
		}
		guard(() => {
			span.answered(response.status);
			let reading = false;
			for (const read of ["json", "text", "blob", "arrayBuffer"] as const) {
				const original = response[read].bind(
					response,
				) as () => Promise<unknown>;
				Object.defineProperty(response, read, {
					configurable: true,
					value: async () => {
						reading = true;
						try {
							return await original();
						} finally {
							guard(() => {
								span.read();
								frame(() => setTimeout(() => guard(span.painted), 0));
								// No frame comes in a hidden tab: recorded anyway.
								setTimeout(() => guard(span.finish), PAINT_WAIT_MS);
							});
						}
					},
				});
			}
			// The caller reads the body in the continuation, before any task.
			setTimeout(() => {
				if (!reading) guard(span.finish);
			}, 0);
		});
		return response;
	};
}

/** What installBrowserTrace started, to stop it (tests, an error). */
export interface Installed {
	trace: Collector;
	/** Turns tracing off: observers, fetch and listeners. */
	stop(): void;
	readonly on: boolean;
	/** Whether the milestone observer is attached (tests). */
	readonly observing: boolean;
}

/** Starts the page's spans when the server traces; null when it doesn't. */
export function installBrowserTrace(history?: {
	subscribe(fn: () => void): () => void;
}): Installed | null {
	if (!tracingOn()) return null;
	let on = true;
	const cleanups: (() => void)[] = [];
	const stop = () => {
		if (!on) return;
		on = false;
		for (const c of cleanups.splice(0)) {
			try {
				c();
			} catch {
				// Already off: nothing more to undo.
			}
		}
	};
	const guard: Guard = (fn) => {
		if (!on) return undefined;
		try {
			return fn();
		} catch (error) {
			stop();
			console.warn("crb: page tracing stopped:", error);
			return undefined;
		}
	};
	try {
		return start(history, guard, stop, cleanups, () => on);
	} catch (error) {
		stop();
		console.warn("crb: page tracing not started:", error);
		return null;
	}
}

function start(
	history: { subscribe(fn: () => void): () => void } | undefined,
	guard: Guard,
	stop: () => void,
	cleanups: (() => void)[],
	isOn: () => boolean,
): Installed {
	const inner = window.fetch.bind(window);
	const env: TraceEnv = {
		timeOrigin: performance.timeOrigin,
		now: () => performance.now(),
		randomHex,
		send(body, beacon, refused) {
			// A beacon (or keepalive, which shares its small quota) only when
			// the page may be going away (hidden, leaving): a batch in the
			// page's life is a plain POST.
			if (beacon && navigator.sendBeacon?.(TRACE_URL, body)) return;
			void inner(TRACE_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
				...(beacon ? { keepalive: true } : {}),
			})
				.then((response) => {
					// Turned away (the server's span budget): the next batch
					// says how many, so the gap shows.
					if (response.status === 429) {
						guard(() => refused(spanCount(body)));
					}
				})
				.catch(() => {});
		},
		setTimer: (fn, ms) => setTimeout(() => guard(fn), ms),
		hidden: () => document.visibilityState === "hidden",
	};
	const trace = new Collector(env, window.location.pathname);
	const original = window.fetch;
	window.fetch = tracedFetch(
		trace,
		inner,
		(fn) => requestAnimationFrame(fn),
		guard,
		isOn,
	);
	cleanups.push(() => {
		window.fetch = original;
	});

	// Milestones: what the page shows, checked once a frame while it
	// changes (a task when hidden: no frame comes, the DOM still does);
	// the observer is attached only while a milestone is pending.
	let scheduled = false;
	let observing = false;
	let giveUp: ReturnType<typeof setTimeout> | undefined;
	const observer = new MutationObserver(() => guard(schedule));
	const attach = () => {
		if (observing) return;
		observing = true;
		observer.observe(document, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["aria-busy", "data-state", "data-testid"],
		});
	};
	const detach = () => {
		if (!observing) return;
		observing = false;
		observer.disconnect();
	};
	cleanups.push(detach);
	const check = () => {
		scheduled = false;
		checkMilestones(document, trace);
		if (!watching(trace)) {
			detach();
			clearTimeout(giveUp);
		}
	};
	const run = () => guard(check);
	const schedule = () => {
		if (scheduled || !watching(trace)) return;
		scheduled = true;
		if (document.visibilityState === "hidden") setTimeout(run, 0);
		else requestAnimationFrame(run);
	};
	const armGiveUp = () => {
		clearTimeout(giveUp);
		giveUp = setTimeout(
			() =>
				guard(() => {
					trace.giveUp();
					detach();
				}),
			PAGE_GIVE_UP_MS,
		);
	};
	cleanups.push(() => clearTimeout(giveUp));
	const pageStarted = () => {
		attach();
		armGiveUp();
		schedule();
	};
	pageStarted();
	const unsubscribe = history?.subscribe(() =>
		guard(() => {
			trace.route(window.location.pathname);
			if (watching(trace)) pageStarted();
		}),
	);
	if (unsubscribe) cleanups.push(unsubscribe);

	const observe = (
		type: string,
		fn: (entry: PerformanceEntry) => void,
	): void => {
		if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
		const po = new PerformanceObserver((list) =>
			guard(() => {
				for (const entry of list.getEntries()) fn(entry);
			}),
		);
		po.observe({ type, buffered: true });
		cleanups.push(() => po.disconnect());
	};
	observe("longtask", (e) => trace.longTask(e.startTime, e.duration));
	observe("layout-shift", (e) => {
		const shift = e as PerformanceEntry & {
			value: number;
			hadRecentInput: boolean;
		};
		if (!shift.hadRecentInput) trace.layoutShift(e.startTime, shift.value);
	});
	observe("largest-contentful-paint", (e) => trace.lcp(e.startTime));

	const navigation = () => {
		const [nav] = performance.getEntriesByType("navigation") as
			| PerformanceNavigationTiming[]
			| [];
		trace.navigation({
			...(nav
				? {
						type: nav.type,
						responseStart: nav.responseStart,
						domInteractive: nav.domInteractive,
						domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
						loadEventEnd: nav.loadEventEnd,
						transferSize: nav.transferSize,
					}
				: {}),
			viewportWidth: window.innerWidth,
		});
	};
	let navigated = false;
	const afterLoad = () =>
		setTimeout(
			() =>
				guard(() => {
					if (navigated) return;
					navigated = true;
					navigation();
				}),
			0,
		);
	const listen = (
		target: Window | Document,
		type: string,
		fn: (event: Event) => void,
	) => {
		const handler = (event: Event) => guard(() => fn(event));
		target.addEventListener(type, handler);
		cleanups.push(() => target.removeEventListener(type, handler));
	};
	if (document.readyState === "complete") afterLoad();
	else listen(window, "load", afterLoad);
	listen(document, "visibilitychange", () => {
		trace.visibility();
		if (document.visibilityState !== "hidden") return;
		// A check queued for a frame waits for none now: run it as a task.
		if (scheduled) setTimeout(run, 0);
		// The tab may be closed with no other event: what waits goes out
		// in a way that outlives it; the page itself stays open.
		trace.flush("hidden");
	});
	listen(window, "pagehide", () => {
		if (!navigated) {
			navigated = true;
			navigation();
		}
		trace.flush("final");
	});
	// Back from the back-forward cache: a page of its own, watched anew.
	listen(window, "pageshow", (event) => {
		if (!(event as PageTransitionEvent).persisted) return;
		trace.restored(window.location.pathname);
		pageStarted();
	});
	return {
		trace,
		stop,
		get on() {
			return isOn();
		},
		get observing() {
			return observing;
		},
	};
}
