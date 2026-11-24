// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Collector,
	PAGE_GIVE_UP_MS,
	type TraceEnv,
	type WireSpan,
} from "./collector";
import {
	apiPath,
	type Installed,
	installBrowserTrace,
	tracedFetch,
	tracingOn,
} from "./install";

const REV = "01m86pyhfvg1dfxbd57vr7mv08";

function collector() {
	let n = 0;
	const sent: WireSpan[] = [];
	const env: TraceEnv = {
		timeOrigin: 0,
		now: () => 0,
		randomHex: (bytes) => (++n).toString(16).padStart(bytes * 2, "0"),
		send: (body) => sent.push(...JSON.parse(body).spans),
		setTimer: () => null,
		hidden: () => false,
	};
	const trace = new Collector(env, "/");
	return {
		trace,
		spans: () => {
			trace.flush();
			return sent;
		},
	};
}

const realFetch = window.fetch;
let installed: Installed | null = null;

beforeEach(() => {
	// A fetch that answers: install binds it, and its own POSTs go there.
	window.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;
	// jsdom runs no frames: one is a task here.
	vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
		setTimeout(() => fn(0), 0),
	);
});

afterEach(() => {
	installed?.stop();
	installed = null;
	window.fetch = realFetch;
	document.head.innerHTML = "";
	document.body.innerHTML = "";
	window.history.replaceState(null, "", "/");
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
	Reflect.deleteProperty(document, "visibilityState");
});

const traced = () => {
	document.head.innerHTML = '<meta name="crb-trace" content="1">';
};

/** A router history whose moves the test makes. */
function fakeHistory() {
	const subs: (() => void)[] = [];
	return {
		subscribe(fn: () => void) {
			subs.push(fn);
			return () => subs.splice(subs.indexOf(fn), 1);
		},
		move(path: string) {
			window.history.pushState(null, "", path);
			for (const fn of subs) fn();
		},
	};
}

describe("tracingOn", () => {
	it("is the server's crb-trace meta", () => {
		expect(tracingOn()).toBe(false);
		traced();
		expect(tracingOn()).toBe(true);
	});

	it("off: nothing installed: no observer, no listener, fetch untouched", () => {
		const mo = vi.spyOn(window, "MutationObserver");
		const po = vi.spyOn(window, "PerformanceObserver");
		const onWindow = vi.spyOn(window, "addEventListener");
		const onDocument = vi.spyOn(document, "addEventListener");
		const before = window.fetch;
		expect(installBrowserTrace(fakeHistory())).toBeNull();
		expect(window.fetch).toBe(before);
		expect(mo).not.toHaveBeenCalled();
		expect(po).not.toHaveBeenCalled();
		expect(onWindow).not.toHaveBeenCalled();
		expect(onDocument).not.toHaveBeenCalled();
	});
});

