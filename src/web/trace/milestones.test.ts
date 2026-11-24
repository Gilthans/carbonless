// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Collector, type TraceEnv, type WireSpan } from "./collector";
import { checkMilestones } from "./milestones";

function setup(path: string) {
	let t = 0;
	let n = 0;
	const sent: WireSpan[] = [];
	const env: TraceEnv = {
		timeOrigin: 0,
		now: () => t,
		randomHex: (bytes) => (++n).toString(16).padStart(bytes * 2, "0"),
		send: (body) => sent.push(...JSON.parse(body).spans),
		setTimer: () => null,
		hidden: () => false,
	};
	const trace = new Collector(env, path);
	const root = document.createElement("div");
	const check = (ms: number, html: string) => {
		t = ms;
		root.innerHTML = html;
		checkMilestones(root, trace);
	};
	const spans = () => {
		trace.flush();
		return sent;
	};
	const at = (name: string) =>
		spans()
			.filter((s) => s.name === name)
			.map((s) => ({ end: s.endMs, attrs: s.attrs }));
	return { trace, check, spans, at };
}

const header = '<h1 data-testid="header-title">t</h1>';
const REV = "01m86pyhfvg1dfxbd57vr7mv08";

describe("checkMilestones", () => {
	it("overview: header, then the thread list, then threads with their code; the page ends there", () => {
		const s = setup(`/r/${REV}`);
		s.check(10, '<div data-testid="header-loading"></div>');
		s.check(
			20,
			`${header}<div data-trace="threads"><ul data-testid="threads-loading"></ul></div>`,
		);
		s.check(
			30,
			`${header}<div data-trace="threads"><ul><li data-testid="thread"><div data-testid="thread-code-loading"></div></li><li data-testid="thread"></li></ul></div>`,
		);
		expect(s.trace.pageOpen).toBe(true);
		s.check(
			40,
			`${header}<div data-trace="threads"><ul><li data-testid="thread"><div data-testid="thread-code"></div></li><li data-testid="thread"></li></ul></div>`,
		);
		expect(s.trace.pageOpen).toBe(false);
		expect(s.at("browser.ui.header")).toEqual([
			{ end: 20, attrs: { route: "overview", review: REV } },
		]);
		expect(s.at("browser.ui.threads")).toEqual([
			{ end: 30, attrs: { route: "overview", review: REV, threads: 2 } },
		]);
		expect(s.at("browser.ui.threads_code")[0]?.end).toBe(40);
		expect(s.at("browser.page")[0]).toMatchObject({
			end: 40,
			attrs: { complete: true },
		});
	});

	it("overview whose threads read failed: the milestone has the error, and the page ends failed, never complete", () => {
		const s = setup(`/r/${REV}`);
		s.check(
			5,
			`${header}<div data-trace="threads" data-state="failed"></div><div data-trace="threads" data-state="failed"></div>`,
		);
		expect(s.trace.pageOpen).toBe(false);
		const spans = s.spans();
		expect(spans.find((x) => x.name === "browser.ui.threads")).toMatchObject({
			error: "failed",
		});
		expect(spans.some((x) => x.name === "browser.ui.threads_code")).toBe(false);
		expect(spans.find((x) => x.name === "browser.page")).toMatchObject({
			error: "failed",
			attrs: { complete: false },
		});
	});

	it("overview with no threads: the list frame without its skeleton is the list", () => {
		const s = setup(`/r/${REV}`);
		s.check(5, `${header}<div data-trace="threads"></div>`);
		expect(s.at("browser.ui.threads_code")[0]).toMatchObject({
			end: 5,
			attrs: { threads: 0 },
		});
	});

	it("files: the first diff line, then the first file with nothing busy in it", () => {
		const s = setup(`/r/${REV}/files`);
		s.check(
			5,
			`${header}<div data-testid="files-loading" aria-busy="true"></div>`,
		);
		s.check(
			10,
			`${header}<section data-file-index="0"><div aria-busy="true"></div></section><section data-file-index="1"><div data-testid="diff-line"></div></section>`,
		);
		expect(s.trace.pageOpen).toBe(true);
		s.check(
			15,
			`${header}<section data-file-index="0"><div data-testid="diff-line"></div></section><section data-file-index="1"></section>`,
		);
		expect(s.trace.pageOpen).toBe(false);
		expect(s.at("browser.ui.diff_rows")[0]?.end).toBe(10);
		expect(s.at("browser.ui.first_file")[0]).toMatchObject({
			end: 15,
			attrs: { files: 2, route: "files" },
		});
	});

	it("files: the first diff line counts after the page's span ended (files open collapsed), until another page", () => {
		const s = setup(`/r/${REV}/files`);
		s.check(5, `${header}<section data-file-index="0"></section>`);
		expect(s.trace.pageOpen).toBe(false);
		s.check(
			900,
			`${header}<section data-file-index="0"><div data-testid="diff-line"></div></section>`,
		);
		expect(s.at("browser.ui.diff_rows")[0]?.end).toBe(900);
		expect(s.at("browser.ui.diff_rows")[0]?.attrs).toMatchObject({
			user: true,
			late: true,
		});
		s.trace.route(`/r/${REV}`);
		s.check(950, '<div data-testid="diff-line"></div>');
		expect(s.at("browser.ui.diff_rows")).toHaveLength(1);
	});

	it("home: rows and done per repo by its index, never its name; done once nothing loads", () => {
		const s = setup("/");
		const chip = (repo: string, state: string) =>
			`<span data-testid="view-repo" data-repo="${repo}" data-state="${state}"></span>`;
		const row = (repo: string) =>
			`<li data-testid="home-row" data-repo="${repo}"></li>`;
		s.check(
			5,
			`${chip("Acme/One", "loading")}${chip("acme/two", "loading")}<section data-section="mine"><li data-testid="row-skeleton"></li></section>`,
		);
		s.check(
			10,
			`${chip("Acme/One", "loading")}${chip("acme/two", "ready")}<section data-section="mine">${row("acme/two")}<li data-testid="row-skeleton"></li></section>`,
		);
		expect(s.trace.pageOpen).toBe(true);
		s.check(
			20,
			`${chip("Acme/One", "ready")}${chip("acme/two", "ready")}<section data-section="mine">${row("acme/one")}${row("acme/one")}${row("acme/two")}</section>`,
		);
		expect(s.trace.pageOpen).toBe(false);
		expect(s.at("browser.ui.home_rows")).toEqual([
			{ end: 10, attrs: { route: "home", rows: 1 } },
		]);
		expect(s.at("browser.ui.repo_rows")).toEqual([
			{ end: 10, attrs: { route: "home", "repo.index": 1, repos: 2, rows: 1 } },
			{ end: 20, attrs: { route: "home", "repo.index": 0, repos: 2, rows: 2 } },
		]);
		expect(s.at("browser.ui.repo_done").map((m) => m.end)).toEqual([10, 20]);
		expect(s.at("browser.ui.home_done")[0]).toMatchObject({
			end: 20,
			attrs: { rows: 3, repos: 2 },
		});
		expect(JSON.stringify(s.spans())).not.toMatch(/acme/i);
	});

	it("home with a repo whose read failed: done, with the error, the page failed", () => {
		const s = setup("/");
		s.check(
			5,
			`<span data-testid="view-repo" data-repo="a/b" data-state="failed"></span><section data-section="mine"></section>`,
		);
		expect(s.at("browser.ui.repo_done")[0]?.attrs).toMatchObject({
			"repo.state": "failed",
		});
		const spans = s.spans();
		expect(spans.find((x) => x.name === "browser.ui.home_done")).toMatchObject({
			error: "failed",
			attrs: { failed: 1 },
		});
		expect(spans.find((x) => x.name === "browser.page")).toMatchObject({
			error: "failed",
			attrs: { complete: false },
		});
	});

	it("a page with no milestones ends at once", () => {
		const s = setup("/settings");
		s.check(3, "<p>settings</p>");
		expect(s.trace.pageOpen).toBe(false);
	});
});
