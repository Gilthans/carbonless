import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ThreadUpdate,
	VerdictAnswer,
	VerdictEvent,
	VerdictRequest,
} from "../../shared/types";
import { ApiError } from "../api";
import { DELAYED_MS, RETRY_DELAYS_MS } from "../files/stateSync";
import { DraftStore } from "../threads/drafts";
import { RefusalStore } from "../threads/refusals";
import { ThreadWrites, VERDICT_LANE } from "../threads/threadWrites";
import { VerdictStore } from "./verdictDraft";

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

interface Call {
	req: VerdictRequest;
	resolve: (a: VerdictAnswer) => void;
	reject: (e: unknown) => void;
}

const HEAD = "a".repeat(40);
const NEW_HEAD = "c".repeat(40);

let calls: Call[];
let landed: [VerdictAnswer, VerdictEvent][];
let store: VerdictStore;
let refusals: RefusalStore;
let ids: number;
let commit: string;

const never = () => new Promise<ThreadUpdate>(() => {});

/** `storage`: the page's localStorage, kept across "reloads" (a new setup). */
function setup(storage: Storage = memoryStorage()) {
	calls = [];
	landed = [];
	ids = 0;
	commit = HEAD;
	store = new VerdictStore(() => storage);
	store.bind("crb:verdict:o/r#1");
	refusals = new RefusalStore(() => storage);
	refusals.bind("crb:refused:o/r#1");
	const drafts = new DraftStore(() => storage);
	drafts.bind("crb:drafts:o/r#1");
	return new ThreadWrites({
		reply: never,
		resolve: never,
		edit: never,
		remove: never,
		gone: () => {},
		theirs: () => {},
		applied: () => {},
		drafts,
		refusals,
		knownComments: () => [],
		newId: () => `id${++ids}`,
		verdict: (req) =>
			new Promise<VerdictAnswer>((resolve, reject) => {
				calls.push({ req, resolve, reject });
			}),
		verdictLanded: (answer, event) => landed.push([answer, event]),
		verdictDraft: store,
		verdictCommit: () => commit,
	});
}

const answer = (state: VerdictAnswer["review"]["state"]): VerdictAnswer => ({
	review: {
		id: "R1",
		state,
		submittedAt: "2026-01-05T00:00:00Z",
		commitId: HEAD,
		body: "",
	},
});

const flush = () => vi.advanceTimersByTimeAsync(0);

const refusedError = (code: "pending-review" | "forbidden", status = 409) =>
	new ApiError(status, "No", undefined, {
		code,
		...(code === "pending-review"
			? { url: "https://github.com/o/r/pull/1/files" }
			: {}),
	});

