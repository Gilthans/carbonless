import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	prView,
	reviewThread,
	threadComment,
} from "../../../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../../test/pr-fixture";
import { REVIEW_PREAMBLE } from "../../shared/agent";
import type { FileHunks, ReviewView } from "../../shared/types";
import { whitespaceLines } from "../../shared/whitespace";
import { hunkView } from "../../web/files/whitespace";
import { MAX_DIFF_CHARS } from "../agent/reads";
import { buildApp } from "../app";
import { SessionRegistry } from "../registry";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

type Tool = { error: boolean; value: Record<string, unknown> };
type Ranges = [number, number][];
type DiffFile = {
	path: string;
	oldPath?: string;
	status?: string;
	diff: string;
	hunks: number;
	whitespaceOnly: { LEFT: Ranges; RIGHT: Ranges };
	pairs: [number, number][];
	nextHunk?: number;
};
type Diff = {
	comparison: {
		base: string;
		head: string;
		from: number | null;
		to: number | null;
	};
	files: DiffFile[];
	unchanged?: number;
	omitted?: string[];
};

/**
 * The agent's reads of the code (CAR-182) through crb's MCP, against a
 * real review: `diff` (full diff, since the last pass, between patch
 * sets; crb's analysis), `file`, and `review`'s patch sets and thread
 * places on the head.
 */
