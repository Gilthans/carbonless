import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	letThrough,
	prView,
	release,
	reviewThread,
} from "../../test/fake-gh/scenario";
import { fakeGhServerCalls } from "../../test/fake-gh/server.mjs";
import { GIT_TEST_TIMEOUTS } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import { buildApp } from "./app";
import { ghRunning, runGh } from "./gh";
import { gitChildren } from "./git";
import { HomeService } from "./home/homeService";
import { SessionRegistry } from "./registry";
import { startServer } from "./serve";
import { Session } from "./session";
import {
	type ResetAnswer,
	registerTestHooks,
	TEST_HOOK_HEADER,
	type TestState,
	testHookToken,
} from "./testHooks";
import { createTracer } from "./trace";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("test hooks", () => {
	let pr: PrFixture;
	let registry: SessionRegistry;
	let app: FastifyInstance | undefined;
	let host: string;

	const serve = async (testHooks: string | null) => {
		app = await buildApp(registry, { accessKey: null, testHooks });
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		host = `127.0.0.1:${address.port}`;
		return app;
	};
	const call = (
		method: "GET" | "POST",
		url: string,
		token: string | null = TOKEN,
		extra: Record<string, string> = {},
	) =>
		(app as FastifyInstance).inject({
			method,
			url,
			headers: {
				host,
				...(token === null ? {} : { [TEST_HOOK_HEADER]: token }),
				...extra,
			},
		});
	const reset = async (): Promise<ResetAnswer> => {
		const res = await call("POST", "/api/_test/reset");
		expect(res.statusCode, res.body).toBe(200);
		return res.json();
	};

	beforeEach(() => {
		pr = createPrFixture();
		registry = new SessionRegistry();
	});
	afterEach(async () => {
		await app?.close();
		app = undefined;
		await registry.closeAll();
		await pr.cleanup();
	});

	it("takes only a 32-hex token from the environment", () => {
		expect(testHookToken(TOKEN)).toBe(TOKEN);
		for (const bad of [undefined, "", "1", TOKEN.toUpperCase(), `${TOKEN}0`]) {
			expect(testHookToken(bad)).toBeNull();
		}
	});

	it("without a token the routes don't exist (404)", async () => {
		await serve(null);
		await registry.open({ pr: pr.arg });
		expect((await call("POST", "/api/_test/reset")).statusCode).toBe(404);
		expect((await call("GET", "/api/_test/state")).statusCode).toBe(404);
		expect(registry.openIds()).toHaveLength(1);
	});

	it("a wrong or missing token is refused (403) and resets nothing", async () => {
		await serve(TOKEN);
		const { session } = await registry.open({ pr: pr.arg });
		for (const token of [null, "", "f".repeat(32), TOKEN.slice(1)]) {
			for (const [method, url] of [
				["POST", "/api/_test/reset"],
				["GET", "/api/_test/state"],
			] as const) {
				const res = await call(method, url, token);
				expect(res.statusCode, `${method} ${url} ${token}`).toBe(403);
			}
		}
		expect(session.closed).toBe(false);
		expect(registry.openIds()).toHaveLength(1);
	});

	it("sits behind the host check", async () => {
		await serve(TOKEN);
		await registry.open({ pr: pr.arg });
		const res = await call("POST", "/api/_test/reset", TOKEN, {
			host: "evil.example",
		});
		expect(res.statusCode).toBe(403);
		expect(registry.openIds()).toHaveLength(1);
	});

	it("reset closes a session whose background gh read is held: it stops, and a fresh open works", async () => {
		await serve(TOKEN);
		const { id, session } = await registry.open({ pr: pr.arg });
		// A read whose threads GitHub holds: it runs on in the background.
		pr.scenario({
			hold: ["threads"],
			prs: {
				12: {
					view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
					graphql: { reviewThreads: [reviewThread({ path: "a.txt" })] },
				},
			},
		});
		await session.overview(0);
		// Held once the fake gh has logged it: the log is written inside the
		// call, before its hold. (crb's own count goes up at the spawn, before
		// the fake gh has the call: not yet running there.)
		await vi.waitFor(
			() => expect(pr.ghLog()).toMatch(/reviewThreads[\s\S]*viewerCanResolve/),
			{ timeout: 10_000 },
		);
		expect(ghRunning().calls).not.toHaveLength(0);
		expect(fakeGhServerCalls().running).toBeGreaterThan(0);

		const answer = await reset();
		expect(answer).toEqual({
			closed: 1,
			ghInFlight: 0,
			ghChildren: 0,
			gitChildren: 0,
			leftovers: [],
		});
		expect(session.closed).toBe(true);
		expect(gitChildren()).toEqual([]);
		// The held gh was killed: the fake gh serves nothing more of it.
		await vi.waitFor(() => expect(fakeGhServerCalls().running).toBe(0), {
			timeout: 10_000,
		});
		const calls = pr.ghLog();
		release(process.env.CRB_FAKE_GH ?? "", "threads");
		await new Promise((r) => setTimeout(r, 300));
		expect(pr.ghLog()).toBe(calls);

		// The registry still works: the same PR opens a new session.
		const again = await registry.open({ pr: pr.arg });
		expect(again.id).toBe(id);
		expect(again.session).not.toBe(session);
		expect(again.session.closed).toBe(false);
		expect((await again.session.overview()).title).toBe("Add widget cache");
	});

	/** A bare server with the hooks and a short wait (no host check). */
	const quickHooks = async (settleMs: number, home?: HomeService) => {
		const quick = Fastify();
		await registerTestHooks(quick, {
			token: TOKEN,
			registry,
			settleMs,
			...(home ? { home } : {}),
		});
		return {
			reset: async (): Promise<ResetAnswer> => {
				const res = await quick.inject({
					method: "POST",
					url: "/api/_test/reset",
					headers: { [TEST_HOOK_HEADER]: TOKEN },
				});
				expect(res.statusCode, res.body).toBe(200);
				return res.json();
			},
			close: () => quick.close(),
		};
	};
	/** Sessions closed so far (close() calls, by session). */
	const closes = () => {
		const spy = vi.spyOn(Session.prototype, "close");
		return {
			sessions: () => spy.mock.contexts as Session[],
			restore: () => spy.mockRestore(),
		};
	};
	const views = () => (pr.ghLog().match(/^pr view /gm) ?? []).length;

	it("a reset doesn't wait past its deadline for an open GitHub holds: it names it, and the open closes what it lands with", async () => {
		const hooks = await quickHooks(300);
		const closed = closes();
		try {
			pr.scenario({ hold: ["prView"] });
			const before = views();
			const opening = registry.open({ pr: pr.arg });
			opening.catch(() => {});
			await vi.waitFor(() => expect(views()).toBeGreaterThan(before), {
				timeout: 10_000,
			});
			const answer = await hooks.reset();
			expect(answer.closed).toBe(0);
			expect(answer.leftovers).toContain(`open ${pr.arg} (pending)`);
			expect(answer.ghInFlight).toBeGreaterThan(0);

			release(process.env.CRB_FAKE_GH ?? "", "prView");
			await expect(opening).rejects.toThrow("The server was reset");
			expect(registry.openIds()).toEqual([]);
			const late = closed.sessions();
			expect(late).toHaveLength(1);
			await vi.waitFor(() => expect(late[0]?.closed).toBe(true));
			// The next reset finds nothing left.
			const again = await hooks.reset();
			expect(again).toMatchObject({ closed: 0, leftovers: [] });
		} finally {
			closed.restore();
			await hooks.close();
		}
	});

	it("a Home read that lands while the reset waits leaves nothing cached", async () => {
		// Home's config read answers only when the test says so.
		let answer: (() => void) | undefined;
		const config = {
			views: [{ name: "My PRs", repos: ["acme/api"] }],
			refresh: { minutes: 5 },
		};
		const home = new HomeService({
			config: {
				read: () =>
					new Promise((resolve) => {
						answer = () => resolve({ config, problems: [] });
					}),
				update: async () => config,
			},
		});
		const hooks = await quickHooks(20_000, home);
		const homeResets = vi.spyOn(home, "reset");
		try {
			const reading = home.repo("acme", "api");
			reading.catch(() => {});
			await vi.waitFor(() => expect(answer).toBeDefined());
			// A gh call the reset waits for (no session's: it stops for none).
			pr.scenario({ hold: ["prView"] });
			const view = runGh([
				"pr",
				"view",
				"12",
				"-R",
				"acme/widget",
				"--json",
				"title",
			]);
			view.catch(() => {});
			await vi.waitFor(() => expect(ghRunning().calls).not.toHaveLength(0));
			const resetting = hooks.reset();
			// Home was cleared; its read, past that await, writes meanwhile.
			await vi.waitFor(() => expect(homeResets).toHaveBeenCalledTimes(1));
			answer?.();
			await vi.waitFor(() => expect(home.cachedRepos()).toEqual(["acme/api"]));
			release(process.env.CRB_FAKE_GH ?? "", "prView");
			expect((await resetting).leftovers).toEqual([]);
			expect(home.cachedRepos()).toEqual([]);
			await reading;
		} finally {
			homeResets.mockRestore();
			await hooks.close();
		}
	});

	it("an open or reopen while a reset runs is refused; the reset leaves nothing open", async () => {
		const { id } = await registry.open({ pr: pr.arg });
		// The reset is held up by an open GitHub holds.
		pr.scenario({ hold: ["prView"] });
		const before = views();
		const held = registry.open({ pr: pr.arg, viewer: "someone" });
		held.catch(() => {});
		await vi.waitFor(() => expect(views()).toBeGreaterThan(before), {
			timeout: 10_000,
		});
		const resetting = registry.reset(20_000);
		// A straggler of the test that ended: a reopen by id, another form of
		// the open. GitHub would answer them (letThrough).
		letThrough(process.env.CRB_FAKE_GH ?? "", "prView");
		await expect(registry.get(id)).rejects.toThrow("The server is resetting");
		await expect(
			registry.open({ pr: "https://github.com/acme/widget/pull/12" }),
		).rejects.toThrow("The server is resetting");
		release(process.env.CRB_FAKE_GH ?? "", "prView");
		expect(await resetting).toEqual({ closed: 1, pending: [] });
		await expect(held).rejects.toThrow("The server was reset");
		expect(registry.openIds()).toEqual([]);
		// After it, opens work again.
		expect((await registry.open({ pr: pr.arg })).id).toBe(id);
	});

	it("a reopen by id begun before a reset opens nothing after it", async () => {
		const { id } = await registry.open({ pr: pr.arg });
		await registry.reset();
		// Reopened by id (a bookmark): its pr view is held.
		pr.scenario({ hold: ["prView"] });
		const before = views();
		const reopening = registry.get(id);
		reopening.catch(() => {});
		await vi.waitFor(() => expect(views()).toBeGreaterThan(before), {
			timeout: 10_000,
		});
		const resetting = registry.reset(20_000);
		release(process.env.CRB_FAKE_GH ?? "", "prView");
		expect(await resetting).toEqual({ closed: 0, pending: [] });
		await expect(reopening).rejects.toThrow("The server was reset");
		expect(registry.openIds()).toEqual([]);
	});

	it("after a reset, a request form opened before reads GitHub again, as in a fresh process", async () => {
		await registry.open({ pr: pr.arg });
		await registry.reset();
		// Another form of the same PR opens the review again.
		await registry.open({ pr: "https://github.com/acme/widget/pull/12" });
		const before = views();
		// The first form: no memory of it, so a fresh open (its pr view).
		await registry.open({ pr: pr.arg });
		expect(views()).toBeGreaterThan(before);
	});

	it("after a reset, the same PR opened again is a new session; state shows it", async () => {
		await serve(TOKEN);
		const first = await registry.open({ pr: pr.arg });
		const state = async (): Promise<TestState> =>
			(await call("GET", "/api/_test/state")).json();
		expect((await state()).sessions).toEqual([first.id]);
		expect((await reset()).closed).toBe(1);
		const after = await state();
		expect(after.sessions).toEqual([]);
		expect(after.homeRepos).toEqual([]);
		expect(after.rss).toBeGreaterThan(0);
		expect(after.gh).toEqual([]);
		expect(after.git).toEqual([]);
		const second = await registry.open({ pr: pr.arg });
		expect(second.session).not.toBe(first.session);
		expect(first.session.closed).toBe(true);
		// An empty server resets to the same.
		expect(await reset()).toMatchObject({ closed: 1 });
		expect(await reset()).toMatchObject({ closed: 0 });
	});
});

