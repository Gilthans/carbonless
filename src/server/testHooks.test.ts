import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prView, release, reviewThread } from "../../test/fake-gh/scenario";
import { fakeGhServerCalls } from "../../test/fake-gh/server.mjs";
import { GIT_TEST_TIMEOUTS } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import { buildApp } from "./app";
import { ghRunning } from "./gh";
import { gitChildren } from "./git";
import { SessionRegistry } from "./registry";
import { startServer } from "./serve";
import {
	type ResetAnswer,
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
		await vi.waitFor(() => expect(ghRunning().calls).not.toHaveLength(0), {
			timeout: 10_000,
		});
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
