import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FAKE_GH_DIR,
	prView,
	reviewThread,
	type Scenario,
	threadComment,
	timelineCommit,
	writeScenario,
} from "../../test/fake-gh/scenario";
import { testGitEnv } from "../../test/git-fixture";
import {
	fetchOverview,
	fetchPrMeta,
	fetchThreadContents,
	fetchThreadSummaries,
	fetchTimeline,
	resolvePrRef,
	runGh,
	viewerSlug,
} from "./gh";

/** The fake gh must answer exactly the calls gh.ts makes, the way gh does. */
describe("fake gh", () => {
	let tmp: string;
	const saved: Record<string, string | undefined> = {};
	const setEnv = (vars: Record<string, string>) => {
		for (const [k, v] of Object.entries(vars)) {
			if (!(k in saved)) saved[k] = process.env[k];
			process.env[k] = v;
		}
	};
	const scenario = (over: Partial<Scenario> = {}) =>
		setEnv({
			CRB_FAKE_GH: writeScenario(tmp, {
				repoPath: tmp,
				user: { login: "Octo_Cat" },
				prs: {},
				...over,
			}),
		});
	const ref = { owner: "acme", repo: "widget", number: 12 };

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "crb-fake-gh-"));
		setEnv({ PATH: `${FAKE_GH_DIR}:${process.env.PATH ?? ""}` });
		scenario();
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		for (const k of Object.keys(saved)) delete saved[k];
		rmSync(tmp, { recursive: true, force: true });
	});

	it("is an executable file", () => {
		expect(statSync(join(FAKE_GH_DIR, "gh")).mode & 0o111).toBe(0o111);
	});

	it("answers auth status, api user and repo view", async () => {
		scenario({ nameWithOwner: "acme/widget" });
		await expect(runGh(["auth", "status"])).resolves.toBeDefined();
		await expect(viewerSlug()).resolves.toBe("octo-cat");
		await expect(resolvePrRef("12", tmp)).resolves.toEqual(ref);
	});

	it("fails repo view outside a GitHub repository", async () => {
		await expect(resolvePrRef("12", tmp)).rejects.toThrow(/git remotes/);
	});

	it("prints only the requested pr view fields", async () => {
		scenario({
			prs: { "12": { view: prView({ headRefOid: "a".repeat(40) }) } },
		});
		const out = JSON.parse(
			await runGh([
				"pr",
				"view",
				"12",
				"-R",
				"acme/widget",
				"--json",
				"title,url",
			]),
		);
		expect(out).toEqual({
			title: "Add widget cache",
			url: "https://github.com/acme/widget/pull/12",
		});
		await expect(fetchPrMeta(ref)).resolves.toMatchObject({
			headOid: "a".repeat(40),
			baseBranch: "main",
			headRepo: "acme/widget",
		});
	});

	it("pages GraphQL connections by the scenario page size and serves bodyHTML", async () => {
		const threads = ["one.ts", "two.ts", "three.ts"].map((path) =>
			reviewThread({ path }),
		);
		scenario({
			pageSize: 2,
			prs: {
				"12": {
					view: prView(),
					graphql: {
						bodyHTML: "<h2>Cache</h2>",
						reviewThreads: threads,
						comments: [
							{ author: { login: "x", __typename: "User" }, createdAt: "" },
						],
					},
				},
			},
		});
		const o = await fetchOverview(ref, "me");
		expect(o.bodyHtml).toBe("<h2>Cache</h2>");
		const summaries = (await fetchThreadSummaries(ref)) as {
			id: string;
			path: string;
			first: { nodes: Record<string, unknown>[] };
		}[];
		expect(summaries.map((t) => t.path)).toEqual([
			"one.ts",
			"two.ts",
			"three.ts",
		]);
		// A summary only: the text comes by id.
		expect(summaries[0]?.first.nodes[0]).not.toHaveProperty("bodyHTML");
		const ids = summaries.map((t) => t.id);
		expect(new Set(ids).size).toBe(3);
		// A thread GitHub no longer has: null, though gh exits 1 as GitHub's
		// answer carries a NOT_FOUND error for it.
		const contents = await fetchThreadContents([ids[0] ?? "", "gone"]);
		expect(contents.size).toBe(2);
		expect(contents.get("gone")).toBeNull();
		const raw = spawnSync(
			join(FAKE_GH_DIR, "gh"),
			["api", "graphql", "-f", 'query=query { nodes(ids: ["gone"]) { id } }'],
			{ encoding: "utf8" },
		);
		expect(raw.status).toBe(1);
		expect(JSON.parse(raw.stdout)).toMatchObject({
			data: { nodes: [null] },
			errors: [{ type: "NOT_FOUND", path: ["nodes", 0] }],
		});
		// Every comment with its text; the fixture keeps the opener's in `first`.
		const content = contents.get(ids[0] ?? "") as {
			comments: { totalCount: number; nodes: Record<string, unknown>[] };
		};
		expect(content.comments.totalCount).toBe(2);
		expect(content.comments.nodes.map((c) => [c.id, c.bodyHTML])).toEqual([
			["C12-0", '<p dir="auto">Should this <strong>expire</strong>?</p>'],
			["C12-0-1", ""],
		]);
		// A summary lists the comments' authors, not their text.
		const listed = (
			summaries[0] as unknown as { comments: { nodes: object[] } }
		).comments.nodes;
		expect(listed).toHaveLength(2);
		for (const c of listed) expect(c).not.toHaveProperty("bodyHTML");
	});

	it("pages a thread's comments by commentPageSize, by alias, text only when asked", async () => {
		const comments = Array.from({ length: 5 }, (_, i) =>
			threadComment({ login: i % 2 ? "octo-author" : "rev", text: `c${i}` }),
		);
		const log = join(tmp, "log");
		scenario({
			commentPageSize: 2,
			prs: {
				"12": {
					view: prView(),
					graphql: {
						reviewThreads: [
							reviewThread({ path: "long.ts" }, comments),
							reviewThread({ path: "short.ts" }, comments.slice(0, 1)),
						],
					},
				},
			},
		});
		setEnv({ CRB_FAKE_GH_LOG: log });
		type Node = {
			id: string;
			comments: { totalCount: number; nodes: Record<string, unknown>[] };
		};
		const [long, short] = (await fetchThreadSummaries(ref)) as Node[];
		expect(long?.comments.totalCount).toBe(5);
		expect(long?.comments.nodes.map((c) => c.id)).toEqual([
			"C12-0",
			"C12-0-1",
			"C12-0-2",
			"C12-0-3",
			"C12-0-4",
		]);
		for (const c of long?.comments.nodes ?? []) {
			expect(c).not.toHaveProperty("bodyHTML");
		}
		expect(short?.comments.nodes).toHaveLength(1);
		const contents = await fetchThreadContents([
			long?.id ?? "",
			short?.id ?? "",
		]);
		const text = (contents.get(long?.id ?? "") as Node).comments.nodes.map(
			(c) => c.bodyText,
		);
		expect(text).toEqual(["c0", "c1", "c2", "c3", "c4"]);
		const { readFileSync } = await import("node:fs");
		// Two more pages each time, for the long thread only.
		const pages = readFileSync(log, "utf8")
			.split("\n")
			.filter((l) => l.includes("node(id:"));
		expect(pages).toHaveLength(4);
		for (const l of pages) expect(l).not.toContain(short?.id ?? "-");
	});

	it("reports a missing PR the way gh does", async () => {
		await expect(fetchPrMeta(ref)).rejects.toThrow(
			"PR acme/widget#12 not found",
		);
		await expect(fetchOverview(ref, "me")).rejects.toThrow(
			"PR acme/widget#12 not found",
		);
	});

	it("reports a logged out account the way gh does", async () => {
		scenario({ loggedOut: true });
		await expect(runGh(["auth", "status"])).rejects.toThrow(
			"gh is not logged in. Run: gh auth login",
		);
		await expect(fetchPrMeta(ref)).rejects.toThrow(
			"gh is not logged in. Run: gh auth login",
		);
	});

	it("exits 2 on anything it does not emulate", () => {
		const r = spawnSync("gh", ["pr", "merge", "12"], {
			env: process.env,
			encoding: "utf8",
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("fake gh: unsupported: pr merge 12");
	});

	it("clones the scenario repo bare", () => {
		const env = testGitEnv();
		execFileSync("git", ["init", "--quiet", join(tmp, "src")], { env });
		scenario({ repoPath: join(tmp, "src") });
		execFileSync(
			"gh",
			[
				"repo",
				"clone",
				"acme/widget",
				join(tmp, "c.git"),
				"--",
				"--bare",
				"--quiet",
			],
			{ env: testGitEnv() },
		);
		expect(
			execFileSync(
				"git",
				["-C", join(tmp, "c.git"), "rev-parse", "--is-bare-repository"],
				{ encoding: "utf8", env },
			).trim(),
		).toBe("true");
	});

	it("reads the timeline: the first page, then the rest at once by position", async () => {
		const items = Array.from({ length: 230 }, (_, i) =>
			timelineCommit({
				login: "ann",
				at: "2026-01-02T10:00:00Z",
				oid: i.toString(16).padStart(40, "0"),
			}),
		);
		const log = join(tmp, "log");
		scenario({
			prs: {
				"12": {
					view: prView(),
					graphql: { timelineItems: items, commitCount: 231 },
				},
			},
		});
		setEnv({ CRB_FAKE_GH_LOG: log });
		const read = await fetchTimeline(ref);
		expect(read.nodes).toEqual(items);
		expect(read.commitCount).toBe(231);
		const { readFileSync } = await import("node:fs");
		const skips = [...readFileSync(log, "utf8").matchAll(/skip=(\d+)/g)].map(
			(m) => m[1],
		);
		expect(skips.sort()).toEqual(["0", "100", "200"]);
	});

	it("never gives a timeline with a hole: pages that disagree are read again, then fail", async () => {
		const items = Array.from({ length: 150 }, (_, i) =>
			timelineCommit({
				login: "ann",
				at: "2026-01-02T10:00:00Z",
				oid: i.toString(16).padStart(40, "0"),
			}),
		);
		scenario({
			timelineCountDrift: true,
			prs: { "12": { view: prView(), graphql: { timelineItems: items } } },
		});
		await expect(fetchTimeline(ref)).rejects.toThrow(
			"The PR's timeline kept changing while it was read",
		);
	});

	it("keeps what GitHub lists when the pages agree on a count they fall short of", async () => {
		const items = Array.from({ length: 150 }, (_, i) =>
			timelineCommit({
				login: "ann",
				at: "2026-01-02T10:00:00Z",
				oid: i.toString(16).padStart(40, "0"),
			}),
		);
		scenario({
			timelineUnlisted: 120,
			prs: { "12": { view: prView(), graphql: { timelineItems: items } } },
		});
		const read = await fetchTimeline(ref);
		expect(read.nodes).toEqual(items);
		expect(read.itemCount).toBe(270);
	});

	it("names a missing PR when reading the timeline", async () => {
		await expect(fetchTimeline(ref)).rejects.toThrow(
			"PR acme/widget#12 not found",
		);
	});
});
