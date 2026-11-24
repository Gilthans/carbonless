import { request } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homePr, release } from "../../../test/fake-gh/scenario";
import {
	createHomeFixture,
	type HomeFixture,
} from "../../../test/home-fixture";
import type {
	HomeRow,
	HomeView,
	PeopleResult,
	RepoHome,
	SearchResult,
} from "../../shared/home.js";
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
	await fx?.cleanup();
	fx = undefined;
});

/** A request whose path goes out as written (no dot-segment removal). */
function raw(
	base: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request(
			`${base}/`,
			{ method, path, headers: { "content-type": "application/json" } },
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (c: string) => {
					text += c;
				});
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: text }),
				);
			},
		);
		req.on("error", reject);
		req.end(body === undefined ? undefined : JSON.stringify(body));
	});
}

async function setup(
	scenario: Parameters<typeof createHomeFixture>[0] = {
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
	},
) {
	fx = createHomeFixture(scenario);
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
	await registerHomeRoutes(app, home, new HomeSearch(home));
	return { app, config: () => config };
}

describe("/api/home", () => {
	it("whole=1 answers a cold repo only whole; anything else gets its batches (CAR-290)", async () => {
		// 15 PRs: a first batch of 10, then 5 (held).
		const prs = Array.from({ length: 15 }, (_, i) =>
			homePr({
				repo: "acme/api",
				number: i + 1,
				author: "Octo",
				updatedAt: iso(Date.now() - (i + 1) * 1000),
			}),
		);
		const { app } = await setup({
			repos: { "acme/api": { prs } },
			hold: ["homePr:11"],
		});
		const get = (query: string) =>
			app
				.inject({ method: "GET", url: `/api/home/repos/acme/api${query}` })
				.then((r) => r.json<RepoHome>());
		let wholeDone = false;
		const whole = get("?whole=1").then((r) => {
			wholeDone = true;
			return r;
		});
		// The first batch is in: a plain ask and a misspelt one get it.
		for (const query of ["", "?whole=yes", "?whole=true"]) {
			const partial = await get(query);
			expect(partial, query).toMatchObject({ complete: false });
			expect(partial.rows, query).toHaveLength(10);
		}
		expect(wholeDone).toBe(false);
		release(fx?.path ?? "", "homePr:11");
		const answer = await whole;
		expect(answer).toMatchObject({ complete: true });
		expect(answer.rows).toHaveLength(15);
	});

	it("GET answers the view without reading a repo; each repo has its own GET", async () => {
		const { app } = await setup();
		const res = await app.inject({ method: "GET", url: "/api/home" });
		expect(res.statusCode).toBe(200);
		const view = res.json<HomeView>();
		expect(view.view.repos).toEqual(["acme/api"]);
		expect(view).not.toHaveProperty("sections");
		expect(fx?.ghLog()).not.toMatch(/pullRequests/);
		const repo = await app.inject({
			method: "GET",
			url: "/api/home/repos/acme/api",
		});
		expect(repo.statusCode).toBe(200);
		const answer = repo.json<RepoHome>();
		expect(answer.repo).toBe("acme/api");
		expect(answer.rows.map((r) => [r.number, r.section])).toEqual([
			[1, "mine"],
		]);
		expect(answer.refreshedAt).not.toBe(null);
		// Fresh: the cache answers; fresh=1 reads again.
		const reads = () => (fx?.ghLog().match(/withOpen=/g) ?? []).length;
		const before = reads();
		await app.inject({ method: "GET", url: "/api/home/repos/acme/api" });
		expect(reads()).toBe(before);
		await app.inject({
			method: "GET",
			url: "/api/home/repos/acme/api?fresh=1",
		});
		expect(reads()).toBe(before + 1);
	});

	it("a repo out of the view is served (any repo the settings may add); a malformed one 400", async () => {
		const { app } = await setup();
		const out = await app.inject({
			method: "GET",
			url: "/api/home/repos/other/tool",
		});
		expect(out.statusCode).toBe(200);
		expect(out.json<RepoHome>().repo).toBe("other/tool");
		const bad = await app.inject({
			method: "GET",
			url: "/api/home/repos/-x/tool",
		});
		expect(bad.statusCode).toBe(400);
		// `seen` is a batch count: a whole number, nothing else.
		for (const seen of ["-1", "x", "1.5", "01", "9999999999"]) {
			const res = await app.inject({
				method: "GET",
				url: `/api/home/repos/acme/api?seen=${seen}`,
			});
			expect(res.statusCode, seen).toBe(400);
		}
		const seen = await app.inject({
			method: "GET",
			url: "/api/home/repos/acme/api?seen=0",
		});
		expect(seen.json<RepoHome>()).toMatchObject({ complete: true });
		// A dot segment is never a repo: it would name a path, not a clone.
		// A browser drops it from the URL, a raw request doesn't (inject
		// normalizes as a browser does, so this goes over a socket).
		const base = await app.listen({ port: 0, host: "127.0.0.1" });
		for (const dots of [".", ".."]) {
			const get = await raw(base, "GET", `/api/home/repos/acme/${dots}`);
			expect(get.status, `${dots} ${get.body}`).toBe(400);
			const post = await raw(
				base,
				"POST",
				`/api/home/prs/acme/${dots}/1/annotations`,
				{ op: "wake" },
			);
			expect(post.status, `${dots} ${post.body}`).toBe(400);
		}
	});

	it("GET and a repo's GET answer 200 with the reason while gh is logged out", async () => {
		const { app } = await setup();
		fx?.scenario({ loggedOut: true });
		const view = await app.inject({ method: "GET", url: "/api/home" });
		expect(view.statusCode).toBe(200);
		expect(view.json<HomeView>().viewerError).toMatch(
			/gh auth login|not logged in/i,
		);
		const repo = await app.inject({
			method: "GET",
			url: "/api/home/repos/acme/api",
		});
		expect(repo.statusCode).toBe(200);
		expect(repo.json<RepoHome>().error).toMatch(/gh auth login|not logged in/i);
	});

	it("annotations: each op, the row back", async () => {
		const { app } = await setup();
		await app.inject({ method: "GET", url: "/api/home/repos/acme/api" });
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
		await app.inject({ method: "GET", url: "/api/home/repos/acme/api" });
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

	it("PUT view writes the config's repos at once, asking GitHub nothing", async () => {
		const { app, config } = await setup();
		const res = await app.inject({
			method: "PUT",
			url: "/api/home/view",
			payload: { repos: ["Acme/API", "acme/nowhere"] },
		});
		expect(res.statusCode).toBe(200);
		expect(config().views[0]?.repos).toEqual(["acme/api", "acme/nowhere"]);
		expect(res.json<HomeView>().view.repos).toEqual([
			"acme/api",
			"acme/nowhere",
		]);
		expect(fx?.ghLog()).toBe("");
		// The typo answers its own error once read.
		const typo = await app.inject({
			method: "GET",
			url: "/api/home/repos/acme/nowhere",
		});
		expect(typo.json<RepoHome>().error).toBe("Not found on GitHub");
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
		await app.inject({ method: "GET", url: "/api/home/repos/acme/api" });
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
		const repos = await app.inject({
			method: "GET",
			url: `/api/home/search?q=${encodeURIComponent("login")}&only=repos`,
		});
		expect(repos.statusCode).toBe(200);
		expect(repos.json<SearchResult>().prs).toEqual([]);
		const bad = await app.inject({
			method: "GET",
			url: "/api/home/search?q=x&only=prs",
		});
		expect(bad.statusCode).toBe(400);
	});

	it("GET people answers a PeopleResult", async () => {
		const { app } = await setup();
		fx?.scenario({ orgMembers: { acme: ["Octo", "olga"] } });
		await app.inject({ method: "GET", url: "/api/home/repos/acme/api" });
		const people = await vi.waitFor(
			async () => {
				const res = await app.inject({
					method: "GET",
					url: "/api/home/people?q=o",
				});
				expect(res.statusCode).toBe(200);
				const answer = res.json<PeopleResult>();
				if (answer.pending) throw new Error("people still pending");
				return answer;
			},
			{ timeout: 10_000, interval: 50 },
		);
		// Never the viewer: "Me" is theirs.
		expect(people.close.map((p) => p.login)).toEqual(["olga"]);
		const long = await app.inject({
			method: "GET",
			url: `/api/home/people?q=${"x".repeat(301)}`,
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
