import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	beforeEach(async () => {
		pr = createPrFixture();
		session = await Session.open(pr.arg, process.cwd());
		app = await buildApp(session, { accessKey: null });
	});
	afterEach(async () => {
		await app.close();
		pr.cleanup();
	});

	const get = async (url: string) => {
		const res = await app.inject({ method: "GET", url });
		expect(res.statusCode, res.body).toBe(200);
		return res.json();
	};
	const post = (url: string, payload?: unknown) =>
		app.inject({ method: "POST", url, payload: payload as object });
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

	it("records a state and returns updated progress", async () => {
		const [key = ""] = keys(await get("/api/review"));
		const res = await post("/api/review/states", {
			snapshotHead: pr.head(),
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
			snapshotHead: pr.head(),
			changes: [{ key: "nope", state: "reviewed" }],
		});
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain("nope");
	});

	it.each([
		["no body", undefined],
		["no changes", { snapshotHead: "x" }],
		["changes not an array", { snapshotHead: "x", changes: {} }],
		["non-string key", { snapshotHead: "x", changes: [{ key: 1 }] }],
		[
			"unknown state",
			{ snapshotHead: "x", changes: [{ key: "k", state: "done" }] },
		],
		[
			"non-string reason",
			{
				snapshotHead: "x",
				changes: [{ key: "k", state: "crossed-off", reason: 5 }],
			},
		],
		[
			"reason too long",
			{
				snapshotHead: "x",
				changes: [{ key: "k", state: "crossed-off", reason: "r".repeat(501) }],
			},
		],
		[
			"too many changes",
			{
				snapshotHead: "x",
				changes: Array.from({ length: 10_001 }, () => ({
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

	it("rejects crossing off without a reason with 400", async () => {
		const [key = ""] = keys(await get("/api/review"));
		const res = await post("/api/review/states", {
			snapshotHead: pr.head(),
			changes: [{ key, state: "crossed-off", reason: "  " }],
		});
		expect(res.statusCode).toBe(400);
	});

	it("rejects a stale snapshotHead with 409", async () => {
		const oldHead = pr.head();
		const [key = ""] = keys(await get("/api/review"));
		const newHead = pr.moveHead({ "later.txt": "later\n" });
		const refreshed = await post("/api/refresh");
		expect(refreshed.statusCode).toBe(200);
		expect(refreshed.json()).toMatchObject({ snapshotHead: newHead });
		const res = await post("/api/review/states", {
			snapshotHead: oldHead,
			changes: [{ key, state: "reviewed" }],
		});
		expect(res.statusCode).toBe(409);
		expect(res.json()).toEqual({ error: "stale" });
		expect((await get("/api/review")).patchset).toBeNull();
	});

	it("keeps a started review on its snapshot after the PR moves", async () => {
		const oldHead = pr.head();
		const [key = ""] = keys(await get("/api/review"));
		await post("/api/review/states", {
			snapshotHead: oldHead,
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

	it("serves hunks and context lines for a file", async () => {
		const hunks = await get("/api/files/0/hunks");
		expect(hunks.hunks).toHaveLength(2);
		const lines = await get("/api/files/0/context?newFrom=10&newTo=11");
		expect(lines).toEqual([
			{ kind: "context", oldNo: 10, newNo: 10, text: "line 10" },
			{ kind: "context", oldNo: 11, newNo: 11, text: "line 11" },
		]);
	});

	it.each([
		["/api/files/-1/hunks", 400],
		["/api/files/1.5/hunks", 400],
		["/api/files/x/hunks", 400],
		["/api/files/99/hunks", 404],
		["/api/files/0/context", 400],
		["/api/files/0/context?newFrom=0&newTo=3", 400],
		["/api/files/0/context?newFrom=5&newTo=3", 400],
		["/api/files/0/context?newFrom=a&newTo=3", 400],
		["/api/files/99/context?newFrom=1&newTo=3", 404],
		["/api/nope", 404],
	])("answers %s with %i", async (url, status) => {
		const res = await app.inject({ method: "GET", url });
		expect(res.statusCode).toBe(status);
		expect(res.json().error).toBeTruthy();
	});

	it("maps a gh failure to 502", async () => {
		pr.scenario({ prs: {} });
		const res = await app.inject({ method: "GET", url: "/api/head" });
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
	});
});
