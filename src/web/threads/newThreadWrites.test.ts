import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	NewThreadAnswer,
	NewThreadRequest,
	PrOverview,
	ReviewThread,
	ThreadComments,
	ThreadsView,
	ThreadUpdate,
} from "../../shared/types";
import { ApiError } from "../api";
import { RETRY_DELAYS_MS } from "../files/stateSync";
import { DraftStore, type NewTarget, newThreadKey } from "./drafts";
import { addThread, ThreadWrites } from "./threadWrites";

/** An in-memory Storage. */
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

const TARGET: NewTarget = {
	path: "src/a.ts",
	commit: "head1",
	subject: "line",
	startSide: "RIGHT",
	startLine: 3,
	side: "RIGHT",
	line: 3,
	startCol: 4,
	endCol: 9,
};

interface Call {
	req: NewThreadRequest;
	resolve: (a: NewThreadAnswer) => void;
	reject: (e: unknown) => void;
}

let calls: Call[];
let created: NewThreadAnswer[];
let posted: number;
let drafts: DraftStore;

const never = () => new Promise<ThreadUpdate>(() => {});

function setup(store = new DraftStore(() => undefined)) {
	calls = [];
	created = [];
	posted = 0;
	drafts = store;
	return new ThreadWrites({
		reply: never,
		resolve: never,
		edit: never,
		remove: never,
		gone: () => {},
		theirs: () => {},
		applied: () => {},
		drafts,
		knownComments: () => [],
		posted: () => {
			posted++;
		},
		create: (req) =>
			new Promise((resolve, reject) => calls.push({ req, resolve, reject })),
		created: (a) => created.push(a),
	});
}

const thread = (id: string): ReviewThread =>
	({
		id,
		path: "src/a.ts",
		line: 3,
		commit: "head1",
		subject: "line",
		resolved: false,
	}) as ReviewThread;

const answer = (id = "T9"): NewThreadAnswer => ({
	thread: thread(id),
	comments: { threadId: id, comments: [] },
});

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-03T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("new thread drafts", () => {
	it("is kept from the first keystroke, restored by a reload, and blank is nothing", () => {
		const storage = memoryStorage();
		const a = new DraftStore(() => storage);
		a.bind("k");
		a.setNew("c1", TARGET, "");
		expect(a.get()).toEqual([]);
		a.setNew("c1", TARGET, "W");
		const b = new DraftStore(() => storage);
		b.bind("k");
		expect(b.newThread("c1")).toMatchObject({
			threadId: newThreadKey("c1"),
			text: "W",
			create: { ...TARGET, clientId: "c1" },
		});
		b.setNew("c1", TARGET, "  ");
		expect(b.get()).toEqual([]);
	});

	it("drops a stored new draft it can't read (no lines for a line comment)", () => {
		const storage = memoryStorage();
		storage.setItem(
			"k",
			JSON.stringify([
				{
					threadId: "new:c1",
					text: "x",
					create: {
						clientId: "c1",
						path: "a",
						commit: "h",
						subject: "line",
						createdAt: "t",
					},
				},
				{
					threadId: "new:c2",
					text: "y",
					create: {
						clientId: "c2",
						path: "a",
						commit: "h",
						subject: "file",
						createdAt: "t",
					},
				},
			]),
		);
		const s = new DraftStore(() => storage);
		s.bind("k");
		expect(s.get().map((d) => d.threadId)).toEqual(["new:c2"]);
	});

	it("isn't anyone's reply box", () => {
		const s = new DraftStore(() => undefined);
		s.setNew("c1", TARGET, "W");
		expect(s.text(newThreadKey("c1"))).toBe("");
	});
});