describe("installBrowserTrace", () => {
	it("a malformed review address doesn't break it (or the page)", () => {
		traced();
		window.history.replaceState(null, "", "/r/%zz/files");
		const history = fakeHistory();
		installed = installBrowserTrace(history);
		expect(installed?.on).toBe(true);
		expect(installed?.trace.page).toMatchObject({ route: "files" });
		history.move("/r/%E0%A4");
		expect(installed?.on).toBe(true);
	});

	it("an error in its own code turns tracing off, never the page's", async () => {
		traced();
		const history = fakeHistory();
		const original = window.fetch;
		installed = installBrowserTrace(history);
		expect(window.fetch).not.toBe(original);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(installed?.trace as Collector, "route").mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => history.move("/settings")).not.toThrow();
		expect(installed?.on).toBe(false);
		expect(installed?.observing).toBe(false);
		expect(warn).toHaveBeenCalled();
		// fetch is exactly the page's own again, and still works.
		expect(window.fetch).toBe(original);
		expect(await (await window.fetch("/api/version")).json()).toEqual({});
	});

	it("the observer is attached only while a milestone is pending, again on a move", async () => {
		vi.useFakeTimers();
		traced();
		window.history.replaceState(null, "", "/settings");
		const history = fakeHistory();
		installed = installBrowserTrace(history);
		expect(installed?.observing).toBe(true);
		await vi.runOnlyPendingTimersAsync();
		// A page with no milestone ends at its first check: nothing to watch.
		expect(installed?.trace.pageOpen).toBe(false);
		expect(installed?.observing).toBe(false);
		history.move(`/r/${REV}`);
		expect(installed?.observing).toBe(true);
		document.body.innerHTML = `<h1 data-testid="header-title">t</h1><div data-trace="threads"></div>`;
		await vi.runOnlyPendingTimersAsync();
		await vi.runOnlyPendingTimersAsync();
		expect(installed?.trace.pageOpen).toBe(false);
		expect(installed?.observing).toBe(false);
	});

	it("in a hidden tab (no frames) milestones are still checked when the page shows them", async () => {
		vi.useFakeTimers();
		traced();
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "hidden",
		});
		const never = vi.fn();
		vi.stubGlobal("requestAnimationFrame", never);
		window.history.replaceState(null, "", `/r/${REV}/verdict`);
		installed = installBrowserTrace(fakeHistory());
		document.body.innerHTML = '<h1 data-testid="header-title">t</h1>';
		await vi.runOnlyPendingTimersAsync();
		await vi.runOnlyPendingTimersAsync();
		expect(installed?.trace.pageOpen).toBe(false);
		expect(never).not.toHaveBeenCalled();
	});

	it("on Files, given up, the observer detaches though diff rows never came", async () => {
		vi.useFakeTimers();
		traced();
		window.history.replaceState(null, "", `/r/${REV}/files`);
		installed = installBrowserTrace(fakeHistory());
		document.body.innerHTML = `<h1 data-testid="header-title">t</h1><section data-file-index="0"></section>`;
		// A frame's worth: not the give-up's 5 minutes.
		await vi.advanceTimersByTimeAsync(50);
		expect(installed?.trace.pageOpen).toBe(false);
		// Still watching for the late diff rows…
		expect(installed?.observing).toBe(true);
		await vi.advanceTimersByTimeAsync(PAGE_GIVE_UP_MS);
		// …until the page is given up.
		expect(installed?.observing).toBe(false);
	});

	it("a batch in the page's life is a plain POST; keepalive and the beacon only when it goes away", () => {
		traced();
		const beacon = vi.fn(() => false);
		Object.defineProperty(navigator, "sendBeacon", {
			configurable: true,
			value: beacon,
		});
		const post = window.fetch as ReturnType<typeof vi.fn>;
		installed = installBrowserTrace(fakeHistory());
		installed?.trace.milestone("browser.ui.home_rows");
		installed?.trace.flush();
		const [url, init] = post.mock.calls.at(-1) as [string, RequestInit];
		expect(url).toBe("/api/trace");
		expect(init.keepalive).toBeUndefined();
		expect(beacon).not.toHaveBeenCalled();
		installed?.trace.flush("final");
		expect(beacon).toHaveBeenCalled();
		// The beacon refused (its quota): a keepalive POST instead.
		expect((post.mock.calls.at(-1) as [string, RequestInit])[1].keepalive).toBe(
			true,
		);
	});
});

describe("going away", () => {
	const hide = () => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "hidden",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	};
	const beacons = () => {
		const sent: string[] = [];
		Object.defineProperty(navigator, "sendBeacon", {
			configurable: true,
			value: (_url: string, body: string) => {
				sent.push(body);
				return true;
			},
		});
		return sent;
	};

	it("hidden then pagehide (a tab closed): what waited goes by beacon at the hide, the page open until pagehide", () => {
		traced();
		const sent = beacons();
		installed = installBrowserTrace(fakeHistory());
		installed?.trace.milestone("browser.ui.home_rows");
		hide();
		const names = () =>
			sent.flatMap((b) =>
				(JSON.parse(b).spans as { name: string }[]).map((x) => x.name),
			);
		expect(names()).toContain("browser.ui.home_rows");
		expect(installed?.trace.pageOpen).toBe(true);
		window.dispatchEvent(new Event("pagehide"));
		expect(names()).toContain("browser.page");
	});

	it("a check queued for a frame runs as a task once the tab hides", async () => {
		vi.useFakeTimers();
		traced();
		beacons();
		const frames = vi.fn();
		vi.stubGlobal("requestAnimationFrame", frames);
		window.history.replaceState(null, "", `/r/${REV}/verdict`);
		installed = installBrowserTrace(fakeHistory());
		expect(frames).toHaveBeenCalled(); // queued for a frame that never comes
		document.body.innerHTML = '<h1 data-testid="header-title">t</h1>';
		hide();
		// A task's worth: not the give-up's 5 minutes.
		await vi.advanceTimersByTimeAsync(50);
		expect(installed?.trace.pageOpen).toBe(false);
		expect(installed?.trace.reached("browser.ui.header")).toBe(true);
	});

	it("a batch the server turns away (429) counts as dropped in the next one", async () => {
		traced();
		const post = window.fetch as ReturnType<typeof vi.fn>;
		post.mockImplementation(async () => new Response("{}", { status: 429 }));
		installed = installBrowserTrace(fakeHistory());
		installed?.trace.milestone("browser.ui.home_rows");
		installed?.trace.milestone("browser.ui.home_done");
		installed?.trace.flush();
		// The refused answer settles (the mock's promise, then its .then).
		await new Promise((done) => setTimeout(done, 0));
		post.mockImplementation(async () => new Response("{}"));
		installed?.trace.milestone("browser.ui.repo_done");
		installed?.trace.flush();
		const last = post.mock.calls.at(-1) as [string, RequestInit];
		expect(JSON.parse(String(last[1].body)).dropped).toBe(2);
	});
});

