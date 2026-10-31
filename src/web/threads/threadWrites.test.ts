import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	EditRequest,
	PrOverview,
	ReplyRequest,
	ResolveRequest,
	ReviewThread,
	ThreadComment,
	ThreadComments,
	ThreadGone,
	ThreadsView,
	ThreadUpdate,
} from "../../shared/types";
import { ApiError, postReply } from "../api";
import {
	DELAYED_MS,
	RETRY_DELAYS_MS,
	STALL_ATTEMPTS,
} from "../files/stateSync";
import { DraftStore, type NewTarget } from "./drafts";
import { RefusalStore } from "./refusals";
import {
	applyComment,
	applyThreadUpdate,
	DELETE_UNDO_MS,
	dropThread,
	FADE_MS,
	MAX_IN_FLIGHT,
	overlayThreads,
	ThreadWrites,
} from "./threadWrites";

interface Call {
	op: "reply" | "resolve" | "edit" | "delete";
	threadId: string;
	req: ReplyRequest | ResolveRequest | EditRequest | null;
	commentId?: string;
	resolve: (u: ThreadUpdate | ThreadGone) => void;
	reject: (e: unknown) => void;
}

/** Edit and delete deps for tests that don't use them. */
const noEdits = {
	edit: () => new Promise<ThreadUpdate>(() => {}),
	remove: () => new Promise<ThreadUpdate>(() => {}),
	gone: () => {},
	theirs: () => {},
};

const update = (threadId: string, more: Partial<ThreadUpdate> = {}) =>
	({
		threadId,
		resolved: false,
		commentCount: 2,
		lastActivityAt: "2026-01-03T12:00:00Z",
		attention: ["bob"],
		yourTurn: false,
		viewerCan: { reply: true, resolve: true, unresolve: false },
		comments: { threadId, comments: [] },
		...more,
	}) satisfies ThreadUpdate;

/** The thread's first refused write (null when none). */
const failedOf = (w: ThreadWrites, threadId: string) =>
	w.state().threads.get(threadId)?.refused[0] ?? null;

let calls: Call[];
let goneCalls: string[];
let theirsCalls: [string, ThreadComment][];
let applied: ThreadUpdate[];
let drafts: DraftStore;
let refusals: RefusalStore;

/** `storage`: a page's localStorage, kept across "reloads" (a new setup). */
function setup(storage?: Storage) {
	calls = [];
	applied = [];
	goneCalls = [];
	theirsCalls = [];
	known = { T1: ["c1", "c2"] };
	ids = 0;
	confirmed = {};
	postedCount = 0;
	drafts = new DraftStore(() => storage);
	refusals = new RefusalStore(() => storage);
	if (storage) {
		drafts.bind("crb:drafts:o/r#1");
		refusals.bind("crb:refused:o/r#1");
	}
	const call =
		(op: Call["op"]) =>
		(threadId: string, req: ReplyRequest | ResolveRequest) =>
			new Promise<ThreadUpdate>((resolve, reject) => {
				calls.push({
					op,
					threadId,
					req,
					resolve: resolve as Call["resolve"],
					reject,
				});
			});
	return new ThreadWrites({
		reply: call("reply"),
		resolve: call("resolve"),
		edit: (threadId, commentId, req) =>
			new Promise<ThreadUpdate>((resolve, reject) => {
				calls.push({
					op: "edit",
					threadId,
					commentId,
					req,
					resolve: resolve as Call["resolve"],
					reject,
				});
			}),
		remove: (threadId, commentId) =>
			new Promise<ThreadUpdate | ThreadGone>((resolve, reject) => {
				calls.push({
					op: "delete",
					threadId,
					commentId,
					req: null,
					resolve,
					reject,
				});
			}),
		gone: (threadId) => goneCalls.push(threadId),
		theirs: (threadId, c) => theirsCalls.push([threadId, c]),
		applied: (u) => applied.push(u),
		drafts,
		refusals,
		knownComments: (threadId) => known[threadId] ?? [],
		newId: () => `cid${++ids}`,
		confirmedResolved: (threadId) => confirmed[threadId],
		posted: () => {
			postedCount++;
		},
	});
}

/** GitHub's resolved state per thread, as the page last had it. */
let confirmed: Record<string, boolean> = {};
let postedCount = 0;

/** The comment ids the page has per thread, for knownCommentIds. */
let known: Record<string, string[]> = {};
let ids = 0;