describe("crb serve's test hooks", () => {
	let dir: string;
	const saved = {
		state: process.env.XDG_STATE_HOME,
		config: process.env.XDG_CONFIG_HOME,
		hooks: process.env.CRB_TEST_HOOKS,
	};
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-hooks-"));
		process.env.XDG_STATE_HOME = join(dir, "state");
		process.env.XDG_CONFIG_HOME = join(dir, "config");
	});
	afterEach(() => {
		for (const [k, v] of Object.entries({
			XDG_STATE_HOME: saved.state,
			XDG_CONFIG_HOME: saved.config,
			CRB_TEST_HOOKS: saved.hooks,
		})) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(dir, { recursive: true, force: true });
	});
	const reset = async (env: string | undefined) => {
		if (env === undefined) delete process.env.CRB_TEST_HOOKS;
		else process.env.CRB_TEST_HOOKS = env;
		const log: string[] = [];
		const s = await startServer({ port: 0, log: (m) => log.push(m) });
		// Read once, then gone: no gh, git or agent child inherits it.
		expect(process.env.CRB_TEST_HOOKS).toBeUndefined();
		try {
			const res = await fetch(`${s.url}/api/_test/reset`, {
				method: "POST",
				headers: { [TEST_HOOK_HEADER]: TOKEN },
			});
			return { status: res.status, log };
		} finally {
			await s.close();
		}
	};

	it("has none unless $CRB_TEST_HOOKS holds a token", async () => {
		expect((await reset(undefined)).status).toBe(404);
		const bad = await reset("not-a-token");
		expect(bad.status).toBe(404);
		expect(bad.log).toContain(
			"CRB_TEST_HOOKS is not a 32-hex token: test hooks off",
		);
		expect((await reset(TOKEN)).status).toBe(200);
	});
});

