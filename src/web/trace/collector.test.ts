import { describe, expect, it } from "vitest";
import {
	apiRoute,
	BATCH,
	BEACON_BATCH,
	Collector,
	FLUSH_MS,
	MAX_PENDING,
	routeOf,
	type TraceEnv,
	type WireBatch,
} from "./collector";

const ORIGIN = 1_800_000_000_000;
/** A review id as the server makes them (a ULID). */
const REV = "01m86pyhfvg1dfxbd57vr7mv08";

function fakeEnv() {
	let t = 0;
	let n = 0;
	let hidden = false;
	const sent: { body: WireBatch; final: boolean }[] = [];
	const timers: { fn: () => void; ms: number }[] = [];
	const env: TraceEnv = {
		timeOrigin: ORIGIN,
		now: () => t,
		randomHex: (bytes) => (++n).toString(16).padStart(bytes * 2, "a"),
		send: (body, final) => sent.push({ body: JSON.parse(body), final }),
		setTimer: (fn, ms) => timers.push({ fn, ms }),
		hidden: () => hidden,
	};
	return {
		env,
		sent,
		timers,
		at: (ms: number) => {
			t = ms;
		},
		hide: (h: boolean) => {
			hidden = h;
		},
		spans: () => sent.flatMap((s) => s.body.spans),
	};
}

describe("routeOf", () => {
	it("names a page by its kind, a review's with its id", () => {
		expect(routeOf("/")).toEqual({ route: "home" });
		expect(routeOf(`/r/${REV}`)).toEqual({ route: "overview", review: REV });
		expect(routeOf(`/r/${REV}/`)).toEqual({ route: "overview", review: REV });
		expect(routeOf(`/r/${REV}/files`)).toEqual({ route: "files", review: REV });
		expect(routeOf(`/r/${REV}/verdict`)).toEqual({
			route: "verdict",
			review: REV,
		});
		expect(routeOf("/settings")).toEqual({ route: "settings" });
		expect(routeOf("/pr/acme/widget/7")).toEqual({ route: "opening" });
	});

	it("never decodes: a malformed or foreign id is a review page with no id", () => {
		expect(routeOf("/r/%zz")).toEqual({ route: "overview" });
		expect(routeOf("/r/%E0%A4/files")).toEqual({ route: "files" });
		expect(routeOf("/r/not-a-review-id")).toEqual({ route: "overview" });
		expect(() => new Collector(fakeEnv().env, "/r/%zz")).not.toThrow();
		const c = new Collector(fakeEnv().env, "/");
		expect(() => c.route("/r/%E0%A4/files")).not.toThrow();
	});
});

describe("apiRoute", () => {
	it("is a template: no review id, repo, number, or query but the stage", () => {
		expect(apiRoute("/api/r/x9z/threads?read=r1&stage=firstCode")).toEqual({
			api: "/api/r/:id/threads",
			stage: "firstCode",
		});
		expect(apiRoute("/api/home/repos/acme/secret-repo?fresh=1")).toEqual({
			api: "/api/home/repos/:repo",
		});
		expect(apiRoute("/api/home/prs/acme/secret/12/annotations")).toEqual({
			api: "/api/home/prs/:repo/:n/annotations",
		});
		expect(apiRoute("/api/r/x/hunks/abc123/4")).toEqual({
			api: "/api/r/:id/hunks/:x/:n",
		});
		expect(apiRoute("/api/home/search?q=my+secret+title").api).toBe(
			"/api/home/search",
		);
		expect(apiRoute("/api/r/x/threads?stage=<b>").stage).toBeUndefined();
	});
});

