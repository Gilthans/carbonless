import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import type { ReviewView, SessionInfo } from "../shared/types";
import { buildApp } from "./app";
import { Session } from "./session";

describe("API", () => {
	let pr: PrFixture;
	let session: Session;
	let app: FastifyInstance;
	let host: string;

	beforeEach(async () => {
		pr = createPrFixture();
		session = await Session.open(pr.arg, process.cwd());
		app = await buildApp(session, { accessKey: null });
		// The loopback Host check needs the real listening port.
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		host = `127.0.0.1:${address.port}`;
	});
	afterEach(async () => {
		await app.close();
		pr.cleanup();
	});

	const inject = (url: string, extra: Record<string, unknown> = {}) =>
		app.inject({ method: "GET", url, headers: { host }, ...extra });
	const get = async (url: string) => {
		const res = await inject(url);
		expect(res.statusCode, res.body).toBe(200);
		return res.json();
	};
	const post = (url: string, payload?: unknown) =>
		inject(url, { method: "POST", payload: payload as object });
	const revision = async (): Promise<string> =>
		(await get("/api/review")).revision;
	const keys = (view: ReviewView) =>
		view.files.flatMap((f) => f.clusters.map((c) => c.key));

	it("serves the review for the PR head before any check-off", async () => {
		const info: SessionInfo = await get("/api/session");
		expect(info.patchset).toBeNull();
		expect(info.snapshotHead).toBe(pr.head());
		const view: ReviewView = await get("/api/review");
		expect(view.patchset).toBeNull();
		expect(view.progress.clusters.total).toBe(3);
		expect(await get("/api/overview")).toMatchObject({
			title: "Add widget cache",
			number: 12,
		});
	});

	it("serves the kept overview, or one read at most maxAge ms ago", async () => {
		const first = await get("/api/overview");
		expect(await get("/api/overview")).toEqual(first);
		expect(await get("/api/overview?maxAge=600000")).toEqual(first);
		const fresh = await get("/api/overview?maxAge=0");
		expect(Date.parse(fresh.fetchedAt)).toBeGreaterThanOrEqual(
			Date.parse(first.fetchedAt),
		);
		for (const bad of ["-1", "1.5", "soon", ""]) {
			const res = await inject(`/api/overview?maxAge=${bad}`);
			expect(res.statusCode, bad).toBe(400);
		}
	});

	it("records a state and returns updated progress", async () => {
		const [key = ""] = keys(await get("/api/review"));
		const res = await post("/api/review/states", {
			revision: await revision(),
			changes: [{ key, state: "reviewed" }],
		});
		expect(res.statusCode, res.body).toBe(200);
		const view: ReviewView = res.json();
		expect(view.patchset).toBe(1);
		expect(view.progress.clusters.reviewed).toBe(1);
		expect((await get("/api/session")).patchset).toBe(1);
		expect((await get("/api/review")).progress.clusters.reviewed).toBe(1);
	});

	it("rejects a state for an unknown cluster with 400", async () => {
		const res = await post("/api/review/states", {
			revision: await revision(),
			changes: [{ key: "nope", state: "reviewed" }],
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain("nope");
	});

	it.each([
		["no body", undefined],
		["no changes", { revision: "x" }],
		["changes not an array", { revision: "x", changes: {} }],
		["non-string key", { revision: "x", changes: [{ key: 1 }] }],
		[
			"unknown state",
			{ revision: "x", changes: [{ key: "k", state: "done" }] },
		],
		[
			"non-string reason",
			{
				revision: "x",
				changes: [{ key: "k", state: "crossed-off", reason: 5 }],
			},
		],
		[
			"reason too long",
			{
				revision: "x",
				changes: [{ key: "k", state: "crossed-off", reason: "r".repeat(501) }],
			},
		],
		[
			"too many changes",
			{
				revision: "x",
				changes: Array.from({ length: 1001 }, () => ({
					key: "k",
					state: "reviewed",
				})),
			},
		],
	])("rejects a bad body (%s) with 400", async (_, body) => {
		const res = await post("/api/review/states", body);
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBeTruthy();
	});

	it("crosses off without a reason", async () => {
		const [key = ""] = keys(await get("/api/review"));
		const res = await post("/api/review/states", {
			revision: await revision(),
			changes: [{ key, state: "crossed-off" }],
		});
		expect(res.statusCode).toBe(200);
		const view: ReviewView = res.json();
		const cluster = view.files
			.flatMap((f) => f.clusters)
			.find((c) => c.key === key);
		expect(cluster?.state).toBe("crossed-off");
		expect(cluster).not.toHaveProperty("reason");
		expect(view.progress.clusters.reviewed).toBe(0);
	});

	it("rejects a write from a review the PR has moved off with 409", async () => {
		// The tab loaded the review, then a refresh moved it to a new head on
		// which the same cluster key still exists.
		const view: ReviewView = await get("/api/review");
		const [key = ""] = keys(view);
		const newHead = pr.moveHead({ "later.txt": "later\n" });
		const refreshed = await post("/api/refresh");
		expect(refreshed.statusCode).toBe(200);
		expect(refreshed.json()).toMatchObject({ snapshotHead: newHead });
		expect(keys(await get("/api/review"))).toContain(key);
		const res = await post("/api/review/states", {
			revision: view.revision,
			changes: [{ key, state: "reviewed" }],
		});
		expect(res.statusCode).toBe(409);
		expect(res.json()).toEqual({ error: "stale" });
		expect((await get("/api/review")).patchset).toBeNull();
	});

	it("rejects a write after only the base moved with 409", async () => {
		const first = pr.head();
		pr.moveHead({ "later.txt": "later\n" });
		await post("/api/refresh");
		const view: ReviewView = await get("/api/review");
		const [key = ""] = keys(view);
		pr.moveMain(first);
		const info = (await post("/api/refresh")).json();
		expect(info).toMatchObject({ snapshotHead: pr.head(), headMoved: false });
		const res = await post("/api/review/states", {
			revision: view.revision,
			changes: [{ key, state: "reviewed" }],
		});
		expect(res.statusCode).toBe(409);
		expect((await get("/api/review")).patchset).toBeNull();
	});

	it("keeps a started review on its snapshot after the PR moves", async () => {
		const oldHead = pr.head();
		const [key = ""] = keys(await get("/api/review"));
		await post("/api/review/states", {
			revision: await revision(),
			changes: [{ key, state: "reviewed" }],
		});
		const newHead = pr.moveHead({ "later.txt": "later\n" });
		expect(await get("/api/head")).toMatchObject({
			headMoved: true,
			currentHead: newHead,
		});
		const info = (await post("/api/refresh")).json();
		expect(info).toMatchObject({
			headMoved: true,
			snapshotHead: oldHead,
			currentHead: newHead,
			patchset: 1,
		});
		expect((await get("/api/review")).progress.clusters.reviewed).toBe(1);
	});

	it("serves hunks and context lines of the client's revision", async () => {
		const rev = await revision();
		const hunks = await get(`/api/files/0/hunks?revision=${rev}`);
		expect(hunks.hunks).toHaveLength(2);
		const lines = await get(
			`/api/files/0/context?revision=${rev}&newFrom=10&newTo=11`,
		);
		expect(lines).toEqual([
			{ kind: "context", oldNo: 10, newNo: 10, text: "line 10" },
			{ kind: "context", oldNo: 11, newNo: 11, text: "line 11" },
		]);
	});

	it("answers hunks and context of another revision with 409", async () => {
		const old = await revision();
		pr.moveHead({ "later.txt": "later\n" });
		await post("/api/refresh");
		for (const url of [
			`/api/files/0/hunks?revision=${old}`,
			`/api/files/0/context?revision=${old}&newFrom=1&newTo=2`,
		]) {
			const res = await inject(url);
			expect(res.statusCode).toBe(409);
			expect(res.json()).toEqual({ error: "stale" });
		}
	});

	it.each([
		["/api/files/-1/hunks?revision=R", 400],
		["/api/files/1.5/hunks?revision=R", 400],
		["/api/files/x/hunks?revision=R", 400],
		["/api/files/0/hunks", 400],
		["/api/files/99/hunks?revision=R", 404],
		["/api/files/0/context?revision=R", 400],
		["/api/files/0/context?newFrom=1&newTo=3", 400],
		["/api/files/0/context?revision=R&newFrom=0&newTo=3", 400],
		["/api/files/0/context?revision=R&newFrom=5&newTo=3", 400],
		["/api/files/0/context?revision=R&newFrom=a&newTo=3", 400],
		["/api/files/99/context?revision=R&newFrom=1&newTo=3", 404],
		["/api/nope", 404],
	])("answers %s with %i", async (url, status) => {
		const res = await inject(url.replace("R", await revision()));
		expect(res.statusCode).toBe(status);
		expect(res.json().error).toBeTruthy();
	});

	it.each([
		["a foreign host", { host: "evil.example:80" }],
		["loopback on another port", { host: "127.0.0.1:1" }],
		["no host", { host: "" }],
	])("refuses %s with 403 (DNS rebinding)", async (_, headers) => {
		const res = await app.inject({ url: "/api/session", headers });
		expect(res.statusCode).toBe(403);
		expect(res.json().error).toBeTruthy();
	});

	it("accepts every loopback spelling of its own host", async () => {
		const port = host.split(":")[1];
		for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "[::1]"]) {
			const res = await app.inject({
				url: "/api/session",
				headers: { host: `${h}:${port}` },
			});
			expect(res.statusCode, h).toBe(200);
		}
	});

	it("refuses writes from another origin with 403", async () => {
		const evil = await inject("/api/refresh", {
			method: "POST",
			headers: { host, origin: "http://evil.example" },
		});
		expect(evil.statusCode).toBe(403);
		const own = await inject("/api/refresh", {
			method: "POST",
			headers: { host, origin: `http://${host}` },
		});
		expect(own.statusCode).toBe(200);
		// Reads don't need an Origin check: the Host check covers them.
		const read = await inject("/api/session", {
			headers: { host, origin: "http://evil.example" },
		});
		expect(read.statusCode).toBe(200);
	});

	const SECURITY_HEADERS = {
		"x-frame-options": "DENY",
		"content-security-policy": "frame-ancestors 'none'",
		"referrer-policy": "no-referrer",
	};

	it("sends security headers on every response", async () => {
		const responses = [
			await inject("/api/session"),
			await inject("/api/nope"),
			await inject("/api/files/x/hunks"),
			await inject("/api/session", { headers: { host: "evil.example" } }),
		];
		expect(responses.map((r) => r.statusCode)).toEqual([200, 404, 400, 403]);
		for (const res of responses)
			expect(res.headers).toMatchObject(SECURITY_HEADERS);
	});

	it("closes without waiting for an open browser connection", async () => {
		// A browser keeps preconnected and keep-alive sockets open; a socket
		// stuck mid-request is the worst case.
		const [hostname, port] = host.split(":");
		const socket = connect(Number(port), hostname);
		await new Promise<void>((done) => socket.once("connect", () => done()));
		socket.write(`GET /api/session HTTP/1.1\r\nHost: ${host}\r\n`);
		socket.on("error", () => {});
		const started = Date.now();
		await app.close();
		expect(Date.now() - started).toBeLessThan(1000);
		socket.destroy();
	});

	it("maps a gh failure to 502", async () => {
		pr.scenario({ prs: {} });
		const res = await inject("/api/head");
		expect(res.statusCode).toBe(502);
		expect(res.json()).toEqual({ error: "PR acme/widget#12 not found" });
	});

	describe("with a web root and an access key", () => {
		let web: string;
		let keyed: FastifyInstance;

		beforeEach(async () => {
			web = mkdtempSync(join(tmpdir(), "crb-web-"));
			mkdirSync(join(web, "assets"));
			writeFileSync(join(web, "index.html"), "<p>spa</p>");
			writeFileSync(join(web, "assets", "app.js"), "js();");
			keyed = await buildApp(session, { webRoot: web, accessKey: "k3y" });
		});
		afterEach(async () => {
			await keyed.close();
			rmSync(web, { recursive: true, force: true });
		});

		it("checks the key on API and static requests", async () => {
			for (const url of ["/", "/files", "/assets/app.js", "/api/session"]) {
				expect((await keyed.inject(url)).statusCode).toBe(401);
			}
			const cookies = { crb_key: "k3y" };
			const page = await keyed.inject({ url: "/assets/app.js", cookies });
			expect(page.body).toBe("js();");
			const api = await keyed.inject({ url: "/api/session", cookies });
			expect(api.statusCode).toBe(200);
		});

		it("sends security headers on static, 401 and SPA responses", async () => {
			const cookies = { crb_key: "k3y" };
			const responses = [
				await keyed.inject("/files"),
				await keyed.inject({ url: "/assets/app.js", cookies }),
				await keyed.inject({ url: "/files", cookies }),
			];
			expect(responses.map((r) => r.statusCode)).toEqual([401, 200, 200]);
			for (const res of responses) {
				expect(res.headers).toMatchObject(SECURITY_HEADERS);
			}
		});

		it("serves index.html for client routes and 404 JSON for unknown API paths", async () => {
			const cookies = { crb_key: "k3y" };
			for (const url of ["/", "/files", "/files?path=a.txt"]) {
				const res = await keyed.inject({ url, cookies });
				expect(res.statusCode).toBe(200);
				expect(res.body).toBe("<p>spa</p>");
			}
			const api = await keyed.inject({ url: "/api/nope", cookies });
			expect(api.statusCode).toBe(404);
			expect(api.json()).toEqual({ error: "Not found" });
		});

		it("accepts any Host but refuses writes from another origin", async () => {
			const cookies = { crb_key: "k3y" };
			const headers = { host: "192.168.1.5:4747" };
			const read = await keyed.inject({
				url: "/api/session",
				cookies,
				headers,
			});
			expect(read.statusCode).toBe(200);
			const evil = await keyed.inject({
				method: "POST",
				url: "/api/refresh",
				cookies,
				headers: { ...headers, origin: "http://evil.example" },
			});
			expect(evil.statusCode).toBe(403);
			const own = await keyed.inject({
				method: "POST",
				url: "/api/refresh",
				cookies,
				headers: { ...headers, origin: "http://192.168.1.5:4747" },
			});
			expect(own.statusCode).toBe(200);
		});
	});
});