describe("ThreadWrites: the verdict", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("sends an approval without a body, and shows it at once until GitHub has it", async () => {
		const w = setup();
		store.setText("kept for later");
		expect(w.submitVerdict("APPROVE", undefined, HEAD)).toBe(true);
		await flush();
		expect(calls.map((c) => c.req)).toEqual([
			{
				clientId: "id1",
				event: "APPROVE",
				commit: HEAD,
				attemptedAt: expect.any(String),
				retry: false,
			},
		]);
		expect(w.state().verdict).toMatchObject({ event: "APPROVE" });
		// Not sent: the message stays where it was.
		expect(store.text()).toBe("kept for later");
		calls[0]?.resolve(answer("APPROVED"));
		await flush();
		expect(landed).toEqual([[answer("APPROVED"), "APPROVE"]]);
		expect(w.state().verdict).toBeNull();
		expect(store.sending()).toBeUndefined();
		expect(w.state().busy).toBe(false);
	});

	it("sends a message with it, taken from the box; never a comment or change request without one", async () => {
		const w = setup();
		expect(w.submitVerdict("COMMENT", "  ", HEAD)).toBe(false);
		expect(w.submitVerdict("REQUEST_CHANGES", undefined, HEAD)).toBe(false);
		await flush();
		expect(calls).toHaveLength(0);
		store.setText("Please fix");
		expect(w.submitVerdict("REQUEST_CHANGES", "Please fix", HEAD)).toBe(true);
		await flush();
		expect(calls[0]?.req).toMatchObject({
			event: "REQUEST_CHANGES",
			body: "Please fix",
		});
		expect(store.text()).toBe("");
		expect(store.sending()?.body).toBe("Please fix");
	});

	it("posts one review for a double press, or a second verdict while the first is out", async () => {
		const w = setup();
		expect(w.submitVerdict("APPROVE", undefined, HEAD)).toBe(true);
		expect(w.submitVerdict("APPROVE", undefined, HEAD)).toBe(false);
		await flush();
		expect(w.submitVerdict("REQUEST_CHANGES", "no", HEAD)).toBe(false);
		await flush();
		expect(calls).toHaveLength(1);
		calls[0]?.resolve(answer("APPROVED"));
		await flush();
		// Settled: the next press is a new verdict.
		expect(w.submitVerdict("COMMENT", "also", HEAD)).toBe(true);
		await flush();
		expect(calls).toHaveLength(2);
	});

	it("retries a transient failure with the same client id and retry: true", async () => {
		const w = setup();
		w.submitVerdict("APPROVE", undefined, HEAD);
		await flush();
		calls[0]?.reject(new ApiError(502, "Bad gateway"));
		await flush();
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] ?? 0);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.req).toMatchObject({
			clientId: "id1",
			retry: true,
			attemptedAt: calls[0]?.req.attemptedAt,
		});
		// Delayed past 5 s: the yellow notice.
		await vi.advanceTimersByTimeAsync(DELAYED_MS);
		expect(w.state().threads.get(VERDICT_LANE)).toMatchObject({
			action: "Verdict",
			delayed: true,
		});
	});

	it("resends a verdict a reload cut short, with retry: true and the same client id", async () => {
		const storage = memoryStorage();
		const first = setup(storage);
		store.setText("Looks good");
		first.submitVerdict("APPROVE", "Looks good", HEAD);
		await flush();
		expect(calls).toHaveLength(1);
		// Reload: a new page over the same storage; nothing sent until resume().
		const again = setup(storage);
		await flush();
		expect(calls).toHaveLength(0);
		expect(again.state().verdict).toBeNull();
		again.resume();
		await flush();
		expect(calls.map((c) => c.req)).toEqual([
			{
				clientId: "id1",
				event: "APPROVE",
				body: "Looks good",
				commit: HEAD,
				attemptedAt: expect.any(String),
				retry: true,
			},
		]);
		expect(again.state().verdict).toMatchObject({ event: "APPROVE" });
		expect(again.state().threads.get(VERDICT_LANE)?.resumed).toBe(true);
		calls[0]?.resolve(answer("APPROVED"));
		await flush();
		expect(store.sending()).toBeUndefined();
	});

	it("lets a resent one be discarded: nothing more is sent", async () => {
		const storage = memoryStorage();
		setup(storage);
		store.setSending({
			clientId: "old",
			event: "APPROVE",
			commit: HEAD,
			attemptedAt: "2026-01-01T00:00:00Z",
			sentOnce: true,
		});
		const w = setup(storage);
		w.resume();
		await flush();
		calls[0]?.reject(new ApiError(0, "down"));
		await flush();
		w.discardResumed(VERDICT_LANE);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(1);
		expect(store.sending()).toBeUndefined();
		expect(w.state().verdict).toBeNull();
	});

	it("lists a refusal as Verdict with its event and message; Retry posts that again, not the box", async () => {
		const w = setup();
		store.setText("Fix it");
		w.submitVerdict("REQUEST_CHANGES", "Fix it", HEAD);
		await flush();
		calls[0]?.reject(refusedError("pending-review"));
		await flush();
		expect(w.state().refused).toEqual([
			expect.objectContaining({
				threadId: VERDICT_LANE,
				key: "verdict",
				action: "Verdict",
				event: "REQUEST_CHANGES",
				body: "Fix it",
				code: "pending-review",
			}),
		]);
		expect(w.state().pendingReview).toEqual({
			url: "https://github.com/o/r/pull/1/files",
		});
		expect(w.state().lost).toBe(true);
		expect(w.state().verdict).toBeNull();
		expect(store.sending()).toBeUndefined();
		// Kept across a reload, with its event and message.
		expect(refusals.get()[0]).toMatchObject({
			event: "REQUEST_CHANGES",
			body: "Fix it",
		});
		// Typed since: not what the Retry sends.
		store.setText("Something else");
		commit = NEW_HEAD;
		w.retry(VERDICT_LANE, "verdict");
		await flush();
		expect(calls[1]?.req).toMatchObject({
			clientId: "id2",
			event: "REQUEST_CHANGES",
			body: "Fix it",
			commit: NEW_HEAD,
			retry: false,
		});
		expect(store.text()).toBe("Something else");
		expect(w.state().refused[0]?.retrying).toBe(true);
		calls[1]?.resolve(answer("CHANGES_REQUESTED"));
		await flush();
		expect(w.state().refused).toEqual([]);
		expect(refusals.get()).toEqual([]);
		expect(w.state().pendingReview).toBeNull();
	});

	it("retries a refused approval without a message when the box was off, whatever the box holds", async () => {
		const w = setup();
		// Ticked, typed, unticked: the text stays in the draft, not sent.
		store.setText("nit: rename x");
		w.submitVerdict("APPROVE", undefined, HEAD);
		await flush();
		expect(calls[0]?.req.body).toBeUndefined();
		calls[0]?.reject(refusedError("forbidden", 403));
		await flush();
		w.retry(VERDICT_LANE, "verdict");
		await flush();
		expect(calls[1]?.req).toMatchObject({ event: "APPROVE" });
		expect(calls[1]?.req.body).toBeUndefined();
		expect(store.text()).toBe("nit: rename x");
	});

	it("drops a refused verdict and its message; nothing is sent", async () => {
		const w = setup();
		w.submitVerdict("COMMENT", "Hmm", HEAD);
		await flush();
		calls[0]?.reject(refusedError("forbidden", 403));
		await flush();
		store.setText("typed since");
		w.drop(VERDICT_LANE, "verdict");
		expect(w.state().refused).toEqual([]);
		expect(refusals.get()).toEqual([]);
		// The box's newer text is the reviewer's, not the refusal's.
		expect(store.text()).toBe("typed since");
		expect(w.state().lost).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it("settles a refusal whose Retry a reload cut short, once the resend lands: no second review", async () => {
		const storage = memoryStorage();
		const first = setup(storage);
		first.submitVerdict("APPROVE", undefined, HEAD);
		await flush();
		calls[0]?.reject(refusedError("forbidden", 403));
		await flush();
		first.retry(VERDICT_LANE, "verdict");
		await flush();
		expect(calls).toHaveLength(2);
		const retried = calls[1]?.req.clientId;
		// Reload while the Retry is out.
		const w = setup(storage);
		w.restore();
		w.resume();
		await flush();
		expect(calls.map((c) => c.req)).toEqual([
			expect.objectContaining({ clientId: retried, retry: true }),
		]);
		// Listed as retrying meanwhile: no Retry to press.
		const f = w.state().refused[0];
		expect(f?.retrying).toBe(true);
		expect(f && w.sendable(VERDICT_LANE, f)).toBe(false);
		calls[0]?.resolve(answer("APPROVED"));
		await flush();
		expect(w.state().refused).toEqual([]);
		expect(refusals.get()).toEqual([]);
		expect(w.state().lost).toBe(false);
		w.retry(VERDICT_LANE, "verdict");
		w.retryAll();
		await flush();
		expect(calls).toHaveLength(1);
	});

	it("keeps a refused verdict's message when a new press supersedes it", async () => {
		const w = setup();
		w.submitVerdict("REQUEST_CHANGES", "Please add tests", HEAD);
		await flush();
		calls[0]?.reject(refusedError("pending-review"));
		await flush();
		// The box is empty: the message lives on the refusal.
		expect(store.text()).toBe("");
		expect(w.submitVerdict("APPROVE", undefined, HEAD)).toBe(true);
		await flush();
		// Superseded: no Retry left to post a second review…
		expect(w.state().refused).toEqual([]);
		expect(refusals.get()).toEqual([]);
		// …and the message is back in the box, not sent with the approval.
		expect(store.text()).toBe("Please add tests");
		expect(calls[1]?.req.event).toBe("APPROVE");
		expect(calls[1]?.req.body).toBeUndefined();
	});

	it("puts a superseded message after other text, once", async () => {
		const w = setup();
		w.submitVerdict("COMMENT", "First thought", HEAD);
		await flush();
		calls[0]?.reject(refusedError("forbidden", 403));
		await flush();
		store.setText("Typed since");
		w.submitVerdict("APPROVE", undefined, HEAD);
		expect(store.text()).toBe("Typed since\n\nFirst thought");
		// The same text already there: left as is.
		const again = setup();
		again.submitVerdict("COMMENT", "Same", HEAD);
		await flush();
		calls[0]?.reject(refusedError("forbidden", 403));
		await flush();
		store.setText("Same");
		again.submitVerdict("APPROVE", undefined, HEAD);
		expect(store.text()).toBe("Same");
		// Pressed with that same message: sent, not put back.
		const resent = setup();
		resent.submitVerdict("COMMENT", "Once", HEAD);
		await flush();
		calls[0]?.reject(refusedError("forbidden", 403));
		await flush();
		store.setText("Once");
		resent.submitVerdict("COMMENT", "Once", HEAD);
		expect(store.text()).toBe("");
	});

	it("lets a discarded resend of a Retry go: the refusal can be retried or dropped again", async () => {
		const storage = memoryStorage();
		const first = setup(storage);
		first.submitVerdict("COMMENT", "Hmm", HEAD);
		await flush();
		calls[0]?.reject(refusedError("forbidden", 403));
		await flush();
		first.retry(VERDICT_LANE, "verdict");
		await flush();
		const w = setup(storage);
		w.restore();
		w.resume();
		await flush();
		calls[0]?.reject(new ApiError(502, "Bad gateway"));
		await flush();
		expect(w.state().refused[0]?.retrying).toBe(true);
		w.discardResumed(VERDICT_LANE);
		const f = w.state().refused[0];
		expect(f?.retrying).toBeUndefined();
		expect(w.state().lost).toBe(true);
		expect(f && w.sendable(VERDICT_LANE, f)).toBe(true);
		w.retry(VERDICT_LANE, "verdict");
		await flush();
		expect(calls[1]?.req).toMatchObject({ event: "COMMENT", body: "Hmm" });
		calls[1]?.reject(refusedError("forbidden", 403));
		await flush();
		w.drop(VERDICT_LANE, "verdict");
		expect(w.state().refused).toEqual([]);
		expect(w.state().lost).toBe(false);
	});

	it("restores a refused verdict after a reload, and an approval retries without a message", async () => {
		const storage = memoryStorage();
		const first = setup(storage);
		first.submitVerdict("APPROVE", undefined, HEAD);
		await flush();
		calls[0]?.reject(refusedError("forbidden", 403));
		await flush();
		const w = setup(storage);
		w.restore();
		expect(w.state().refused).toEqual([
			expect.objectContaining({ action: "Verdict", event: "APPROVE" }),
		]);
		w.retry(VERDICT_LANE, "verdict");
		await flush();
		expect(calls[0]?.req).toMatchObject({ event: "APPROVE", retry: false });
		expect(calls[0]?.req.body).toBeUndefined();
	});
});
