import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	prView,
	reviewThread,
	type Scenario,
	threadComment,
} from "../../test/fake-gh/scenario";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import { GhError, WriteRefusedError } from "./errors";
import { Session } from "./session";
import {
	DEDUPE_SLACK_MS,
	findReply,
	replyToThread,
	setResolved,
	type ThreadWriteTarget,
} from "./threadWrites";

/**
 * The viewer is the fake's gh login, Octo_Cat; the PR author octo-author.
 * Thread T12-0 was opened by the viewer and answered by the author; T12-1
 * was opened by rev.
 */
describe("thread writes", () => {
	let pr: PrFixture;
	let session: Session;

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
	const writeCalls = () =>
		pr
			.ghLog()
			.split("\n")
			.filter((l) => /^api -X POST|resolveReviewThread/.test(l));
	const reply = (body: string, more: { retry?: boolean; at?: string } = {}) =>
		session.replyToThread("T12-0", {
			body,
			attemptedAt: more.at ?? new Date().toISOString(),
			retry: more.retry ?? false,
		});

	beforeEach(async () => {
		pr = createPrFixture();
		threads();
		session = await Session.open(pr.arg, process.cwd());
		// The page has the threads before it writes to one.
		await session.threads((await session.overview()).readId, "summary");
	});
	afterEach(async () => {
		await pr.cleanup();
	});

	it("reply posts via REST to the thread's first comment and returns the new comment and attention", async () => {
		const { readId } = await session.overview();
		const before = (await session.threads(readId, "full")).threads.find(
			(t) => t.id === "T12-0",
		);
		expect(before).toMatchObject({
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
		const after = (await session.threads(readId, "full")).threads.find(
			(t) => t.id === "T12-0",
		);
		expect(after).toMatchObject({
			commentCount: 3,
			attention: ["octo-author"],
		});
		const { threads: view } = await session.comments(readId, ["T12-0"]);
		expect(view[0]?.comments).toHaveLength(3);
	});

	it("a retried reply that already landed is not posted again", async () => {
		threads({ failNext: { op: "reply", status: 502, afterWrite: true } });
		const at = new Date().toISOString();
		const first = await reply("Done", { at }).catch((e) => e);
		expect(first).toBeInstanceOf(GhError);
		expect(first).not.toBeInstanceOf(WriteRefusedError);
		expect(bodies(0)).toEqual(["Should this expire?", "Why would it?", "Done"]);
		const answer = await reply("Done  ", { at, retry: true });
		expect(bodies(0)).toEqual(["Should this expire?", "Why would it?", "Done"]);
		expect(writeCalls()).toHaveLength(1);
		expect(answer.comment).toMatchObject({ id: "C12-0-2", body: "Done" });
		expect(answer.commentCount).toBe(3);
	});

	it("a retry whose first attempt didn't land posts it", async () => {
		threads({ failNext: { op: "reply", status: 502 } });
		const at = new Date().toISOString();
		await expect(reply("Done", { at })).rejects.toBeInstanceOf(GhError);
		expect(bodies(0)).toHaveLength(2);
		const answer = await reply("Done", { at, retry: true });
		expect(bodies(0)).toEqual(["Should this expire?", "Why would it?", "Done"]);
		expect(answer.comment?.body).toBe("Done");
	});

	it("a retry doesn't take an older identical comment for this one", async () => {
		await reply("Same");
		const later = new Date(Date.now() + DEDUPE_SLACK_MS + 5000).toISOString();
		await reply("Same", { at: later, retry: true });
		expect(bodies(0)?.filter((b) => b === "Same")).toHaveLength(2);
	});

	it("pending review → 409 pending-review with url ending /files, nothing stored", async () => {
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
		const { readId } = await session.overview();
		expect(
			(await session.threads(readId, "full")).threads.find(
				(t) => t.id === "T12-0",
			)?.resolved,
		).toBe(true);
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
		await expect(
			theirs.replyToThread("T12-0", {
				body: "Hi",
				attemptedAt: new Date().toISOString(),
				retry: false,
			}),
		).rejects.toMatchObject({ code: "writes-off" });
		await expect(theirs.setThreadResolved("T12-0", true)).rejects.toMatchObject(
			{
				code: "writes-off",
			},
		);
		expect(writeCalls()).toEqual([]);
		// The gh login under another spelling is the viewer.
		const self = await Session.open(pr.arg, process.cwd(), () => {}, {
			viewer: "octo-cat",
		});
		expect(self.writes()).toBe("on");
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
		nextSeq: () => 1,
		apply: () => {},
	});
	const req = { body: "Hi", attemptedAt: "2026-01-03T10:00:00Z", retry: false };

	it("as-of session → 403 writes-off", async () => {
		await expect(
			replyToThread(target("as-of"), "T1", req),
		).rejects.toMatchObject({ code: "writes-off" });
		await expect(
			setResolved(target("as-of"), "T1", true),
		).rejects.toMatchObject({
			code: "writes-off",
		});
	});

	it("a blank or oversized reply → invalid", async () => {
		for (const body of ["", " \n\t", "x".repeat(65537)]) {
			await expect(
				replyToThread(target("on"), "T1", { ...req, body }),
			).rejects.toMatchObject({ code: "invalid" });
		}
	});
});

describe("findReply", () => {
	const node = (login: string, body: string, publishedAt: string | null) => ({
		id: `${login}-${body}`,
		author: { login },
		body,
		createdAt: publishedAt ?? "2026-01-03T10:00:00Z",
		publishedAt,
		state: publishedAt ? "SUBMITTED" : "PENDING",
	});
	const content = (...nodes: unknown[]) => ({ comments: { nodes } });
	const AT = "2026-01-03T10:00:00Z";

	it("matches the viewer's comment with the same body, line ends and trailing space aside", () => {
		expect(
			findReply(
				content(node("Octo_Cat", "Fine\r\nthanks  \n", "2026-01-03T10:00:02Z")),
				"octo-cat",
				"Fine\nthanks",
				AT,
			)?.id,
		).toBe("Octo_Cat-Fine\r\nthanks  \n");
	});

	it("takes up to a minute's clock skew, not older; never another's or a pending one", () => {
		const c = content(
			node("Octo_Cat", "A", "2026-01-03T09:59:30Z"),
			node("Octo_Cat", "B", "2026-01-03T09:58:00Z"),
			node("rev", "C", "2026-01-03T10:00:05Z"),
			node("Octo_Cat", "D", null),
			node("Octo_Cat", " A", "2026-01-03T10:00:05Z"),
		);
		expect(findReply(c, "octo-cat", "A", AT)?.id).toBe("Octo_Cat-A");
		expect(findReply(c, "octo-cat", "B", AT)).toBeNull();
		expect(findReply(c, "octo-cat", "C", AT)).toBeNull();
		expect(findReply(c, "octo-cat", "D", AT)).toBeNull();
	});
});