describe("Collector", () => {
	it("roots the trace at the navigation; pages, milestones and requests nest under it", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, `/r/${REV}`);
		f.at(120);
		c.milestone("browser.ui.header");
		c.milestone("browser.ui.header"); // once
		const req = c.fetch("get", "/api/r/rev1/review");
		f.at(300);
		req?.answered(200);
		f.at(340);
		req?.read();
		f.at(360);
		req?.painted();
		f.at(400);
		c.navigation({ type: "navigate", responseStart: 12.4, loadEventEnd: 250 });
		c.endPage("complete");
		c.flush();
		const spans = f.spans();
		const by = (name: string) => spans.filter((s) => s.name === name);
		const [nav] = by("browser.navigation");
		const [page] = by("browser.page");
		const [header] = by("browser.ui.header");
		const [fetch] = by("browser.fetch");
		expect(by("browser.ui.header")).toHaveLength(1);
		expect(nav).toMatchObject({
			spanId: c.rootId,
			traceId: c.traceId,
			startMs: ORIGIN,
			endMs: ORIGIN + 250,
			attrs: { type: "navigate", ttfb_ms: 12, load_ms: 250, route: "overview" },
		});
		expect(nav?.parentSpanId).toBeUndefined();
		expect(page).toMatchObject({
			parentSpanId: c.rootId,
			startMs: ORIGIN,
			endMs: ORIGIN + 400,
			attrs: { route: "overview", review: REV, complete: true },
		});
		expect(page?.attrs).not.toHaveProperty("spa");
		expect(header).toMatchObject({
			parentSpanId: page?.spanId,
			startMs: ORIGIN,
			endMs: ORIGIN + 120,
			attrs: { route: "overview", review: REV },
		});
		expect(fetch).toMatchObject({
			parentSpanId: page?.spanId,
			startMs: ORIGIN + 120,
			endMs: ORIGIN + 300,
			attrs: {
				"http.method": "GET",
				api: "/api/r/:id/review",
				status: 200,
				body_ms: 220,
				painted_ms: 240,
			},
		});
		expect(req?.traceparent).toBe(`00-${c.traceId}-${fetch?.spanId}-01`);
		expect(f.sent.every((s) => s.body.doc === c.traceId)).toBe(true);
	});

	it("a route change ends the page left, incomplete; the next is an SPA move from its time", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, `/r/${REV}`);
		f.at(500);
		c.route(`/r/${REV}`); // the same page: nothing
		expect(c.pageOpen).toBe(true);
		c.route(`/r/${REV}/files`);
		expect(c.page).toEqual({ route: "files", review: REV, start: 500 });
		f.at(700);
		c.milestone("browser.ui.first_file");
		c.endPage("complete");
		c.flush();
		const pages = f.spans().filter((s) => s.name === "browser.page");
		expect(pages.map((p) => p.attrs)).toEqual([
			{ route: "overview", review: REV, complete: false },
			{ route: "files", review: REV, spa: true, complete: true },
		]);
		expect(pages[1]).toMatchObject({
			startMs: ORIGIN + 500,
			endMs: ORIGIN + 700,
		});
		expect(
			f.spans().find((s) => s.name === "browser.ui.first_file"),
		).toMatchObject({
			startMs: ORIGIN + 500,
			endMs: ORIGIN + 700,
			attrs: { spa: true },
		});
	});

	it("a page hidden at any point says so on its milestones after and on itself", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, `/r/${REV}`);
		c.milestone("browser.ui.header");
		f.hide(true);
		c.visibility();
		f.hide(false);
		c.visibility(); // back: it was hidden all the same
		c.milestone("browser.ui.threads");
		c.endPage("complete");
		const by = (name: string) => f.spans().find((s) => s.name === name)?.attrs;
		expect(by("browser.ui.header")).not.toHaveProperty("hidden");
		expect(by("browser.ui.threads")).toMatchObject({ hidden: true });
		expect(by("browser.page")).toMatchObject({ hidden: true, complete: true });
		// A page that starts hidden (a background tab) is hidden from its start.
		const g = fakeEnv();
		g.hide(true);
		const d = new Collector(g.env, "/");
		d.milestone("browser.ui.home_rows");
		d.flush();
		expect(g.spans()[0]?.attrs).toMatchObject({ hidden: true });
	});

	it("a user-paced milestone is marked, late after the page ended, and never where an abandoned page ends", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, `/r/${REV}/files`);
		f.at(100);
		c.milestone("browser.ui.header");
		f.at(200);
		c.milestone("browser.ui.diff_rows", undefined, undefined, { user: true });
		f.at(PAGE_END);
		c.endPage("abandoned");
		f.at(PAGE_END + 50);
		c.milestone("browser.ui.first_file", undefined, undefined, { user: true });
		c.flush();
		const by = (name: string) => f.spans().find((s) => s.name === name);
		expect(by("browser.ui.diff_rows")?.attrs).toMatchObject({ user: true });
		expect(by("browser.ui.diff_rows")?.attrs).not.toHaveProperty("late");
		expect(by("browser.ui.first_file")?.attrs).toMatchObject({
			user: true,
			late: true,
		});
		// Abandoned: it ends at its last load milestone, not at the give-up.
		expect(by("browser.page")).toMatchObject({
			endMs: ORIGIN + 100,
			attrs: { complete: false, abandoned: true },
		});
	});

	it("an abandoned page with no milestone is a zero-length span", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, "/");
		f.at(PAGE_END);
		c.endPage("abandoned");
		c.flush();
		expect(f.spans()[0]).toMatchObject({ startMs: ORIGIN, endMs: ORIGIN });
	});

	it("a failed page carries the error, never complete", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, `/r/${REV}`);
		c.endPage("failed");
		c.flush();
		expect(f.spans()[0]).toMatchObject({
			name: "browser.page",
			error: "failed",
			attrs: { complete: false },
		});
	});

	it("back from the back-forward cache: a new page, restored", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, "/");
		c.endPage("complete");
		f.at(900);
		c.restored("/");
		expect(c.pageOpen).toBe(true);
		c.milestone("browser.ui.home_rows");
		c.flush();
		const rows = f.spans().find((s) => s.name === "browser.ui.home_rows");
		expect(rows).toMatchObject({
			startMs: ORIGIN + 900,
			attrs: { restored: true },
		});
		// A restore isn't an SPA move: they aggregate apart.
		expect(rows?.attrs).not.toHaveProperty("spa");
	});

	it("once the page has ended its reads aren't traced, and a write is a trace of its own", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, `/r/${REV}`);
		c.endPage("complete");
		expect(c.fetch("GET", "/api/r/x/agent/status")).toBeNull();
		expect(c.fetch("head", "/api/version")).toBeNull();
		const write = c.fetch("POST", "/api/r/x/state");
		write?.answered(200);
		write?.finish();
		c.flush();
		const [span] = f.spans().filter((s) => s.name === "browser.fetch");
		expect(span?.traceId).not.toBe(c.traceId);
		expect(span?.parentSpanId).toBeUndefined();
		expect(span?.attrs).toMatchObject({ after_page: true, route: "overview" });
		expect(write?.traceparent).toBe(`00-${span?.traceId}-${span?.spanId}-01`);
		// The batch still names the document: its clock is the page's.
		expect(f.sent.at(-1)?.body.doc).toBe(c.traceId);
	});

	it("a request hidden at any point from its start to its end says so", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, "/");
		const across = c.fetch("GET", "/api/home");
		f.hide(true);
		c.visibility();
		f.hide(false);
		c.visibility();
		across?.answered(200);
		across?.finish();
		const visible = c.fetch("GET", "/api/home");
		visible?.answered(200);
		visible?.finish();
		f.hide(true);
		const startedHidden = c.fetch("GET", "/api/home");
		f.hide(false);
		startedHidden?.answered(200);
		startedHidden?.finish();
		c.flush();
		expect(
			f
				.spans()
				.filter((s) => s.name === "browser.fetch")
				.map((s) => s.attrs?.hidden ?? false),
		).toEqual([true, false, true]);
	});

	it("a hidden flush goes as beacons and leaves the page open; spans turned away count in the next batch", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, "/");
		c.milestone("browser.ui.home_rows");
		c.flush("hidden");
		expect(f.sent.map((s) => s.final)).toEqual([true]);
		expect(c.pageOpen).toBe(true);
		c.lost(7);
		c.milestone("browser.ui.home_done");
		c.flush();
		expect(f.sent.at(-1)?.body.dropped).toBe(7);
		expect(f.sent.at(-1)?.final).toBe(false);
	});

	it("given up, a page's late milestones aren't looked for; a new page looks again", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, `/r/${REV}/files`);
		expect(c.lateOpen).toBe(true);
		c.giveUp();
		expect(c.lateOpen).toBe(false);
		expect(c.pageOpen).toBe(false);
		c.route(`/r/${REV}`);
		expect(c.lateOpen).toBe(true);
	});

	it("a failed request is a span with its error", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, "/");
		const req = c.fetch("POST", "/api/home/view");
		f.at(10);
		req?.answered(null, "network error");
		req?.painted(); // after it is recorded: no change
		c.flush();
		const [s] = f.spans();
		expect(s).toMatchObject({ name: "browser.fetch", error: "network error" });
		expect(s?.attrs).not.toHaveProperty("painted_ms");
	});

	it("long tasks and big layout shifts are spans while the page loads; every shift counts in its CLS", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, "/");
		c.longTask(100, 80.6);
		c.layoutShift(150, 0.01);
		c.layoutShift(160, 0.3);
		c.endPage("left");
		c.longTask(300, 90); // after: not the load's
		c.flush();
		const names = f.spans().map((s) => s.name);
		expect(names).toEqual([
			"browser.longtask",
			"browser.layout_shift",
			"browser.page",
		]);
		expect(f.spans()[0]?.attrs).toMatchObject({ duration_ms: 81 });
		expect(f.spans()[2]?.attrs).toMatchObject({ cls: 0.31 });
	});

	it("batches: a timer sends what waits, BATCH at most a post; the final flush ends the page, sends the LCP, in beacon-sized batches", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, "/");
		c.lcp(90);
		for (let i = 0; i < BATCH + 5; i++) c.longTask(i, 60);
		expect(f.timers).toHaveLength(1);
		expect(f.timers[0]?.ms).toBe(FLUSH_MS);
		expect(f.sent).toHaveLength(0);
		f.timers[0]?.fn();
		expect(f.sent.map((s) => s.body.spans.length)).toEqual([BATCH, 5]);
		expect(f.sent.every((s) => !s.final)).toBe(true);
		f.sent.length = 0;
		for (let i = 0; i < BEACON_BATCH + 3; i++) c.layoutShift(i, 0.1);
		f.at(1000);
		c.flush("final");
		expect(f.sent.every((s) => s.final)).toBe(true);
		expect(f.sent.map((s) => s.body.spans.length)).toEqual([BEACON_BATCH, 5]);
		const last = f.sent.at(-1);
		expect(last?.body.sentAt).toBe(ORIGIN + 1000);
		expect(last?.body.spans.map((s) => s.name).slice(-2)).toEqual([
			"browser.page",
			"browser.lcp",
		]);
		expect(
			last?.body.spans.find((s) => s.name === "browser.lcp"),
		).toMatchObject({ startMs: ORIGIN, endMs: ORIGIN + 90 });
	});

	it("a page complete sends what waits at once, without waiting for the timer", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, `/r/${REV}/verdict`);
		c.milestone("browser.ui.header");
		expect(f.sent).toHaveLength(0);
		c.endPage("complete");
		expect(f.spans().map((s) => s.name)).toEqual([
			"browser.ui.header",
			"browser.page",
		]);
		// Left incomplete: the timer or the beacon sends it.
		c.route(`/r/${REV}/files`);
		c.route(`/r/${REV}`);
		expect(f.spans()).toHaveLength(2);
	});

	it("drops spans past MAX_PENDING and says how many", () => {
		const f = fakeEnv();
		const c = new Collector(f.env, "/");
		for (let i = 0; i < MAX_PENDING + 3; i++) c.longTask(i, 60);
		c.flush();
		expect(f.spans()).toHaveLength(MAX_PENDING);
		expect(f.sent[0]?.body.dropped).toBe(3);
	});
});

const PAGE_END = 300_000;