describe("apiPath", () => {
	const origin = "http://h:1";
	it("only this origin's API, never the trace route itself", () => {
		expect(apiPath("/api/r/x/review?a=1", origin)).toBe("/api/r/x/review?a=1");
		expect(apiPath(new URL("http://h:1/api/home"), origin)).toBe("/api/home");
		expect(apiPath("/assets/x.js", origin)).toBeNull();
		expect(apiPath("http://other/api/home", origin)).toBeNull();
		expect(apiPath("/api/trace", origin)).toBeNull();
	});
});

describe("tracedFetch", () => {
	it("sends a traceparent; the span ends at the frame after its body is read", async () => {
		vi.useFakeTimers();
		const c = collector();
		const inner = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response('{"a":1}', { status: 201 }),
		);
		const frames: (() => void)[] = [];
		const f = tracedFetch(c.trace, inner as typeof fetch, (fn) =>
			frames.push(fn),
		);
		const res = await f("/api/r/x/review", {
			headers: { "x-keep": "1" },
		});
		expect(await res.json()).toEqual({ a: 1 });
		const headers = inner.mock.calls[0]?.[1]?.headers as Headers;
		expect(headers.get("x-keep")).toBe("1");
		expect(headers.get("traceparent")).toMatch(
			new RegExp(`^00-${c.trace.traceId}-[0-9a-f]{16}-01$`),
		);
		expect(c.spans()).toHaveLength(0);
		frames.shift()?.();
		vi.runAllTimers();
		const [span] = c.spans();
		expect(span).toMatchObject({
			name: "browser.fetch",
			attrs: {
				status: 201,
				api: "/api/r/:id/review",
				body_ms: 0,
				painted_ms: 0,
			},
		});
		expect(headers.get("traceparent")).toContain(span?.spanId);
	});

	it("a body nobody reads: the span ends at the answer's headers", async () => {
		vi.useFakeTimers();
		const c = collector();
		const f = tracedFetch(
			c.trace,
			(async () => new Response("x")) as typeof fetch,
			() => {},
		);
		await f("/api/version");
		vi.runAllTimers();
		expect(c.spans()).toHaveLength(1);
	});

	it("other addresses, and reads once the page ended, go as they are, with no span or header", async () => {
		const c = collector();
		const inner = vi.fn(async () => new Response("x"));
		const f = tracedFetch(c.trace, inner as typeof fetch, () => {});
		await f("/assets/a.js");
		await f("/api/trace", { method: "POST" });
		c.trace.endPage("complete");
		const before = c.spans().length;
		await f("/api/r/x/agent/status");
		expect(inner.mock.calls).toEqual([
			["/assets/a.js", undefined],
			["/api/trace", { method: "POST" }],
			["/api/r/x/agent/status", undefined],
		]);
		expect(c.spans()).toHaveLength(before);
	});

	it("an error in its bookkeeping goes to the guard; the request goes out as it would", async () => {
		const c = collector();
		vi.spyOn(c.trace, "fetch").mockImplementation(() => {
			throw new Error("boom");
		});
		const inner = vi.fn(async () => new Response("ok"));
		const errors: unknown[] = [];
		const f = tracedFetch(
			c.trace,
			inner as typeof fetch,
			() => {},
			(fn) => {
				try {
					return fn();
				} catch (error) {
					errors.push(error);
					return undefined;
				}
			},
		);
		expect(await (await f("/api/home")).text()).toBe("ok");
		expect(errors).toHaveLength(1);
		expect(inner).toHaveBeenCalledWith("/api/home", undefined);
	});

	it("a request that fails is a span with its error, and still throws", async () => {
		const c = collector();
		const f = tracedFetch(
			c.trace,
			(async () => {
				throw new TypeError("down");
			}) as typeof fetch,
			() => {},
		);
		await expect(f("/api/home")).rejects.toThrow("down");
		expect(c.spans()[0]).toMatchObject({ error: "network error" });
	});
});