describe("request spans", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-req-trace-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const spans = () =>
		readdirSync(dir).flatMap((f) =>
			readFileSync(join(dir, f), "utf8")
				.trim()
				.split("\n")
				.flatMap(
					(line) =>
						JSON.parse(line).resourceSpans[0].scopeSpans[0].spans as {
							name: string;
							traceId: string;
							parentSpanId?: string;
						}[],
				),
		);

	it("go under an incoming traceparent of another trace; in the server's own trace, or without one, as before", async () => {
		const tracer = createTracer({
			dir,
			service: "crb",
			flushOnExit: false,
		});
		const parent = tracer.start("server root");
		tracer.setDefaultParent(parent.context);
		const registry = new SessionRegistry();
		const app = await buildApp(registry, { accessKey: null, tracer });
		try {
			const headers = { host: "127.0.0.1" };
			await app.inject({
				url: "/api/version",
				headers: {
					...headers,
					traceparent:
						"00-0123456789abcdef0123456789abcdef-0011223344556677-01",
				},
			});
			await app.inject({ url: "/api/version", headers });
			// The server's own trace (the test that started it): under the
			// server's span, where its own gits and gh already are.
			await app.inject({
				url: "/api/version",
				headers: {
					...headers,
					traceparent: `00-${parent.context?.traceId}-8899aabbccddeeff-01`,
				},
			});
			// Not a traceparent: as without one.
			await app.inject({
				url: "/api/version",
				headers: { ...headers, traceparent: "nonsense" },
			});
		} finally {
			await app.close();
			await registry.closeAll();
		}
		tracer.flush();
		const requests = spans().filter((s) => s.name === "GET /api/version");
		expect(requests).toHaveLength(4);
		expect(requests[0]).toMatchObject({
			traceId: "0123456789abcdef0123456789abcdef",
			parentSpanId: "0011223344556677",
		});
		for (const s of requests.slice(1)) {
			expect(s).toMatchObject({
				traceId: parent.context?.traceId,
				parentSpanId: parent.context?.spanId,
			});
		}
	});
});
