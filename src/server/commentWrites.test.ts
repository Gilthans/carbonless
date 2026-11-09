import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../../test/fake-gh/atomic.mjs";
import {
	editElsewhere,
	prView,
	reviewThread,
	type Scenario,
	threadComment,
} from "../../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import type { EditRequest, ThreadGone, ThreadUpdate } from "../shared/types";
import { GhError } from "./errors";
import { Session } from "./session";
import {
	deleteThreadComment,
	editComment,
	type ThreadWriteTarget,
	withoutComment,
	writeWaits,
} from "./threadWrites";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

/**
 * The viewer is the fake's gh login, Octo_Cat. T12-0: the viewer's
 * opener (C12-0, REST 1000), the author's reply (C12-0-1, 1001) and the
 * viewer's (C12-0-2, 1002). T12-1: rev's only comment. T12-2: the
 * viewer's only comment (C12-2, 3000).
 */
describe("editing and deleting comments", () => {
	let pr: PrFixture;
	let session: Session;

	const said = (login: string, text: string, m: number) =>
		threadComment({
			login,
			text,
			createdAt: `2026-01-03T10:0${m}:00Z`,
			commit: pr.head(),
		});
	const threads = (over: Partial<Scenario> = {}) =>
		pr.scenario({
			prs: {
				12: {
					view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
					graphql: {
						reviewThreads: [
							reviewThread({ path: "a.txt", line: 2 }, [
								said("Octo_Cat", "Should this expire?", 1),
								said("octo-author", "Why would it?", 2),
								said("Octo_Cat", "Fair.", 3),
							]),
							reviewThread({ path: "a.txt", line: 26 }, [
								said("rev", "Typo", 4),
							]),
							reviewThread({ path: "new.txt", line: 1 }, [
								said("Octo_Cat", "Nit", 5),
							]),
						],
					},
				},
			},
			...over,
		});
	const scenarioPath = () => process.env.CRB_FAKE_GH ?? "";
	/** Changes the stored scenario's PR 12 threads in place (as GitHub would elsewhere). */
	const threadsWith = (
		change: (t: { comments: { nodes: Record<string, unknown>[] } }[]) => void,
		over: Partial<Scenario> = {},
	) => {
		const s = JSON.parse(readFileSync(scenarioPath(), "utf8"));
		change(s.prs[12].graphql.reviewThreads);
		writeFileAtomic(scenarioPath(), JSON.stringify({ ...s, ...over }));
	};
	const writeCalls = () =>
		pr
			.ghLog()
			.split("\n")
			.filter((l) => /^api -X (POST|PATCH|DELETE)/.test(l));
	const edit = (
		commentId: string,
		body: string,
		more: Partial<EditRequest> = {},
		threadId = "T12-0",
		s: Session = session,
	) =>
		s.editThreadComment(threadId, commentId, {
			body,
			from: "Fair.",
			force: false,
			...more,
		});
	const comments = async (threadId: string, s: Session = session) =>
		(await s.comments((await s.overview()).readId, [threadId])).threads[0];
	const listed = async (s: Session = session) =>
		(await s.threads((await s.overview()).readId, "full")).threads.map(
			(t) => t.id,
		);

	// Re-reads wait for nothing: what GitHub shows is set by the scenario.
	const realSleep = writeWaits.sleep;
	beforeEach(async () => {
		writeWaits.sleep = async () => {};
		pr = createPrFixture();
		threads();
		session = await Session.open(pr.arg, process.cwd());
		await session.threads((await session.overview()).readId, "summary");
	});
	afterEach(async () => {
		writeWaits.sleep = realSleep;
		await pr.cleanup();
	});

	it("maps what the viewer may do and when a comment was edited", async () => {
		threads();
		const t = await comments("T12-0");
		expect(t?.comments.map((c) => c.viewerCan)).toEqual([
			{ update: true, delete: true },
			{ update: false, delete: false },
			{ update: true, delete: true },
		]);
		expect(t?.comments.every((c) => c.editedAt === null && !c.deleted)).toBe(
			true,
		);
	});

	it("an edit PATCHes the comment by its REST id and answers with it edited", async () => {
		const answer = await edit("C12-0-2", "Fair enough.");
		expect(writeCalls()).toEqual([
			"api -X PATCH repos/acme/widget/pulls/comments/1002 -H Accept: application/vnd.github.full+json --input -",
		]);
		expect(answer.comment).toMatchObject({
			id: "C12-0-2",
			body: "Fair enough.",
			viewerCan: { update: true, delete: true },
		});
		expect(answer.comment?.editedAt).toEqual(expect.any(String));
		expect(answer.commentCount).toBe(3);
		// The kept read has it too, before any Refresh.
		expect((await comments("T12-0"))?.comments[2]?.body).toBe("Fair enough.");
	});

	it("an edit escapes tags GitHub would drop; the comment edits as typed, and the same text again sends nothing", async () => {
		const typed = "Use List<String>, not <T>";
		const answer = await edit("C12-0-2", typed);
		expect(writeCalls()).toHaveLength(1);
		const stored = JSON.parse(readFileSync(scenarioPath(), "utf8")).prs[12]
			.graphql.reviewThreads[0].comments.nodes[2].body;
		expect(stored).toBe("Use List\\<String>, not \\<T>");
		expect(answer.comment?.body).toBe(typed);
		expect((await comments("T12-0"))?.comments[2]?.body).toBe(typed);
		// Unchanged: done, nothing sent; from as the page had it: no 409.
		await edit("C12-0-2", typed, { from: typed });
		expect(writeCalls()).toHaveLength(1);
		await edit("C12-0-2", "Use List<Integer>", { from: typed });
		expect(writeCalls()).toHaveLength(2);
	});

	it("an edit whose body is already on GitHub sends no PATCH (a retry that landed)", async () => {
		const answer = await edit("C12-0-2", "Fair.  \r\n", { from: "anything" });
		expect(writeCalls()).toEqual([]);
		expect(answer.comment?.body).toBe("Fair.");
	});

	it("changed on GitHub since the edit began → 409 changed with it as it is now; force saves anyway", async () => {
		editElsewhere(scenarioPath(), { pr: 12, thread: 0, comment: 2 }, "Fair!");
		await expect(edit("C12-0-2", "Mine")).rejects.toMatchObject({
			code: "changed",
			current: { id: "C12-0-2", body: "Fair!", editedAt: expect.any(String) },
		});
		expect(writeCalls()).toEqual([]);
		const forced = await edit("C12-0-2", "Mine", { force: true });
		expect(writeCalls()).toHaveLength(1);
		expect(forced.comment?.body).toBe("Mine");
		// The check is on the body alone, line ends and trailing space aside.
		editElsewhere(scenarioPath(), { pr: 12, thread: 0, comment: 2 }, "Ours");
		await edit("C12-0-2", "Again", { from: "Ours\r\n " });
		expect(writeCalls()).toHaveLength(2);
	});

	it("GitHub not showing the edit yet: the answer has the new text all the same", async () => {
		threads({ writeUnlistedMs: 60_000 });
		const answer = await edit("C12-0-2", "Later");
		expect(answer.comment?.body).toBe("Later");
		expect(answer.comment?.html).toBe('<p dir="auto">Later</p>');
		expect(answer.comments.comments[2]?.body).toBe("Later");
	});

	it("an edit of a comment or thread that is gone → 404 gone; GitHub's 403 → forbidden; 502 → transient", async () => {
		await expect(edit("C12-0-9", "x")).rejects.toMatchObject({ code: "gone" });
		threads({ deletedThreads: ["T12-0"] });
		await expect(edit("C12-0-2", "x")).rejects.toMatchObject({ code: "gone" });
		threads();
		await expect(
			edit("C12-1", "x", { from: "Typo" }, "T12-1"),
		).rejects.toMatchObject({ code: "forbidden" });
		threads({ failNext: { op: "edit", status: 502 } });
		const failed = edit("C12-0-2", "x");
		await expect(failed).rejects.toBeInstanceOf(GhError);
		await expect(failed).rejects.not.toHaveProperty("code");
		// GitHub's 404 for a comment still there: refused, not gone.
		threads({ failNext: { op: "edit", status: 404 } });
		await expect(edit("C12-0-2", "x")).rejects.toMatchObject({
			code: "forbidden",
		});
	});

	it("another's comment, even one GitHub would let the viewer change (a maintainer): forbidden, nothing sent", async () => {
		threads({
			prs: {
				12: {
					view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
					graphql: {
						reviewThreads: [
							reviewThread({ path: "a.txt", line: 2 }, [
								{
									...said("rev", "Typo", 1),
									viewerCanUpdate: true,
									viewerCanDelete: true,
								},
							]),
						],
					},
				},
			},
		});
		// GitHub's truth, not the kept read of the scenario it opened on.
		await session.refresh();
		expect((await comments("T12-0"))?.comments[0]?.viewerCan).toEqual({
			update: false,
			delete: false,
		});
		await expect(edit("C12-0", "x", { from: "Typo" })).rejects.toMatchObject({
			code: "forbidden",
		});
		await expect(
			session.deleteThreadComment("T12-0", "C12-0"),
		).rejects.toMatchObject({ code: "forbidden" });
		expect(writeCalls()).toEqual([]);
	});

	it("a comment GitHub gives no REST id for: 403 forbidden for an edit and a delete (a delete's 404 is only a thread gone)", async () => {
		threadsWith((t) => {
			const c = t[0]?.comments.nodes[2];
			if (c) c.databaseId = null;
		});
		await expect(edit("C12-0-2", "x")).rejects.toMatchObject({
			code: "forbidden",
			message: "GitHub gave no id to edit the comment by",
		});
		await expect(
			session.deleteThreadComment("T12-0", "C12-0-2"),
		).rejects.toMatchObject({
			code: "forbidden",
			message: "GitHub gave no id to delete the comment by",
		});
		expect(writeCalls()).toEqual([]);
	});

	it("a blank, oversized or malformed edit → invalid, nothing sent", async () => {
		const bad: unknown[] = [
			{ body: " \n", from: "Fair.", force: false },
			{ body: "x".repeat(65537), from: "Fair.", force: false },
			{ body: "x", force: false },
			{ body: "x", from: "Fair.", force: "yes" },
		];
		for (const r of bad) {
			await expect(
				session.editThreadComment("T12-0", "C12-0-2", r as EditRequest),
			).rejects.toMatchObject({ code: "invalid" });
		}
		expect(writeCalls()).toEqual([]);
	});

	it("deleting a reply DELETEs it; the thread stays with the rest", async () => {
		const answer = (await session.deleteThreadComment(
			"T12-0",
			"C12-0-2",
		)) as ThreadUpdate;
		expect(writeCalls()).toEqual([
			"api -X DELETE repos/acme/widget/pulls/comments/1002",
		]);
		expect(answer.commentCount).toBe(2);
		expect(answer.comments.comments.map((c) => c.id)).toEqual([
			"C12-0",
			"C12-0-1",
		]);
		expect(answer.attention).toEqual(["Octo_Cat"]);
		expect((await comments("T12-0"))?.comments).toHaveLength(2);
	});

	it("deleting the opener of a thread with replies edits it to [deleted]; deleting it again is done, editing it writes it back", async () => {
		const answer = (await session.deleteThreadComment(
			"T12-0",
			"C12-0",
		)) as ThreadUpdate;
		expect(writeCalls()).toEqual([
			"api -X PATCH repos/acme/widget/pulls/comments/1000 -H Accept: application/vnd.github.full+json --input -",
		]);
		expect(answer.commentCount).toBe(3);
		expect(answer.comment).toMatchObject({
			id: "C12-0",
			body: "[deleted]",
			deleted: true,
			viewerCan: { update: true, delete: false },
		});
		// A retry of the delete that landed: answered with the blanked opener.
		const again = (await session.deleteThreadComment(
			"T12-0",
			"C12-0",
		)) as ThreadUpdate;
		expect(again.comment).toMatchObject({ id: "C12-0", deleted: true });
		expect(again.commentCount).toBe(3);
		expect(writeCalls()).toHaveLength(1);
		// Owner: "allowing for me to edit it back if I want".
		const back = await edit("C12-0", "Back", { from: "[deleted]" });
		expect(back.comment).toMatchObject({
			id: "C12-0",
			body: "Back",
			deleted: false,
			viewerCan: { update: true, delete: true },
		});
		expect(writeCalls()).toHaveLength(2);
	});

	it("a blanked opener left alone may be deleted, and then really is: ThreadGone", async () => {
		await session.deleteThreadComment("T12-0", "C12-0");
		await session.deleteThreadComment("T12-0", "C12-0-2");
		// rev's reply goes elsewhere (a maintainer, or rev).
		threadsWith((t) => {
			const reply = t[0]?.comments.nodes[1];
			if (reply) reply.removed = true;
		});
		// GitHub's truth, not the kept read's.
		await session.refresh();
		const t = await comments("T12-0");
		expect(t?.comments.map((c) => [c.id, c.deleted, c.viewerCan])).toEqual([
			["C12-0", true, { update: true, delete: true }],
		]);
		const answer = await session.deleteThreadComment("T12-0", "C12-0");
		expect(answer).toEqual({ threadId: "T12-0", gone: true });
		expect(writeCalls().at(-1)).toBe(
			"api -X DELETE repos/acme/widget/pulls/comments/1000",
		);
	});

	it("deleting an opener right after replying to it, GraphQL not listing the reply yet: blanked, not deleted", async () => {
		threads({ replyUnlisted: true });
		await session.replyToThread("T12-2", {
			body: "Done",
			attemptedAt: new Date().toISOString(),
			retry: false,
			clientId: "r1",
			knownCommentIds: ["C12-2"],
		});
		const answer = (await session.deleteThreadComment(
			"T12-2",
			"C12-2",
		)) as ThreadUpdate;
		expect(writeCalls().at(-1)).toBe(
			"api -X PATCH repos/acme/widget/pulls/comments/3000 -H Accept: application/vnd.github.full+json --input -",
		);
		expect(answer.comment).toMatchObject({ id: "C12-2", deleted: true });
	});

	it("the last reply under a blanked opener deleted, GraphQL still listing it: the opener's delete really deletes, the reply stays gone", async () => {
		await session.deleteThreadComment("T12-0", "C12-0");
		threadsWith(
			(t) => {
				const reply = t[0]?.comments.nodes[1];
				if (reply) reply.removed = true;
			},
			{ writeUnlistedMs: 60_000 },
		);
		const left = (await session.deleteThreadComment(
			"T12-0",
			"C12-0-2",
		)) as ThreadUpdate;
		expect(left.comments.comments.map((c) => c.id)).toEqual(["C12-0"]);
		expect(left.comments.comments[0]?.viewerCan.delete).toBe(true);
		const answer = await session.deleteThreadComment("T12-0", "C12-0");
		expect(writeCalls().at(-1)).toBe(
			"api -X DELETE repos/acme/widget/pulls/comments/1000",
		);
		expect(answer).toEqual({ threadId: "T12-0", gone: true });
	});

	it("an edit answered as already there doesn't mark a never-edited comment edited", async () => {
		const answer = await edit("C12-0-2", "Fair.", { from: "Fair." });
		expect(writeCalls()).toEqual([]);
		expect(answer.comment?.editedAt).toBeNull();
	});

	it("an opener followed only by the viewer's pending comments is deleted, not blanked; pending ones are refused", async () => {
		threads({
			prs: {
				12: {
					view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
					graphql: {
						reviewThreads: [
							reviewThread({ path: "a.txt", line: 2 }, [
								said("Octo_Cat", "Hm", 1),
								threadComment({
									login: "Octo_Cat",
									text: "Draft",
									pending: true,
									createdAt: "2026-01-03T10:05:00Z",
								}),
							]),
						],
					},
				},
			},
		});
		// The session's kept read is of the scenario it opened on (published
		// replies, which would have the opener blanked): GitHub's truth now.
		await session.refresh();
		await expect(edit("C12-0-1", "x", { from: "Draft" })).rejects.toMatchObject(
			{ code: "forbidden" },
		);
		await expect(
			session.deleteThreadComment("T12-0", "C12-0-1"),
		).rejects.toMatchObject({ code: "forbidden" });
		expect(writeCalls()).toEqual([]);
		// None published left: gone from the page.
		await expect(
			session.deleteThreadComment("T12-0", "C12-0"),
		).resolves.toEqual({ threadId: "T12-0", gone: true });
		expect(writeCalls()).toEqual([
			"api -X DELETE repos/acme/widget/pulls/comments/1000",
		]);
	});

	it("a reply GraphQL doesn't list yet can be edited and deleted at once", async () => {
		threads({ replyUnlisted: true });
		const posted = await session.replyToThread("T12-0", {
			body: "Just now",
			attemptedAt: new Date().toISOString(),
			retry: false,
			clientId: "r1",
			knownCommentIds: ["C12-0", "C12-0-1", "C12-0-2"],
		});
		const id = posted.comment?.id ?? "";
		expect(posted.comment?.viewerCan).toEqual({ update: true, delete: true });
		const edited = await edit(id, "Just now, edited", { from: "Just now" });
		expect(edited.comment?.body).toBe("Just now, edited");
		expect(writeCalls().at(-1)).toMatch(
			/^api -X PATCH repos\/acme\/widget\/pulls\/comments\/1003 /,
		);
		const deleted = (await session.deleteThreadComment(
			"T12-0",
			id,
		)) as ThreadUpdate;
		expect(writeCalls().at(-1)).toBe(
			"api -X DELETE repos/acme/widget/pulls/comments/1003",
		);
		expect(deleted.comments.comments.map((c) => c.id)).not.toContain(id);
	});

	it("a delete retry GraphQL still lists but REST has no more: done, not refused", async () => {
		threads({
			writeUnlistedMs: 60_000,
			failNext: { op: "delete", status: 502, afterWrite: true },
		});
		await expect(
			session.deleteThreadComment("T12-0", "C12-0-2"),
		).rejects.toBeInstanceOf(GhError);
		const retried = (await session.deleteThreadComment(
			"T12-0",
			"C12-0-2",
		)) as ThreadUpdate;
		expect(retried.commentCount).toBe(2);
	});

	it("the changed check reads GitHub's body by REST: no false 409 while GraphQL lags an edit", async () => {
		threads({ writeUnlistedMs: 60_000 });
		await edit("C12-0-2", "B");
		const next = await edit("C12-0-2", "C", { from: "B" });
		expect(next.comment?.body).toBe("C");
		expect(writeCalls()).toHaveLength(2);
	});

	it("deleting a thread's only comment → ThreadGone, and the thread leaves the kept reads", async () => {
		expect(await listed()).toContain("T12-2");
		const answer = await session.deleteThreadComment("T12-2", "C12-2");
		expect(answer).toEqual({ threadId: "T12-2", gone: true });
		expect(writeCalls()).toEqual([
			"api -X DELETE repos/acme/widget/pulls/comments/3000",
		]);
		expect(await listed()).not.toContain("T12-2");
		expect(await comments("T12-2")).toMatchObject({
			comments: [],
			unavailable: "deleted",
		});
		// A retry after it landed: done, not an error.
		await expect(
			session.deleteThreadComment("T12-2", "C12-2"),
		).resolves.toEqual({ threadId: "T12-2", gone: true });
	});

	it("deleting a thread's only comment while GraphQL lags: ThreadGone all the same", async () => {
		threads({ writeUnlistedMs: 60_000 });
		const answer = await session.deleteThreadComment("T12-2", "C12-2");
		expect((answer as ThreadGone).gone).toBe(true);
	});

	it("GitHub's 404 on a delete counts as done once the comment is gone; one still there is refused", async () => {
		threads({ failNext: { op: "delete", status: 404, afterWrite: true } });
		const done = (await session.deleteThreadComment(
			"T12-0",
			"C12-0-2",
		)) as ThreadUpdate;
		expect(done.commentCount).toBe(2);
		// Not in a fresh read any more: done, without a call.
		const again = (await session.deleteThreadComment(
			"T12-0",
			"C12-0-2",
		)) as ThreadUpdate;
		expect(again.commentCount).toBe(2);
		expect(writeCalls()).toHaveLength(1);
		threads({ failNext: { op: "delete", status: 404 } });
		await expect(
			session.deleteThreadComment("T12-0", "C12-0-2"),
		).rejects.toMatchObject({ code: "forbidden" });
	});

	it("a deleted comment GraphQL still lists is left out of the answer", async () => {
		threads({ writeUnlistedMs: 60_000 });
		const answer = (await session.deleteThreadComment(
			"T12-0",
			"C12-0-2",
		)) as ThreadUpdate;
		expect(answer.commentCount).toBe(2);
		expect(answer.comments.comments.map((c) => c.id)).not.toContain("C12-0-2");
		expect(answer.lastActivityAt).toBe("2026-01-03T10:02:00Z");
	});

	it("a thread gone or of another PR → 404 gone; a transient failure → 502", async () => {
		await expect(
			session.deleteThreadComment("T13-0", "C13-0"),
		).rejects.toMatchObject({ code: "gone" });
		threads({ failNext: { op: "delete", status: 503 } });
		const failed = session.deleteThreadComment("T12-0", "C12-0-2");
		await expect(failed).rejects.toBeInstanceOf(GhError);
		await expect(failed).rejects.not.toHaveProperty("code");
	});

	it("a reply, an edit and a delete on one thread land in the order asked", async () => {
		threads({ replyDelayMs: 600 });
		const replied = session.replyToThread("T12-0", {
			body: "One more",
			attemptedAt: new Date().toISOString(),
			retry: false,
			clientId: "r1",
			knownCommentIds: ["C12-0", "C12-0-1", "C12-0-2"],
		});
		const edited = edit("C12-0-3", "One more, edited", { from: "One more" });
		const deleted = session.deleteThreadComment("T12-0", "C12-0-3");
		await Promise.all([replied, edited, deleted]);
		expect(writeCalls().map((l) => l.split(" ")[2])).toEqual([
			"POST",
			"PATCH",
			"DELETE",
		]);
		expect((await comments("T12-0"))?.comments).toHaveLength(3);
	});

	it("--viewer other → writes-off, and nothing may be done to any comment", async () => {
		const theirs = await Session.open(pr.arg, process.cwd(), () => {}, {
			viewer: "someone-else",
		});
		const t = await comments("T12-0", theirs);
		expect(t?.comments.map((c) => c.viewerCan)).toEqual([
			{ update: false, delete: false },
			{ update: false, delete: false },
			{ update: false, delete: false },
		]);
		await expect(
			edit("C12-0-2", "x", {}, "T12-0", theirs),
		).rejects.toMatchObject({ code: "writes-off" });
		await expect(
			theirs.deleteThreadComment("T12-0", "C12-0-2"),
		).rejects.toMatchObject({ code: "writes-off" });
		expect(writeCalls()).toEqual([]);
	});
});

