import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PrOverview,
	ReplyRequest,
	ResolveRequest,
	ReviewThread,
	ThreadComments,
	ThreadsView,
	ThreadUpdate,
} from "../../shared/types";
import { ApiError, postReply } from "../api";
import {
	DELAYED_MS,
	RETRY_DELAYS_MS,
	STALL_ATTEMPTS,
} from "../files/stateSync";
import { DraftStore } from "./drafts";
import {
	applyThreadUpdate,
	MAX_IN_FLIGHT,
	overlayThreads,
	ThreadWrites,
} from "./threadWrites";

interface Call {
	op: "reply" | "resolve";
	threadId: string;
	req: ReplyRequest | ResolveRequest;
	resolve: (u: ThreadUpdate) => void;
	reject: (e: unknown) => void;
}

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

let calls: Call[];
let applied: ThreadUpdate[];
let drafts: DraftStore;

function setup() {
	calls = [];
	applied = [];
	known = { T1: ["c1", "c2"] };
	ids = 0;
	drafts = new DraftStore(() => undefined);
	const call =
		(op: Call["op"]) =>
		(threadId: string, req: ReplyRequest | ResolveRequest) =>
			new Promise<ThreadUpdate>((resolve, reject) => {
				calls.push({ op, threadId, req, resolve, reject });
			});
	return new ThreadWrites({
		reply: call("reply"),
		resolve: call("resolve"),
		applied: (u) => applied.push(u),
		drafts,
		knownComments: (threadId) => known[threadId] ?? [],
		newId: () => `cid${++ids}`,
	});
}

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
			expect(view?.failed).toMatchObject({
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
		expect(w.state().threads.get("T1")?.failed?.code).toBe("gone");
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
		expect(w.state().threads.get("T1")?.failed).toMatchObject({
			code: "pending-review",
			url: "https://github.com/o/r/pull/1/files",
		});
		expect(w.state().pendingReview).toEqual({
			url: "https://github.com/o/r/pull/1/files",
		});
	});

	it("Retry resends a refused reply from the box, as a retry of its first attempt", async () => {
		const w = setup();
		w.reply("T1", "Fixed");
		calls[0]?.reject(new ApiError(403, "no"));
		await flush();
		drafts.setText("T1", "Fixed, really");
		known.T1 = ["c1", "c2", "c3"];
		w.retry("T1");
		// The same reply: its client id and the comments known when first sent.
		expect(calls[1]?.req).toEqual({
			body: "Fixed, really",
			attemptedAt: "2026-01-03T12:00:00.000Z",
			retry: true,
			clientId: "cid1",
			knownCommentIds: ["c1", "c2"],
		});
		expect(drafts.text("T1")).toBe("");
		expect(w.state().threads.get("T1")?.failed).toBeNull();
	});

	it("a refused resolve keeps its intended state until Retry", async () => {
		const w = setup();
		w.setResolved("T1", true);
		calls[0]?.reject(new ApiError(403, "no"));
		await flush();
		expect(w.state().threads.get("T1")).toMatchObject({
			resolved: true,
			failed: { action: "Resolve" },
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
						action: "Resolve" as const,
						delayed: false,
						waiting: null,
						stalled: null,
						failed: null,
					},
				],
			]),
			pendingReview: null,
			busy: true,
		};
		const out = overlayThreads([a, b], state);
		expect(out[0]?.resolved).toBe(true);
		expect(out[1]).toBe(b);
		const none = [a, b];
		expect(
			overlayThreads(none, { ...state, threads: new Map(), busy: false }),
		).toBe(none);
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
					publishedAt: "2026-01-01T00:00:00Z",
					pending: false,
					html: "",
					body: "Q",
					text: "Q",
				},
				{
					id: "c2",
					author: "octo",
					bot: false,
					publishedAt: "2026-01-03T12:00:00Z",
					pending: false,
					html: "<p>A</p>",
					body: "A",
					text: "A",
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
