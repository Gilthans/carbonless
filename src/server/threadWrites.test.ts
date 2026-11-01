import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { MAX_REPLY, type ReplyRequest } from "../shared/types";
import { GhError, WriteRefusedError } from "./errors";
import { OverviewRead } from "./overviewRead";
import { Session } from "./session";
import type { ThreadCodeSource } from "./threadCode";
import {
	editProblem,
	findReply,
	LIST_WAITS_MS,
	replyProblem,
	replyToThread,
	setResolved,
	type ThreadWriteTarget,
	writeWaits,
} from "./threadWrites";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

/** T12-0's comment ids before any reply. */
const KNOWN = ["C12-0", "C12-0-1"];

/**
 * The viewer is the fake's gh login, Octo_Cat; the PR author octo-author.
 * Thread T12-0 was opened by the viewer and answered by the author; T12-1
 * was opened by rev.
 */
describe("thread writes", () => {
	let pr: PrFixture;
	let session: Session;
	let ids = 0;

	const said = (login: string, text: string, m: number) =>
		threadComment({
			login,
			text,
			createdAt: `2026-01-03T10:0${m}:00Z`,
			commit: pr.head(),
		});
	const threads = (over: Partial<Scenario> = {}, reviews: unknown[] = []) =>
		pr.scenario({
			prs: {
				12: {
					view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
					graphql: {
						reviewThreads: [
							reviewThread({ path: "a.txt", line: 2 }, [
								said("Octo_Cat", "Should this expire?", 1),
								said("octo-author", "Why would it?", 2),
							]),
							reviewThread({ path: "a.txt", line: 26 }, [
								said("rev", "Typo", 3),
							]),
						],
						reviews,
					},
				},
			},
			...over,
		});
	/** The scenario as the fake gh has stored it (its writes included). */
	const stored = () =>
		JSON.parse(readFileSync(process.env.CRB_FAKE_GH ?? "", "utf8")) as {
			prs: Record<
				string,
				{
					graphql: {
						reviewThreads: {
							isResolved: boolean;
							comments: { nodes: { body?: string }[] };
						}[];
					};
				}
			>;
		};
	const bodies = (i: number) =>
		stored().prs[12]?.graphql.reviewThreads[i]?.comments.nodes.map(
			(c) => c.body,
		);
	const log = () => pr.ghLog().split("\n");
	const writeCalls = () =>
		log().filter((l) => /^api -X POST|resolveReviewThread/.test(l));
	/** Reads of one thread by id (a write's re-read). */
	const threadReads = () =>
		(
			pr
				.ghLog()
				.match(/node\(id: \$id\) \{\s*\.\.\. on PullRequestReviewThread/g) ?? []
		).length;
	const request = (body: string, more: Partial<ReplyRequest> = {}) => ({
		body,
		attemptedAt: new Date().toISOString(),
		retry: false,
		clientId: `c${++ids}`,
		knownCommentIds: KNOWN,
		...more,
	});
	const reply = (
		body: string,
		more: Partial<ReplyRequest> = {},
		s: Session = session,
	) => s.replyToThread("T12-0", request(body, more));
	const thread0 = async (s: Session = session) =>
		(await s.threads((await s.overview()).readId, "full")).threads.find(
			(t) => t.id === "T12-0",
		);

	/** The waits a write took (writeWaits), none of them real. */
	let waited: number[] = [];
	/** GitHub's GraphQL lists the replies held back after this many waits. */
	let catchUp = Number.POSITIVE_INFINITY;
	const catchUpAfter = (n: number) => {
		catchUp = n;
	};
	const realSleep = writeWaits.sleep;

	beforeEach(async () => {
		waited = [];
		catchUp = Number.POSITIVE_INFINITY;
		writeWaits.sleep = async (ms) => {
			waited.push(ms);
			if (waited.length >= catchUp) listReplies(process.env.CRB_FAKE_GH ?? "");
		};
		pr = createPrFixture();
		threads();
		session = await Session.open(pr.arg, process.cwd());
		// The page has the threads before it writes to one.
		await session.threads((await session.overview()).readId, "summary");
	});
	afterEach(async () => {
		writeWaits.sleep = realSleep;
		// Never the GraphQL reply, which would join a pending review.
		expect(pr.ghLog()).not.toContain("addPullRequestReviewThreadReply");
		await pr.cleanup();
	});

	it("reply posts via REST to the thread's first comment and returns the new comment and attention", async () => {
		const { readId } = await session.overview();
		expect(await thread0()).toMatchObject({
			attention: ["Octo_Cat"],
			yourTurn: true,
			commentCount: 2,
			viewerCan: { reply: true, resolve: true, unresolve: false },
		});
		const answer = await reply("It's a cache.\n");
		expect(writeCalls()).toHaveLength(1);
		expect(writeCalls()[0]).toMatch(
			/^api -X POST repos\/acme\/widget\/pulls\/12\/comments\/1000\/replies /,
		);
		expect(answer).toMatchObject({
			threadId: "T12-0",
			resolved: false,
			commentCount: 3,
			attention: ["octo-author"],
			yourTurn: false,
			viewerCan: { reply: true, resolve: true, unresolve: false },
			comment: { author: "Octo_Cat", body: "It's a cache.\n", pending: false },
		});
		expect(answer.comments.comments.map((c) => c.author)).toEqual([
			"Octo_Cat",
			"octo-author",
			"Octo_Cat",
		]);
		expect(answer.comments.comments.at(-1)?.id).toBe(answer.comment?.id);
		// The kept read agrees until the next Refresh.
		expect(await thread0()).toMatchObject({
			commentCount: 3,
			attention: ["octo-author"],
		});
		const { threads: view } = await session.comments(readId, ["T12-0"]);
		expect(view[0]?.comments).toHaveLength(3);
	});

	it("a resend while the first attempt still runs waits for it and doesn't post again", async () => {
		// The first attempt's post is held until the resend is in.
		threads({ hold: ["reply"] });
		const clientId = "same";
		const first = reply("Done", { clientId });
		await vi.waitFor(() => expect(writeCalls()).toHaveLength(1), {
			timeout: 10_000,
		});
		// The connection dropped: the client resends.
		const again = reply("Done", { clientId, retry: true });
		release(process.env.CRB_FAKE_GH ?? "", "reply");
		const [a, b] = await Promise.all([first, again]);
		expect(bodies(0)).toEqual(["Should this expire?", "Why would it?", "Done"]);
		expect(writeCalls()).toHaveLength(1);
		expect(b.comment?.id).toBe(a.comment?.id);
		expect(b.commentCount).toBe(3);
	});

	it("a resend after a reload finds the reply posted: in this session, and on GitHub for a new one", async () => {
		const clientId = "reloaded";
		const first = await reply("Done", { clientId });
		// The answer never reached the page; after a reload it resends.
		const again = await reply("Done", { clientId, retry: true });
		expect(again.comment?.id).toBe(first.comment?.id);
		expect(writeCalls()).toHaveLength(1);
		// crb restarted too: GitHub's comments say it's there.
		const fresh = await Session.open(pr.arg, process.cwd());
		await fresh.threads((await fresh.overview()).readId, "summary");
		const found = await reply("Done", { clientId, retry: true }, fresh);
		expect(found.comment?.id).toBe(first.comment?.id);
		expect(writeCalls()).toHaveLength(1);
		expect(bodies(0)).toHaveLength(3);
	});

	it("a resend of a reply GitHub doesn't list yet is answered from what this session posted", async () => {
		threads({ replyUnlisted: true });
		const first = await reply("Done", { clientId: "unlisted" });
		const again = await reply("Done", { clientId: "unlisted", retry: true });
		expect(writeCalls()).toHaveLength(1);
		expect(again.comment?.id).toBe(first.comment?.id);
		expect(bodies(0)).toHaveLength(3);
	});

	it("a retry after an unknown outcome looks again while GitHub lags, then doesn't post twice", async () => {
		threads({
			replyUnlisted: true,
			failNext: { op: "reply", status: 502, afterWrite: true },
		});
		await expect(reply("Done", { clientId: "doubt" })).rejects.toBeInstanceOf(
			GhError,
		);
		// GitHub lists it only after the retry's first wait.
		catchUpAfter(1);
		const answer = await reply("Done", { clientId: "doubt", retry: true });
		expect(waited).toEqual([LIST_WAITS_MS[0]]);
		expect(writeCalls()).toHaveLength(1);
		expect(bodies(0)).toEqual(["Should this expire?", "Why would it?", "Done"]);
		expect(answer.comment?.body).toBe("Done");
	});

	it("a reply found by the dedupe leaves the pending-review warning as it was", async () => {
		pr.scenario({
			prs: {
				12: {
					view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
					graphql: {
						reviewThreads: [
							reviewThread({ path: "a.txt", line: 2 }, [
								said("Octo_Cat", "Should this expire?", 1),
								said("octo-author", "Why would it?", 2),
								said("Octo_Cat", "Done", 3),
							]),
						],
						reviews: [{ author: { login: "Octo_Cat" }, state: "PENDING" }],
					},
				},
			},
		});
		const { readId } = await session.overview(0);
		await session.threads(readId, "summary");
		expect((await session.overview()).pendingReview).not.toBeNull();
		const answer = await reply("Done", { retry: true });
		expect(answer.comment?.id).toBe("C12-0-2");
		expect(writeCalls()).toEqual([]);
		expect((await session.overview()).pendingReview).not.toBeNull();
	});

	it("a retried reply that already landed is not posted again", async () => {
		threads({ failNext: { op: "reply", status: 502, afterWrite: true } });
		const clientId = "lost";
		const first = await reply("Done", { clientId }).catch((e) => e);
		expect(first).toBeInstanceOf(GhError);
		expect(first).not.toBeInstanceOf(WriteRefusedError);
		expect(bodies(0)).toEqual(["Should this expire?", "Why would it?", "Done"]);
		const answer = await reply("Done  ", { clientId, retry: true });
		expect(bodies(0)).toEqual(["Should this expire?", "Why would it?", "Done"]);
		expect(writeCalls()).toHaveLength(1);
		expect(answer.comment).toMatchObject({ id: "C12-0-2", body: "Done" });
		expect(answer.commentCount).toBe(3);
	});

	it("a reply's tags GitHub would drop go escaped; the comment reads as typed, and its retry finds it", async () => {
		threads({ failNext: { op: "reply", status: 502, afterWrite: true } });
		const clientId = "lt";
		const typed = "List<String> and <T>, `Map<K>`, a < b";
		await expect(reply(typed, { clientId })).rejects.toBeInstanceOf(GhError);
		expect(bodies(0)?.at(-1)).toBe("List\\<String> and \\<T>, `Map<K>`, a < b");
		const answer = await reply(typed, { clientId, retry: true });
		expect(writeCalls()).toHaveLength(1);
		expect(answer.comment).toMatchObject({ id: "C12-0-2", body: typed });
	});

	it("a retry whose first attempt didn't land posts it", async () => {
		threads({ failNext: { op: "reply", status: 502 } });
		const clientId = "failed";
		await expect(reply("Done", { clientId })).rejects.toBeInstanceOf(GhError);
		expect(bodies(0)).toHaveLength(2);
		const answer = await reply("Done", { clientId, retry: true });
		expect(bodies(0)).toEqual(["Should this expire?", "Why would it?", "Done"]);
		expect(answer.comment?.body).toBe("Done");
	});

	it("a retry doesn't take an identical comment the client knew, or another reply's, for this one", async () => {
		const first = await reply("Same");
		const id = first.comment?.id ?? "";
		// Known when this one was first sent.
		await reply("Same", { retry: true, knownCommentIds: [...KNOWN, id] });
		expect(bodies(0)?.filter((b) => b === "Same")).toHaveLength(2);
		// Unknown to the client, but another reply this session posted.
		const ids3 = (await thread0())?.commentCount;
		expect(ids3).toBe(4);
		await reply("Same", { retry: true });
		expect(bodies(0)?.filter((b) => b === "Same")).toHaveLength(3);
	});

	it("GitHub not listing the reply yet: re-read, then the posted comment is added", async () => {
		threads({ replyUnlisted: true });
		const before = threadReads();
		const answer = await reply("Later <b>");
		// The first re-read and one after each wait.
		expect(threadReads() - before).toBe(3);
		expect(waited).toEqual(LIST_WAITS_MS);
		expect(answer).toMatchObject({
			commentCount: 3,
			attention: ["octo-author"],
			comment: {
				body: "Later <b>",
				// GitHub keeps <b> (closing it): no escape for a tag it keeps.
				html: '<p dir="auto">Later <b></b></p>',
				author: "Octo_Cat",
			},
		});
		const { readId } = await session.overview();
		const { threads: view } = await session.comments(readId, ["T12-0"]);
		expect(
			view[0]?.comments.filter((c) => c.body === "Later <b>"),
		).toHaveLength(1);
		expect((await thread0())?.commentCount).toBe(3);
	});

	it("GitHub listing it after a moment: no more re-reads than needed", async () => {
		threads({ replyUnlisted: true });
		catchUpAfter(1);
		const before = threadReads();
		const answer = await reply("Soon");
		expect(threadReads() - before).toBe(2);
		expect(answer.commentCount).toBe(3);
	});

	it("posted, then the thread is gone: 200 with the reply, from the kept copy", async () => {
		await session.comments((await session.overview()).readId, ["T12-0"]);
		threads({ replyDeletesThread: true });
		const answer = await reply("Bye");
		expect(answer).toMatchObject({ commentCount: 3, comment: { body: "Bye" } });
	});

	it("pending review → 409 pending-review with url ending /files, nothing stored; it shows until a reply posts", async () => {
		expect((await session.overview()).pendingReview).toBeNull();
		threads({}, [
			{ author: { login: "Octo_Cat" }, state: "PENDING", submittedAt: null },
		]);
		const refused = await reply("Hi").catch((e) => e);
		expect(refused).toBeInstanceOf(WriteRefusedError);
		expect(refused).toMatchObject({
			code: "pending-review",
			url: "https://github.com/acme/widget/pull/12/files",
		});
		expect(bodies(0)).toHaveLength(2);
		expect((await session.overview()).pendingReview).toEqual({
			url: "https://github.com/acme/widget/pull/12/files",
		});
		// Discarded on GitHub: the next reply posts, and the warning goes.
		threads();
		await reply("Hi");
		expect((await session.overview()).pendingReview).toBeNull();
	});

	it("resolve and unresolve flip resolved; resolved empties attention", async () => {
		const resolved = await session.setThreadResolved("T12-0", true);
		expect(resolved).toMatchObject({
			resolved: true,
			attention: [],
			yourTurn: false,
			viewerCan: { reply: true, resolve: false, unresolve: true },
		});
		expect(stored().prs[12]?.graphql.reviewThreads[0]?.isResolved).toBe(true);
		expect((await thread0())?.resolved).toBe(true);
		const open = await session.setThreadResolved("T12-0", false);
		expect(open).toMatchObject({
			resolved: false,
			attention: ["Octo_Cat"],
			yourTurn: true,
		});
		// Idempotent.
		await expect(
			session.setThreadResolved("T12-0", false),
		).resolves.toMatchObject({ resolved: false });
	});

	it("a reply then a resolve on one thread land in that order", async () => {
		threads({ replyDelayMs: 800 });
		const replied = reply("First");
		const resolved = session.setThreadResolved("T12-0", true);
		await Promise.all([replied, resolved]);
		const order = writeCalls().map((l) =>
			l.startsWith("api -X") ? "reply" : "resolve",
		);
		expect(order).toEqual(["reply", "resolve"]);
		expect(await thread0()).toMatchObject({ resolved: true, commentCount: 3 });
	});

	it("deleted thread → 404 gone", async () => {
		threads({ deletedThreads: ["T12-0"] });
		await expect(reply("Hi")).rejects.toMatchObject({ code: "gone" });
		await expect(
			session.setThreadResolved("T12-0", true),
		).rejects.toMatchObject({ code: "gone" });
		// A thread of another PR is not this one's to write to.
		await expect(
			session.setThreadResolved("T13-0", true),
		).rejects.toMatchObject({ code: "gone" });
		// The cached thread was tried (GitHub said gone); the other PR's never.
		expect(writeCalls()).toHaveLength(2);
	});

	it("GitHub's 404 for a thread that is still there: forbidden, not gone", async () => {
		threads({ failNext: { op: "reply", status: 404 } });
		await expect(reply("Hi")).rejects.toMatchObject({
			code: "forbidden",
			message: "GitHub refused the reply: Not Found",
		});
	});

	it("GitHub 403 → 403 forbidden with GitHub's message", async () => {
		threads({ failNext: { op: "resolve", status: 403 } });
		await expect(
			session.setThreadResolved("T12-0", true),
		).rejects.toMatchObject({
			code: "forbidden",
			message:
				"Octo_Cat does not have permission to resolve this review thread.",
		});
		threads({
			prs: {
				12: {
					view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
					graphql: {
						reviewThreads: [
							reviewThread({ path: "a.txt", line: 2, viewerCanReply: false }, [
								said("rev", "Hm", 1),
							]),
						],
					},
				},
			},
		});
		await expect(reply("Hi")).rejects.toMatchObject({
			code: "forbidden",
			message: "Resource not accessible by integration",
		});
	});

	it("--viewer other → 403 writes-off, no gh write call made", async () => {
		const theirs = await Session.open(pr.arg, process.cwd(), () => {}, {
			viewer: "someone-else",
		});
		expect(theirs.writes()).toBe("viewer");
		const o = await theirs.overview();
		expect(o.writes).toBe("viewer");
		const { threads: list } = await theirs.threads(o.readId, "summary");
		expect(list[0]?.viewerCan).toEqual({
			reply: false,
			resolve: false,
			unresolve: false,
		});
		await expect(reply("Hi", {}, theirs)).rejects.toMatchObject({
			code: "writes-off",
		});
		await expect(theirs.setThreadResolved("T12-0", true)).rejects.toMatchObject(
			{ code: "writes-off" },
		);
		expect(writeCalls()).toEqual([]);
		// The gh login under another spelling is the viewer.
		const self = await Session.open(pr.arg, process.cwd(), () => {}, {
			viewer: "octo-cat",
		});
		expect(self.writes()).toBe("on");
	});

	it("a closed session refuses writes as closed (503)", async () => {
		await session.close();
		await expect(reply("Hi")).rejects.toMatchObject({
			name: "Error",
			message: "The session is closed",
		});
		expect(writeCalls()).toEqual([]);
	});

	describe("a write's re-read in a kept read", () => {
		const nodes = (text: string) => ({
			summary: reviewThread({ path: "a.txt", line: 2 }, [said("rev", text, 1)]),
			content: {
				comments: {
					nodes: [{ ...said("rev", text, 1), id: "C12-0" }],
				},
			},
		});
		const read = () =>
			new OverviewRead({
				ref: { owner: "acme", repo: "widget", number: 12 },
				viewer: "octo-cat",
				writes: "on",
				code: {
					window: async () => null,
					code: async () => null,
				} as unknown as ThreadCodeSource,
				base: async () => ({ snapshot: "", ref: "" }),
			});
		const text = async (r: OverviewRead) =>
			(await r.comments(["T12-0"])).threads[0]?.comments[0]?.text;
		const withId = (n: ReturnType<typeof nodes>) => ({
			...n,
			summary: { ...n.summary, id: "T12-0" },
		});

		it("a later re-read wins over an earlier one, whichever is applied last", async () => {
			const r = read();
			await r.threads("full");
			r.applyWrite("T12-0", withId(nodes("newer")), 2, Date.now());
			r.applyWrite("T12-0", withId(nodes("older")), 1, Date.now());
			expect(await text(r)).toBe("newer");
			await r.settled;
		});

		it("is ignored by a read that started after it, and waits for a summary still to come", async () => {
			const startedAt = Date.now() - 1000;
			const late = read();
			late.applyWrite("T12-0", withId(nodes("re-read")), 1, startedAt);
			expect(await text(late)).toBe("Should this expire?");
			await late.settled;
			const early = new OverviewRead({
				ref: { owner: "acme", repo: "widget", number: 12 },
				viewer: "octo-cat",
				writes: "on",
				code: {
					window: async () => null,
					code: async () => null,
				} as unknown as ThreadCodeSource,
				base: async () => ({ snapshot: "", ref: "" }),
			});
			// Before its summary is in.
			early.applyWrite("T12-0", withId(nodes("re-read")), 1, Date.now());
			expect(await text(early)).toBe("re-read");
			await early.settled;
		});
	});
});

describe("thread writes off and refused before GitHub", () => {
	const target = (writes: ThreadWriteTarget["writes"]): ThreadWriteTarget => ({
		ref: { owner: "acme", repo: "widget", number: 12 },
		prUrl: "https://github.com/acme/widget/pull/12",
		viewer: "octo-cat",
		writes,
		prAuthor: () => Promise.reject(new Error("no gh")),
		summaryOf: () => {
			throw new Error("no read");
		},
		cached: () => undefined,
		nextSeq: () => 1,
		apply: () => {},
		drop: () => {},
		dropped: () => false,
		deletedHere: () => false,
		markDeleted: () => {},
		posted: () => undefined,
		remember: () => {},
		inDoubt: () => false,
		setInDoubt: () => {},
		claimedIds: () => new Set(),
		setPendingReview: () => {},
	});
	const req: ReplyRequest = {
		body: "Hi",
		attemptedAt: "2026-01-03T10:00:00Z",
		retry: false,
		clientId: "c1",
		knownCommentIds: [],
	};

	it("as-of session → 403 writes-off", async () => {
		await expect(
			replyToThread(target("as-of"), "T1", req),
		).rejects.toMatchObject({ code: "writes-off" });
		await expect(
			setResolved(target("as-of"), "T1", true),
		).rejects.toMatchObject({ code: "writes-off" });
	});

	it("a blank or oversized reply, or one without its ids → invalid", async () => {
		const bad = [
			{ ...req, body: "" },
			{ ...req, body: " \n\t" },
			{ ...req, body: "x".repeat(65537) },
			{ ...req, clientId: "" },
			{ ...req, knownCommentIds: [1] },
			{ ...req, retry: true, knownCommentIds: [] },
		];
		for (const r of bad) {
			await expect(
				replyToThread(target("on"), "T1", r as ReplyRequest),
			).rejects.toMatchObject({ code: "invalid" });
		}
	});
});

describe("length once escaped", () => {
	it("a body that fits as typed but not once escaped is refused with the limit on the text as typed", () => {
		// 21,000 escapes: 21,000 characters less room for the typed text.
		const body = `${"<T>".repeat(21_000)}${"x".repeat(MAX_REPLY - 63_000)}`;
		const limit = `at most ${MAX_REPLY - 21_000} characters`;
		expect(
			replyProblem({
				body,
				attemptedAt: "",
				retry: false,
				clientId: "c",
				knownCommentIds: [],
			}),
		).toBe(`A reply is ${limit}`);
		expect(editProblem({ body, from: "", force: false })).toBe(
			`A comment is ${limit}`,
		);
		// As typed, with no escapes: the plain limit.
		expect(
			editProblem({ body: "x".repeat(MAX_REPLY + 1), from: "", force: false }),
		).toBe(`A comment is at most ${MAX_REPLY} characters`);
	});
});

describe("findReply", () => {
	const node = (id: string, login: string, body: string, pending = false) => ({
		id,
		author: { login },
		body,
		createdAt: "2026-01-03T10:00:00Z",
		publishedAt: pending ? null : "2026-01-03T10:00:00Z",
		state: pending ? "PENDING" : "SUBMITTED",
	});
	const content = (...nodes: unknown[]) => ({ comments: { nodes } });

	it("matches the viewer's comment with the same body, line ends and trailing space aside", () => {
		expect(
			findReply(
				content(node("a", "Octo_Cat", "Fine\r\nthanks  \n")),
				"octo-cat",
				"Fine\nthanks",
				[],
			)?.id,
		).toBe("a");
	});

	it("only a comment new to the client and not another reply's; never another's or a pending one", () => {
		const c = content(
			node("old", "Octo_Cat", "A"),
			node("theirs", "rev", "A"),
			node("pending", "Octo_Cat", "A", true),
			node("other", "Octo_Cat", "A"),
			node("new", "Octo_Cat", "A"),
		);
		expect(findReply(c, "octo-cat", "A", ["old"], new Set(["other"]))?.id).toBe(
			"new",
		);
		expect(findReply(c, "octo-cat", "A", ["old", "new", "other"])).toBeNull();
		expect(findReply(c, "octo-cat", " A", [])).toBeNull();
	});
});
