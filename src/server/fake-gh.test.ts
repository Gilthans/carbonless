import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEPT_TAGS } from "../../test/fake-gh/keptTags.mjs";
import {
	FAKE_GH_DIR,
	fakeGhEnv,
	prView,
	release,
	reviewThread,
	type Scenario,
	threadComment,
	timelineCommit,
	writeScenario,
} from "../../test/fake-gh/scenario";
import { fakeGhServerCalls } from "../../test/fake-gh/server.mjs";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../../test/git-fixture";
import { settleGh } from "../../test/settle-gh";
import { GITHUB_KEPT_TAGS } from "../shared/markdownEscape";
import { GhError, WriteRefusedError } from "./errors";
import {
	deleteComment,
	fetchComment,
	fetchOverview,
	fetchPrMeta,
	fetchThread,
	fetchThreadContents,
	fetchThreadSummaries,
	fetchTimeline,
	patchComment,
	postReply,
	postResolved,
	resolvePrRef,
	runGh,
	viewerSlug,
} from "./gh";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

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
		setEnv(fakeGhEnv());
		scenario();
	});

	afterEach(async () => {
		try {
			await settleGh(process.env.CRB_FAKE_GH);
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			for (const k of Object.keys(saved)) delete saved[k];
			rmSync(tmp, { recursive: true, force: true });
		}
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

	it("holds a call until the test releases it, then answers", async () => {
		scenario({
			hold: ["prView"],
			prs: { "12": { view: prView({ headRefOid: "a".repeat(40) }) } },
		});
		let answered = false;
		const view = fetchPrMeta(ref).then((meta) => {
			answered = true;
			return meta;
		});
		await new Promise((r) => setTimeout(r, 300));
		expect(answered).toBe(false);
		release(process.env.CRB_FAKE_GH ?? "", "prView");
		await expect(view).resolves.toMatchObject({ headOid: "a".repeat(40) });
	});

	it("renders with GitHub's kept tags: its copy is GITHUB_KEPT_TAGS", () => {
		expect([...KEPT_TAGS].sort()).toEqual([...GITHUB_KEPT_TAGS].sort());
	});

	it("refuses a repository name from gh that isn't a plain path segment (cache paths are built from it)", async () => {
		scenario({ nameWithOwner: "acme/.." });
		await expect(resolvePrRef("12", tmp)).rejects.toThrow(
			/Could not find the GitHub repository/,
		);
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

	describe("writes", () => {
		const PR_URL = "https://github.com/acme/widget/pull/12";
		const said = (login: string, text: string) =>
			threadComment({ login, text, createdAt: "2026-01-03T10:00:00Z" });
		const writable = (over: Partial<Scenario> = {}, reviews: unknown[] = []) =>
			scenario({
				nameWithOwner: "acme/widget",
				prs: {
					"12": {
						view: prView(),
						graphql: {
							reviewThreads: [
								reviewThread({ path: "a.ts", line: 1 }, [said("bob", "Why?")]),
								reviewThread({ path: "b.ts", line: 2, isResolved: true }, [
									said("bob", "Done?"),
								]),
							],
							reviews,
						},
					},
				},
				...over,
			});
		const thread0 = async () => {
			const [node] = await fetchThreadSummaries(ref);
			return node as {
				id: string;
				isResolved: boolean;
				viewerCanReply: boolean;
				viewerCanResolve: boolean;
				viewerCanUnresolve: boolean;
				first: { nodes: { databaseId: number }[] };
				comments: { totalCount: number; nodes: { id: string }[] };
			};
		};

		it("a reply then a threads read shows it, with GitHub's REST answer", async () => {
			writable();
			const before = await thread0();
			expect(before).toMatchObject({
				viewerCanReply: true,
				viewerCanResolve: true,
				viewerCanUnresolve: false,
			});
			const opener = before.first.nodes[0]?.databaseId ?? 0;
			const posted = await postReply(ref, opener, "Because.", PR_URL);
			expect(posted).toMatchObject({ body: "Because.", author: "Octo_Cat" });
			const after = await thread0();
			expect(after.comments.totalCount).toBe(2);
			expect(after.comments.nodes.map((c) => c.id)).toEqual([
				"C12-0",
				posted.nodeId,
			]);
			const content = (await fetchThreadContents([after.id])).get(after.id) as {
				comments: { nodes: { body: string; author: { login: string } }[] };
			};
			expect(content.comments.nodes.at(-1)).toMatchObject({
				body: "Because.",
				author: { login: "Octo_Cat" },
			});
			// By id, with its PR.
			await expect(fetchThread(ref, after.id)).resolves.toMatchObject({
				comments: { totalCount: 2 },
			});
			await expect(
				fetchThread({ ...ref, number: 13 }, after.id),
			).resolves.toBeNull();
		});

		it("resolve and unresolve flip isResolved and what the viewer may do", async () => {
			writable();
			const { id } = await thread0();
			await postResolved(id, true);
			expect(await thread0()).toMatchObject({
				isResolved: true,
				viewerCanResolve: false,
				viewerCanUnresolve: true,
			});
			await postResolved(id, false);
			expect((await thread0()).isResolved).toBe(false);
		});

		it("refuses a reply while the viewer has a pending review (GitHub's 422)", async () => {
			writable({}, [
				{ author: { login: "Octo_Cat" }, state: "PENDING", submittedAt: null },
			]);
			const opener = (await thread0()).first.nodes[0]?.databaseId ?? 0;
			const refused = await postReply(ref, opener, "Hi", PR_URL).catch(
				(e) => e,
			);
			expect(refused).toBeInstanceOf(WriteRefusedError);
			expect(refused).toMatchObject({
				code: "pending-review",
				url: `${PR_URL}/files`,
			});
			expect((await thread0()).comments.totalCount).toBe(1);
			// Another reviewer's pending review isn't the viewer's.
			writable({}, [{ author: { login: "bob" }, state: "PENDING" }]);
			await expect(postReply(ref, opener, "Hi", PR_URL)).resolves.toBeDefined();
		});

		it("fails the next write as told: before it lands, or after (afterWrite)", async () => {
			writable({ failNext: { op: "reply", status: 502 } });
			const opener = (await thread0()).first.nodes[0]?.databaseId ?? 0;
			const first = await postReply(ref, opener, "One", PR_URL).catch((e) => e);
			expect(first).not.toBeInstanceOf(WriteRefusedError);
			expect(String(first)).toMatch(/HTTP 502/);
			expect((await thread0()).comments.totalCount).toBe(1);
			// Used up: the next one lands.
			await postReply(ref, opener, "One", PR_URL);
			expect((await thread0()).comments.totalCount).toBe(2);

			writable({ failNext: { op: "reply", status: 502, afterWrite: true } });
			await expect(postReply(ref, opener, "Two", PR_URL)).rejects.toThrow(
				/HTTP 502/,
			);
			expect((await thread0()).comments.totalCount).toBe(2);

			writable({ failNext: { op: "resolve", status: 403 } });
			const { id } = await thread0();
			await expect(postResolved(id, true)).rejects.toMatchObject({
				code: "forbidden",
				message: expect.stringMatching(/permission/),
			});
		});

		it("fails like gh api: the answer on stdout, its top-level message on stderr", () => {
			writable({}, [{ author: { login: "Octo_Cat" }, state: "PENDING" }]);
			const out = spawnSync(
				"gh",
				[
					"api",
					"-X",
					"POST",
					"repos/acme/widget/pulls/12/comments/1000/replies",
					"-H",
					"Accept: application/vnd.github.full+json",
					"--input",
					"-",
				],
				{ input: JSON.stringify({ body: "Hi" }), encoding: "utf8" },
			);
			expect(out.status).toBe(1);
			expect(out.stderr.trim()).toBe("gh: Unprocessable Entity (HTTP 422)");
			expect(JSON.parse(out.stdout)).toMatchObject({
				errors: ["user_id can only have one pending review per pull request"],
				status: "422",
			});
			writable({
				failNext: { op: "resolve", graphql: { message: "Nope", type: "X" } },
			});
			const gql = spawnSync(
				"gh",
				[
					"api",
					"graphql",
					"-f",
					"query=mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }",
					"-f",
					"id=T12-0",
				],
				{ encoding: "utf8" },
			);
			expect(gql.status).toBe(1);
			expect(gql.stderr.trim()).toBe("gh: Nope");
			expect(JSON.parse(gql.stdout).errors[0]).toMatchObject({
				type: "X",
				message: "Nope",
			});
		});

		it("classifies by GitHub's answer: refusals for good, transient only for GitHub's trouble", async () => {
			const opener = 1000;
			const replyFails = async (failNext: Scenario["failNext"]) => {
				writable({ failNext });
				return postReply(ref, opener, "Hi", PR_URL).catch((e) => e);
			};
			const refusal = (code: string) =>
				expect.objectContaining({ constructor: WriteRefusedError, code });
			expect(await replyFails({ op: "reply", status: 400 })).toEqual(
				refusal("invalid"),
			);
			expect(await replyFails({ op: "reply", status: 401 })).toEqual(
				refusal("forbidden"),
			);
			expect(await replyFails({ op: "reply", status: 410 })).toEqual(
				refusal("invalid"),
			);
			for (const failNext of [
				{
					op: "reply",
					status: 403,
					message: "API rate limit exceeded for user.",
				},
				{ op: "reply", status: 429 },
				{ op: "reply", status: 503 },
			] as const) {
				const e = await replyFails(failNext);
				expect(e, JSON.stringify(failNext)).toBeInstanceOf(GhError);
				expect(e).not.toBeInstanceOf(WriteRefusedError);
			}
			const resolveFails = async (graphql: {
				type?: string;
				message: string;
			}) => {
				writable({ failNext: { op: "resolve", graphql } });
				return postResolved("T12-0", true).catch((e) => e);
			};
			expect(await resolveFails({ message: "Not allowed here" })).toEqual(
				expect.objectContaining({
					code: "invalid",
					message: "Not allowed here",
				}),
			);
			expect(
				await resolveFails({ type: "UNPROCESSABLE", message: "No" }),
			).toEqual(refusal("invalid"));
			const trouble = await resolveFails({
				message: "Something went wrong while executing your query.",
			});
			expect(trouble).not.toBeInstanceOf(WriteRefusedError);
			expect(
				await resolveFails({ type: "RATE_LIMITED", message: "Slow down" }),
			).not.toBeInstanceOf(WriteRefusedError);
		});

		it("a deleted thread is gone: 404 for a reply, NOT_FOUND for resolving", async () => {
			writable({ deletedThreads: ["T12-0"] });
			await expect(postReply(ref, 1000, "Hi", PR_URL)).rejects.toMatchObject({
				code: "gone",
			});
			await expect(postResolved("T12-0", true)).rejects.toMatchObject({
				code: "gone",
			});
			await expect(fetchThread(ref, "T12-0")).resolves.toBeNull();
		});

		describe("edits and deletes", () => {
			/** T12-0: the viewer's opener (REST 1000), bob's reply (1001), the viewer's (1002). */
			const three = (over: Partial<Scenario> = {}, bobs: object = {}) =>
				writable({
					prs: {
						"12": {
							view: prView(),
							graphql: {
								reviewThreads: [
									reviewThread({ path: "a.ts", line: 1 }, [
										{ ...said("Octo_Cat", "Why?"), diffHunk: "@@ hunk" },
										{ ...said("bob", "Because."), ...bobs },
										said("Octo_Cat", "Ok."),
									]),
								],
							},
						},
					},
					...over,
				});
			type Content = {
				comments: {
					totalCount: number;
					nodes: {
						id: string;
						body: string;
						databaseId: number;
						lastEditedAt: string | null;
						viewerCanUpdate: boolean;
						viewerCanDelete: boolean;
						diffHunk: string;
					}[];
				};
			};
			const content = async () =>
				(await fetchThreadContents(["T12-0"])).get("T12-0") as Content | null;

			it("lists each comment's REST id, lastEditedAt and what the viewer may do (their own)", async () => {
				three();
				const c = await content();
				expect(
					c?.comments.nodes.map((n) => [
						n.databaseId,
						n.lastEditedAt,
						n.viewerCanUpdate,
						n.viewerCanDelete,
					]),
				).toEqual([
					[1000, null, true, true],
					[1001, null, false, false],
					[1002, null, true, true],
				]);
			});

			it("an edit is stored and answered as GitHub's REST does; others' are refused (403)", async () => {
				three();
				const edited = await patchComment(ref, 1002, "Ok then.");
				expect(edited).toMatchObject({
					body: "Ok then.",
					bodyHtml: '<p dir="auto">Ok then.</p>',
				});
				const c = await content();
				expect(c?.comments.nodes[2]).toMatchObject({
					body: "Ok then.",
					lastEditedAt: edited.updatedAt,
				});
				await expect(patchComment(ref, 1001, "Mine")).rejects.toMatchObject({
					code: "forbidden",
				});
				await expect(patchComment(ref, 1009, "x")).rejects.toMatchObject({
					code: "gone",
				});
			});

			it("deleting the opener makes the next comment first, with the hunk; a reply then goes to it", async () => {
				three();
				await deleteComment(ref, 1000);
				const after = await thread0();
				expect(after.comments.totalCount).toBe(2);
				expect(after.first.nodes[0]?.databaseId).toBe(1001);
				const c = await content();
				expect(c?.comments.nodes.map((n) => n.id)).toEqual([
					"C12-0-1",
					"C12-0-2",
				]);
				expect(c?.comments.nodes[0]?.diffHunk).toBe("@@ hunk");
				await postReply(ref, 1001, "Still?", PR_URL);
				expect((await content())?.comments.totalCount).toBe(3);
				// Deleted: 404 from then on.
				await expect(deleteComment(ref, 1000)).rejects.toMatchObject({
					code: "gone",
				});
			});

			it("deleting every comment deletes the thread", async () => {
				// A maintainer may delete others' comments.
				three({}, { viewerCanDelete: true });
				for (const id of [1002, 1001, 1000]) await deleteComment(ref, id);
				await expect(fetchThread(ref, "T12-0")).resolves.toBeNull();
				await expect(fetchThreadSummaries(ref)).resolves.toEqual([]);
				await expect(content()).resolves.toBeNull();
			});

			it("writeUnlistedMs: GraphQL shows the text before an edit, and a deleted comment, for a while", async () => {
				three({ writeUnlistedMs: 60_000 });
				await patchComment(ref, 1000, "New");
				await deleteComment(ref, 1002);
				const c = await content();
				expect(c?.comments.nodes.map((n) => n.body)).toEqual([
					"Why?",
					"Because.",
					"Ok.",
				]);
				// REST has them at once.
				await expect(fetchComment(ref, 1000)).resolves.toMatchObject({
					body: "New",
				});
				await expect(fetchComment(ref, 1002)).resolves.toBeNull();
			});

			it("failNext edit/delete fails before, or after the write lands", async () => {
				three({ failNext: { op: "edit", status: 502, afterWrite: true } });
				await expect(patchComment(ref, 1002, "Landed")).rejects.toBeInstanceOf(
					GhError,
				);
				expect((await content())?.comments.nodes[2]?.body).toBe("Landed");
				three({ failNext: { op: "delete", status: 500 } });
				await expect(deleteComment(ref, 1002)).rejects.toBeInstanceOf(GhError);
				expect((await content())?.comments.totalCount).toBe(3);
			});
		});

		/**
		 * test/fake-gh/gh forwards each call to this process's fake gh
		 * server (server.mjs), which must keep a gh process's semantics.
		 */
		describe("its server", () => {
			const replyArgs = (opener: number) => [
				"api",
				"-X",
				"POST",
				`repos/acme/widget/pulls/12/comments/${opener}/replies`,
				"-H",
				"Accept: application/vnd.github.full+json",
				"--input",
				"-",
			];
			const until = async (done: () => boolean) => {
				while (!done()) await new Promise((r) => setTimeout(r, 20));
			};

			it("answers the calls, and without a server a process of its own does", async () => {
				writable();
				const before = fakeGhServerCalls().served;
				await expect(viewerSlug()).resolves.toBe("octo-cat");
				expect(fakeGhServerCalls().served).toBe(before + 1);
				setEnv({ CRB_FAKE_GH_SERVER: "" });
				await expect(viewerSlug()).resolves.toBe("octo-cat");
				const raw = spawnSync("gh", ["pr", "merge", "12"], {
					env: process.env,
					encoding: "utf8",
				});
				expect(raw.status).toBe(2);
				expect(raw.stderr).toBe("fake gh: unsupported: pr merge 12\n");
				expect(fakeGhServerCalls().served).toBe(before + 1);
			});

			it("a held call doesn't hold the others", async () => {
				writable({ hold: ["prView"] });
				let answered = false;
				const view = fetchPrMeta(ref).then(() => {
					answered = true;
				});
				await expect(viewerSlug()).resolves.toBe("octo-cat");
				await expect(thread0()).resolves.toMatchObject({ isResolved: false });
				expect(answered).toBe(false);
				release(process.env.CRB_FAKE_GH ?? "", "prView");
				await view;
			});

			it("passes stdin, stdout and stderr byte for byte, however long and whatever the script", async () => {
				// stderr comes before stdout: counted in characters, not
				// bytes (a UTF-8 locale), it would take some of stdout.
				writable({
					failNext: { op: "resolve", graphql: { message: "Nö ✓", type: "X" } },
				});
				const { LC_ALL: _, ...env } = process.env;
				const gql = spawnSync(
					"gh",
					[
						"api",
						"graphql",
						"-f",
						"query=mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }",
						"-f",
						"id=T12-0",
					],
					{ env: { ...env, LANG: "C.UTF-8" }, encoding: "utf8" },
				);
				expect(gql.stderr).toBe("gh: Nö ✓\n");
				expect(JSON.parse(gql.stdout).errors[0].message).toBe("Nö ✓");
				writable();
				const opener = (await thread0()).first.nodes[0]?.databaseId ?? 0;
				const body = `שלום ✓ "quoted" \\ $HOME \`x\`\n\n${"é—🙂".repeat(30_000)}\n`;
				const posted = await postReply(ref, opener, body, PR_URL);
				expect(posted.body).toBe(body);
				const { id } = await thread0();
				const content = (await fetchThreadContents([id])).get(id) as {
					comments: { nodes: { body: string }[] };
				};
				expect(content.comments.nodes.at(-1)?.body).toBe(body);
			});

			it("a killed call stops at its gate and saves nothing, like a killed process", async () => {
				const log = join(tmp, "gh.log");
				setEnv({ CRB_FAKE_GH_LOG: log });
				writable({ hold: ["reply"] });
				const opener = (await thread0()).first.nodes[0]?.databaseId ?? 0;
				const gh = spawn("gh", replyArgs(opener), { env: process.env });
				gh.stdin.end(JSON.stringify({ body: "Never" }));
				const exited = new Promise((r) => gh.on("exit", r));
				await until(
					() =>
						existsSync(log) && readFileSync(log, "utf8").includes("replies"),
				);
				gh.kill("SIGKILL");
				await exited;
				release(process.env.CRB_FAKE_GH ?? "", "reply");
				await until(() => fakeGhServerCalls().running === 0);
				expect((await thread0()).comments.totalCount).toBe(1);
			});

			it("a gh killed before it logs its call goes no further: no log line, no write", async () => {
				// A shim of the test's own, killed when the server asks it to
				// log the call: as a gh process killed before its first line.
				setEnv({ CRB_FAKE_GH_LOG: join(tmp, "gh.log") });
				writable();
				const opener = (await thread0()).first.nodes[0]?.databaseId ?? 0;
				const before = fakeGhServerCalls().served;
				const [host, port] = (process.env.CRB_FAKE_GH_SERVER ?? "").split(":");
				const args = replyArgs(opener);
				const env = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
				const socket = connect(Number(port), host);
				socket.write(
					`${[
						"1",
						tmp,
						"1",
						String(args.length),
						...args,
						...env,
						"",
						JSON.stringify({ body: "Never" }),
					].join("\0")}\0`,
				);
				let said = "";
				await new Promise<void>((resolve) =>
					socket.on("data", (d) => {
						said += d;
						if (said === "log\n") resolve();
					}),
				);
				socket.destroy();
				await until(() => fakeGhServerCalls().running === 0);
				expect(fakeGhServerCalls().served).toBe(before + 1);
				expect(readFileSync(join(tmp, "gh.log"), "utf8")).not.toContain(
					"replies",
				);
				expect((await thread0()).comments.totalCount).toBe(1);
			});
		});
	});
});