describe("comment writes off before GitHub", () => {
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
		known: () => {},
	});

	it("as of a cutoff → writes-off", async () => {
		await expect(
			editComment(target("as-of"), "T1", "C1", {
				body: "x",
				from: "y",
				force: false,
			}),
		).rejects.toMatchObject({ code: "writes-off" });
		await expect(
			deleteThreadComment(target("as-of"), "T1", "C1"),
		).rejects.toMatchObject({ code: "writes-off" });
	});
});

describe("withoutComment", () => {
	const c = (id: string, at: string) => ({
		id,
		author: { login: id },
		createdAt: at,
		publishedAt: at,
		state: "SUBMITTED",
	});
	const nodes = () => ({
		summary: {
			first: { nodes: [{ ...c("a", "1"), originalCommit: { oid: "x" } }] },
			latest: { nodes: [c("c", "3")] },
			comments: {
				totalCount: 3,
				nodes: [c("a", "1"), c("b", "2"), c("c", "3")],
			},
		},
		content: {
			comments: {
				totalCount: 3,
				nodes: [c("a", "1"), c("b", "2"), c("c", "3")],
			},
		},
	});

	it("drops it from both lists and counts; the last one gone moves latest, the first one first", () => {
		const last = withoutComment(nodes(), "c") as {
			summary: Record<
				string,
				{ nodes: { id?: string }[]; totalCount?: number }
			>;
			content: { comments: { nodes: unknown[]; totalCount: number } };
		};
		expect(last.summary.comments?.totalCount).toBe(2);
		expect(last.content.comments.totalCount).toBe(2);
		expect(last.summary.latest?.nodes[0]).toMatchObject({ createdAt: "2" });
		const first = withoutComment(nodes(), "a") as {
			summary: Record<
				string,
				{ nodes: { id?: string; originalCommit?: unknown }[] }
			>;
		};
		expect(first.summary.first?.nodes[0]).toMatchObject({
			id: "b",
			originalCommit: { oid: "x" },
		});
		expect(withoutComment(nodes(), "zzz")).toEqual(nodes());
	});
});
