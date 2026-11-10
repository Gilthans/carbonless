import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUTS } from "../../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../../test/pr-fixture";
import {
	type AgentStatus,
	type AgentThread,
	JOINED_PREAMBLE,
} from "../../shared/agent";
import { buildApp } from "../app";
import { SessionRegistry } from "../registry";
import { reviewIdOf } from "./server";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

type Tool = { error: boolean; value: Record<string, unknown> };

describe("/mcp", () => {
	let pr: PrFixture;
	let registry: SessionRegistry;
	let id: string;
	let app: FastifyInstance;
	let host: string;
	let clients: Client[];

	const start = async (accessKey: string | null = null) => {
		app = await buildApp(registry, { accessKey, mcpKeepAliveMs: 50 });
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		host = `127.0.0.1:${address.port}`;
	};

	beforeEach(async () => {
		pr = createPrFixture();
		registry = new SessionRegistry();
		({ id } = await registry.open({ pr: pr.arg }));
		clients = [];
		await start();
	});
	afterEach(async () => {
		await Promise.all(clients.map((c) => c.close().catch(() => {})));
		await app.close();
		await registry.closeAll();
		await pr.cleanup();
	});

	const connect = async (query = ""): Promise<Client> => {
		const client = new Client({ name: "test-session", version: "1.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`http://${host}/mcp${query}`)),
		);
		clients.push(client);
		return client;
	};
	const call = async (
		client: Client,
		name: string,
		args: Record<string, unknown>,
	): Promise<Tool> => {
		const r = await client.callTool({ name, arguments: args });
		const [first] = r.content as { type: string; text: string }[];
		return { error: r.isError === true, value: JSON.parse(first?.text ?? "") };
	};
	const api = (url: string, method = "GET", payload?: unknown) =>
		app.inject({
			method: method as "GET",
			url: `/api/r/${id}${url}`,
			headers: { host },
			...(payload === undefined ? {} : { payload: payload as object }),
		});
	const status = async (): Promise<AgentStatus> => (await api("/agent")).json();
	const threads = async (): Promise<AgentThread[]> =>
		(await api("/agent/threads")).json().threads;
	const span = () => ({
		subject: "line",
		path: "a.txt",
		commit: pr.head(),
		side: "RIGHT",
		line: 2,
		startSide: "RIGHT",
		startLine: 2,
	});
	const ask = async (clientId = "q1", text = "Why?") => {
		const res = await api("/agent/threads", "POST", {
			clientId,
			text,
			span: span(),
		});
		expect(res.statusCode, res.body).toBe(200);
		return res.json() as AgentThread;
	};
	const link = () => `http://${host}/r/${id}`;

	/** attach, Approve in the page, attach again: the approved result. */
	const join = async (client: Client) => {
		const asked = await call(client, "attach", {
			review: link(),
			name: "carbonless · main",
			machine: "devbox",
			harness: "Claude Code 2.1",
		});
		expect(asked.error, JSON.stringify(asked.value)).toBe(false);
		const request = asked.value.request as string;
		const ok = await api(`/agent/join/${request}`, "POST", { approve: true });
		expect(ok.statusCode, ok.body).toBe(200);
		const approved = await call(client, "attach", {
			review: link(),
			name: "carbonless · main",
			request,
		});
		expect(approved.value.state).toBe("approved");
		return approved.value as {
			token: string;
			watch: string;
			waiting: number;
			review: Record<string, unknown>;
			instructions: string;
		};
	};

	/** The watcher, as curl would hold it. */
	const watcher = async (token: string, review = id) => {
		const ac = new AbortController();
		const res = await fetch(`http://${host}/mcp/watch/${review}`, {
			headers: { authorization: `Bearer ${token}` },
			signal: ac.signal,
		});
		return { res, ac };
	};
	/** The watcher's body without its keep-alive newlines. */
	const lineOf = async (res: Response) => (await res.text()).trim();

	it("lists the tools; before approval only reviews and attach work", async () => {
		const client = await connect();
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"attach",
			"detach",
			"next",
			"reply",
			"review",
			"reviews",
			"threads",
		]);
		for (const t of tools) expect(t.description).toEqual(expect.any(String));
		const fake = `${id}.${"A".repeat(43)}`;
		for (const name of ["next", "threads", "review", "detach"]) {
			const r = await call(client, name, { token: fake });
			expect(r, name).toMatchObject({
				error: true,
				value: { error: "unknown-token" },
			});
		}
		const r = await call(client, "reply", {
			token: "nope",
			thread: "x",
			replyTo: "y",
			text: "hi",
		});
		expect(r.value.error).toBe("unknown-token");
	});

	it("reviews lists the open review on the request's origin, without asking GitHub", async () => {
		const client = await connect();
		const before = pr.ghLog();
		const r = await call(client, "reviews", {});
		expect(r.error).toBe(false);
		const reviews = r.value.reviews as Record<string, unknown>[];
		expect(reviews).toEqual([
			expect.objectContaining({
				link: link(),
				repo: "acme/widget",
				pr: 12,
				title: "Add widget cache",
				joinable: true,
				buddy: "none",
			}),
		]);
		expect((await call(client, "reviews", { query: "nothing" })).value).toEqual(
			{ reviews: [] },
		);
		expect(pr.ghLog()).toBe(before);
	});

	it("attach: pending with the link, the request on every page's status; Deny says denied", async () => {
		const client = await connect();
		const r = await call(client, "attach", {
			review: `${link()}/files?key=ignored`,
			name: "carbonless‮ · main\n",
		});
		expect(r.value).toMatchObject({ state: "pending" });
		expect(r.value.message).toContain(link());
		expect(r.value.message).toContain(r.value.request as string);
		const s = await status();
		// Sanitised, and the remote address when no machine is given.
		expect(s.joinRequest).toMatchObject({
			id: r.value.request,
			name: "carbonless · main",
			machine: "127.0.0.1",
		});
		await api(`/agent/join/${r.value.request}`, "POST", { approve: false });
		const denied = await call(client, "attach", {
			review: link(),
			name: "x",
			request: r.value.request,
		});
		expect(denied.value.state).toBe("denied");
	});

	it("attach with request waits for the answer (resolved while it waits)", async () => {
		const client = await connect();
		const r = await call(client, "attach", { review: link(), name: "s" });
		const request = r.value.request as string;
		const waiting = call(client, "attach", {
			review: link(),
			name: "s",
			request,
		});
		// The page sees the request while attach waits, and answers it.
		await vi.waitFor(async () =>
			expect((await status()).joinRequest?.id).toBe(request),
		);
		await api(`/agent/join/${request}`, "POST", { approve: true });
		expect((await waiting).value.state).toBe("approved");
	});

	it("attach refuses a bad link or request id", async () => {
		const client = await connect();
		for (const review of ["", "http://x/r/nope", "../../etc"]) {
			const r = await call(client, "attach", { review, name: "s" });
			expect(r.value.error, review).toBe("invalid");
		}
		const r = await call(client, "attach", {
			review: link(),
			name: "s",
			request: "../x",
		});
		expect(r.value.error).toBe("invalid");
	});

	it("approved: token, facts, waiting, the watch line; next, reply land in the thread", async () => {
		const asked = await ask();
		const client = await connect();
		const a = await join(client);
		expect(a.token.startsWith(`${id}.`)).toBe(true);
		expect(a.waiting).toBe(1);
		expect(a.watch).toContain(`'http://${host}/mcp/watch/${id}'`);
		expect(a.watch).toContain(`Authorization: Bearer ${a.token}`);
		expect(a.review).toMatchObject({
			link: link(),
			repo: "acme/widget",
			pr: 12,
			title: "Add widget cache",
			head: { commit: pr.head() },
		});
		expect(a.review).not.toHaveProperty("tree");
		expect(a.instructions).toMatch(/watch/);
		expect(await status()).toMatchObject({
			via: "mcp",
			state: "reconnecting",
			joined: { name: "carbonless · main", machine: "devbox" },
		});

		const n = await call(client, "next", { token: a.token });
		expect(n.error).toBe(false);
		const q = n.value as {
			thread: string;
			replyTo: string;
			preamble: string;
			envelope: {
				review: Record<string, unknown>;
				thread: { anchor: Record<string, unknown> };
				pr?: unknown;
			};
			anchoredFile: { path: string; commit: string; text: string };
			hunk: string;
		};
		expect(q.thread).toBe(asked.id);
		expect(q.replyTo).toBe(asked.messages[0]?.id);
		expect(q.preamble).toBe(JOINED_PREAMBLE);
		expect(q.envelope.review).not.toHaveProperty("tree");
		expect(q.envelope.thread.anchor).not.toHaveProperty("file");
		expect(q.envelope.pr).toBeDefined();
		expect(q.anchoredFile).toMatchObject({ path: "a.txt", commit: pr.head() });
		expect(q.anchoredFile.text).toContain("line 2 changed");
		expect(q.hunk).toContain("+line 2 changed");
		expect((await status()).answering?.thread).toBe(asked.id);
		// Until it replies, next hands out the same thread.
		const again = await call(client, "next", { token: a.token });
		expect(again.value.thread).toBe(asked.id);
		expect((again.value as { envelope: { pr?: unknown } }).envelope.pr).toBe(
			undefined,
		);

		const r = await call(client, "reply", {
			token: a.token,
			thread: q.thread,
			replyTo: q.replyTo,
			text: "Two writers race.",
		});
		expect(r.value).toMatchObject({ ok: true, waiting: false });
		const [t] = await threads();
		expect(t?.waiting).toBe(false);
		expect(t?.messages[1]).toMatchObject({
			by: "ai",
			text: "Two writers race.",
			replyTo: q.replyTo,
			agent: {
				name: "carbonless · main",
				version: "Claude Code 2.1",
				via: "mcp",
				machine: "devbox",
			},
		});
		expect((await call(client, "next", { token: a.token })).value).toEqual({
			none: true,
		});
		const all = await call(client, "threads", { token: a.token });
		expect(all.value.threads).toHaveLength(1);
		const facts = await call(client, "review", { token: a.token });
		expect(facts.value).toMatchObject({ repo: "acme/widget", link: link() });
	});

	it("a reviewer's message while the session answers still waits after its reply (Review focus 4)", async () => {
		const asked = await ask();
		const client = await connect();
		const a = await join(client);
		const n = await call(client, "next", { token: a.token });
		const more = await api(`/agent/threads/${asked.id}/messages`, "POST", {
			clientId: "m2",
			text: "And on close?",
		});
		expect(more.statusCode, more.body).toBe(200);
		await call(client, "reply", {
			token: a.token,
			thread: asked.id,
			replyTo: n.value.replyTo,
			text: "First answer.",
		});
		const [t] = await threads();
		expect(t?.waiting).toBe(true);
		const next = await call(client, "next", { token: a.token });
		expect(next.value.thread).toBe(asked.id);
		expect(next.value.replyTo).toBe(t?.messages[1]?.id);
	});

	it("reply to a thread not handed, a bad replyTo, or after leaving: refused, nothing stored (Review focus 5)", async () => {
		const first = await ask("q1", "One?");
		const second = await ask("q2", "Two?");
		const client = await connect();
		const a = await join(client);
		const n = await call(client, "next", { token: a.token });
		expect(n.value.thread).toBe(first.id);
		const other = await call(client, "reply", {
			token: a.token,
			thread: second.id,
			replyTo: second.messages[0]?.id,
			text: "Sneaky.",
		});
		expect(other.value.error).toBe("not-handed");
		const bad = await call(client, "reply", {
			token: a.token,
			thread: first.id,
			replyTo: second.messages[0]?.id,
			text: "Wrong replyTo.",
		});
		expect(bad.value.error).toBe("invalid");
		const empty = await call(client, "reply", {
			token: a.token,
			thread: first.id,
			replyTo: n.value.replyTo,
			text: "  ",
		});
		expect(empty.value.error).toBe("invalid");

		expect((await call(client, "detach", { token: a.token })).value).toEqual({
			ok: true,
		});
		const s = await status();
		expect(s.left).toMatchObject({
			why: "detached",
			name: "carbonless · main",
		});
		expect(s.joined).toBeUndefined();
		const late = await call(client, "reply", {
			token: a.token,
			thread: first.id,
			replyTo: n.value.replyTo,
			text: "Too late.",
		});
		expect(late.value.error).toBe("unknown-token");
		expect((await threads()).every((t) => t.messages.length === 1)).toBe(true);
		// The thread handed out goes back to waiting for whoever answers next.
		expect((await threads()).every((t) => t.waiting)).toBe(true);
	});

	describe("the watcher", () => {
		it("connects (listening), keeps alive, and delivers one line when a question comes", async () => {
			const client = await connect();
			const a = await join(client);
			const { res } = await watcher(a.token);
			expect(res.status).toBe(200);
			await vi.waitFor(async () =>
				expect((await status()).state).toBe("ready"),
			);
			const reader = res.body?.getReader();
			if (!reader) throw new Error("no body");
			// A keep-alive byte comes before any question.
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value)).toMatch(/^\n+$/);
			await ask();
			let body = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				body += new TextDecoder().decode(value);
			}
			expect(body.trim()).toBe(
				"carbonless: a question is waiting on acme/widget#12. Call crb's next tool, answer with reply, then run this watch command again.",
			);
			// Delivered and closed: busy, not reconnecting.
			await vi.waitFor(async () => expect((await status()).state).toBe("busy"));
		});

		it("answers at once when a question already waits", async () => {
			await ask();
			const client = await connect();
			const a = await join(client);
			const { res } = await watcher(a.token);
			expect(await lineOf(res)).toMatch(/question is waiting/);
		});

		it("a watcher dropped mid-delivery is delivered again on reconnect; the thread still waits (Review focus 1)", async () => {
			const client = await connect();
			const a = await join(client);
			const port = Number(host.split(":")[1]);
			// A raw request whose socket dies as the line comes in.
			const dropped = new Promise<void>((resolve) => {
				const req = httpRequest(
					{
						host: "127.0.0.1",
						port,
						path: `/mcp/watch/${id}`,
						headers: { authorization: `Bearer ${a.token}`, host },
					},
					(res) => {
						// The line arrives; the session never sees it.
						res.on("data", (chunk: Buffer) => {
							if (!chunk.toString().includes("carbonless")) return;
							req.destroy();
							resolve();
						});
					},
				);
				req.on("error", () => resolve());
				req.end();
			});
			await vi.waitFor(async () =>
				expect((await status()).state).toBe("ready"),
			);
			await ask();
			await dropped;
			expect((await threads())[0]?.waiting).toBe(true);
			const { res } = await watcher(a.token);
			expect(await lineOf(res)).toMatch(/question is waiting/);
		});

		it("a newer watcher replaces the open one, which ends with a line", async () => {
			const client = await connect();
			const a = await join(client);
			const old = await watcher(a.token);
			const fresh = await watcher(a.token);
			expect(await lineOf(old.res)).toMatch(/newer watcher/);
			fresh.ac.abort();
		});

		it("an open watcher ends when the session leaves; a new one gets 410; a bad token 401", async () => {
			const client = await connect();
			const a = await join(client);
			const { res } = await watcher(a.token);
			await vi.waitFor(async () =>
				expect((await status()).state).toBe("ready"),
			);
			const off = await api("/agent/disconnect", "POST");
			expect(off.statusCode).toBe(200);
			expect(await lineOf(res)).toMatch(/no longer joined.*disconnected/);
			expect((await watcher(a.token)).res.status).toBe(410);
			expect((await watcher(`${id}.${"B".repeat(43)}`)).res.status).toBe(410);
			expect((await watcher("garbage")).res.status).toBe(401);
			const elsewhere = `01k9e6m2q8x4v7c3n5b0h1j2t6.${"B".repeat(43)}`;
			expect((await watcher(elsewhere)).res.status).toBe(401);
		});

		it("a dropped watcher (not delivering) makes the session reconnecting", async () => {
			const client = await connect();
			const a = await join(client);
			const w = await watcher(a.token);
			await vi.waitFor(async () =>
				expect((await status()).state).toBe("ready"),
			);
			w.ac.abort();
			await vi.waitFor(async () =>
				expect((await status()).state).toBe("reconnecting"),
			);
		});
	});

	describe("behind an access key", () => {
		beforeEach(async () => {
			await app.close();
			await start("k3y_9");
		});

		it("401 without the key; with it, the watch line carries it", async () => {
			const bare = await fetch(`http://${host}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(bare.status).toBe(401);
			const watch = await fetch(`http://${host}/mcp/watch/${id}`);
			expect(watch.status).toBe(401);
			const client = await connect("?key=k3y_9");
			const r = await call(client, "attach", { review: link(), name: "s" });
			await api(`/agent/join/${r.value.request}?key=k3y_9`, "POST", {
				approve: true,
			});
			const a = await call(client, "attach", {
				review: link(),
				name: "s",
				request: r.value.request,
			});
			expect(a.value.watch).toContain(
				`'http://${host}/mcp/watch/${id}?key=k3y_9'`,
			);
		});

		it("a POST from another origin is refused", async () => {
			const res = await fetch(`http://${host}/mcp?key=k3y_9`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://evil.example",
				},
				body: "{}",
			});
			expect(res.status).toBe(403);
		});
	});
});

describe("reviewIdOf", () => {
	const ID = "01k9e6m2q8x4v7c3n5b0h1j2t6";
	it("takes a review's link, any page of it, or a bare id", () => {
		for (const s of [
			ID,
			` ${ID} `,
			`http://box:4747/r/${ID}`,
			`http://box:4747/r/${ID}/files?key=k#x`,
		]) {
			expect(reviewIdOf(s), s).toBe(ID);
		}
		for (const s of ["", "nope", `http://box/x/${ID}`, `http://box/r/${ID}x`]) {
			expect(reviewIdOf(s), s).toBeNull();
		}
	});
});