describe("ThreadWrites: new threads", () => {
	it("posts the draft with its span, shows it as sending, and lists the answer", async () => {
		const w = setup();
		drafts.setNew("c1", TARGET, "Why trim?");
		w.createThread("c1");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.req).toEqual({
			...TARGET,
			clientId: "c1",
			body: "Why trim?",
			attemptedAt: "2026-01-03T12:00:00.000Z",
			retry: false,
		});
		expect(drafts.newThread("c1")?.create?.sending).toMatchObject({
			sentOnce: true,
		});
		expect(w.state().threads.get("new:c1")?.action).toBe("New comment");
		calls[0]?.resolve(answer());
		await flush();
		expect(created.map((a) => a.thread.id)).toEqual(["T9"]);
		expect(drafts.get()).toEqual([]);
		expect(w.state().threads.size).toBe(0);
		expect(posted).toBe(1);
	});

	it("never sends a blank one, nor one already on its way", () => {
		const w = setup();
		w.createThread("nothing");
		drafts.setNew("c1", TARGET, "x");
		w.createThread("c1");
		w.createThread("c1");
		expect(calls).toHaveLength(1);
	});

	it("a file comment goes without lines", () => {
		const w = setup();
		drafts.setNew(
			"c2",
			{ path: "img.png", commit: "head1", subject: "file" },
			"2x?",
		);
		w.createThread("c2");
		expect(calls[0]?.req).toEqual({
			path: "img.png",
			commit: "head1",
			subject: "file",
			clientId: "c2",
			body: "2x?",
			attemptedAt: "2026-01-03T12:00:00.000Z",
			retry: false,
		});
	});

	it("retries a transient failure with backoff, asking GitHub first", async () => {
		const w = setup();
		drafts.setNew("c1", TARGET, "x");
		w.createThread("c1");
		calls[0]?.reject(new ApiError(502, "Bad gateway"));
		await flush();
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] ?? 0);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.req).toMatchObject({
			clientId: "c1",
			retry: true,
			attemptedAt: "2026-01-03T12:00:00.000Z",
		});
	});

	it.each([
		["pending-review", 409, "https://github.com/o/r/pull/1/files"],
		["gone", 404, undefined],
		["stale", 409, undefined],
		["invalid", 400, undefined],
	] as const)(
		"a %s refusal is red, the draft back in its box",
		async (code, status, url) => {
			const w = setup();
			drafts.setNew("c1", TARGET, "Keep me");
			w.createThread("c1");
			calls[0]?.reject(
				new ApiError(status, "no", undefined, {
					code,
					...(url ? { url } : {}),
				}),
			);
			await flush();
			const view = w.state().threads.get("new:c1");
			expect(view?.failed).toMatchObject({ action: "New comment", code });
			expect(drafts.newThread("c1")).toMatchObject({ text: "Keep me" });
			expect(drafts.newThread("c1")?.create?.sending).toBeUndefined();
			expect(w.state().pendingReview).toEqual(url ? { url } : null);
			// Retry sends it again (looking first), the same client id.
			w.retry("new:c1");
			expect(calls[1]?.req).toMatchObject({ clientId: "c1", retry: true });
		},
	);

	it("one left sending by a reload is resent, looked for first", () => {
		const storage = memoryStorage();
		const before = new DraftStore(() => storage);
		before.bind("k");
		before.setNew("c1", TARGET, "x");
		before.markNewSending("c1", "2026-01-03T11:59:00.000Z");
		before.markNewSent("c1");
		const after = new DraftStore(() => storage);
		after.bind("k");
		const w = setup(after);
		w.resume();
		expect(calls[0]?.req).toMatchObject({
			clientId: "c1",
			retry: true,
			attemptedAt: "2026-01-03T11:59:00.000Z",
		});
		expect(w.state().threads.get("new:c1")?.resumed).toBe(true);
	});

	it("discarding drops the draft; one out isn't sent again", async () => {
		const w = setup();
		drafts.setNew("c1", TARGET, "x");
		w.createThread("c1");
		w.discard("new:c1");
		expect(drafts.get()).toEqual([]);
		calls[0]?.reject(new ApiError(502, "Bad gateway"));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(1);
		expect(w.state().threads.size).toBe(0);
	});
});

describe("addThread", () => {
	it("lists the new thread first in every read's lists, once, with its comments", () => {
		const client = new QueryClient();
		client.setQueryData(["overview"], { readId: "r1" } as PrOverview);
		const view: ThreadsView = { threads: [thread("T1")], complete: true };
		client.setQueryData(["threads", "r1", "summary"], view);
		client.setQueryData(["threads", "r1", "full"], view);
		addThread(client, answer());
		addThread(client, answer());
		for (const stage of ["summary", "full"]) {
			const v = client.getQueryData<ThreadsView>(["threads", "r1", stage]);
			expect(v?.threads.map((t) => t.id)).toEqual(["T9", "T1"]);
		}
		expect(
			client.getQueryData<ThreadComments>(["comments", "r1", "T9"]),
		).toEqual({ threadId: "T9", comments: [] });
	});
});
