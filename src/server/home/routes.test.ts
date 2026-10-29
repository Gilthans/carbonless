import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homePr } from "../../../test/fake-gh/scenario";
import {
	createHomeFixture,
	type HomeFixture,
} from "../../../test/home-fixture";
import type { HomeRow, HomeView, SearchResult } from "../../shared/home.js";
import { type HomeConfig, HomeService } from "./homeService.js";
import { MAX_NOTE, parseAnnotationOp, registerHomeRoutes } from "./routes.js";
import { HomeSearch } from "./search.js";

// Each fake gh call is a node process: give a loaded machine time.
vi.setConfig({ testTimeout: 30_000 });

const iso = (ms: number) => new Date(ms).toISOString();
let fx: HomeFixture | undefined;
let app: FastifyInstance | undefined;
afterEach(async () => {
	await app?.close();
	app = undefined;
	fx?.cleanup();
	fx = undefined;
});

async function setup() {
	fx = createHomeFixture({
		repos: {
			"acme/api": {
				prs: [
					homePr({
						repo: "acme/api",
						number: 1,
						title: "Fix login",
						author: "Octo",
						updatedAt: iso(Date.now() - 1000),
					}),
				],
			},
		},
	});
	let config: HomeConfig = {
		views: [{ name: "My PRs", repos: ["acme/api"] }],
		refresh: { minutes: 2 },
	};
	const home = new HomeService({
		config: {
			read: async () => ({ config, problems: [] }),
			update: async (change) => {
				config = change(config);
				return config;
			},
		},
		started: { list: async () => [] },
	});
	app = Fastify();
	await registerHomeRoutes(app, home, new HomeSearch(home), {
		startOnRequest: false,
	});
	return { app, config: () => config };
}

describe("/api/home", () => {
	it("GET and POST refresh answer the HomeView", async () => {
		const { app } = await setup();
		const before = (
			await app.inject({ method: "GET", url: "/api/home" })
		).json<HomeView>();
		expect(before.refreshedAt).toBe(null);
		const res = await app.inject({ method: "POST", url: "/api/home/refresh" });
		expect(res.statusCode).toBe(200);
		const view = res.json<HomeView>();
		expect(view.sections[0]?.rows.map((r) => r.number)).toEqual([1]);
		const again = (
			await app.inject({ method: "GET", url: "/api/home" })
		).json<HomeView>();
		expect(again.refreshedAt).toBe(view.refreshedAt);
	});

	it("GET and POST refresh answer 200 with the reason while gh is logged out", async () => {
		const { app } = await setup();
		fx?.scenario({ loggedOut: true });
		for (const [method, url] of [
			["GET", "/api/home"],
			["POST", "/api/home/refresh"],
		] as const) {
			const res = await app.inject({ method, url });
			expect(res.statusCode).toBe(200);
			expect(res.json<HomeView>().refreshError).toMatch(
				/gh auth login|not logged in/i,
			);
		}
	});

	it("annotations: each op, the row back", async () => {
		const { app } = await setup();
		await app.inject({ method: "POST", url: "/api/home/refresh" });
		const post = (body: unknown) =>
			app.inject({
				method: "POST",
				url: "/api/home/prs/acme/api/1/annotations",
				payload: body as object,
			});
		const snoozed = await post({
			op: "snooze",
			until: iso(Date.now() + 3_600_000),
			wakeOnActivity: true,
		});
		expect(snoozed.statusCode).toBe(200);
		expect(snoozed.json<HomeRow>().hidden).toBe("snoozed");
		expect((await post({ op: "wake" })).json<HomeRow>().hidden).toBe(null);
		expect(
			(await post({ op: "note", text: "hi" })).json<HomeRow>().annotations.note,
		).toBe("hi");
		expect(
			(await post({ op: "wait", who: "bob" })).json<HomeRow>().hidden,
		).toBe("waiting");
	});

	it("annotations: 400 on a bad op, a past until, a long note; 404 off Home", async () => {
		const { app } = await setup();
		await app.inject({ method: "POST", url: "/api/home/refresh" });
		const post = (url: string, body: unknown) =>
			app.inject({ method: "POST", url, payload: body as object });
		const url = "/api/home/prs/acme/api/1/annotations";
		for (const bad of [
			{ op: "hide" },
			{ op: "snooze", until: iso(Date.now() - 1000), wakeOnActivity: true },
			{ op: "snooze", until: "soon", wakeOnActivity: true },
			{ op: "snooze", until: iso(Date.now() + 1000) },
			{ op: "note", text: "x".repeat(MAX_NOTE + 1) },
			{ op: "wait", who: "not a login" },
		]) {
			const res = await post(url, bad);
			expect(res.statusCode, JSON.stringify(bad)).toBe(400);
			expect(res.json<{ error: string }>().error).toBeTruthy();
		}
		expect(
			(await post("/api/home/prs/acme/api/99/annotations", { op: "wake" }))
				.statusCode,
		).toBe(404);
		expect(
			(await post("/api/home/prs/acme/a..b/x/annotations", { op: "wake" }))
				.statusCode,
		).toBe(400);
	});

	it("PUT view writes the config's repos", async () => {
		const { app, config } = await setup();
		const res = await app.inject({
			method: "PUT",
			url: "/api/home/view",
			payload: { repos: ["Acme/API"] },
		});
		expect(res.statusCode).toBe(200);
		expect(config().views[0]?.repos).toEqual(["acme/api"]);
		expect(res.json<HomeView>().view.repos).toEqual(["acme/api"]);
		const bad = await app.inject({
			method: "PUT",
			url: "/api/home/view",
			payload: { repos: ["nope"] },
		});
		expect(bad.statusCode).toBe(400);
		const notList = await app.inject({
			method: "PUT",
			url: "/api/home/view",
			payload: { repos: "acme/api" },
		});
		expect(notList.statusCode).toBe(400);
	});

	it("GET search answers a SearchResult", async () => {
		const { app } = await setup();
		await app.inject({ method: "POST", url: "/api/home/refresh" });
		const res = await app.inject({
			method: "GET",
			url: `/api/home/search?q=${encodeURIComponent("login")}`,
		});
		expect(res.statusCode).toBe(200);
		expect(res.json<SearchResult>().prs.map((p) => p.number)).toEqual([1]);
		const long = await app.inject({
			method: "GET",
			url: `/api/home/search?q=${"x".repeat(301)}`,
		});
		expect(long.statusCode).toBe(400);
	});
});

describe("parseAnnotationOp", () => {
	it("normalizes until to ISO UTC", () => {
		const now = Date.parse("2026-10-29T12:00:00Z");
		expect(
			parseAnnotationOp(
				{
					op: "snooze",
					until: "2026-10-30T09:00:00+02:00",
					wakeOnActivity: false,
				},
				now,
			),
		).toEqual({
			op: "snooze",
			until: "2026-10-30T07:00:00.000Z",
			wakeOnActivity: false,
		});
	});
});