/** Lets settled promises run their `then`s. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-03T12:00:00Z"));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("ThreadWrites", () => {
	it("writes to one thread go in order: a resolve waits for the slow reply", async () => {
		const w = setup();
		w.reply("T1", "Fixed");
		w.setResolved("T1", true);
		expect(calls.map((c) => c.op)).toEqual(["reply"]);
		// The reply shows, the resolve shows as intended, both waiting.
		expect(w.state().threads.get("T1")).toMatchObject({
			resolved: true,
			replies: [{ text: "Fixed" }],
			action: "Reply",
		});
		await vi.advanceTimersByTimeAsync(3000);
		expect(calls).toHaveLength(1);
		calls[0]?.resolve(update("T1"));
		await flush();
		expect(calls.map((c) => c.op)).toEqual(["reply", "resolve"]);
		expect(calls[1]?.req).toEqual({ resolved: true });
		calls[1]?.resolve(update("T1", { resolved: true }));
		await flush();
		expect(applied.map((u) => u.resolved)).toEqual([false, true]);
		expect(w.state().threads.size).toBe(0);
		expect(w.state().busy).toBe(false);
	});

	it("runs different threads in parallel, at most four at once", async () => {
		const w = setup();
		for (let i = 0; i < MAX_IN_FLIGHT + 2; i++) w.setResolved(`T${i}`, true);
		expect(calls).toHaveLength(MAX_IN_FLIGHT);
		calls[0]?.resolve(update("T0", { resolved: true }));
		await flush();
		expect(calls).toHaveLength(MAX_IN_FLIGHT + 1);
		expect(calls.at(-1)?.threadId).toBe(`T${MAX_IN_FLIGHT}`);
	});

	it("a resolve still in line takes the newer intent", async () => {
		const w = setup();
		w.reply("T1", "a");
		w.setResolved("T1", true);
		w.setResolved("T1", false);
		calls[0]?.resolve(update("T1"));
		await flush();
		expect(calls.slice(1).map((c) => c.req)).toEqual([{ resolved: false }]);
	});

	it("turns yellow after DELAYED_MS, with why it waits", async () => {
		const w = setup();
		w.reply("T1", "Fixed");
		calls[0]?.reject(new ApiError(0, "unreachable"));
		await flush();
		expect(w.state().threads.get("T1")?.delayed).toBe(false);
		expect(w.state().threads.get("T1")?.waiting).toBe("Can't reach crb");
		await vi.advanceTimersByTimeAsync(DELAYED_MS);
		expect(w.state().threads.get("T1")?.delayed).toBe(true);
	});

	it("retries transient failures on the backoff, each reply resend with retry: true and the first attemptedAt", async () => {
		const w = setup();
		w.reply("T1", "Fixed");
		const first = calls[0]?.req as ReplyRequest;
		expect(first).toEqual({
			body: "Fixed",
			attemptedAt: "2026-01-03T12:00:00.000Z",
			retry: false,
			clientId: "cid1",
			knownCommentIds: ["c1", "c2"],
		});
		for (const status of [0, 408, 429, 500, 502]) {
			calls.at(-1)?.reject(new ApiError(status, `failed ${status}`));
			await flush();
			const n = calls.length;
			const wait = RETRY_DELAYS_MS[n - 1] ?? 30_000;
			await vi.advanceTimersByTimeAsync(wait - 1);
			expect(calls).toHaveLength(n);
			await vi.advanceTimersByTimeAsync(1);
			expect(calls).toHaveLength(n + 1);
			expect(calls.at(-1)?.req).toEqual({ ...first, retry: true });
		}
	});

	it("goes red after STALL_ATTEMPTS transient failures, retrying on", async () => {
		const w = setup();
		w.setResolved("T1", true);
		for (let i = 0; i < STALL_ATTEMPTS; i++) {
			expect(w.state().threads.get("T1")?.stalled).toBeNull();
			calls.at(-1)?.reject(new ApiError(503, "busy"));
			await flush();
			await vi.advanceTimersByTimeAsync(30_000);
		}
		expect(w.state().threads.get("T1")?.stalled?.message).toBe("busy");
		expect(calls).toHaveLength(STALL_ATTEMPTS + 1);
		calls.at(-1)?.resolve(update("T1", { resolved: true }));
		await flush();
		expect(w.state().threads.get("T1")).toBeUndefined();
	});

	it.each([400, 403, 404, 409])(
		"%i is red at once and never sent again by itself",
		async (status) => {
			const w = setup();
			drafts.setText("T1", "");
			w.reply("T1", "Fixed");
			calls[0]?.reject(new ApiError(status, `refused ${status}`));
			await flush();
			await vi.advanceTimersByTimeAsync(120_000);
			expect(calls).toHaveLength(1);
			const view = w.state().threads.get("T1");
			expect(failedOf(w, "T1")).toMatchObject({
				action: "Reply",
				error: { message: `refused ${status}` },
			});
			// The reply is no longer shown as sending: its text is back in the box.
			expect(view?.replies).toEqual([]);
			expect(drafts.text("T1")).toBe("Fixed");
			expect(drafts.get().some((d) => d.sending)).toBe(false);
		},
	);

	it("a deleted thread (404) keeps the draft and doesn't loop", async () => {
		const w = setup();
		w.reply("T1", "Fixed");
		calls[0]?.reject(
			new ApiError(404, "The thread is gone", undefined, { code: "gone" }),
		);
		await flush();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(calls).toHaveLength(1);
		expect(failedOf(w, "T1")?.code).toBe("gone");
		expect(drafts.text("T1")).toBe("Fixed");
	});

	it("a pending review (409) is refused with its link and noted for the warning", async () => {
		const w = setup();
		w.reply("T1", "Fixed");
		calls[0]?.reject(
			new ApiError(409, "one pending review", undefined, {
				code: "pending-review",
				url: "https://github.com/o/r/pull/1/files",
			}),
		);
		await flush();
		expect(failedOf(w, "T1")).toMatchObject({
			code: "pending-review",
			url: "https://github.com/o/r/pull/1/files",
		});
		expect(w.state().pendingReview).toEqual({
			url: "https://github.com/o/r/pull/1/files",
		});
	});

	it("Retry resends a refused reply from the box as a new reply", async () => {
		const w = setup();
		w.reply("T1", "Fixed");
		calls[0]?.reject(new ApiError(403, "no"));
		await flush();
		drafts.setText("T1", "Fixed, really");
		known.T1 = ["c1", "c2", "c3"];
		w.retry("T1");
		// Refused for good: a new reply, with a new client id and the
		// comments known now (never the refused id again).
		expect(calls[1]?.req).toMatchObject({
			body: "Fixed, really",
			// Certainly new: no dedupe asked for.
			retry: false,
			clientId: "cid2",
			knownCommentIds: ["c1", "c2", "c3"],
		});
		expect(drafts.text("T1")).toBe("");
		// Listed, retrying, until GitHub has it.
		expect(failedOf(w, "T1")).toMatchObject({ retrying: true });
		calls[1]?.resolve(update("T1"));
		await flush();
		expect(failedOf(w, "T1")).toBeNull();
	});

	it("a refused resolve keeps its intended state until Retry", async () => {
		const w = setup();
		w.setResolved("T1", true);
		calls[0]?.reject(new ApiError(403, "no"));
		await flush();
		expect(w.state().threads.get("T1")).toMatchObject({
			resolved: true,
			refused: [{ action: "Resolve", resolved: true }],
		});
		w.retry("T1");
		expect(calls[1]?.req).toEqual({ resolved: true });
	});

	it("Retry of a stalled write sends at once", async () => {
		const w = setup();
		w.setResolved("T1", true);
		calls[0]?.reject(new ApiError(502, "bad gateway"));
		await flush();
		w.retry("T1");
		expect(calls).toHaveLength(2);
	});

	it("keeps a sent reply in the drafts until confirmed, then drops it", async () => {
		const w = setup();
		drafts.setText("T1", "Fixed");
		w.reply("T1", "Fixed");
		expect(drafts.text("T1")).toBe("");
		expect(drafts.get()).toEqual([
			{
				threadId: "T1",
				text: "Fixed",
				sending: {
					attemptedAt: "2026-01-03T12:00:00.000Z",
					sentOnce: true,
					clientId: "cid1",
					knownCommentIds: ["c1", "c2"],
				},
			},
		]);
		calls[0]?.resolve(update("T1"));
		await flush();
		expect(drafts.get()).toEqual([]);
	});

	it("resume() resends unconfirmed replies with retry: true, once", async () => {
		const w = setup();
		drafts.addSending("T1", "Fixed", {
			attemptedAt: "2026-01-03T11:00:00.000Z",
			clientId: "before-reload",
			knownCommentIds: ["c1"],
		});
		w.resume();
		w.resume();
		// As first sent, before the reload: never a new id.
		expect(calls.map((c) => c.req)).toEqual([
			{
				body: "Fixed",
				attemptedAt: "2026-01-03T11:00:00.000Z",
				retry: true,
				clientId: "before-reload",
				knownCommentIds: ["c1"],
			},
		]);
		expect(w.state().threads.get("T1")?.replies).toEqual([
			{ text: "Fixed", attemptedAt: "2026-01-03T11:00:00.000Z" },
		]);
	});

	it("gives each reply its own client id, the same on every resend", async () => {
		const w = setup();
		w.reply("T1", "a");
		calls[0]?.reject(new ApiError(502, "bad gateway"));
		await flush();
		await vi.advanceTimersByTimeAsync(1000);
		calls[1]?.resolve(update("T1"));
		await flush();
		w.reply("T1", "b");
		expect(calls.map((c) => (c.req as ReplyRequest).clientId)).toEqual([
			"cid1",
			"cid1",
			"cid2",
		]);
	});

	it("takes the known comment ids at the first send, once earlier writes to the thread are answered", async () => {
		const w = setup();
		w.reply("T1", "first");
		w.reply("T1", "second");
		expect(calls).toHaveLength(1);
		// The first reply is in: the page now has it among the comments.
		known.T1 = ["c1", "c2", "c9"];
		calls[0]?.resolve(update("T1"));
		await flush();
		expect(calls.map((c) => (c.req as ReplyRequest).knownCommentIds)).toEqual([
			["c1", "c2"],
			["c1", "c2", "c9"],
		]);
		// Kept with the draft, for a resend after a reload.
		expect(drafts.get()[0]?.sending?.knownCommentIds).toEqual([
			"c1",
			"c2",
			"c9",
		]);
	});

	it("reads the comments first when the page hasn't them, and never sends an empty list", async () => {
		const w = setup();
		let give: ((ids: string[]) => void) | undefined;
		known = {};
		const wAsync = new ThreadWrites({
			reply: (threadId, req) =>
				new Promise((resolve, reject) => {
					calls.push({
						op: "reply",
						threadId,
						req,
						resolve: resolve as Call["resolve"],
						reject,
					});
				}),
			resolve: () => new Promise(() => {}),
			...noEdits,
			applied: () => {},
			drafts,
			knownComments: () =>
				new Promise((resolve) => {
					give = resolve;
				}),
			newId: () => "x",
		});
		void w;
		wAsync.reply("T1", "Fixed");
		await flush();
		expect(calls).toHaveLength(0);
		give?.([]);
		await flush();
		// None known: it waits and tries again, as for a lost server.
		expect(calls).toHaveLength(0);
		expect(wAsync.state().threads.get("T1")?.waiting).toBe(
			"Couldn't read the thread's comments",
		);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] ?? 1000);
		give?.(["c1"]);
		await flush();
		expect(
			(calls[0]?.req as ReplyRequest | undefined)?.knownCommentIds,
		).toEqual(["c1"]);
	});

	it("a stalled reply's Retry keeps its client id and known ids", async () => {
		const w = setup();
		w.reply("T1", "Fixed");
		calls[0]?.reject(new ApiError(502, "bad gateway"));
		await flush();
		known.T1 = ["c1", "c2", "c3"];
		w.retry("T1");
		expect(calls[1]?.req).toMatchObject({
			clientId: "cid1",
			knownCommentIds: ["c1", "c2"],
			retry: true,
		});
	});

	it("Drop lets a refused resolve go: GitHub's state shows again, nothing waits", async () => {
		const w = setup();
		confirmed.T1 = false;
		w.setResolved("T1", true);
		calls[0]?.reject(new ApiError(403, "no"));
		await flush();
		expect(w.state().busy).toBe(true);
		expect(w.state().lost).toBe(true);
		w.drop("T1", "resolve");
		expect(w.state().threads.get("T1")).toBeUndefined();
		expect(w.state().busy).toBe(false);
		expect(w.state().lost).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it("Drop of a refused reply lets it go with its text", async () => {
		const w = setup();
		w.reply("T1", "Drop me");
		calls[0]?.reject(new ApiError(403, "no"));
		await flush();
		w.drop("T1", "reply");
		expect(w.state().threads.get("T1")).toBeUndefined();
		expect(w.state().refused).toEqual([]);
		expect(drafts.text("T1")).toBe("");
		expect(calls).toHaveLength(1);
	});

	it("toggling back to GitHub's state sends nothing: a refused one is let go, a queued one dropped", async () => {
		const w = setup();
		confirmed.T1 = false;
		w.setResolved("T1", true);
		calls[0]?.reject(new ApiError(403, "no"));
		await flush();
		w.setResolved("T1", false);
		expect(calls).toHaveLength(1);
		expect(w.state().threads.get("T1")).toBeUndefined();
		// Resolve then undo while it waits behind a reply: neither is sent.
		w.reply("T1", "first");
		w.setResolved("T1", true);
		w.setResolved("T1", false);
		calls[1]?.resolve(update("T1"));
		await flush();
		expect(calls.map((c) => c.op)).toEqual(["resolve", "reply"]);
	});

	it("undo while the resolve is out is sent, in order", async () => {
		const w = setup();
		confirmed.T1 = false;
		w.setResolved("T1", true);
		w.setResolved("T1", false);
		calls[0]?.resolve(update("T1", { resolved: true }));
		await flush();
		expect(calls.map((c) => c.req)).toEqual([
			{ resolved: true },
			{ resolved: false },
		]);
	});

	it("a newly posted reply says so (the pending-review flag goes); a deduped retry doesn't", async () => {
		const w = setup();
		w.reply("T1", "a");
		calls[0]?.resolve(update("T1"));
		await flush();
		expect(postedCount).toBe(1);
		drafts.addSending("T2", "b", {
			attemptedAt: "2026-01-03T11:00:00.000Z",
			clientId: "old",
			knownCommentIds: ["c1"],
		});
		w.resume();
		calls[1]?.resolve(update("T2"));
		await flush();
		expect(postedCount).toBe(1);
	});

	it("a resumed reply is flagged, and discarding it while out stops its retries and drops it", async () => {
		const w = setup();
		drafts.addSending("T1", "From yesterday", {
			attemptedAt: "2026-01-02T11:00:00.000Z",
			clientId: "old",
			knownCommentIds: ["c1"],
		});
		w.resume();
		expect(w.state().threads.get("T1")?.resumed).toBe(true);
		w.discard("T1");
		expect(drafts.get()).toEqual([]);
		expect(w.state().threads.get("T1")?.resumed).toBe(false);
		calls[0]?.reject(new ApiError(502, "bad gateway"));
		await flush();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(1);
		expect(w.state().threads.get("T1")).toBeUndefined();
		expect(w.state().busy).toBe(false);
	});

	it("discarding a resumed reply keeps the box draft and replies sent since", async () => {
		const w = setup();
		drafts.addSending("T1", "From yesterday", {
			attemptedAt: "2026-01-02T11:00:00.000Z",
			clientId: "old",
			knownCommentIds: ["c1"],
		});
		w.resume();
		w.reply("T1", "Sent today");
		drafts.setText("T1", "Typing now");
		w.discardResumed("T1");
		expect(drafts.text("T1")).toBe("Typing now");
		expect(
			drafts
				.get()
				.filter((d) => d.sending)
				.map((d) => d.text),
		).toEqual(["Sent today"]);
		// The resumed one was out: it fails, isn't retried; today's goes next.
		calls[0]?.reject(new ApiError(502, "bad gateway"));
		await flush();
		expect(calls.map((c) => (c.req as ReplyRequest).body)).toEqual([
			"From yesterday",
			"Sent today",
		]);
	});

	it("discarding a resumed reply waiting out a backoff drops it and sends the next at once", async () => {
		const w = setup();
		drafts.addSending("T1", "From yesterday", {
			attemptedAt: "2026-01-02T11:00:00.000Z",
			clientId: "old",
			knownCommentIds: ["c1"],
		});
		w.resume();
		w.setResolved("T1", true);
		calls[0]?.reject(new ApiError(502, "bad gateway"));
		await flush();
		w.discardResumed("T1");
		expect(calls.map((c) => c.op)).toEqual(["reply", "resolve"]);
		expect(drafts.get()).toEqual([]);
	});

	it("a reply discarded while its comments are read is never posted", async () => {
		drafts = new DraftStore(() => undefined);
		calls = [];
		let give: ((ids: string[]) => void) | undefined;
		const w = new ThreadWrites({
			reply: (threadId, req) =>
				new Promise((resolve, reject) => {
					calls.push({
						op: "reply",
						threadId,
						req,
						resolve: resolve as Call["resolve"],
						reject,
					});
				}),
			resolve: () => new Promise(() => {}),
			...noEdits,
			applied: () => {},
			drafts,
			knownComments: () =>
				new Promise((resolve) => {
					give = resolve;
				}),
			newId: () => "x",
		});
		drafts.addSending("T1", "From yesterday", {
			attemptedAt: "2026-01-02T11:00:00.000Z",
			clientId: "old",
			knownCommentIds: [],
		});
		w.resume();
		await flush();
		w.discardResumed("T1");
		give?.(["c1"]);
		await flush();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toEqual([]);
		expect(w.state().threads.get("T1")).toBeUndefined();
	});

	it("discard drops a queued reply before it goes", () => {
		const w = setup();
		w.setResolved("T1", true);
		w.reply("T1", "never mind");
		w.discard("T1");
		expect(w.state().threads.get("T1")?.replies).toEqual([]);
		expect(drafts.get()).toEqual([]);
	});

	it("never sends blank text", () => {
		const w = setup();
		w.reply("T1", "  \n ");
		expect(calls).toEqual([]);
	});
});

describe("overlayThreads", () => {
	it("shows an intended resolve at once, the rest as they are", () => {
		const a = { id: "A", resolved: false } as ReviewThread;
		const b = { id: "B", resolved: false } as ReviewThread;
		const state = {
			threads: new Map([
				[
					"A",
					{
						threadId: "A",
						resolved: true,
						replies: [],
						edits: [],
						deletes: [],
						action: "Resolve" as const,
						resumed: false,
						delayed: false,
						waiting: null,
						stalled: null,
						refused: [],
					},
				],
			]),
			pendingReview: null,
			busy: true,
			lost: true,
			refused: [],
			gone: new Set<string>(),
		};
		const out = overlayThreads(
			[{ ...a, yourTurn: true, attention: ["octo"] }, b],
			state,
		);
		expect(out[0]).toMatchObject({
			resolved: true,
			yourTurn: false,
			attention: [],
		});
		expect(out[1]).toBe(b);
		const none = [a, b];
		expect(
			overlayThreads(none, {
				...state,
				threads: new Map(),
				busy: false,
				lost: false,
			}),
		).toBe(none);
	});
});

describe("editing and deleting comments", () => {
	const comment = (id: string, body: string): ThreadComment => ({
		id,
		author: "octo",
		bot: false,
		avatarUrl: "",
		publishedAt: "2026-01-03T09:00:00Z",
		pending: false,
		html: `<p>${body}</p>`,
		body,
		text: body,
		editedAt: null,
		viewerCan: { update: true, delete: true },
		deleted: false,
	});

	it("an edit shows at once, goes with what it started from, and its draft goes once GitHub has it", async () => {
		const w = setup();
		drafts.setEdit("T1", "c1", "Old", "New");
		w.saveEdit("T1", "c1");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			op: "edit",
			threadId: "T1",
			commentId: "c1",
			req: { body: "New", from: "Old", force: false },
		});
		expect(w.state().threads.get("T1")).toMatchObject({
			edits: [{ commentId: "c1", text: "New" }],
			action: "Edit",
		});
		// Saving: kept (a reload resends it), out of the editor.
		expect(drafts.edit("c1")?.edit?.saving).toBe(true);
		expect(w.state().busy).toBe(true);
		calls[0]?.resolve(update("T1"));
		await flush();
		expect(applied).toHaveLength(1);
		expect(drafts.edit("c1")).toBeUndefined();
		expect(w.state().threads.size).toBe(0);
	});

	it("an unchanged or blank edit sends nothing", () => {
		const w = setup();
		w.saveEdit("T1", "c1");
		drafts.setEdit("T1", "c1", "Old", "   ");
		w.saveEdit("T1", "c1");
		expect(calls).toHaveLength(0);
		expect(w.state().threads.size).toBe(0);
	});

	it("goes in line behind the thread's reply", async () => {
		const w = setup();
		w.reply("T1", "Fixed");
		drafts.setEdit("T1", "c1", "Old", "New");
		w.saveEdit("T1", "c1");
		expect(calls.map((c) => c.op)).toEqual(["reply"]);
		calls[0]?.resolve(update("T1"));
		await flush();
		expect(calls.map((c) => c.op)).toEqual(["reply", "edit"]);
	});

	it("changed on GitHub: refused, the draft back in its editor; Show theirs takes GitHub's text in, Save anyway forces", async () => {
		const w = setup();
		drafts.setEdit("T1", "c1", "Old", "Mine");
		w.saveEdit("T1", "c1");
		const theirs = comment("c1", "Theirs");
		calls[0]?.reject(
			new ApiError(409, "Changed", undefined, {
				code: "changed",
				current: theirs,
			}),
		);
		await flush();
		const view = w.state().threads.get("T1");
		expect(failedOf(w, "T1")).toMatchObject({
			action: "Edit",
			code: "changed",
			commentId: "c1",
			current: theirs,
		});
		expect(view?.edits).toEqual([]);
		// Nothing typed is lost: the draft is in the editor again.
		expect(drafts.edit("c1")).toEqual({
			threadId: "T1",
			text: "Mine",
			edit: { commentId: "c1", from: "Old" },
		});
		// Never resent by itself.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(1);
		w.showTheirs("T1", "c1");
		expect(theirsCalls).toEqual([["T1", theirs]]);
		expect(drafts.edit("c1")?.edit?.from).toBe("Theirs");
		expect(drafts.edit("c1")?.text).toBe("Mine");
		expect(w.state().threads.get("T1")).toBeUndefined();
		w.saveEdit("T1", "c1", true);
		expect(calls[1]).toMatchObject({
			op: "edit",
			req: { body: "Mine", from: "Theirs", force: true },
		});
	});

	it("Save anyway straight from the refusal sends force", async () => {
		const w = setup();
		drafts.setEdit("T1", "c1", "Old", "Mine");
		w.saveEdit("T1", "c1");
		calls[0]?.reject(
			new ApiError(409, "Changed", undefined, { code: "changed" }),
		);
		await flush();
		w.saveEdit("T1", "c1", true);
		expect(failedOf(w, "T1")).toBeNull();
		expect(calls[1]?.req).toEqual({ body: "Mine", from: "Old", force: true });
	});

	it("an edit of a comment gone (404) says so and keeps the draft", async () => {
		const w = setup();
		drafts.setEdit("T1", "c1", "Old", "Mine");
		w.saveEdit("T1", "c1");
		calls[0]?.reject(
			new ApiError(404, "The comment is gone", undefined, { code: "gone" }),
		);
		await flush();
		expect(failedOf(w, "T1")).toMatchObject({
			action: "Edit",
			code: "gone",
		});
		expect(drafts.edit("c1")?.text).toBe("Mine");
		expect(drafts.edit("c1")?.edit?.saving).toBeUndefined();
	});

	it("a transient failure resends the same edit (the server finds one that landed)", async () => {
		const w = setup();
		drafts.setEdit("T1", "c1", "Old", "Mine");
		w.saveEdit("T1", "c1");
		calls[0]?.reject(new ApiError(502, "bad gateway"));
		await flush();
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] ?? 0);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.req).toEqual(calls[0]?.req);
	});

	it("an edit a reload left saving is resent on resume, once", () => {
		const w = setup();
		drafts.setEdit("T1", "c1", "Old", "Mine");
		drafts.markSaving("c1", true);
		w.resume();
		w.resume();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			op: "edit",
			req: { body: "Mine", from: "Old", force: false },
		});
	});

	it("a reply refused behind which an edit waits: the edit still goes, its draft untouched", async () => {
		const w = setup();
		w.reply("T1", "LGTM");
		drafts.setEdit("T1", "c2", "Old", "My careful edit");
		w.saveEdit("T1", "c2");
		calls[0]?.reject(
			new ApiError(409, "Pending review", undefined, {
				code: "pending-review",
				url: "https://github.com/o/r/pull/1/files",
			}),
		);
		await flush();
		expect(drafts.text("T1")).toBe("LGTM");
		expect(drafts.edit("c2")).toMatchObject({
			text: "My careful edit",
			edit: { commentId: "c2", from: "Old", saving: true },
		});
		expect(calls[1]).toMatchObject({
			op: "edit",
			req: { body: "My careful edit", from: "Old", force: false },
		});
	});

	it("Retry of a refused Save anyway saves anyway again", async () => {
		const w = setup();
		drafts.setEdit("T1", "c1", "Old", "Mine");
		w.saveEdit("T1", "c1", true);
		calls[0]?.reject(new ApiError(403, "No", undefined, { code: "forbidden" }));
		await flush();
		w.retry("T1");
		expect(calls[1]?.req).toEqual({ body: "Mine", from: "Old", force: true });
	});

	it("a resumed edit shows as resumed and can be let go, its draft too", async () => {
		const w = setup();
		drafts.setEdit("T1", "c1", "Old", "Mine");
		drafts.markSaving("c1", true);
		w.resume();
		expect(w.state().threads.get("T1")).toMatchObject({
			action: "Edit",
			resumed: true,
		});
		w.discardResumed("T1");
		expect(drafts.edit("c1")).toBeUndefined();
		// The one already out is never sent again.
		calls[0]?.reject(new ApiError(502, "bad gateway"));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(1);
		expect(w.state().threads.size).toBe(0);
	});

	it("cancelling an edit drops its draft and its refusal", async () => {
		const w = setup();
		drafts.setEdit("T1", "c1", "Old", "Mine");
		w.saveEdit("T1", "c1");
		calls[0]?.reject(new ApiError(400, "Bad", undefined, { code: "invalid" }));
		await flush();
		w.cancelEdit("T1", "c1");
		expect(drafts.edit("c1")).toBeUndefined();
		expect(w.state().threads.size).toBe(0);
	});

	it("lost: only writes nothing resends after a reload (resolves, deletes), never replies, edits or new threads", async () => {
		const w = setup();
		w.reply("T1", "Fixed");
		drafts.setEdit("T2", "c9", "Old", "New");
		w.saveEdit("T2", "c9");
		expect(w.state().busy).toBe(true);
		expect(w.state().lost).toBe(false);
		w.setResolved("T3", true);
		expect(w.state().lost).toBe(true);
		calls
			.find((c) => c.threadId === "T3")
			?.resolve(update("T3", { resolved: true }));
		await flush();
		expect(w.state().lost).toBe(false);
		w.deleteComment("T4", "c4");
		await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS);
		// On its way now: still not on GitHub, nothing resends it.
		expect(w.state().threads.get("T4")?.deletes).toEqual([
			{ commentId: "c4", undo: false },
		]);
		expect(w.state().lost).toBe(true);
	});

	it("a delete waits out its undo window: Undo within it sends nothing", async () => {
		const w = setup();
		w.deleteComment("T1", "c2");
		expect(w.state().threads.get("T1")?.deletes).toEqual([
			{ commentId: "c2", undo: true },
		]);
		// Leaving the page now would lose it: the guard asks.
		expect(w.state().busy).toBe(true);
		expect(w.state().lost).toBe(true);
		await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS - 1);
		w.undoDelete("T1", "c2");
		await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS * 2);
		expect(calls).toHaveLength(0);
		expect(w.state().threads.size).toBe(0);
		expect(w.state().busy).toBe(false);
	});

	it("after the window the delete is sent, and GitHub's answer shows", async () => {
		const w = setup();
		drafts.setEdit("T1", "c2", "Old", "Half an edit");
		w.deleteComment("T1", "c2");
		await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS);
		expect(calls).toEqual([
			expect.objectContaining({
				op: "delete",
				threadId: "T1",
				commentId: "c2",
			}),
		]);
		expect(w.state().threads.get("T1")?.deletes).toEqual([
			{ commentId: "c2", undo: false },
		]);
		// Too late to undo: it's out.
		w.undoDelete("T1", "c2");
		expect(w.state().threads.get("T1")?.deletes).toHaveLength(1);
		calls[0]?.resolve(update("T1"));
		await flush();
		expect(applied).toHaveLength(1);
		expect(drafts.edit("c2")).toBeUndefined();
		expect(w.state().threads.size).toBe(0);
	});

	it("deleting twice in the window is one delete", async () => {
		const w = setup();
		w.deleteComment("T1", "c2");
		w.deleteComment("T1", "c2");
		await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS);
		expect(calls).toHaveLength(1);
	});

	it("a thread gone (its last comment deleted) stays listed as gone while it fades, then the page drops it", async () => {
		const w = setup();
		w.deleteComment("T1", "c1");
		await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS);
		calls[0]?.resolve({ threadId: "T1", gone: true });
		await flush();
		expect(applied).toHaveLength(0);
		expect(w.state().gone.has("T1")).toBe(true);
		expect(goneCalls).toEqual([]);
		await vi.advanceTimersByTimeAsync(FADE_MS);
		expect(goneCalls).toEqual(["T1"]);
		expect(w.state().gone.size).toBe(0);
	});

	it("a delete answered 404 (the thread gone already) counts as done", async () => {
		const w = setup();
		w.deleteComment("T1", "c1");
		await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS);
		calls[0]?.reject(
			new ApiError(404, "The thread is gone", undefined, { code: "gone" }),
		);
		await flush();
		expect(failedOf(w, "T1")).toBeNull();
		expect(w.state().gone.has("T1")).toBe(true);
	});

	it("a refused delete shows the comment again; Retry sends it at once", async () => {
		const w = setup();
		w.deleteComment("T1", "c2");
		await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS);
		calls[0]?.reject(
			new ApiError(403, "Not yours", undefined, { code: "forbidden" }),
		);
		await flush();
		expect(w.state().threads.get("T1")).toMatchObject({
			deletes: [],
			refused: [{ action: "Delete", commentId: "c2", key: "delete:c2" }],
		});
		// Its Retry is the only way it's sent: a reload would lose it.
		expect(w.state().lost).toBe(true);
		w.retry("T1");
		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({ op: "delete", commentId: "c2" });
	});
});

describe("applyThreadUpdate", () => {
	it("updates the thread in the thread lists and its comments, so card, bubble and dot change", () => {
		const client = new QueryClient();
		const thread = {
			id: "T1",
			author: "alice",
			resolved: false,
			commentCount: 1,
			hasReply: false,
			attention: ["alice"],
			yourTurn: true,
		} as ReviewThread;
		const other = { id: "T2", author: "x" } as ReviewThread;
		client.setQueryData(["overview"], { readId: "r1" } as PrOverview);
		for (const stage of ["summary", "full"]) {
			client.setQueryData<ThreadsView>(["threads", "r1", stage], {
				threads: [thread, other],
				complete: true,
			});
		}
		const comments: ThreadComments = {
			threadId: "T1",
			comments: [
				{
					id: "c1",
					author: "alice",
					bot: false,
					avatarUrl: "",
					publishedAt: "2026-01-01T00:00:00Z",
					pending: false,
					html: "",
					body: "Q",
					text: "Q",
					editedAt: null,
					viewerCan: { update: false, delete: false },
					deleted: false,
				},
				{
					id: "c2",
					author: "octo",
					bot: false,
					avatarUrl: "",
					publishedAt: "2026-01-03T12:00:00Z",
					pending: false,
					html: "<p>A</p>",
					body: "A",
					text: "A",
					editedAt: null,
					viewerCan: { update: false, delete: false },
					deleted: false,
				},
			],
		};
		applyThreadUpdate(
			client,
			update("T1", {
				resolved: true,
				commentCount: 2,
				attention: [],
				yourTurn: false,
				comments,
			}),
		);
		for (const stage of ["summary", "full"]) {
			const view = client.getQueryData<ThreadsView>(["threads", "r1", stage]);
			expect(view?.threads[0]).toMatchObject({
				resolved: true,
				commentCount: 2,
				hasReply: true,
				attention: [],
				yourTurn: false,
			});
			expect(view?.threads[1]).toBe(other);
		}
		expect(client.getQueryData(["comments", "r1", "T1"])).toEqual(comments);
	});

	const c = (id: string, body: string, more: Partial<ThreadComment> = {}) =>
		({
			id,
			author: "octo",
			bot: false,
			avatarUrl: "",
			publishedAt: "2026-01-03T12:00:00Z",
			pending: false,
			html: `<p>${body}</p>`,
			body,
			text: body,
			editedAt: null,
			viewerCan: { update: true, delete: true },
			deleted: false,
			...more,
		}) satisfies ThreadComment;

	const seeded = () => {
		const client = new QueryClient();
		client.setQueryData(["overview"], { readId: "r1" } as PrOverview);
		client.setQueryData<ThreadsView>(["threads", "r1", "full"], {
			threads: [
				{ id: "T1", author: "octo", html: "<p>Old</p>", body: "Old" },
				{ id: "T2", author: "x" },
			] as ReviewThread[],
			complete: true,
		});
		client.setQueryData<ThreadComments>(["comments", "r1", "T1"], {
			threadId: "T1",
			comments: [c("c1", "Old"), c("c2", "Reply")],
		});
		return client;
	};

	it("an edit of the opener changes the card's text too; one of a reply doesn't", () => {
		const client = seeded();
		const edited = c("c1", "New", { editedAt: "2026-01-03T13:00:00Z" });
		applyThreadUpdate(
			client,
			update("T1", {
				comment: edited,
				comments: { threadId: "T1", comments: [edited, c("c2", "Reply")] },
			}),
		);
		const t = () =>
			client.getQueryData<ThreadsView>(["threads", "r1", "full"])?.threads[0];
		expect(t()).toMatchObject({
			html: "<p>New</p>",
			body: "New",
			excerpt: "New",
		});
		const reply = c("c2", "Changed");
		applyThreadUpdate(
			client,
			update("T1", {
				comment: reply,
				comments: { threadId: "T1", comments: [edited, reply] },
			}),
		);
		expect(t()?.body).toBe("New");
	});

	it("Show theirs puts GitHub's comment in place", () => {
		const client = seeded();
		applyComment(client, "T1", c("c1", "Theirs"));
		expect(
			client
				.getQueryData<ThreadComments>(["comments", "r1", "T1"])
				?.comments.map((x) => x.body),
		).toEqual(["Theirs", "Reply"]);
		expect(
			client.getQueryData<ThreadsView>(["threads", "r1", "full"])?.threads[0]
				?.body,
		).toBe("Theirs");
	});

	it("a thread gone leaves every list, its comments gone", () => {
		const client = seeded();
		dropThread(client, "T1");
		expect(
			client
				.getQueryData<ThreadsView>(["threads", "r1", "full"])
				?.threads.map((t) => t.id),
		).toEqual(["T2"]);
		expect(client.getQueryData(["comments", "r1", "T1"])).toEqual({
			threadId: "T1",
			comments: [],
			unavailable: "deleted",
		});
	});
});

describe("postReply", () => {
	it("posts to the thread's replies and reads a refusal's code and link", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: "A pending review blocks replies",
						code: "pending-review",
						url: "https://github.com/o/r/pull/1/files",
					}),
					{ status: 409 },
				),
		);
		vi.stubGlobal("fetch", fetch);
		const req = {
			body: "Hi",
			attemptedAt: "x",
			retry: false,
			clientId: "cid",
			knownCommentIds: [],
		};
		const error = await postReply("PRRT_1", req).catch((e: unknown) => e);
		expect(fetch).toHaveBeenCalledWith(
			"/api/threads/PRRT_1/replies",
			expect.objectContaining({ method: "POST", body: JSON.stringify(req) }),
		);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(409);
		expect((error as ApiError).write).toEqual({
			code: "pending-review",
			url: "https://github.com/o/r/pull/1/files",
		});
	});
});

const NEW_TARGET: NewTarget = {
	path: "src/a.ts",
	commit: "head1",
	subject: "file",
};

/** A localStorage of its own, for reloads. */
function memoryStorage(): Storage {
	const data = new Map<string, string>();
	return {
		get length() {
			return data.size;
		},
		clear: () => data.clear(),
		getItem: (k) => data.get(k) ?? null,
		key: (i) => [...data.keys()][i] ?? null,
		removeItem: (k) => {
			data.delete(k);
		},
		setItem: (k, v) => {
			data.set(k, v);
		},
	};
}

