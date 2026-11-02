import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../../test/fake-gh/atomic.mjs";
import {
	listReplies,
	prView,
	release,
	reviewThread,
	type Scenario,
	threadComment,
} from "../../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import type { NewThreadRequest } from "../shared/types";
import { GhError, WriteRefusedError } from "./errors";
import { newThreadProblem, placeOf, postedBody } from "./newThreads";
import { mapThreads } from "./overview";
import { parseHead } from "./pinnedHead";
import { Session } from "./session";
import { writeWaits } from "./threadWrites";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

/** A thread as the fake gh stores it (scenario.ts ThreadNode, plus a new one's own fields). */
interface Stored {
	path: string;
	subjectType: string;
	line: number | null;
	originalLine: number | null;
	startLine: number | null;
	originalStartLine: number | null;
	diffSide: string;
	startDiffSide: string | null;
	first: { nodes: { body: string; diffHunk: string }[] };
	comments: { nodes: { body: string }[] };
}

/**
 * PR acme/widget#12 (test/pr-fixture.ts): a.txt's lines 2 and 26 changed,
 * new.txt added. The viewer is Octo_Cat; T12-0 is an older thread by rev.
 */
describe("new threads", () => {
	let pr: PrFixture;
	let session: Session;
	let ids = 0;

	const scenario = (over: Partial<Scenario> = {}, reviews: unknown[] = []) =>
		pr.scenario({
			prs: {
				12: {
					view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
					graphql: {
						reviewThreads: [
							reviewThread({ path: "a.txt", line: 26 }, [
								threadComment({
									login: "rev",
									text: "Typo",
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
	/** Sets scenario fields, keeping what the fake gh stored (its writes). */
	const tweak = (over: Partial<Scenario>) => {
		const path = process.env.CRB_FAKE_GH ?? "";
		const s = JSON.parse(readFileSync(path, "utf8")) as Scenario;
		writeFileAtomic(path, JSON.stringify({ ...s, ...over }, null, "\t"));
	};
	const stored = (): Stored[] =>
		(
			JSON.parse(readFileSync(process.env.CRB_FAKE_GH ?? "", "utf8")) as {
				prs: Record<string, { graphql: { reviewThreads: Stored[] } }>;
			}
		).prs[12]?.graphql.reviewThreads ?? [];
	const posts = () =>
		pr
			.ghLog()
			.split("\n")
			.filter((l) =>
				/^api -X POST repos\/acme\/widget\/pulls\/12\/comments /.test(l),
			);
	const request = (more: Partial<NewThreadRequest> = {}): NewThreadRequest => ({
		clientId: `n${++ids}`,
		body: "Why not a map?",
		attemptedAt: new Date().toISOString(),
		retry: false,
		path: "a.txt",
		commit: pr.head(),
		subject: "line",
		side: "RIGHT",
		line: 2,
		...more,
	});
	const refused = async (p: Promise<unknown>) => {
		const error = await p.then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(WriteRefusedError);
		return error as WriteRefusedError;
	};

	/** The waits a write took (writeWaits), none of them real. */
	let waited: number[] = [];
	/** GitHub's GraphQL lists held-back threads after this many waits. */
	let catchUp = Number.POSITIVE_INFINITY;
	const realSleep = writeWaits.sleep;

	beforeEach(async () => {
		waited = [];
		catchUp = Number.POSITIVE_INFINITY;
		writeWaits.sleep = async (ms) => {
			waited.push(ms);
			if (waited.length >= catchUp) listReplies(process.env.CRB_FAKE_GH ?? "");
		};
		pr = createPrFixture();
		scenario();
		session = await Session.open(pr.arg, process.cwd());
		await session.threads((await session.overview()).readId, "summary");
	});
	afterEach(async () => {
		writeWaits.sleep = realSleep;
		// Never GraphQL's, which would put the comment into a pending review.
		expect(pr.ghLog()).not.toContain("addPullRequestReviewThread");
		await pr.cleanup();
	});

	it("a span on one line: REST line + side only, the marker on the body, and the thread GitHub reads back carries the span", async () => {
		const req = request({ startCol: 5, endCol: 12 });
		const { thread, comments } = await session.startThread(req);
		expect(posts()).toHaveLength(1);
		const [t] = stored().slice(-1);
		// What was sent: one line, no start.
		expect(t).toMatchObject({
			path: "a.txt",
			subjectType: "LINE",
			line: 2,
			originalLine: 2,
			// GitHub's own: a single line's startLine is the line.
			startLine: 2,
			originalStartLine: null,
			diffSide: "RIGHT",
			startDiffSide: null,
		});
		expect(t?.comments.nodes[0]?.body).toBe(
			`Why not a map?\n\n<!-- crb:v1 id=${req.clientId} span=2:5-2:12 -->`,
		);
		// What is read back: those lines, with the span; no marker shown.
		expect(thread.anchor).toEqual({
			path: "a.txt",
			commit: pr.head(),
			side: "RIGHT",
			line: 2,
			startSide: "RIGHT",
			startLine: 2,
			startCol: 5,
			endCol: 12,
			at: expect.any(String),
		});
		expect(thread).toMatchObject({
			id: "T12-1",
			subject: "line",
			author: "Octo_Cat",
			body: "Why not a map?",
			excerpt: "Why not a map?",
			commit: pr.head(),
			loaded: true,
		});
		// The fake's hunk (GitHub's view) agrees with the clone's rows.
		expect(thread.code).toMatchObject({
			source: "clone",
			snapshot: { same: true },
		});
		expect(
			thread.code?.rows.filter((r) => r.marked).map((r) => r.newNo),
		).toEqual([2]);
		expect(comments.comments.map((c) => c.body)).toEqual(["Why not a map?"]);
		expect(comments.comments[0]?.viewerCan).toEqual({
			update: true,
			delete: true,
		});
	});

	it("joins the kept reads: the overview's threads and comments show it before any Refresh", async () => {
		const { readId } = await session.overview();
		const { thread } = await session.startThread(
			request({ startCol: 2, endCol: 7 }),
		);
		expect(thread.code?.anchor).toMatchObject({ startCol: 2, endCol: 7 });
		const view = await session.threads(readId, "full");
		const listed = view.threads.find((t) => t.id === thread.id);
		expect(listed?.anchor).toEqual(thread.anchor);
		expect(listed?.code?.anchor).toEqual(thread.anchor);
		expect(listed?.code?.source).toBe("clone");
		const { threads } = await session.comments(readId, [thread.id]);
		expect(threads[0]?.comments.map((c) => c.body)).toEqual(["Why not a map?"]);
		// A new read (a reload's Refresh) has it from GitHub, the same.
		const fresh = await session.overview(0);
		const again = (await session.threads(fresh.readId, "full")).threads.find(
			(t) => t.id === thread.id,
		);
		expect(again?.anchor).toEqual(thread.anchor);
		expect(again?.body).toBe("Why not a map?");
		// The code window's anchor too: the span is painted after a reload.
		expect(again?.code?.source).toBe("clone");
		expect(again?.code?.anchor).toEqual(thread.anchor);
	});

	it("a range across lines, a range from LEFT to RIGHT, and a LEFT line: GitHub's exact lines", async () => {
		const cases: [Partial<NewThreadRequest>, Partial<Stored>][] = [
			[
				{
					startSide: "RIGHT",
					startLine: 1,
					side: "RIGHT",
					line: 3,
					startCol: 2,
					endCol: 4,
				},
				{ startLine: 1, line: 3, diffSide: "RIGHT", startDiffSide: "RIGHT" },
			],
			[
				{ startSide: "LEFT", startLine: 2, side: "RIGHT", line: 2 },
				{ startLine: 2, line: 2, diffSide: "RIGHT", startDiffSide: "LEFT" },
			],
			[
				{ side: "LEFT", line: 2 },
				{
					startLine: 2,
					originalStartLine: null,
					line: 2,
					diffSide: "LEFT",
					startDiffSide: null,
				},
			],
		];
		for (const [where, sent] of cases) {
			const { thread } = await session.startThread(request(where));
			expect(stored().at(-1)).toMatchObject(sent);
			const side = where.side ?? "RIGHT";
			expect(thread.anchor).toMatchObject({
				side,
				line: where.line,
				startSide: where.startSide ?? side,
				startLine: where.startLine ?? where.line,
			});
			expect(thread.anchor?.startCol ?? null).toBe(where.startCol ?? null);
			expect(thread.anchor?.endCol ?? null).toBe(where.endCol ?? null);
		}
		// A range starting on LEFT and ending on RIGHT on the same number is
		// a range, not one line.
		expect(
			placeOf(
				request({ startSide: "LEFT", startLine: 2, side: "RIGHT", line: 2 }),
			),
		).toMatchObject({ start: { side: "LEFT", line: 2 } });
	});

	it("a range from RIGHT to LEFT goes to GitHub as asked (it takes one whose start comes first in the diff)", async () => {
		const { thread } = await session.startThread(
			request({ startSide: "RIGHT", startLine: 1, side: "LEFT", line: 2 }),
		);
		expect(stored().at(-1)).toMatchObject({
			startDiffSide: "RIGHT",
			originalStartLine: 1,
			diffSide: "LEFT",
			originalLine: 2,
		});
		expect(thread.anchor).toMatchObject({
			startSide: "RIGHT",
			startLine: 1,
			side: "LEFT",
			line: 2,
		});
	});

	it("a range starting LEFT on a context line: the anchor is the old number, though GitHub's startLine reads back the new one", async () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
		lines[1] = "line 2 changed";
		lines[25] = "line 26 changed";
		// Two lines on top: old line 1 is new line 3.
		const now = pr.moveHead({
			"a.txt": `${["top 1", "top 2", ...lines].join("\n")}\n`,
		});
		const s = await Session.open(pr.arg, process.cwd());
		const { thread } = await s.startThread(
			request({
				commit: now,
				startSide: "LEFT",
				startLine: 1,
				side: "LEFT",
				line: 2,
			}),
		);
		// GitHub's quirk, reproduced by the fake.
		expect(stored().at(-1)).toMatchObject({
			startLine: 3,
			originalStartLine: 1,
			startDiffSide: "LEFT",
		});
		expect(thread.anchor).toMatchObject({
			startSide: "LEFT",
			startLine: 1,
			side: "LEFT",
			line: 2,
		});
		expect(
			thread.code?.rows.filter((r) => r.marked).map((r) => r.oldNo),
		).toEqual([1, 2]);
	});

	it("with no original line, a LEFT start is never GitHub's current startLine (the new number there)", () => {
		const node = {
			...reviewThread({
				path: "a.txt",
				line: 5,
				originalLine: null,
				startLine: 3,
				originalStartLine: null,
				diffSide: "LEFT",
				startDiffSide: "LEFT",
			}),
			id: "T1",
		};
		const [t] = mapThreads([node], { prAuthor: "rev", viewer: "Octo_Cat" });
		expect(t?.anchor).toMatchObject({
			startSide: "LEFT",
			startLine: 5,
			side: "LEFT",
			line: 5,
		});
	});

	it("a range across two hunks goes as asked (GitHub takes it); a line between hunks is GitHub's 422 → gone", async () => {
		const { thread } = await session.startThread(
			request({ startSide: "RIGHT", startLine: 2, side: "RIGHT", line: 26 }),
		);
		expect(thread.anchor).toMatchObject({ startLine: 2, line: 26 });
		const between = await refused(
			session.startThread(request({ side: "RIGHT", line: 15 })),
		);
		expect(between.code).toBe("gone");
	});

	it("a file comment: subject_type file, no lines, on any file of the diff", async () => {
		const { thread } = await session.startThread(
			request({
				subject: "file",
				path: "new.txt",
				side: undefined,
				line: undefined,
			}),
		);
		// GitHub reports a file thread on line 1; carbonless on none.
		expect(stored().at(-1)).toMatchObject({
			path: "new.txt",
			subjectType: "FILE",
			line: 1,
			originalLine: 1,
			diffSide: "RIGHT",
		});
		expect(thread).toMatchObject({
			line: null,
			currentLine: null,
			subject: "file",
			path: "new.txt",
			anchor: null,
			code: null,
			body: "Why not a map?",
		});
		expect(stored().at(-1)?.comments.nodes[0]?.body).toMatch(
			/\n\n<!-- crb:v1 id=n\d+ -->$/,
		);
	});

	it("GitHub's 422 for a line or a file not in its diff → gone (404), nothing posted", async () => {
		const before = stored().length;
		expect(
			(await refused(session.startThread(request({ line: 15 })))).code,
		).toBe("gone");
		expect(
			(
				await refused(
					session.startThread(
						request({
							subject: "file",
							path: "nope.txt",
							side: undefined,
							line: undefined,
						}),
					),
				)
			).code,
		).toBe("gone");
		expect(stored()).toHaveLength(before);
	});

	it("a pending review → 409 pending-review with the files link; nothing pending made; the warning shows", async () => {
		scenario({}, [{ author: { login: "Octo_Cat" }, state: "PENDING" }]);
		const before = stored().length;
		const error = await refused(session.startThread(request()));
		expect(error.code).toBe("pending-review");
		expect(error.url).toBe("https://github.com/acme/widget/pull/12/files");
		expect(stored()).toHaveLength(before);
		expect((await session.overview()).pendingReview).toEqual({
			url: "https://github.com/acme/widget/pull/12/files",
		});
	});

	it("a selection made on another head → 409 stale, nothing sent", async () => {
		const error = await refused(
			session.startThread(request({ commit: "f".repeat(40) })),
		);
		expect(error.code).toBe("stale");
		expect(posts()).toHaveLength(0);
	});

	it("invalid requests are refused before GitHub", async () => {
		const bad: Partial<NewThreadRequest>[] = [
			{ body: "  \n" },
			{ body: "x".repeat(65536) },
			{ clientId: "has space" },
			{ clientId: "x-->" },
			{ side: "UP" as "LEFT" },
			{ line: 0 },
			{ startSide: "RIGHT", startLine: 5, line: 2 },
			{ startSide: "RIGHT" },
			{ startCol: 3 },
			{ startCol: 4, endCol: 4 },
			{ startCol: -1, endCol: 4 },
			{ subject: "file", startCol: 1, endCol: 2 },
			{ subject: "file" },
			{ commit: "HEAD" },
			{ path: "" },
		];
		for (const more of bad) {
			const error = await refused(session.startThread(request(more)));
			expect(error.code, JSON.stringify(more)).toBe("invalid");
		}
		expect(posts()).toHaveLength(0);
		expect(newThreadProblem(request())).toBeNull();
		expect(newThreadProblem(null)).not.toBeNull();
	});

	it("the post lands but the answer is lost: the retry returns the same thread, nothing posted twice, after a restart too", async () => {
		tweak({ failNext: { op: "comment", status: 502, afterWrite: true } });
		const req = request({ startCol: 0, endCol: 3 });
		const lost = await session.startThread(req).then(
			() => null,
			(e: unknown) => e,
		);
		expect(lost).toBeInstanceOf(GhError);
		expect(lost).not.toBeInstanceOf(WriteRefusedError);
		expect(stored()).toHaveLength(2);
		const again = await session.startThread({ ...req, retry: true });
		expect(again.thread.id).toBe("T12-1");
		expect(again.thread.anchor).toMatchObject({ startCol: 0, endCol: 3 });
		// crb restarted: the new session finds it on GitHub by its client id.
		const restarted = await Session.open(pr.arg, process.cwd());
		const third = await restarted.startThread({ ...req, retry: true });
		expect(third.thread.id).toBe("T12-1");
		expect(posts()).toHaveLength(1);
		expect(stored()).toHaveLength(2);
	});

	it("a lost answer, then the head moves: the retry still returns the thread, not stale, and posts nothing", async () => {
		tweak({ failNext: { op: "comment", status: 502, afterWrite: true } });
		const req = request();
		await expect(session.startThread(req)).rejects.toBeInstanceOf(GhError);
		const path = process.env.CRB_FAKE_GH ?? "";
		const before = JSON.parse(readFileSync(path, "utf8")) as Scenario;
		const now = pr.moveHead({ "later.txt": "later\n" });
		const prs = before.prs;
		const pr12 = prs[12];
		if (!pr12) throw new Error("no PR 12");
		pr12.view = prView({ headRefOid: now, baseRefName: "main" });
		tweak({ prs });
		const restarted = await Session.open(pr.arg, process.cwd());
		expect(restarted.info().snapshotHead).toBe(now);
		const again = await restarted.startThread({ ...req, retry: true });
		expect(again.thread.id).toBe("T12-1");
		// A fresh one on the old head is stale, as before.
		const stale = await refused(
			restarted.startThread(request({ commit: req.commit })),
		);
		expect(stale.code).toBe("stale");
		expect(posts()).toHaveLength(1);
	});

	it("an unknown outcome: the retry lists again after each wait before posting, as GitHub may make it late", async () => {
		tweak({ failNext: { op: "comment", status: 502 } });
		const req = request();
		await expect(session.startThread(req)).rejects.toBeInstanceOf(GhError);
		// GitHub makes it while the retry waits (its first wait).
		writeWaits.sleep = async (ms) => {
			waited.push(ms);
			if (waited.length === 1) {
				execFileSync(
					"gh",
					[
						"api",
						"-X",
						"POST",
						"repos/acme/widget/pulls/12/comments",
						"-H",
						"Accept: application/vnd.github.full+json",
						"--input",
						"-",
					],
					{
						input: JSON.stringify({
							body: postedBody(req),
							commit_id: req.commit,
							path: req.path,
							line: req.line,
							side: req.side,
						}),
					},
				);
			}
		};
		const { thread } = await session.startThread({ ...req, retry: true });
		expect(thread.id).toBe("T12-1");
		expect(waited[0]).toBe(300);
		// The failed attempt and GitHub's late one; no third.
		expect(posts()).toHaveLength(2);
		expect(stored()).toHaveLength(2);
	});

	it("a resend while the first attempt runs waits for it; a resend after it is answered without posting", async () => {
		tweak({ commentDelayMs: 300 });
		const req = request();
		const [first, second] = await Promise.all([
			session.startThread(req),
			session.startThread({ ...req, retry: true }),
		]);
		expect(second.thread.id).toBe(first.thread.id);
		const third = await session.startThread(req);
		expect(third.thread.id).toBe(first.thread.id);
		expect(posts()).toHaveLength(1);
	});

	it("a retry whose first attempt didn't land posts it; one carrying another client id doesn't count", async () => {
		const other = await session.startThread(request());
		tweak({ failNext: { op: "comment", status: 502 } });
		const req = request();
		await expect(session.startThread(req)).rejects.toBeInstanceOf(GhError);
		const { thread } = await session.startThread({ ...req, retry: true });
		expect(posts()).toHaveLength(3);
		expect(other.thread.id).toBe("T12-1");
		expect(thread.id).toBe("T12-2");
		expect(stored()).toHaveLength(3);
	});

	it("GitHub's GraphQL lagging: re-read until it lists the thread; never listed, a 502 whose resend doesn't post again", async () => {
		tweak({ threadUnlisted: true });
		catchUp = 2;
		const { thread } = await session.startThread(request());
		expect(thread.id).toBe("T12-1");
		expect(waited).toEqual([300, 1000]);

		tweak({ threadUnlisted: true });
		catchUp = Number.POSITIVE_INFINITY;
		const req = request();
		const error = await session.startThread(req).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(GhError);
		expect(error).not.toBeInstanceOf(WriteRefusedError);
		listReplies(process.env.CRB_FAKE_GH ?? "");
		const later = await session.startThread({ ...req, retry: true });
		expect(later.thread.id).toBe("T12-2");
		expect(posts()).toHaveLength(2);
	});

	it("an edit keeps the marker and its span; from and the dedupe compare without it", async () => {
		const { thread, comments } = await session.startThread(
			request({ startCol: 1, endCol: 6 }),
		);
		const id = comments.comments[0]?.id ?? "";
		const edited = await session.editThreadComment(thread.id, id, {
			body: "Why not a Map?",
			from: "Why not a map?",
			force: false,
		});
		expect(edited.comment?.body).toBe("Why not a Map?");
		expect(stored().at(-1)?.comments.nodes[0]?.body).toMatch(
			/^Why not a Map\?\n\n<!-- crb:v1 id=n\d+ span=2:1-2:6 -->$/,
		);
		// The same text again: done, nothing sent.
		const log = pr.ghLog();
		await session.editThreadComment(thread.id, id, {
			body: "Why not a Map?",
			from: "Why not a map?",
			force: false,
		});
		expect(pr.ghLog().slice(log.length)).not.toContain("-X PATCH");
		const fresh = await session.overview(0);
		const again = (await session.threads(fresh.readId, "full")).threads.find(
			(t) => t.id === thread.id,
		);
		expect(again?.anchor).toMatchObject({ startCol: 1, endCol: 6 });
		expect(again?.body).toBe("Why not a Map?");
	});

	it("as of a cutoff or as someone else: writes-off, nothing sent", async () => {
		const other = await Session.open(pr.arg, process.cwd(), () => {}, {
			viewer: "someone-else",
		});
		expect((await refused(other.startThread(request()))).code).toBe(
			"writes-off",
		);
		expect(posts()).toHaveLength(0);
	});

	it("a new thread's tags GitHub would drop go escaped, before the marker; it reads back as typed", async () => {
		const req = request({ body: "Why not List<String>?" });
		const { thread, comments } = await session.startThread(req);
		expect(stored().at(-1)?.comments.nodes[0]?.body).toBe(
			`Why not List\\<String>?\n\n<!-- crb:v1 id=${req.clientId} -->`,
		);
		expect(thread.body).toBe("Why not List<String>?");
		expect(comments.comments[0]?.body).toBe("Why not List<String>?");
		expect(postedBody(request({ clientId: "a1", body: "<T>" }))).toBe(
			"\\<T>\n\n<!-- crb:v1 id=a1 -->",
		);
	});

	it("postedBody: the marker with the posted lines, only with a span", () => {
		expect(postedBody(request({ clientId: "a1" }))).toBe(
			"Why not a map?\n\n<!-- crb:v1 id=a1 -->",
		);
		expect(
			postedBody(
				request({
					clientId: "a1",
					startLine: 1,
					startSide: "LEFT",
					line: 3,
					startCol: 0,
					endCol: 9,
				}),
			),
		).toBe("Why not a map?\n\n<!-- crb:v1 id=a1 span=1:0-3:9 -->");
	});
});

describe("commentLeft", () => {
	let pr: PrFixture;
	afterEach(async () => {
		await pr.cleanup();
	});

	const compares = () => pr.ghLog().match(/compare\//g)?.length ?? 0;
	const scenario12 = (over: Partial<Scenario> = {}, head = pr.head()) =>
		pr.scenario({
			...over,
			prs: {
				12: {
					view: prView({ headRefOid: head, baseRefName: "main" }),
					graphql: {
						commits: [
							{
								commit: {
									oid: pr.mergeBase,
									committedDate: "2026-01-01T00:00:00Z",
								},
							},
						],
						reviews: [],
						reviewThreads: [],
						comments: [],
					},
				},
			},
		});
	const line = (
		commit: string,
		clientId: string,
		more: Partial<NewThreadRequest> = {},
	): NewThreadRequest => ({
		clientId,
		body: "Here",
		attemptedAt: new Date().toISOString(),
		retry: false,
		path: "a.txt",
		commit,
		subject: "line",
		side: "LEFT",
		line: 2,
		...more,
	});

	it("GitHub's merge base is the snapshot's left side: true, one compare per snapshot, a LEFT comment posted", async () => {
		pr = createPrFixture();
		scenario12();
		const s = await Session.open(pr.arg, process.cwd());
		await s.overview();
		expect(await s.commentLeft()).toBe(true);
		expect((await s.overview(0)).commentLeft).toBe(true);
		expect(compares()).toBe(1);
		// Its smallest answer: no files.
		expect(pr.ghLog()).toContain(
			`compare/main...${pr.head()}?per_page=1&page=2 --jq .merge_base_commit.sha`,
		);
		const { thread } = await s.startThread(line(pr.head(), "l0"));
		expect(thread.anchor).toMatchObject({ side: "LEFT", line: 2 });
	});

	it("never held up: the overview answers at once, true until GitHub says; then false, LEFT lines refused (400), RIGHT posted", async () => {
		pr = createPrFixture();
		// GitHub's merge base isn't the snapshot's left side.
		// GitHub's answer waits until the overview is in: an overview that
		// waited for it would never come.
		scenario12({
			mergeBases: { [pr.head()]: "e".repeat(40) },
			hold: ["compare"],
		});
		const s = await Session.open(pr.arg, process.cwd());
		const first = await s.overview();
		expect(first.commentLeft).toBe(true);
		release(process.env.CRB_FAKE_GH ?? "", "compare");
		expect(await s.commentLeft()).toBe(false);
		expect(compares()).toBe(1);
		expect((await s.overview()).commentLeft).toBe(false);
		scenario12();
		for (const req of [
			line(pr.head(), "l1"),
			line(pr.head(), "l2", {
				startSide: "LEFT",
				startLine: 2,
				side: "RIGHT",
				line: 2,
			}),
		]) {
			const error = await s.startThread(req).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(WriteRefusedError);
			expect((error as WriteRefusedError).code).toBe("invalid");
			expect((error as WriteRefusedError).message).toMatch(/base/);
		}
		expect(pr.ghLog()).not.toMatch(/-X POST/);
		const right = await s.startThread(line(pr.head(), "l3", { side: "RIGHT" }));
		expect(right.thread.anchor).toMatchObject({ side: "RIGHT", line: 2 });
		expect(compares()).toBe(1);
	});

	it("a started review of a PR then merged: asked against the PR's own base commit, where GitHub still puts its LEFT lines (gallery #11)", async () => {
		pr = createPrFixture();
		scenario12();
		const first = await Session.open(pr.arg, process.cwd());
		const review = await first.review();
		const key = review.files[0]?.clusters[0]?.key ?? "";
		await first.setStates(review.revision, [{ key, state: "reviewed" }]);
		await first.close();
		// Merged by a merge commit: main now holds the head.
		pr.moveMain();
		const merged = (baseRefOid?: string) =>
			pr.scenario({
				prs: {
					12: {
						view: prView({
							headRefOid: pr.head(),
							baseRefName: "main",
							state: "MERGED",
							...(baseRefOid ? { baseRefOid } : {}),
						}),
						graphql: { reviews: [], reviewThreads: [], comments: [] },
					},
				},
			});
		merged(pr.mergeBase);
		const s = await Session.open(pr.arg, process.cwd());
		expect(s.snapshot().base).toBe(pr.mergeBase);
		expect(await s.commentLeft()).toBe(true);
		expect(pr.ghLog()).toContain(`compare/${pr.mergeBase}...${pr.head()}`);
		// Without GitHub's base commit, the branch: fails closed.
		merged();
		const t = await Session.open(pr.arg, process.cwd());
		expect(await t.commentLeft()).toBe(false);
	});

	it("a post checks LEFT lines against the snapshot it started on, though a Refresh moves the session meanwhile", async () => {
		pr = createPrFixture();
		scenario12({ hold: ["restList"] });
		const s = await Session.open(pr.arg, process.cwd());
		const then = pr.head();
		// A retry: it lists the PR's comments first (held), then posts.
		const posting = s.startThread(line(then, "l9", { retry: true }));
		await vi.waitFor(
			() => expect(pr.ghLog()).toMatch(/pulls\/12\/comments --paginate/),
			{
				timeout: 10_000,
			},
		);
		// Meanwhile the PR moves on, to a head GitHub has another base for.
		const now = pr.moveHead({ "later.txt": "later\n" });
		scenario12(
			{ mergeBases: { [now]: "e".repeat(40) }, hold: ["restList"] },
			now,
		);
		await s.refresh();
		expect(s.snapshot().head).toBe(now);
		release(process.env.CRB_FAKE_GH ?? "", "restList");
		const { thread } = await posting;
		expect(thread.anchor).toMatchObject({
			side: "LEFT",
			line: 2,
			commit: then,
		});
	});

	it("asked again when a Refresh brings another base commit under a snapshot that stays", async () => {
		pr = createPrFixture();
		const withBase = (baseRefOid: string) =>
			pr.scenario({
				prs: {
					12: {
						view: prView({
							headRefOid: pr.head(),
							baseRefName: "main",
							baseRefOid,
						}),
						graphql: { reviews: [], reviewThreads: [], comments: [] },
					},
				},
			});
		withBase(pr.mergeBase);
		const s = await Session.open(pr.arg, process.cwd());
		const review = await s.review();
		const key = review.files[0]?.clusters[0]?.key ?? "";
		await s.setStates(review.revision, [{ key, state: "reviewed" }]);
		expect(await s.commentLeft()).toBe(true);
		// GitHub's base for the PR now holds the head.
		withBase(pr.head());
		await s.refresh();
		expect(s.snapshot().base).toBe(pr.mergeBase);
		expect(await s.commentLeft()).toBe(false);
	});

	it("where nothing is written (--viewer someone else) it isn't asked", async () => {
		pr = createPrFixture();
		scenario12();
		const s = await Session.open(pr.arg, process.cwd(), () => {}, {
			viewer: "someone-else",
		});
		expect((await s.overview()).commentLeft).toBe(true);
		expect(await s.commentLeft()).toBe(true);
		expect(compares()).toBe(0);
	});

	it("a pinned head: asked for the pinned commit", async () => {
		pr = createPrFixture();
		const then = pr.head();
		const now = pr.moveHead({ "later.txt": "later\n" });
		pr.scenario({
			mergeBases: { [then]: "e".repeat(40) },
			prs: {
				12: {
					view: prView({ headRefOid: now, baseRefName: "main" }),
					graphql: {
						commits: [
							{ commit: { oid: then, committedDate: "2026-01-02T00:00:00Z" } },
							{ commit: { oid: now, committedDate: "2026-01-04T00:00:00Z" } },
						],
						reviews: [],
						reviewThreads: [],
						comments: [],
					},
				},
			},
		});
		const s = await Session.open(pr.arg, process.cwd(), () => {}, {
			head: parseHead(then),
		});
		expect(await s.commentLeft()).toBe(false);
		expect(pr.ghLog()).toContain(`...${then}`);
	});

	it("a failed compare: true meanwhile; a write asks again", async () => {
		pr = createPrFixture();
		scenario12({ mergeBases: { [pr.head()]: "nope" } });
		const s = await Session.open(pr.arg, process.cwd());
		expect((await s.overview()).commentLeft).toBe(true);
		await expect(s.commentLeft()).rejects.toBeInstanceOf(GhError);
		scenario12();
		const before = compares();
		const { thread } = await s.startThread(line(pr.head(), "l4"));
		expect(thread.anchor).toMatchObject({ side: "LEFT" });
		// The write asked again rather than take the failure as the answer.
		expect(compares()).toBe(before + 1);
	});
});