describe("/mcp reads: diff, file, patch sets, threads at head", () => {
	let pr: PrFixture;
	let registry: SessionRegistry;
	let id: string;
	let app: FastifyInstance;
	let host: string;
	let clients: Client[];

	beforeEach(async () => {
		pr = createPrFixture();
		registry = new SessionRegistry();
		({ id } = await registry.open({ pr: pr.arg }));
		clients = [];
		app = await buildApp(registry, { accessKey: null, mcpKeepAliveMs: 50 });
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		host = `127.0.0.1:${address.port}`;
	});
	afterEach(async () => {
		await Promise.all(clients.map((c) => c.close().catch(() => {})));
		await app.close();
		await registry.closeAll();
		await pr.cleanup();
	});

	const connect = async (): Promise<Client> => {
		const client = new Client({ name: "test-session", version: "1.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`http://${host}/mcp`)),
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
	const link = () => `http://${host}/r/${id}`;
	/** attach, Approve in the page, attach again: the session's token. */
	const join = async (client: Client): Promise<string> => {
		const asked = await call(client, "attach", {
			review: link(),
			name: "carbonless · main",
		});
		const request = asked.value.request as string;
		const ok = await api(`/agent/join/${request}`, "POST", { approve: true });
		expect(ok.statusCode, ok.body).toBe(200);
		const approved = await call(client, "attach", {
			review: link(),
			name: "carbonless · main",
			request,
		});
		expect(approved.value.state).toBe("approved");
		return approved.value.token as string;
	};
	const joined = async () => {
		const client = await connect();
		const token = await join(client);
		return {
			ok: async (name: string, args: Record<string, unknown> = {}) => {
				const r = await call(client, name, { token, ...args });
				expect(r.error, `${name}: ${JSON.stringify(r.value)}`).toBe(false);
				return r.value;
			},
			refused: async (name: string, args: Record<string, unknown>) => {
				const r = await call(client, name, { token, ...args });
				expect(r.error, `${name} ${JSON.stringify(args)}`).toBe(true);
				return r.value as { error: string; message: string };
			},
		};
	};
	const view = async (query = ""): Promise<ReviewView> => {
		const res = await api(`/review${query}`);
		expect(res.statusCode, res.body).toBe(200);
		return res.json() as ReviewView;
	};
	const mark = async (v: ReviewView, key: string) => {
		const res = await app.inject({
			method: "POST",
			url: `/api/r/${id}/review/states`,
			headers: { host },
			payload: { revision: v.revision, changes: [{ key, state: "reviewed" }] },
		});
		expect(res.statusCode, res.body).toBe(200);
	};
	const keyOf = (v: ReviewView, path: string) => {
		const c = v.files.find((f) => f.path === path)?.clusters[0];
		if (!c) throw new Error(`no cluster in ${path}`);
		return c.key;
	};
	const refresh = async () => {
		const res = await api("/refresh", "POST");
		expect(res.statusCode, res.body).toBe(200);
	};
	const refs = async () => {
		const session = await registry.get(id);
		const repo = (session as unknown as { repo: string }).repo;
		return execFileSync(
			"git",
			["for-each-ref", "--format=%(refname) %(objectname)", "refs/crb"],
			{ cwd: repo, encoding: "utf8", env: testGitEnv() },
		);
	};
	/** PS1 on the PR's first head, PS2 on a second one that adds b.txt. */
	const twoPatchsets = async () => {
		const h1 = pr.head();
		const first = await view();
		await mark(first, keyOf(first, "a.txt"));
		const h2 = pr.moveHead({ "b.txt": "b\n" });
		await refresh();
		const atHead = await view(`?head=${h2}`);
		await mark(atHead, keyOf(atHead, "b.txt"));
		expect((await view("?patchset=2")).patchset).toBe(2);
		return { h1, h2 };
	};

	it("the agent is told of diff and file", async () => {
		const client = await connect();
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("diff");
		expect(names).toContain("file");
		expect(REVIEW_PREAMBLE).toContain("`diff`");
		expect(REVIEW_PREAMBLE).toContain("`file`");
	});

	it("diff: the review's full diff from crb's clone, as unified text per file; it writes nothing", async () => {
		const s = await joined();
		const stored = await refs();
		const d = (await s.ok("diff")) as unknown as Diff;
		expect(d.comparison).toEqual({
			base: pr.mergeBase,
			head: pr.head(),
			from: null,
			to: null,
		});
		expect(d.files.map((f) => [f.path, f.status])).toEqual([
			["a.txt", "modified"],
			["new.txt", "added"],
		]);
		const a = d.files[0] as DiffFile;
		expect(a.hunks).toBe(2);
		expect(a.diff).toContain(
			"@@ -1,5 +1,5 @@\n line 1\n-line 2\n+line 2 changed",
		);
		expect(a.diff).toContain("-line 26\n+line 26 changed");
		// The page pairs each edited line with its old one.
		expect(a.pairs).toEqual([
			[2, 2],
			[26, 26],
		]);
		expect(a.whitespaceOnly).toEqual({ LEFT: [], RIGHT: [] });
		expect(d.files[1]?.diff).toBe("@@ -0,0 +1,1 @@\n+new");
		expect(d.omitted).toBeUndefined();
		// One file by path.
		const one = (await s.ok("diff", { path: "new.txt" })) as unknown as Diff;
		expect(one.files.map((f) => f.path)).toEqual(["new.txt"]);
		expect(await refs()).toBe(stored);
	});

	it("diff: crb's analysis per file is the page's own (whitespace-only lines, paired lines)", async () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
		lines[1] = "line 2 changed";
		lines[25] = "line 26 changed";
		// Re-indented only: whitespace-only.
		lines[9] = "    line 10";
		// Two lines become one edited line: paired by similarity.
		lines.splice(14, 2, "line 15 and more");
		pr.moveHead({ "a.txt": `${lines.join("\n")}\n` });
		await refresh();
		const s = await joined();
		const d = (await s.ok("diff", { path: "a.txt" })) as unknown as Diff;
		const got = d.files[0] as DiffFile;
		expect(got.whitespaceOnly).toEqual({ LEFT: [[10, 10]], RIGHT: [[10, 10]] });
		expect(got.pairs).toContainEqual([15, 15]);
		// The page's computation over the hunks it is served.
		const v = await view();
		const index = v.files.find((f) => f.path === "a.txt")?.index;
		const res = await api(`/files/${index}/hunks?revision=${v.revision}`);
		expect(res.statusCode, res.body).toBe(200);
		const { hunks } = res.json() as FileHunks;
		const pagePairs = hunks.flatMap((h) =>
			hunkView(h.lines, false).pairs.map(([del, add]) => [
				del.oldNo,
				add.newNo,
			]),
		);
		const pageWs = hunks.flatMap((h) => [...whitespaceLines(h.lines)]);
		expect(got.pairs).toEqual(pagePairs);
		expect(got.whitespaceOnly.LEFT.flat()).toEqual(
			pageWs.filter((l) => l.kind === "del").flatMap((l) => [l.oldNo, l.oldNo]),
		);
		expect(got.whitespaceOnly.RIGHT.flat()).toEqual(
			pageWs.filter((l) => l.kind === "add").flatMap((l) => [l.newNo, l.newNo]),
		);
	});

	it("review: the reviewer's patch sets, the last one and what 'since your last pass' compares from", async () => {
		const s = await joined();
		const fresh = (await s.ok("review")).review as Record<string, unknown>;
		expect(fresh).toMatchObject({
			patchsets: [],
			lastReviewed: null,
			sinceLast: null,
			headPatchset: null,
		});
		const { h1, h2 } = await twoPatchsets();
		const r = (await s.ok("review")).review as Record<string, unknown>;
		expect(r.patchsets).toEqual([
			{
				number: 1,
				head: h1,
				mergeBase: pr.mergeBase,
				startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
			},
			{
				number: 2,
				head: h2,
				mergeBase: pr.mergeBase,
				startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
			},
		]);
		expect(r).toMatchObject({ lastReviewed: 2 });
		expect(r).toMatchObject({
			head: { commit: h2 },
			headPatchset: 2,
			sinceLast: 1,
		});
	});

	it("diff from 'last', and between two patch sets: the since view's changes only; the files it doesn't change are counted", async () => {
		const { h1, h2 } = await twoPatchsets();
		const s = await joined();
		const between = (await s.ok("diff", { from: 1, to: 2 })) as unknown as Diff;
		expect(between.comparison).toEqual({
			base: h1,
			head: h2,
			from: 1,
			to: 2,
		});
		expect(between.files.map((f) => f.path)).toEqual(["b.txt"]);
		expect(between.files[0]?.diff).toBe("@@ -0,0 +1,1 @@\n+b");
		expect(between.unchanged).toBe(2);
		// PS1's own full diff hasn't b.txt.
		const ps1 = (await s.ok("diff", { to: 1 })) as unknown as Diff;
		expect(ps1.comparison).toMatchObject({ head: h1, from: null, to: 1 });
		expect(ps1.files.map((f) => f.path)).toEqual(["a.txt", "new.txt"]);
		// "last" relative to PS2: PS1.
		const last = (await s.ok("diff", {
			from: "last",
			to: 2,
		})) as unknown as Diff;
		expect(last).toEqual(between);
		// "last" with no `to`: relative to the review's head.
		const r = (await s.ok("review")).review as { headPatchset: number | null };
		// The review is on PS2, the head the reviewer marked last.
		expect(r.headPatchset).toBe(2);
		expect(await s.ok("diff", { from: "last" })).toEqual(between);
		// Not before the head: refused, never an empty diff.
		for (const args of [{ from: 2, to: 1 }, { from: 2, to: 2 }, { from: 9 }]) {
			const r = await s.refused("diff", args);
			expect(r.error, JSON.stringify(args)).toBe("invalid");
		}
		const none = await s.refused("diff", { from: "last", to: 1 });
		expect(none).toMatchObject({
			error: "invalid",
			message: expect.stringContaining("only the full diff"),
		});
	});

	it("diff past its budget names the files it left out and cuts a long one with a marker", async () => {
		const big = Array.from(
			{ length: 30_000 },
			(_, i) => `a long line of the big file, number ${i}`,
		);
		pr.moveHead({ "big.txt": `${big.join("\n")}\n` });
		await refresh();
		const s = await joined();
		const all = (await s.ok("diff")) as unknown as Diff;
		expect(all.files.map((f) => f.path)).toEqual([
			"a.txt",
			"big.txt",
			"new.txt",
		]);
		expect(all.omitted).toEqual(["big.txt"]);
		const left = all.files.find((f) => f.path === "big.txt");
		expect(left).toMatchObject({ diff: "", hunks: 1, nextHunk: 0 });
		// Every other file is whole.
		expect(all.files.find((f) => f.path === "new.txt")?.diff).toContain("+new");
		const one = (await s.ok("diff", { path: "big.txt" })) as unknown as Diff;
		const text = one.files[0]?.diff ?? "";
		expect(text.length).toBeLessThanOrEqual(MAX_DIFF_CHARS);
		expect(text).toMatch(/\[truncated: hunk 0 is too long; .*file tool\]$/);
		// The file tool reads the rest, window by window.
		const f = await s.ok("file", { path: "big.txt", startLine: 29_999 });
		expect(f).toMatchObject({
			lines: 30_000,
			startLine: 29_999,
			endLine: 30_000,
			text: `${big[29_998]}\n${big[29_999]}`,
		});
		const first = await s.ok("file", { path: "big.txt" });
		expect(first.startLine).toBe(1);
		expect(first.nextLine).toBe((first.endLine as number) + 1);
		expect((first.text as string).length).toBeLessThanOrEqual(200_000);
	});

	it("diff refuses a path that isn't a file of the comparison, or could be an option", async () => {
		const s = await joined();
		for (const path of [
			"--output=x",
			"-p",
			"../a.txt",
			"/etc/passwd",
			"nope.txt",
		]) {
			const r = await s.refused("diff", { path });
			expect(r.error, path).toBe("invalid");
		}
		const r = await s.refused("diff", { fromHunk: 1 });
		expect(r.error).toBe("invalid");
	});

	it("file: a file at the head (default) or another of the review's commits, a window of lines", async () => {
		const s = await joined();
		const head = await s.ok("file", { path: "a.txt" });
		expect(head).toMatchObject({
			path: "a.txt",
			commit: pr.head(),
			lines: 30,
			startLine: 1,
			endLine: 30,
		});
		expect((head.text as string).split("\n")[1]).toBe("line 2 changed");
		expect(head.nextLine).toBeUndefined();
		const base = await s.ok("file", {
			path: "a.txt",
			commit: pr.mergeBase,
			startLine: 2,
			endLine: 3,
		});
		expect(base).toMatchObject({
			startLine: 2,
			endLine: 3,
			text: "line 2\nline 3",
		});
		const gone = await s.refused("file", {
			path: "new.txt",
			commit: pr.mergeBase,
		});
		expect(gone.error).toBe("not-found");
	});

	it("file refuses a path or commit that isn't safe or isn't the review's", async () => {
		const s = await joined();
		for (const path of [
			"--output=x",
			"-",
			"../../etc/passwd",
			"/etc/passwd",
			"a/../../x",
		]) {
			const r = await s.refused("file", { path });
			expect(r.error, path).toBe("invalid");
		}
		const session = await registry.get(id);
		const repo = (session as unknown as { repo: string }).repo;
		// A commit in the clone that isn't one of the review's (as crb's own
		// data would be): refused, though git has it.
		const other = execFileSync(
			"git",
			["commit-tree", `${pr.mergeBase}^{tree}`, "-m", "not the review's"],
			{
				cwd: repo,
				encoding: "utf8",
				env: {
					...testGitEnv(),
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@example.com",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@example.com",
				},
			},
		).trim();
		for (const commit of [
			"--output=x",
			"HEAD",
			"main",
			"0".repeat(40),
			other,
		]) {
			const r = await s.refused("file", { path: "a.txt", commit });
			expect(r.error, commit).toBe("invalid");
		}
	});

	it("review: each GitHub thread's place on the head, as the page places it, carried past a push; an outdated one says it can't be placed", async () => {
		const h1 = pr.head();
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
		lines[25] = "line 26 changed";
		// Line 2 is deleted, three lines go on top: line 26 is now 28.
		lines.splice(1, 1);
		pr.moveHead({ "a.txt": `top 1\ntop 2\ntop 3\n${lines.join("\n")}\n` });
		const h2 = pr.head();
		pr.scenario({
			prs: {
				12: {
					view: prView({ headRefOid: h2, baseRefName: "main" }),
					graphql: {
						reviewThreads: [
							reviewThread({ path: "a.txt", line: 26 }, [
								threadComment({ login: "rev", text: "Why 26?", commit: h1 }),
							]),
							reviewThread(
								{
									path: "a.txt",
									line: null,
									originalLine: 2,
									isOutdated: true,
								},
								[threadComment({ login: "rev", text: "And 2?", commit: h1 })],
							),
						],
					},
				},
			},
		});
		await refresh();
		const o = await api("/overview?maxAge=0");
		expect(o.statusCode, o.body).toBe(200);
		const s = await joined();
		const r = (await s.ok("review")).review as {
			head: { commit: string };
			threads: {
				line: number | null;
				outdated: boolean;
				comments: { body: string }[];
				atHead?: Record<string, unknown>;
			}[];
			placementsError?: string;
		};
		expect(r.head.commit).toBe(h2);
		expect(r.placementsError).toBeUndefined();
		const by = (body: string) =>
			r.threads.find((t) => t.comments[0]?.body === body);
		// GitHub's line stays as GitHub gave it; atHead is where crb shows it.
		expect(by("Why 26?")).toMatchObject({
			line: 26,
			atHead: {
				kind: "placed",
				path: "a.txt",
				side: "RIGHT",
				startLine: 28,
				line: 28,
			},
		});
		const outdated = by("And 2?");
		expect(outdated).toMatchObject({ outdated: true });
		// Never put back on GitHub's original line as if it still stood there.
		expect(outdated?.atHead).toMatchObject({ kind: "unplaced", path: "a.txt" });
		expect(outdated?.atHead?.fate).toEqual(expect.any(String));
	});
});