describe("refused writes", () => {
	it("each kind refused is listed, kept, and makes leaving ask", async () => {
		const storage = memoryStorage();
		const w = setup(storage);
		w.reply("T1", "A reply");
		w.setResolved("T2", true);
		drafts.setEdit("T3", "c3", "Old", "New");
		w.saveEdit("T3", "c3");
		w.deleteComment("T4", "c4");
		await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS);
		for (const c of [...calls]) c.reject(new ApiError(403, `no ${c.op}`));
		await flush();
		expect(
			w.state().refused.map((f) => [f.threadId, f.key, f.error.message]),
		).toEqual([
			["T1", "reply", "no reply"],
			["T2", "resolve", "no resolve"],
			["T3", "edit:c3", "no edit"],
			["T4", "delete:c4", "no delete"],
		]);
		expect(w.state().lost).toBe(true);
		expect(refusals.get().map((r) => r.key)).toEqual([
			"reply",
			"resolve",
			"edit:c3",
			"delete:c4",
		]);
	});

	it("Retry: listed, retrying, until GitHub takes it; refused again it stays with the new message", async () => {
		const w = setup(memoryStorage());
		w.setResolved("T1", true);
		calls[0]?.reject(new ApiError(403, "first"));
		await flush();
		const at = w.state().refused[0]?.at;
		vi.advanceTimersByTime(1000);
		w.retry("T1", "resolve");
		expect(w.state().refused[0]).toMatchObject({ retrying: true });
		expect(w.state().lost).toBe(true);
		calls[1]?.reject(new ApiError(403, "second"));
		await flush();
		expect(w.state().refused).toHaveLength(1);
		expect(w.state().refused[0]).toMatchObject({
			key: "resolve",
			error: { message: "second" },
			at,
		});
		expect(w.state().refused[0]?.retrying).toBeUndefined();
		expect(refusals.get()[0]?.message).toBe("second");
		w.retry("T1", "resolve");
		calls[2]?.resolve(update("T1", { resolved: true }));
		await flush();
		expect(w.state().refused).toEqual([]);
		expect(w.state().lost).toBe(false);
		expect(refusals.get()).toEqual([]);
	});

	it("Drop settles it at once: out of the list and storage, nothing sent, leaving doesn't ask", async () => {
		const w = setup(memoryStorage());
		drafts.setNew("n1", NEW_TARGET, "A new one");
		w.createThread("n1");
		w.deleteComment("T1", "c1");
		await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS);
		for (const c of [...calls]) c.reject(new ApiError(422, "no"));
		await flush();
		expect(w.state().refused.map((f) => f.key)).toEqual([
			"create",
			"delete:c1",
		]);
		w.drop("new:n1", "create");
		expect(drafts.newThread("n1")).toBeUndefined();
		w.drop("T1", "delete:c1");
		expect(w.state().refused).toEqual([]);
		expect(w.state().lost).toBe(false);
		expect(refusals.get()).toEqual([]);
		// The new thread had no way to go here (refused at once); the delete went once.
		expect(calls).toHaveLength(1);
	});

	it("a reload lists them again, and their Retry works", async () => {
		const storage = memoryStorage();
		let w = setup(storage);
		w.reply("T1", "Still here");
		w.setResolved("T2", true);
		w.deleteComment("T3", "c3");
		await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS);
		for (const c of [...calls]) c.reject(new ApiError(403, "no"));
		await flush();
		// The next page: the same storage, nothing in memory.
		w = setup(storage);
		expect(w.state().refused).toEqual([]);
		w.restore();
		expect(
			w.state().refused.map((f) => [f.threadId, f.action, f.error.message]),
		).toEqual([
			["T1", "Reply", "no"],
			["T2", "Resolve", "no"],
			["T3", "Delete", "no"],
		]);
		expect(w.state().threads.get("T2")?.resolved).toBe(true);
		expect(w.state().lost).toBe(true);
		w.retry("T2", "resolve");
		w.retry("T3", "delete:c3");
		w.retry("T1", "reply");
		expect(calls.map((c) => [c.op, c.req])).toEqual([
			["resolve", { resolved: true }],
			["delete", null],
			["reply", expect.objectContaining({ body: "Still here" })],
		]);
	});

	it("a reload drops a kept refusal whose draft is gone (sent from another tab)", async () => {
		const storage = memoryStorage();
		let w = setup(storage);
		w.reply("T1", "Sent elsewhere");
		calls[0]?.reject(new ApiError(403, "no"));
		await flush();
		drafts.setText("T1", "");
		w = setup(storage);
		w.restore();
		expect(w.state().refused).toEqual([]);
		expect(refusals.get()).toEqual([]);
	});

	it("a Retry of a reply whose box is empty settles it, sending nothing", async () => {
		const w = setup();
		w.reply("T1", "Text");
		calls[0]?.reject(new ApiError(403, "no"));
		await flush();
		drafts.setText("T1", "");
		w.retry("T1", "reply");
		expect(calls).toHaveLength(1);
		expect(w.state().refused).toEqual([]);
	});

	it("one thread keeps each refusal: a refused reply and a refused resolve both listed", async () => {
		const w = setup();
		w.reply("T1", "Text");
		calls[0]?.reject(new ApiError(403, "no reply"));
		await flush();
		w.setResolved("T1", true);
		calls[1]?.reject(new ApiError(403, "no resolve"));
		await flush();
		expect(
			w
				.state()
				.threads.get("T1")
				?.refused.map((f) => f.key),
		).toEqual(["reply", "resolve"]);
		w.retryAll();
		// One thread, one write at a time: the resolve waits for the reply.
		expect(calls.slice(2).map((c) => c.op)).toEqual(["reply"]);
		calls[2]?.resolve(update("T1"));
		await flush();
		expect(calls.slice(2).map((c) => c.op)).toEqual(["reply", "resolve"]);
		expect(w.state().refused.map((f) => f.key)).toEqual(["resolve"]);
	});
});
