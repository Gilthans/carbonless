import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	prView,
	release,
	reviewThread,
	type Scenario,
	threadComment,
} from "../../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import type {
	CommentsView,
	ReviewThread,
	ReviewView,
	SessionInfo,
} from "../shared/types";
import { buildApp, prTitle, withPrTitle } from "./app";
import type { HomeService } from "./home/homeService";
import { SessionRegistry } from "./registry";
import { ThreadPlacer } from "./rereview/threads";
import { BUILD, VERSION_HEADER } from "./version";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

describe("API", () => {
	let pr: PrFixture;
	let registry: SessionRegistry;
	let id: string;
	let app: FastifyInstance;
	let host: string;
	/** A review route's path for review `of` (this test's by default). */
	const r = (url: string, of = id) =>
		/^\/api\/(?!r\/|version|reviews)/.test(url)
			? url.replace(/^\/api\//, `/api/r/${of}/`)
			: url;

	beforeEach(async () => {
		pr = createPrFixture();
		registry = new SessionRegistry();
		({ id } = await registry.open({ pr: pr.arg }));
		app = await buildApp(registry, { accessKey: null });
		// The loopback Host check needs the real listening port.
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		host = `127.0.0.1:${address.port}`;
	});
	afterEach(async () => {
		await app.close();
		await registry.closeAll();
		await pr.cleanup();
	});

	const inject = (url: string, extra: Record<string, unknown> = {}) =>
		app.inject({ method: "GET", url: r(url), headers: { host }, ...extra });
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
		const same = (o: { readId: string; fetchedAt: string }) => [
			o.readId,
			o.fetchedAt,
		];
		expect(same(await get("/api/overview"))).toEqual(same(first));
		expect(same(await get("/api/overview?maxAge=600000"))).toEqual(same(first));
		// Its age, by the server's clock.
		expect(Date.parse(first.servedAt)).toBeGreaterThanOrEqual(
			Date.parse(first.fetchedAt),
		);
		const fresh = await get("/api/overview?maxAge=0");
		expect(fresh.readId).not.toBe(first.readId);
		expect(Date.parse(fresh.fetchedAt)).toBeGreaterThanOrEqual(
			Date.parse(first.fetchedAt),
		);
		for (const bad of ["-1", "1.5", "soon", ""]) {
			const res = await inject(`/api/overview?maxAge=${bad}`);
			expect(res.statusCode, bad).toBe(400);
		}
	});

	it("serves a read's threads by stage; a read no longer kept is gone (410)", async () => {
		const { readId } = await get("/api/overview");
		for (const stage of ["summary", "first", "firstCode", "full"]) {
			const view = await get(
				`/api/threads?${new URLSearchParams({ read: readId, stage })}`,
			);
			expect(Array.isArray(view.threads), stage).toBe(true);
		}
		const full = await get(
			`/api/threads?${new URLSearchParams({ read: readId, stage: "full" })}`,
		);
		expect(full.complete).toBe(true);
		expect((await inject("/api/threads?read=nope&stage=full")).statusCode).toBe(
			410,
		);
		expect(
			(await inject(`/api/threads?read=${readId}&stage=soon`)).statusCode,
		).toBe(400);
		expect((await inject("/api/threads?stage=full")).statusCode).toBe(400);
	});

	it("serves a read's timeline; 410 for a read no longer kept", async () => {
		const { readId } = await get("/api/overview");
		const view = await get(
			`/api/timeline?${new URLSearchParams({ read: readId })}`,
		);
		expect(Array.isArray(view.events)).toBe(true);
		expect(Array.isArray(view.gaps)).toBe(true);
		expect((await inject("/api/timeline?read=nope")).statusCode).toBe(410);
		expect((await inject("/api/timeline")).statusCode).toBe(400);
	});

	describe("/api/comments", () => {
		/** Threads on the PR (`T12-<i>`). */
		const threads = (over: Partial<Scenario> = {}) => {
			const head = pr.head();
			const said = (login: string, m: number, bot = false) =>
				threadComment({
					login,
					bot,
					text: `${login} at ${m}`,
					createdAt: `2026-01-03T10:0${m}:00Z`,
					commit: head,
				});
			pr.scenario({
				...over,
				prs: {
					12: {
						view: prView({ headRefOid: head, baseRefName: "main" }),
						graphql: {
							reviewThreads: [
								reviewThread({ path: "a.txt", line: 2 }, [
									said("rev", 1),
									said("ci", 2, true),
									said("octo-author", 3),
								]),
								reviewThread({ path: "a.txt", line: 26 }, [said("rev", 4)]),
								reviewThread({ path: "new.txt", line: 1 }, [
									said("Octo_Cat", 5),
									said("octo-author", 6),
								]),
							],
						},
					},
				},
			});
		};
		/** The threads on the PR, and the overview read again to see them. */
		const withThreads = async (over: Partial<Scenario> = {}) => {
			threads(over);
			const { readId } = await get("/api/overview?maxAge=0");
			return readId as string;
		};
		const comments = (read: string, ids: string[]) =>
			`/api/comments?${new URLSearchParams({ read, ids: ids.join(",") })}`;
		const contentReads = () =>
			pr
				.ghLog()
				.split("\n")
				.filter((l) => l.includes("nodes(ids:")).length;

		it("serves every comment of the threads asked for, in the order asked", async () => {
			const readId = await withThreads();
			const view: CommentsView = await get(
				comments(readId, ["T12-1", "T12-0"]),
			);
			expect(view.threads.map((t) => t.threadId)).toEqual(["T12-1", "T12-0"]);
			expect(
				view.threads[1]?.comments.map((c) => [c.author, c.bot, c.text]),
			).toEqual([
				["rev", false, "rev at 1"],
				["ci", true, "ci at 2"],
				["octo-author", false, "octo-author at 3"],
			]);
			expect(view.threads[0]?.comments).toHaveLength(1);
		});

		it("gives each thread its attention set and anchor from the summary on", async () => {
			// The comments' text is held: the summary comes without it.
			const readId = await withThreads({ hold: ["threadContent"] });
			const { threads } = await get(
				`/api/threads?read=${readId}&stage=summary`,
			);
			release(process.env.CRB_FAKE_GH ?? "", "threadContent");
			const byPath = (path: string, line: number) =>
				(threads as ReviewThread[]).find(
					(t) => t.path === path && t.anchor?.line === line,
				);
			expect(byPath("a.txt", 2)).toMatchObject({
				loaded: false,
				attention: ["rev"],
				yourTurn: false,
				anchor: { commit: pr.head(), side: "RIGHT", line: 2, startLine: 2 },
			});
			// The author answered the viewer (gh's Octo_Cat): their turn.
			expect(byPath("new.txt", 1)).toMatchObject({
				attention: ["Octo_Cat"],
				yourTurn: true,
			});
			// The PR author's turn.
			expect(byPath("a.txt", 26)?.attention).toEqual(["octo-author"]);
		});

		it("rejects a missing read or more than 50 ids; 410 for a read no longer kept", async () => {
			expect((await inject("/api/comments?ids=T12-0")).statusCode).toBe(400);
			const { readId } = await get("/api/overview");
			const many = Array.from({ length: 51 }, (_, i) => `T12-${i}`);
			expect((await inject(comments(readId, many))).statusCode).toBe(400);
			expect((await inject(comments("nope", ["T12-0"]))).statusCode).toBe(410);
		});

		it("says which threads' comments will never come: deleted, or not readable", async () => {
			const readId = await withThreads({ deletedThreads: ["T12-1"] });
			const view: CommentsView = await get(
				comments(readId, ["T12-1", "bad id!", "T12-2"]),
			);
			expect(
				view.threads.map((t) => [t.threadId, t.unavailable, t.comments.length]),
			).toEqual([
				["T12-1", "deleted", 0],
				["bad id!", "unreadable", 0],
				["T12-2", undefined, 2],
			]);
		});

		it("fails rather than give fewer comments, and reads again when asked again", async () => {
			const readId = await withThreads({ failGraphql: "nodes(ids:" });
			// The background read fails too.
			expect(
				(await inject(`/api/threads?read=${readId}&stage=full`)).statusCode,
			).toBe(502);
			const failed = await inject(comments(readId, ["T12-0"]));
			expect(failed.statusCode).toBe(502);
			threads();
			const view: CommentsView = await get(comments(readId, ["T12-0"]));
			expect(view.threads[0]?.comments).toHaveLength(3);
		});

		it("two requests after a failed background read make one read again, not two", async () => {
			const readId = await withThreads({ failGraphql: "nodes(ids:" });
			expect(
				(await inject(`/api/threads?read=${readId}&stage=full`)).statusCode,
			).toBe(502);
			threads({ threadContentDelayMs: 300 });
			const before = contentReads();
			const [a, b] = await Promise.all([
				get(comments(readId, ["T12-0", "T12-1"])),
				get(comments(readId, ["T12-1", "T12-0"])),
			]);
			expect(a.threads[0].comments).toHaveLength(3);
			expect(b.threads[1].comments).toHaveLength(3);
			expect(contentReads() - before).toBe(1);
		});

		it("joins the background read for ids on their way: one gh call, not two", async () => {
			const readId = await withThreads({ threadContentDelayMs: 800 });
			await get(`/api/threads?read=${readId}&stage=summary`);
			const view: CommentsView = await get(
				comments(readId, ["T12-0", "T12-1", "T12-2"]),
			);
			expect(view.threads.every((t) => t.comments.length > 0)).toBe(true);
			expect(contentReads()).toBe(1);
			// In by now: served without another read.
			await get(comments(readId, ["T12-2"]));
			expect(contentReads()).toBe(1);
		});
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

	it("names every refused change's key in a 400, storing none", async () => {
		const [key = ""] = keys(await get("/api/review"));
		const res = await post("/api/review/states", {
			revision: await revision(),
			changes: [
				{ key, state: "reviewed" },
				{ key: "ghost1", state: "reviewed" },
				{ key: "ghost2", state: "reviewed" },
			],
		});
		expect(res.statusCode).toBe(400);
		expect(res.json()).toEqual({
			error: "No cluster ghost1 in this snapshot (and 1 more)",
			keys: ["ghost1", "ghost2"],
		});
		const bad = await post("/api/review/states", {
			revision: await revision(),
			changes: [
				{ key, state: "done" },
				{ key: "k2", state: "crossed-off", reason: "x".repeat(10_000) },
			],
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().keys).toEqual([key, "k2"]);
		const view: ReviewView = await get("/api/review");
		expect(view.progress.clusters.reviewed).toBe(0);
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
		const res = await app.inject({ url: r("/api/session"), headers });
		expect(res.statusCode).toBe(403);
		expect(res.json().error).toBeTruthy();
	});

	it("accepts every loopback spelling of its own host", async () => {
		const port = host.split(":")[1];
		for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "[::1]"]) {
			const res = await app.inject({
				url: r("/api/session"),
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
		const dropped = new Promise((done) => socket.once("close", done));
		// The client never lets go: a close() that waited for it would hang
		// until the test times out.
		await app.close();
		await dropped;
	});

	it("maps a gh failure to 502", async () => {
		pr.scenario({ prs: {} });
		const res = await inject("/api/head");
		expect(res.statusCode).toBe(502);
		expect(res.json()).toEqual({ error: "PR acme/widget#12 not found" });
	});

	describe("thread writes", () => {
		const setup = async (
			over: Partial<Scenario> = {},
			reviews: unknown[] = [],
		) => {
			pr.scenario({
				prs: {
					12: {
						view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
						graphql: {
							reviewThreads: [
								reviewThread({ path: "a.txt", line: 2 }, [
									threadComment({
										login: "rev",
										text: "Why?",
										commit: pr.head(),
									}),
								]),
							],
							reviews,
						},
					},
				},
				...over,
			});
			const { readId } = await get("/api/overview?maxAge=0");
			await get(`/api/threads?read=${readId}&stage=summary`);
		};
		const replyTo = (id: string, payload: unknown) =>
			post(`/api/threads/${id}/replies`, payload);
		const ok = {
			body: "Because.",
			attemptedAt: new Date().toISOString(),
			retry: false,
			clientId: "r1",
			knownCommentIds: ["C12-0"],
		};

		it("200: a reply and resolving answer with the thread's new state", async () => {
			await setup();
			const replied = await replyTo("T12-0", ok);
			expect(replied.statusCode, replied.body).toBe(200);
			expect(replied.json()).toMatchObject({
				threadId: "T12-0",
				commentCount: 2,
				attention: ["rev", "octo-author"],
				comment: { body: "Because.", author: "Octo_Cat" },
			});
			const resolved = await post("/api/threads/T12-0/resolved", {
				resolved: true,
			});
			expect(resolved.statusCode, resolved.body).toBe(200);
			expect(resolved.json()).toMatchObject({ resolved: true, attention: [] });
			expect((await get("/api/overview")).writes).toBe("on");
		});

		it("400 invalid: blank or too long a body, bad fields, bad JSON, a bad id", async () => {
			await setup();
			const bad = [
				await replyTo("T12-0", { ...ok, body: "  \n" }),
				await replyTo("T12-0", { ...ok, body: "x".repeat(65537) }),
				await replyTo("T12-0", { ...ok, clientId: 7 }),
				await replyTo("T12-0", { ...ok, knownCommentIds: "C12-0" }),
				await replyTo("T12-0", { body: "Hi" }),
				await inject("/api/threads/T12-0/replies", {
					method: "POST",
					payload: "{nope",
					headers: { host, "content-type": "application/json" },
				}),
				await post("/api/threads/T12-0/resolved", { resolved: "yes" }),
				await replyTo("bad%20id!", ok),
			];
			for (const res of bad) {
				expect(res.statusCode, res.body).toBe(400);
				expect(res.json().code, res.body).toBe("invalid");
			}
			expect(pr.ghLog()).not.toMatch(/-X POST|resolveReviewThread/);
		});

		it("403 writes-off as someone else (--viewer); 403 forbidden with GitHub's message", async () => {
			await setup({ failNext: { op: "resolve", status: 403 } });
			const forbidden = await post("/api/threads/T12-0/resolved", {
				resolved: true,
			});
			expect(forbidden.statusCode).toBe(403);
			expect(forbidden.json()).toEqual({
				code: "forbidden",
				error:
					"Octo_Cat does not have permission to resolve this review thread.",
			});
			const theirs = new SessionRegistry();
			const { id: theirId } = await theirs.open({
				pr: pr.arg,
				viewer: "someone-else",
			});
			const other = await buildApp(theirs, { accessKey: null });
			try {
				await other.listen({ port: 0, host: "127.0.0.1" });
				const address = other.server.address();
				if (!address || typeof address === "string") throw new Error("no port");
				const res = await other.inject({
					method: "POST",
					url: r("/api/threads/T12-0/replies", theirId),
					payload: ok,
					headers: { host: `127.0.0.1:${address.port}` },
				});
				expect(res.statusCode, res.body).toBe(403);
				expect(res.json().code).toBe("writes-off");
			} finally {
				await other.close();
				await theirs.closeAll();
			}
		});

		it("404 gone: the thread no longer exists", async () => {
			await setup();
			await setup({ deletedThreads: ["T12-0"] });
			const res = await replyTo("T12-0", ok);
			expect(res.statusCode).toBe(404);
			expect(res.json().code).toBe("gone");
		});

		it("409 pending-review with the link; 502 for other gh failures", async () => {
			await setup({}, [{ author: { login: "Octo_Cat" }, state: "PENDING" }]);
			expect((await get("/api/overview")).pendingReview).toEqual({
				url: "https://github.com/acme/widget/pull/12/files",
			});
			const pending = await replyTo("T12-0", ok);
			expect(pending.statusCode).toBe(409);
			expect(pending.json()).toMatchObject({
				code: "pending-review",
				url: "https://github.com/acme/widget/pull/12/files",
			});
			await setup({ failNext: { op: "reply", status: 502 } });
			const failed = await replyTo("T12-0", ok);
			expect(failed.statusCode).toBe(502);
			expect(failed.json().error).toMatch(/HTTP 502/);
		});

		it("GitHub's other refusals are refusals, not retried: 400, 401, 410, a GraphQL error without a type", async () => {
			const cases: [Partial<Scenario>, number, string][] = [
				[{ failNext: { op: "reply", status: 400 } }, 400, "invalid"],
				[{ failNext: { op: "reply", status: 401 } }, 403, "forbidden"],
				[{ failNext: { op: "reply", status: 410 } }, 400, "invalid"],
			];
			for (const [over, status, code] of cases) {
				await setup(over);
				const res = await replyTo("T12-0", { ...ok, clientId: code + status });
				expect(res.statusCode, res.body).toBe(status);
				expect(res.json().code).toBe(code);
			}
			await setup({
				failNext: {
					op: "resolve",
					graphql: { message: "Thread can't be resolved right now" },
				},
			});
			const res = await post("/api/threads/T12-0/resolved", { resolved: true });
			expect(res.statusCode).toBe(400);
			expect(res.json()).toEqual({
				code: "invalid",
				error: "Thread can't be resolved right now",
			});
		});

		it("rate limits stay transient (502), a rate-limit 403 too", async () => {
			await setup({
				failNext: {
					op: "reply",
					status: 403,
					message: "You have exceeded a secondary rate limit.",
				},
			});
			const res = await replyTo("T12-0", ok);
			expect(res.statusCode).toBe(502);
			await setup({ failNext: { op: "reply", status: 429 } });
			expect(
				(await replyTo("T12-0", { ...ok, clientId: "r2" })).statusCode,
			).toBe(502);
		});

		it("a closed session answers 503", async () => {
			await setup();
			// crb shutting down.
			await registry.closeAll();
			const res = await replyTo("T12-0", ok);
			expect(res.statusCode).toBe(503);
		});
	});

	describe("new threads", () => {
		const setup = async (
			over: Partial<Scenario> = {},
			reviews: unknown[] = [],
		) => {
			pr.scenario({
				prs: {
					12: {
						view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
						graphql: { reviewThreads: [], reviews },
					},
				},
				...over,
			});
			await get("/api/overview?maxAge=0");
		};
		const start = (payload: unknown) => post("/api/threads", payload);
		const ok = () => ({
			clientId: "n1",
			body: "Why?",
			attemptedAt: new Date().toISOString(),
			retry: false,
			path: "a.txt",
			commit: pr.head(),
			subject: "line",
			side: "RIGHT",
			line: 2,
			startCol: 1,
			endCol: 4,
		});

		it("200: the new thread with its span, and its comments; the overview says LEFT lines take comments", async () => {
			await setup();
			expect((await get("/api/overview")).commentLeft).toBe(true);
			const res = await start(ok());
			expect(res.statusCode, res.body).toBe(200);
			expect(res.json()).toMatchObject({
				thread: {
					id: "T12-0",
					path: "a.txt",
					anchor: { side: "RIGHT", line: 2, startCol: 1, endCol: 4 },
					body: "Why?",
				},
				comments: { threadId: "T12-0", comments: [{ body: "Why?" }] },
			});
		});

		it("400 invalid, 409 stale, 404 gone, 409 pending-review, 502", async () => {
			await setup();
			for (const bad of [
				{ ...ok(), body: " " },
				{ ...ok(), subject: "file" },
				{ ...ok(), startSide: "RIGHT", startLine: 9 },
				{ body: "Hi" },
			]) {
				const res = await start(bad);
				expect(res.statusCode, res.body).toBe(400);
				expect(res.json().code).toBe("invalid");
			}
			const json = await inject("/api/threads", {
				method: "POST",
				payload: "{nope",
				headers: { host, "content-type": "application/json" },
			});
			expect(json.statusCode).toBe(400);
			expect(json.json().code).toBe("invalid");
			const stale = await start({ ...ok(), commit: "f".repeat(40) });
			expect(stale.statusCode).toBe(409);
			expect(stale.json().code).toBe("stale");
			const gone = await start({ ...ok(), clientId: "n2", line: 15 });
			expect(gone.statusCode, gone.body).toBe(404);
			expect(gone.json().code).toBe("gone");
			expect(pr.ghLog()).toMatch(
				/-X POST repos\/acme\/widget\/pulls\/12\/comments /,
			);
			await setup({}, [{ author: { login: "Octo_Cat" }, state: "PENDING" }]);
			const pending = await start({ ...ok(), clientId: "n3" });
			expect(pending.statusCode).toBe(409);
			expect(pending.json()).toMatchObject({
				code: "pending-review",
				url: "https://github.com/acme/widget/pull/12/files",
			});
			await setup({ failNext: { op: "comment", status: 502 } });
			const failed = await start({ ...ok(), clientId: "n4" });
			expect(failed.statusCode).toBe(502);
		});
	});

	describe("comment edits and deletes", () => {
		/** T12-0: the viewer's opener and rev's reply; T12-1: the viewer's only comment. */
		const setup = async (over: Partial<Scenario> = {}) => {
			const said = (login: string, text: string) =>
				threadComment({ login, text, commit: pr.head() });
			pr.scenario({
				prs: {
					12: {
						view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
						graphql: {
							reviewThreads: [
								reviewThread({ path: "a.txt", line: 2 }, [
									said("Octo_Cat", "Why?"),
									said("rev", "Because."),
								]),
								reviewThread({ path: "a.txt", line: 26 }, [
									said("Octo_Cat", "Nit"),
								]),
							],
						},
					},
				},
				...over,
			});
			const { readId } = await get("/api/overview?maxAge=0");
			await get(`/api/threads?read=${readId}&stage=summary`);
		};
		const url = (thread: string, comment: string) =>
			`/api/threads/${thread}/comments/${comment}`;
		const patch = (thread: string, comment: string, payload: unknown) =>
			inject(url(thread, comment), {
				method: "PATCH",
				payload: payload as object,
			});
		const del = (thread: string, comment: string) =>
			inject(url(thread, comment), { method: "DELETE" });
		const edit = { body: "Why, though?", from: "Why?", force: false };

		it("200: an edit answers with the edited comment; a delete with the thread or ThreadGone", async () => {
			await setup();
			const edited = await patch("T12-0", "C12-0", edit);
			expect(edited.statusCode, edited.body).toBe(200);
			expect(edited.json()).toMatchObject({
				threadId: "T12-0",
				commentCount: 2,
				comment: {
					id: "C12-0",
					body: "Why, though?",
					viewerCan: { update: true, delete: true },
					deleted: false,
				},
			});
			expect(edited.json().comment.editedAt).toEqual(expect.any(String));
			const blanked = await del("T12-0", "C12-0");
			expect(blanked.statusCode, blanked.body).toBe(200);
			expect(blanked.json()).toMatchObject({
				commentCount: 2,
				comment: { id: "C12-0", body: "[deleted]", deleted: true },
			});
			const gone = await del("T12-1", "C12-1");
			expect(gone.statusCode, gone.body).toBe(200);
			expect(gone.json()).toEqual({ threadId: "T12-1", gone: true });
			const { readId } = await get("/api/overview");
			const view = await get(`/api/threads?read=${readId}&stage=summary`);
			expect(view.threads.map((t: ReviewThread) => t.id)).toEqual(["T12-0"]);
		});

		it("400 invalid: a blank, long or malformed edit, bad JSON, bad ids", async () => {
			await setup();
			const bad = [
				await patch("T12-0", "C12-0", { ...edit, body: " \n" }),
				await patch("T12-0", "C12-0", { ...edit, body: "x".repeat(65537) }),
				await patch("T12-0", "C12-0", { ...edit, from: 1 }),
				await patch("T12-0", "C12-0", { body: "x", from: "Why?" }),
				await inject(url("T12-0", "C12-0"), {
					method: "PATCH",
					payload: "{nope",
					headers: { host, "content-type": "application/json" },
				}),
				await patch("bad%20id!", "C12-0", edit),
				await patch("T12-0", "bad%20id!", edit),
				await del("T12-0", "bad%20id!"),
			];
			for (const res of bad) {
				expect(res.statusCode, res.body).toBe(400);
				expect(res.json().code, res.body).toBe("invalid");
			}
			expect(pr.ghLog()).not.toMatch(/-X (PATCH|DELETE)/);
		});

		it("200: a blanked opener deleted again is done, and an edit writes it back", async () => {
			await setup();
			expect((await del("T12-0", "C12-0")).statusCode).toBe(200);
			const again = await del("T12-0", "C12-0");
			expect(again.statusCode).toBe(200);
			expect(again.json().comment).toMatchObject({
				deleted: true,
				viewerCan: { update: true, delete: false },
			});
			const edited = await patch("T12-0", "C12-0", {
				...edit,
				from: "[deleted]",
			});
			expect(edited.statusCode, edited.body).toBe(200);
			expect(edited.json().comment).toMatchObject({
				body: edit.body,
				deleted: false,
			});
		});

		it("403 writes-off as someone else; 403 forbidden for another's comment", async () => {
			await setup();
			const theirs = await patch("T12-0", "C12-0-1", {
				...edit,
				from: "Because.",
			});
			expect(theirs.statusCode, theirs.body).toBe(403);
			expect(theirs.json().code).toBe("forbidden");
			const as = new SessionRegistry();
			const { id: theirId } = await as.open({
				pr: pr.arg,
				viewer: "someone-else",
			});
			const other = await buildApp(as, { accessKey: null });
			try {
				await other.listen({ port: 0, host: "127.0.0.1" });
				const address = other.server.address();
				if (!address || typeof address === "string") throw new Error("no port");
				const headers = { host: `127.0.0.1:${address.port}` };
				for (const res of [
					await other.inject({
						method: "PATCH",
						url: r(url("T12-0", "C12-0"), theirId),
						payload: edit,
						headers,
					}),
					await other.inject({
						method: "DELETE",
						url: r(url("T12-0", "C12-0"), theirId),
						headers,
					}),
				]) {
					expect(res.statusCode, res.body).toBe(403);
					expect(res.json().code).toBe("writes-off");
				}
			} finally {
				await other.close();
				await as.closeAll();
			}
		});

		it("404 gone: a thread gone, a comment gone (an edit)", async () => {
			await setup();
			const missing = await patch("T12-0", "C12-0-7", edit);
			expect(missing.statusCode).toBe(404);
			expect(missing.json().code).toBe("gone");
			await setup({ deletedThreads: ["T12-0"] });
			for (const res of [
				await patch("T12-0", "C12-0", edit),
				await del("T13-0", "C13-0"),
			]) {
				expect(res.statusCode, res.body).toBe(404);
				expect(res.json().code).toBe("gone");
			}
		});

		it("409 changed with the comment as GitHub has it now", async () => {
			await setup();
			const res = await patch("T12-0", "C12-0", { ...edit, from: "Huh?" });
			expect(res.statusCode).toBe(409);
			expect(res.json()).toMatchObject({
				code: "changed",
				error: "Changed on GitHub since you opened it",
				current: { id: "C12-0", body: "Why?" },
			});
			const forced = await patch("T12-0", "C12-0", {
				...edit,
				from: "Huh?",
				force: true,
			});
			expect(forced.statusCode).toBe(200);
		});

		it("502 for GitHub's trouble; 503 once the session is closed", async () => {
			await setup({ failNext: { op: "edit", status: 502 } });
			expect((await patch("T12-0", "C12-0", edit)).statusCode).toBe(502);
			await setup({ failNext: { op: "delete", status: 500 } });
			expect((await del("T12-1", "C12-1")).statusCode).toBe(502);
			// crb shutting down.
			await registry.closeAll();
			expect((await patch("T12-0", "C12-0", edit)).statusCode).toBe(503);
			expect((await del("T12-1", "C12-1")).statusCode).toBe(503);
		});
	});

	describe("the verdict", () => {
		const setup = async (
			over: Partial<Scenario> = {},
			view: Record<string, unknown> = {},
			reviews: unknown[] = [],
		) => {
			pr.scenario({
				prs: {
					12: {
						view: prView({
							headRefOid: pr.head(),
							baseRefName: "main",
							mergeStateStatus: "BLOCKED",
							reviewDecision: "REVIEW_REQUIRED",
							...view,
						}),
						graphql: { reviewThreads: [], reviews },
					},
				},
				...over,
			});
		};
		const ok = () => ({
			clientId: "v1",
			event: "APPROVE",
			commit: pr.head(),
			attemptedAt: new Date().toISOString(),
			retry: false,
		});

		it("GET: what blocks the merge, kept; maxAge as for the overview", async () => {
			await setup();
			const facts = await get("/api/verdict");
			expect(facts).toMatchObject({
				mergeStateStatus: "BLOCKED",
				reviewDecision: "REVIEW_REQUIRED",
				rule: null,
				head: pr.head(),
			});
			expect(await get("/api/verdict")).toEqual(facts);
			expect(await get("/api/verdict?maxAge=600000")).toEqual(facts);
			for (const bad of ["-1", "1.5", "soon", ""]) {
				const res = await inject(`/api/verdict?maxAge=${bad}`);
				expect(res.statusCode, bad).toBe(400);
			}
			await setup({ failGraphql: "mergeStateStatus" });
			expect((await inject("/api/verdict?maxAge=0")).statusCode).toBe(502);
		});

		it("POST 200: the review as GitHub recorded it, without the marker", async () => {
			await setup();
			const res = await post("/api/verdict", {
				...ok(),
				event: "COMMENT",
				body: "Fine.",
			});
			expect(res.statusCode, res.body).toBe(200);
			expect(res.json()).toEqual({
				review: {
					id: "PRR_12_0",
					state: "COMMENTED",
					submittedAt: expect.any(String),
					commitId: pr.head(),
					body: "Fine.",
					url: "https://github.com/acme/widget/pull/12#pullrequestreview-9000",
				},
			});
			expect((await get("/api/overview")).reviews[0]).toMatchObject({
				author: "Octo_Cat",
				state: "COMMENTED",
			});
		});

		it("POST 400 invalid, 409 stale, 409 pending-review, 403 forbidden, 502", async () => {
			await setup();
			for (const bad of [
				{ ...ok(), event: "MERGE" },
				{ ...ok(), event: "REQUEST_CHANGES" },
				{ ...ok(), event: "COMMENT", body: " " },
				{ ...ok(), body: "x".repeat(65536) },
				{ ...ok(), clientId: "a b" },
				{ event: "APPROVE" },
			]) {
				const res = await post("/api/verdict", bad);
				expect(res.statusCode, res.body).toBe(400);
				expect(res.json().code).toBe("invalid");
			}
			const json = await inject("/api/verdict", {
				method: "POST",
				payload: "{nope",
				headers: { host, "content-type": "application/json" },
			});
			expect(json.statusCode).toBe(400);
			expect(json.json().code).toBe("invalid");
			const stale = await post("/api/verdict", {
				...ok(),
				commit: "f".repeat(40),
			});
			expect(stale.statusCode).toBe(409);
			expect(stale.json().code).toBe("stale");
			expect(pr.ghLog()).not.toMatch(/pulls\/12\/reviews/);
			await setup({}, {}, [
				{ author: { login: "Octo_Cat" }, state: "PENDING" },
			]);
			const pending = await post("/api/verdict", ok());
			expect(pending.statusCode).toBe(409);
			expect(pending.json()).toMatchObject({
				code: "pending-review",
				url: "https://github.com/acme/widget/pull/12/files",
			});
			await setup({}, { author: { login: "Octo_Cat" } });
			const own = await post("/api/verdict", { ...ok(), clientId: "v2" });
			expect(own.statusCode).toBe(403);
			expect(own.json()).toEqual({
				code: "forbidden",
				error: "Can not approve your own pull request",
			});
			await setup({ failNext: { op: "verdict", status: 502 } });
			const failed = await post("/api/verdict", { ...ok(), clientId: "v3" });
			expect(failed.statusCode).toBe(502);
		});

		it("POST 403 writes-off as someone else (--viewer)", async () => {
			await setup();
			const theirs = new SessionRegistry();
			const { id: theirId } = await theirs.open({
				pr: pr.arg,
				viewer: "someone-else",
			});
			const other = await buildApp(theirs, { accessKey: null });
			try {
				await other.listen({ port: 0, host: "127.0.0.1" });
				const address = other.server.address();
				if (!address || typeof address === "string") throw new Error("no port");
				const res = await other.inject({
					method: "POST",
					url: r("/api/verdict", theirId),
					payload: ok(),
					headers: { host: `127.0.0.1:${address.port}` },
				});
				expect(res.statusCode, res.body).toBe(403);
				expect(res.json().code).toBe("writes-off");
				// Reading what blocks is fine.
				const read = await other.inject({
					method: "GET",
					url: r("/api/verdict", theirId),
					headers: { host: `127.0.0.1:${address.port}` },
				});
				expect(read.statusCode, read.body).toBe(200);
			} finally {
				await other.close();
				await theirs.closeAll();
			}
			expect(pr.ghLog()).not.toMatch(/-X POST .*reviews/);
		});
	});

	describe("the server's routes", () => {
		const commits = () => ({
			commits: [
				{
					commit: {
						oid: pr.head(),
						committedDate: "2026-01-02T10:00:00Z",
						pushedDate: null,
					},
				},
			],
		});

		it("GET /api/version is this build", async () => {
			expect(await get("/api/version")).toEqual(BUILD);
		});

		it("refuses a crb of another build, naming both; takes its own", async () => {
			const other = { version: BUILD.version, commit: "f".repeat(40) };
			for (const url of ["/api/version", "/api/reviews", r("/api/session")]) {
				const res = await inject(url, {
					headers: { host, [VERSION_HEADER]: JSON.stringify(other) },
				});
				expect(res.statusCode, url).toBe(409);
				expect(res.json()).toEqual({
					error: `server runs ${BUILD.version} (${BUILD.commit.slice(0, 7)}), this crb is ${BUILD.version} (fffffff). Restart the server (crb serve) or run the matching crb`,
					code: "version-mismatch",
					server: BUILD,
				});
			}
			const garbled = await inject("/api/version", {
				headers: { host, [VERSION_HEADER]: "nope" },
			});
			expect(garbled.statusCode).toBe(409);
			const own = await inject(r("/api/session"), {
				headers: { host, [VERSION_HEADER]: JSON.stringify(BUILD) },
			});
			expect(own.statusCode).toBe(200);
			// The browser sends none.
			expect((await inject(r("/api/session"))).statusCode).toBe(200);
		});

		it("POST /api/reviews opens a review and answers its URL", async () => {
			const res = await post("/api/reviews", { pr: pr.arg });
			expect(res.statusCode, res.body).toBe(200);
			expect(res.json()).toEqual({ id, url: `http://${host}/r/${id}` });
			const url = await post("/api/reviews", {
				pr: "https://github.com/acme/widget/pull/12",
			});
			expect(url.json().id).toBe(id);
		});

		it("POST /api/reviews: the server's own URL and key when it has them", async () => {
			const keyed = await buildApp(registry, {
				accessKey: "k3y",
				baseUrl: () => "http://100.1.2.3:4800",
			});
			try {
				const res = await keyed.inject({
					method: "POST",
					url: "/api/reviews?key=k3y",
					payload: { pr: pr.arg },
				});
				expect(res.json()).toEqual({
					id,
					url: `http://100.1.2.3:4800/r/${id}?key=k3y`,
				});
			} finally {
				await keyed.close();
			}
		});

		it("POST /api/reviews refuses a bad body (400) and an unreviewable PR (409)", async () => {
			for (const body of [
				undefined,
				{},
				{ pr: 12 },
				{ pr: "12" },
				{ pr: "not a pr" },
				{ pr: pr.arg, head: "xyz" },
				{ pr: pr.arg, asOf: "2026-01-03" },
				{ pr: pr.arg, head: "reviewed", asOf: "2026-01-03T10:00:00Z" },
				{ pr: pr.arg, viewer: "../x" },
				{ pr: pr.arg, head: 7 },
			]) {
				const res = await post("/api/reviews", body);
				expect(res.statusCode, JSON.stringify(body)).toBe(400);
			}
			const missing = await post("/api/reviews", { pr: "acme/widget#99" });
			expect(missing.statusCode).toBe(409);
			expect(missing.json()).toMatchObject({ code: "refused" });
			expect(missing.json().error).toMatch(/not found/);
			pr.scenario({
				prs: {
					12: {
						view: {
							...prView({ headRefOid: pr.head(), baseRefName: "main" }),
							state: "MERGED",
						},
					},
				},
			});
			// Asked another way than the open review was: read anew.
			const merged = await post("/api/reviews", {
				pr: "https://github.com/acme/widget/pull/12",
			});
			expect(merged.statusCode, merged.body).toBe(409);
			expect(merged.json()).toEqual({
				code: "refused",
				error: "PR acme/widget#12 is already merged; nothing to review",
			});
		});

		it("serves two reviews on one app, each by its id", async () => {
			pr.scenario({
				prs: {
					12: {
						view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
						graphql: commits(),
					},
				},
			});
			const pinned = await post("/api/reviews", {
				pr: pr.arg,
				head: pr.head().slice(0, 8),
			});
			expect(pinned.statusCode, pinned.body).toBe(200);
			const other: string = pinned.json().id;
			expect(other).not.toBe(id);
			const plain: SessionInfo = await get(r("/api/session"));
			const theirs: SessionInfo = await get(r("/api/session", other));
			expect(plain.pinnedHead).toBeNull();
			expect(theirs.pinnedHead).toBe(pr.head());
		});

		it("a review its PR now refuses, reopened by id, is a 409 saying why", async () => {
			await app.close();
			await registry.closeAll();
			pr.scenario({
				prs: {
					12: {
						view: {
							...prView({ headRefOid: pr.head(), baseRefName: "main" }),
							state: "MERGED",
						},
					},
				},
			});
			// A restart: a server that never opened it.
			registry = new SessionRegistry();
			app = await buildApp(registry, { accessKey: null });
			await app.listen({ port: 0, host: "127.0.0.1" });
			const address = app.server.address();
			if (!address || typeof address === "string") throw new Error("no port");
			host = `127.0.0.1:${address.port}`;
			const res = await inject(r("/api/session"));
			expect(res.statusCode).toBe(409);
			expect(res.json()).toEqual({
				code: "refused",
				error: "PR acme/widget#12 is already merged; nothing to review",
			});
		});

		it("refuses what another site's page sets off: /pr/..., /api/reviews and a review's writes", async () => {
			const site = (value: string, more: Record<string, string> = {}) => ({
				headers: { host, "sec-fetch-site": value, ...more },
			});
			for (const value of ["cross-site", "same-site"]) {
				const open = await inject("/pr/acme/widget/12", site(value));
				expect(open.statusCode, value).toBe(403);
				const reviews = await inject("/api/reviews", {
					method: "POST",
					payload: { pr: pr.arg },
					...site(value),
				});
				expect(reviews.statusCode, value).toBe(403);
				const refresh = await inject(r("/api/refresh"), {
					method: "POST",
					...site(value),
				});
				expect(refresh.statusCode, value).toBe(403);
			}
			// Without Sec-Fetch-Site (older browsers), the Origin says.
			const evil = await inject("/api/reviews", {
				method: "POST",
				payload: { pr: pr.arg },
				headers: { host, origin: "http://evil.example" },
			});
			expect(evil.statusCode).toBe(403);
			// Typed or bookmarked (none), from its own pages (same-origin), or
			// a link the reviewer clicked on another site: opens.
			for (const headers of [
				{ "sec-fetch-site": "none" },
				{ "sec-fetch-site": "same-origin" },
				{
					"sec-fetch-site": "cross-site",
					"sec-fetch-mode": "navigate",
					"sec-fetch-dest": "document",
					"sec-fetch-user": "?1",
				},
				{},
			]) {
				const res = await inject("/pr/acme/widget/12", {
					headers: { host, ...headers },
				});
				expect(res.statusCode, JSON.stringify(headers)).toBe(302);
			}
			// A script's navigation, no click: refused.
			const scripted = await inject("/pr/acme/widget/12", {
				headers: {
					host,
					"sec-fetch-site": "cross-site",
					"sec-fetch-mode": "navigate",
					"sec-fetch-dest": "document",
				},
			});
			expect(scripted.statusCode).toBe(403);
			// Reads of a review stay open to its own pages and to crb.
			const read = await inject(r("/api/session"), site("same-origin"));
			expect(read.statusCode).toBe(200);
			const own = await inject("/api/reviews", {
				method: "POST",
				payload: { pr: pr.arg },
			});
			expect(own.statusCode).toBe(200);
		});

		it("an unknown review id is a 404 with its code", async () => {
			for (const bad of ["01zzzzzzzzzzzzzzzzzzzzzzzz", "nope"]) {
				const res = await inject(`/api/r/${bad}/session`);
				expect(res.statusCode).toBe(404);
				expect(res.json()).toMatchObject({ code: "unknown-review" });
			}
		});

		it("GET /pr/<owner>/<repo>/<n> redirects to the review", async () => {
			const res = await inject("/pr/acme/widget/12");
			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe(`/r/${id}`);
			pr.scenario({
				prs: {
					12: {
						view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
						graphql: commits(),
					},
				},
			});
			const pinned = await inject(`/pr/acme/widget/12?head=${pr.head()}`);
			expect(pinned.statusCode).toBe(302);
			expect(pinned.headers.location).not.toBe(`/r/${id}`);
		});

		it("GET /pr/... with the web UI answers the page at once; the page opens the review", async () => {
			const web = mkdtempSync(join(tmpdir(), "crb-web-"));
			writeFileSync(join(web, "index.html"), "<html><head></head><p>spa</p>");
			const withWeb = await buildApp(registry, {
				webRoot: web,
				accessKey: "k3y",
			});
			const open = vi.spyOn(registry, "open");
			try {
				// A PR GitHub doesn't know: the page, which asks and says why.
				for (const url of [
					"/pr/acme/widget/12?key=k3y",
					"/pr/acme/widget/99?key=k3y",
					`/pr/acme/widget/12?key=k3y&head=${pr.head()}`,
				]) {
					const page = await withWeb.inject({ url });
					expect(page.statusCode, url).toBe(200);
					expect(page.headers["content-type"]).toMatch(/text\/html/);
					expect(page.body).toContain("<p>spa</p>");
					expect(page.body).not.toContain("crb-not-found");
				}
				expect(open).not.toHaveBeenCalled();
				// An address that names no PR: the 404 page saying why, at once.
				const bad = await withWeb.inject({
					url: "/pr/acme/widget/0?key=k3y",
				});
				expect(bad.statusCode).toBe(404);
				expect(bad.body).toMatch(
					/<meta name="crb-not-found" content="[^"]*Not a PR[^"]*"><\/head>/,
				);
				const quote = await withWeb.inject({
					url: `/pr/acme/widget/12?key=k3y&head=${encodeURIComponent('"><script>')}`,
				});
				expect(quote.statusCode).toBe(404);
				expect(quote.body).not.toContain("<script>");
				expect(quote.body).toContain("&quot;&gt;&lt;script&gt;");
			} finally {
				open.mockRestore();
				await withWeb.close();
				rmSync(web, { recursive: true, force: true });
			}
			// Without the web UI: the open, then JSON saying why.
			const json = await inject("/pr/acme/widget/99");
			expect(json.statusCode).toBe(404);
			expect(json.json().error).toMatch(/not found/);
		});
	});

	describe("re-review routes", () => {
		const mark = async (rev: string, key: string) => {
			const res = await post("/api/review/states", {
				revision: rev,
				changes: [{ key, state: "reviewed" }],
			});
			expect(res.statusCode, res.body).toBe(200);
			return res.json() as ReviewView;
		};
		/** PS1 with one mark, then a newer head. */
		const setup = async () => {
			const ps1: ReviewView = await get("/api/review");
			const [key = ""] = keys(ps1);
			await mark(ps1.revision, key);
			const newHead = pr.moveHead({ "later.txt": "later\n" });
			expect((await get("/api/head")).head).toMatchObject({
				oid: newHead,
				commits: 1,
			});
			return { ps1, key, newHead };
		};
		const answered = async (from: number, to: string) => {
			for (;;) {
				const answer = await get(`/api/rereview?from=${from}&head=${to}`);
				if (!answer.pending) return answer;
				await new Promise((r) => setTimeout(r, 20));
			}
		};

		it("GET /rereview: pending, then the answer; 400 for bad params, 404 for a patch set the reviewer hasn't", async () => {
			const { newHead } = await setup();
			const first = await get(`/api/rereview?from=1&head=${newHead}`);
			expect(first).toEqual({ pending: true });
			const answer = await answered(1, newHead);
			expect(answer).toMatchObject({
				from: 1,
				toHead: newHead,
				shape: { code: "S1", commits: 1 },
				interdiff: "available",
				toRead: { files: 3, clusters: 3 },
			});
			for (const bad of [
				`from=0&head=${newHead}`,
				"from=1&head=main",
				"from=1&to=x",
				"from=1",
				`head=${newHead}`,
				`from=1&to=1&head=${newHead}`,
			]) {
				expect((await inject(`/api/rereview?${bad}`)).statusCode, bad).toBe(
					400,
				);
			}
			expect(
				(await inject(`/api/rereview?from=9&head=${newHead}`)).statusCode,
			).toBe(404);
			expect((await inject("/api/rereview?from=1&to=9")).statusCode).toBe(404);
		});

		it("GET /review?head= views the head; ?patchset= an earlier one read-only; hunks?from= the since view; writes against PS1 are 409 stale", async () => {
			const { ps1, key, newHead } = await setup();
			await answered(1, newHead);
			const view: ReviewView = await get(`/api/review?head=${newHead}`);
			expect(view.patchset).toBeNull();
			expect(view.files.map((f) => f.path)).toEqual([
				"a.txt",
				"later.txt",
				"new.txt",
			]);
			// The engine's provisional carry, laid over.
			expect(view.files[0]?.clusters[0]).toMatchObject({
				key,
				state: "reviewed",
				carried: { from: 1, rule: "exact" },
			});
			const later = view.files[1];
			if (!later) throw new Error("no later.txt");
			const since = await get(
				`/api/files/${later.index}/hunks?revision=${view.revision}&from=1`,
			);
			expect(since.hunks[0]?.lines).toEqual([
				{
					kind: "add",
					newNo: 1,
					text: "later",
					clusterKey: later.clusters[0]?.key,
				},
			]);
			expect(
				(await inject(`/api/files/0/hunks?revision=${view.revision}&from=x`))
					.statusCode,
			).toBe(400);
			expect(
				(await inject(`/api/files/0/hunks?revision=${view.revision}&from=9`))
					.statusCode,
			).toBe(404);
			// Nothing written by viewing.
			expect((await get("/api/session")).patchsets).toHaveLength(1);
			// The first mark on the viewed head starts PS2 with the carry.
			const started = await mark(view.revision, later.clusters[0]?.key ?? "");
			expect(started.patchset).toBe(2);
			expect(started.progress.clusters.reviewed).toBe(2);
			expect(
				(await get("/api/session")).patchsets.map(
					(p: { number: number; since: number | null }) => [p.number, p.since],
				),
			).toEqual([
				[1, null],
				[2, 1],
			]);
			// PS1 as reviewed, read-only.
			const old: ReviewView = await get("/api/review?patchset=1");
			expect(old).toMatchObject({ patchset: 1, revision: ps1.revision });
			expect(old.progress.clusters.reviewed).toBe(1);
			const stale = await post("/api/review/states", {
				revision: ps1.revision,
				changes: [{ key, state: "unreviewed" }],
			});
			expect(stale.statusCode).toBe(409);
			expect(stale.json()).toEqual({ error: "stale" });
			expect((await inject("/api/review?patchset=9")).statusCode).toBe(404);
			expect((await inject("/api/review?patchset=0")).statusCode).toBe(400);
			expect((await inject("/api/review?head=main")).statusCode).toBe(400);
			expect(
				(await inject(`/api/review?head=${newHead}&patchset=1`)).statusCode,
			).toBe(400);
			expect((await get("/api/review")).patchset).toBe(2);
			// By patch set: PS2 against PS1.
			for (;;) {
				const answer = await get("/api/rereview?from=1&to=2");
				if (answer.pending) {
					await new Promise((r) => setTimeout(r, 20));
					continue;
				}
				expect(answer).toMatchObject({ from: 1, toRevision: view.revision });
				break;
			}
		});
	});

	describe("thread placement routes", () => {
		/** The fake gh's scenario with these threads (moveHead resets it). */
		const withThreads = (threads: unknown[]) =>
			pr.scenario({
				prs: {
					12: {
						view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
						graphql: {
							bodyHTML: "",
							reviewThreads: threads as never,
							reviews: [],
							comments: [],
							timelineItems: [],
						},
					},
				},
			} as Partial<Scenario>);
		/** A thread on a.txt line 2 (PS1's "line 2 changed") and one on new.txt. */
		const threadsOn = (commit: string, resolved: boolean) => [
			reviewThread({ path: "a.txt", line: 2, subjectType: "LINE" }, [
				threadComment({ login: "rev", text: "Why?", commit, diffHunk: "" }),
			]),
			reviewThread(
				{ path: "new.txt", line: 1, subjectType: "LINE", isResolved: resolved },
				[threadComment({ login: "rev", text: "Hm", commit, diffHunk: "" })],
			),
		];
		/** The placements once in (`whole`: the resolved threads' too). */
		const placementsOf = async (query: string, whole = true) => {
			for (;;) {
				const answer = await get(`/api/placements?${query}`);
				if (!answer.pending && (!whole || answer.complete)) return answer;
				await new Promise((r) => setTimeout(r, 20));
			}
		};
		const byId = (answer: { threads: { id: string; placement: unknown }[] }) =>
			Object.fromEntries(answer.threads.map((t) => [t.id, t.placement]));
		/** PS1 started, the threads made on it, then a push rewriting line 2. */
		const setup = async (resolved = true) => {
			const ps1: ReviewView = await get("/api/review");
			const [key = ""] = keys(ps1);
			const marked = await post("/api/review/states", {
				revision: ps1.revision,
				changes: [{ key, state: "reviewed" }],
			});
			expect(marked.statusCode, marked.body).toBe(200);
			const h1 = pr.head();
			const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
			lines[1] = "line 2 reworked";
			lines[25] = "line 26 changed";
			const h2 = pr.moveHead({ "a.txt": `${lines.join("\n")}\n` });
			withThreads(threadsOn(h1, resolved));
			const { readId } = await get("/api/overview?maxAge=0");
			return { h1, h2, readId: readId as string };
		};

		it("GET /placements: pending, then every thread placed, resolved ones too (a quiet line when unplaced); 400, 404, 410", async () => {
			const { h1, h2, readId } = await setup();
			const first = await get(`/api/placements?read=${readId}&head=${h2}`);
			expect(first).toEqual({ pending: true });
			const answer = await placementsOf(`read=${readId}&head=${h2}`);
			expect(answer).toMatchObject({ readId, patchset: null });
			expect(byId(answer)).toEqual({
				"T12-0": {
					kind: "changed",
					anchor: {
						path: "a.txt",
						startSide: "RIGHT",
						startLine: 2,
						side: "RIGHT",
						line: 2,
					},
					old: {
						side: "RIGHT",
						startLine: 2,
						line: 2,
						text: ["line 2 changed"],
					},
					now: ["line 2 reworked"],
				},
				// Resolved: placed all the same.
				"T12-1": expect.objectContaining({ kind: expect.any(String) }),
			});
			// On PS1 itself: placed, as made.
			expect(byId(await placementsOf(`read=${readId}&ps=1`))).toEqual({
				"T12-0": expect.objectContaining({ kind: "placed" }),
				"T12-1": expect.objectContaining({ kind: "placed" }),
			});
			// Unresolved on GitHub: the next read places it the same.
			withThreads(threadsOn(h1, false));
			const { readId: next } = await get("/api/overview?maxAge=0");
			expect(
				Object.keys(byId(await placementsOf(`read=${next}&head=${h2}`))),
			).toEqual(["T12-0", "T12-1"]);
			for (const bad of [
				`read=${next}`,
				`head=${h2}`,
				`read=${next}&ps=0`,
				`read=${next}&head=main`,
				`read=${next}&ps=1&head=${h2}`,
			]) {
				expect((await inject(`/api/placements?${bad}`)).statusCode, bad).toBe(
					400,
				);
			}
			expect(
				(await inject(`/api/placements?read=${next}&ps=9`)).statusCode,
			).toBe(404);
			expect(
				(await inject(`/api/placements?read=nope&head=${h2}`)).statusCode,
			).toBe(410);
		});

		it("unresolved threads are answered while the resolved ones are still being placed", async () => {
			let release: () => void = () => {};
			const gate = new Promise<void>((r) => {
				release = r;
			});
			const inputs = ThreadPlacer.prototype.inputs;
			const held = vi
				.spyOn(ThreadPlacer.prototype, "inputs")
				.mockImplementation(async function (this: ThreadPlacer, ...args) {
					const [, threads] = args;
					if (threads.length > 0 && threads.every((t) => t.resolved)) {
						await gate;
					}
					return inputs.apply(this, args);
				});
			try {
				const { h2, readId } = await setup();
				const first = await placementsOf(`read=${readId}&head=${h2}`, false);
				expect(first.complete).toBe(false);
				expect(Object.keys(byId(first))).toEqual(["T12-0"]);
				release();
				for (;;) {
					const next = await placementsOf(`read=${readId}&head=${h2}`, false);
					if (next.complete) {
						expect(Object.keys(byId(next))).toEqual(["T12-0", "T12-1"]);
						break;
					}
					await new Promise((r) => setTimeout(r, 20));
				}
			} finally {
				release();
				held.mockRestore();
			}
		});

		it("the engine's answer carries the placements of the newest read once they are in", async () => {
			const { h2, readId } = await setup();
			await placementsOf(`read=${readId}&head=${h2}`);
			for (;;) {
				const answer = await get(`/api/rereview?from=1&head=${h2}`);
				if (answer.pending) {
					await new Promise((r) => setTimeout(r, 20));
					continue;
				}
				expect(answer.threads).toEqual([
					{
						id: "T12-0",
						placement: expect.objectContaining({ kind: "changed" }),
					},
					{ id: "T12-1", placement: expect.any(Object) },
				]);
				break;
			}
		});

		it("POST /threads/:id/placement writes thread-placed on the latest patch set; the placements then have it; refuses what doesn't fit", async () => {
			const { h2, readId } = await setup();
			// PS2 on the new head (a mark starts it).
			const view: ReviewView = await get(`/api/review?head=${h2}`);
			const started = await post("/api/review/states", {
				revision: view.revision,
				changes: [
					{ key: view.files[0]?.clusters[0]?.key ?? "", state: "reviewed" },
				],
			});
			expect(started.statusCode, started.body).toBe(200);
			const anchor = {
				path: "a.txt",
				startSide: "RIGHT",
				startLine: 20,
				side: "RIGHT",
				line: 20,
			};
			const ok = await post("/api/threads/T12-0/placement", {
				patchset: 2,
				anchor,
			});
			expect(ok.statusCode, ok.body).toBe(200);
			expect(ok.json()).toEqual({
				id: "T12-0",
				placement: { kind: "placed", anchor, changed: false },
			});
			expect(byId(await placementsOf(`read=${readId}&ps=2`))["T12-0"]).toEqual({
				kind: "placed",
				anchor,
				changed: false,
			});
			const refused = async (body: unknown, status = 400) => {
				const res = await post("/api/threads/T12-0/placement", body);
				expect(res.statusCode, JSON.stringify(body)).toBe(status);
			};
			// Each check on its own: the patch set, every anchor field, the
			// path and lines against the patch set's files.
			await refused({ patchset: 9, anchor });
			await refused({ patchset: 0, anchor });
			await refused({ patchset: "2", anchor });
			await refused({ patchset: 2 });
			await refused({ patchset: 2, anchor: { ...anchor, side: "UP" } });
			await refused({ patchset: 2, anchor: { ...anchor, startSide: 1 } });
			await refused({ patchset: 2, anchor: { ...anchor, line: 0 } });
			await refused({ patchset: 2, anchor: { ...anchor, startLine: 1.5 } });
			await refused({ patchset: 2, anchor: { ...anchor, path: "" } });
			await refused({ patchset: 2, anchor: { ...anchor, path: "nope.txt" } });
			await refused({
				patchset: 2,
				anchor: { ...anchor, path: "<b>x</b>.txt" },
			});
			await refused({
				patchset: 2,
				anchor: { ...anchor, line: 31, startLine: 31 },
			});
			await refused({ patchset: 2, anchor: { ...anchor, startLine: 25 } });
			// An earlier patch set is read-only.
			await refused({ patchset: 1, anchor }, 409);
			const bad = await post("/api/threads/no%20id/placement", {
				patchset: 2,
				anchor,
			});
			expect(bad.statusCode).toBe(400);
			// Nothing of the refused ones landed.
			expect(byId(await placementsOf(`read=${readId}&ps=2`))["T12-0"]).toEqual({
				kind: "placed",
				anchor,
				changed: false,
			});
		});
	});

	describe("with a web root and an access key", () => {
		let web: string;
		let keyed: FastifyInstance;

		beforeEach(async () => {
			web = mkdtempSync(join(tmpdir(), "crb-web-"));
			mkdirSync(join(web, "assets"));
			writeFileSync(join(web, "index.html"), "<p>spa</p>");
			writeFileSync(join(web, "assets", "app.js"), "js();");
			keyed = await buildApp(registry, { webRoot: web, accessKey: "k3y" });
		});
		afterEach(async () => {
			await keyed.close();
			rmSync(web, { recursive: true, force: true });
		});

		it("checks the key on API and static requests", async () => {
			for (const url of [
				"/",
				`/r/${id}/files`,
				"/assets/app.js",
				r("/api/session"),
				"/api/version",
				"/pr/acme/widget/12",
			]) {
				expect((await keyed.inject(url)).statusCode).toBe(401);
			}
			const cookies = { crb_key: "k3y" };
			const page = await keyed.inject({ url: "/assets/app.js", cookies });
			expect(page.body).toBe("js();");
			const api = await keyed.inject({ url: r("/api/session"), cookies });
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
			for (const url of [
				"/",
				`/r/${id}`,
				`/r/${id}/files`,
				`/r/${id}/files?path=a.txt`,
			]) {
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
				url: r("/api/session"),
				cookies,
				headers,
			});
			expect(read.statusCode).toBe(200);
			const evil = await keyed.inject({
				method: "POST",
				url: r("/api/refresh"),
				cookies,
				headers: { ...headers, origin: "http://evil.example" },
			});
			expect(evil.statusCode).toBe(403);
			const own = await keyed.inject({
				method: "POST",
				url: r("/api/refresh"),
				cookies,
				headers: { ...headers, origin: "http://192.168.1.5:4747" },
			});
			expect(own.statusCode).toBe(200);
		});
	});
});

describe("the opening page's title", () => {
	const evil = '"><script>alert(1)</script>&amp; <b>';
	it("is escaped in its meta: GitHub's title is anyone's text", () => {
		const html = withPrTitle("<html><head></head><p>spa</p></html>", evil);
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<b>");
		expect(html).toContain(
			'<meta name="crb-pr-title" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;amp; &lt;b&gt;"></head>',
		);
		// Read back (as an HTML parser decodes it), it is the title as it was.
		const content = /content="([^"]*)"/.exec(html)?.[1] ?? "";
		const decoded = content.replace(
			/&(quot|gt|lt|#39|amp);/g,
			(_, e: string) =>
				({ quot: '"', gt: ">", lt: "<", "#39": "'", amp: "&" })[e] ?? "",
		);
		expect(decoded).toBe(evil);
		expect(withPrTitle("<head></head>", null)).toBe("<head></head>");
	});

	it("is Home's for that PR, by any case of its name; none when Home doesn't know it", () => {
		const home = {
			knownPrs: () => [
				{ owner: "Acme", repo: "Widget", number: 7, title: evil },
			],
		} as unknown as HomeService;
		expect(prTitle(home, { owner: "acme", repo: "widget", number: 7 })).toBe(
			evil,
		);
		expect(prTitle(home, { owner: "acme", repo: "widget", number: 8 })).toBe(
			null,
		);
		expect(prTitle(undefined, { owner: "a", repo: "b", number: 1 })).toBe(null);
	});
});
