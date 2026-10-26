import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ClusterView,
	FileView,
	ReviewView,
	StateChange,
} from "../../shared/types";
import { ApiError } from "../api";
import {
	DELAYED_MS,
	describePending,
	isTransient,
	MAX_CHANGES,
	overlayReview,
	pendingFiles,
	RETRY_DELAYS_MS,
	StateSync,
	type SyncDeps,
} from "./stateSync";

const cluster = (
	key: string,
	over: Partial<ClusterView> = {},
): ClusterView => ({
	key,
	kind: "lines",
	oldStart: 1,
	oldCount: 1,
	newStart: 1,
	newCount: 1,
	removed: ["a"],
	added: ["b"],
	lines: 2,
	state: "unreviewed",
	...over,
});

const file = (path: string, clusters: ClusterView[]): FileView => ({
	index: 0,
	path,
	status: "modified",
	binary: false,
	submodule: false,
	additions: 1,
	deletions: 1,
	clusters,
	done: false,
	reviewed: false,
	crossedOff: false,
});

const view = (files: FileView[], revision = "r1"): ReviewView => ({
	revision,
	patchset: 1,
	files,
	progress: {
		clusters: { total: 0, reviewed: 0, crossedOff: 0 },
		lines: { total: 0, reviewed: 0, crossedOff: 0 },
		files: { total: 0, reviewed: 0, crossedOff: 0, done: 0 },
	},
});

interface Call {
	revision: string;
	changes: StateChange[];
	resolve: (view: unknown) => void;
	reject: (error: unknown) => void;
}

function harness() {
	const calls: Call[] = [];
	const stored: ReviewView[] = [];
	const deps: SyncDeps = {
		post: (revision, changes) =>
			new Promise((resolve, reject) => {
				calls.push({
					revision,
					changes,
					resolve: resolve as (view: unknown) => void,
					reject,
				});
			}),
		stored: (v) => {
			stored.push(v);
		},
		staled: vi.fn(),
		failed: vi.fn(),
	};
	const sync = new StateSync(deps);
	const flush = () => vi.advanceTimersByTimeAsync(0);
	return { sync, calls, stored, deps, flush };
}

const ok = view([file("a.ts", [cluster("k1")])]);
const set = (key: string, state: StateChange["state"]): StateChange => ({
	key,
	state,
});

describe("StateSync", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("holds the intended state at once and clears it once stored", async () => {
		const { sync, calls, stored, flush } = harness();
		const done = vi.fn();
		void sync.apply("r1", "a.ts", [set("k1", "reviewed")]).then(done);
		expect(sync.getState().pending.get("k1")?.change.state).toBe("reviewed");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.changes).toEqual([set("k1", "reviewed")]);
		calls[0]?.resolve(ok);
		await flush();
		expect(stored).toEqual([ok]);
		expect(sync.getState().pending.size).toBe(0);
		expect(done).toHaveBeenCalled();
	});

	it("writes one at a time, in order, coalescing what queued behind", async () => {
		const { sync, calls, flush } = harness();
		void sync.apply("r1", "a.ts", [set("k1", "reviewed")]);
		void sync.apply("r1", "a.ts", [set("k2", "reviewed")]);
		void sync.apply("r1", "a.ts", [set("k2", "crossed-off")]);
		expect(calls).toHaveLength(1);
		calls[0]?.resolve(ok);
		await flush();
		expect(calls).toHaveLength(2);
		expect(calls[1]?.changes).toEqual([set("k2", "crossed-off")]);
	});

	it("keeps a newer change over an older write's answer", async () => {
		const { sync, calls, flush } = harness();
		void sync.apply("r1", "a.ts", [set("k1", "reviewed")]);
		// Undone while the first write is out.
		void sync.apply("r1", "a.ts", [set("k1", "unreviewed")]);
		calls[0]?.resolve(
			view([file("a.ts", [cluster("k1", { state: "reviewed" })])]),
		);
		await flush();
		const pending = sync.getState().pending;
		expect(pending.get("k1")?.change.state).toBe("unreviewed");
		expect(calls[1]?.changes).toEqual([set("k1", "unreviewed")]);
		calls[1]?.resolve(ok);
		await flush();
		expect(sync.getState().pending.size).toBe(0);
	});

	it("splits a large batch into requests of at most MAX_CHANGES", async () => {
		const { sync, calls, flush } = harness();
		const changes = Array.from({ length: 2500 }, (_, i) =>
			set(`k${i}`, "reviewed"),
		);
		void sync.apply("r1", "a.ts", changes);
		for (let i = 0; i < 3; i++) {
			calls[i]?.resolve(ok);
			await flush();
		}
		expect(calls.map((c) => c.changes.length)).toEqual([
			MAX_CHANGES,
			MAX_CHANGES,
			500,
		]);
		expect(calls.flatMap((c) => c.changes)).toEqual(changes);
	});

	it.each([
		[0, "Could not reach carbonless"],
		[408, "timeout"],
		[429, "slow down"],
		[500, "boom"],
		[503, "unavailable"],
	])(
		"retries a %s with backoff, the delayed notice covering the wait",
		async (status, message) => {
			const { sync, calls, flush } = harness();
			void sync.apply("r1", "a.ts", [set("k1", "reviewed")]);
			calls[0]?.reject(new ApiError(status, message));
			await flush();
			expect(sync.getState().failure).toBeNull();
			await vi.advanceTimersByTimeAsync((RETRY_DELAYS_MS[0] ?? 0) - 1);
			expect(calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(calls).toHaveLength(2);
			calls[1]?.reject(new ApiError(status, message));
			await flush();
			await vi.advanceTimersByTimeAsync((RETRY_DELAYS_MS[1] ?? 0) - 1);
			expect(calls).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(calls).toHaveLength(3);
			// Still waiting after 5 s in all: the notice shows.
			expect(sync.getState().delayed).toBe(false);
			await vi.advanceTimersByTimeAsync(DELAYED_MS);
			expect(sync.getState().delayed).toBe(true);
			expect(sync.getState().failure).toBeNull();
			calls[2]?.resolve(ok);
			await flush();
			expect(sync.getState()).toMatchObject({ delayed: false, failure: null });
			expect(sync.getState().pending.size).toBe(0);
		},
	);

	it("caps the backoff", async () => {
		const { sync, calls, flush } = harness();
		void sync.apply("r1", "a.ts", [set("k1", "reviewed")]);
		for (let i = 0; i < RETRY_DELAYS_MS.length + 3; i++) {
			calls[i]?.reject(new ApiError(502, "bad gateway"));
			await flush();
			await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS.at(-1) ?? 0);
		}
		expect(calls).toHaveLength(RETRY_DELAYS_MS.length + 4);
	});

	it("shows the delayed notice after 5 s and drops it once stored", async () => {
		const { sync, calls, flush } = harness();
		const seen = vi.fn();
		sync.subscribe(() => seen(sync.getState().delayed));
		void sync.apply("r1", "a.ts", [set("k1", "reviewed")]);
		await vi.advanceTimersByTimeAsync(DELAYED_MS - 1);
		expect(sync.getState().delayed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(sync.getState().delayed).toBe(true);
		expect(seen).toHaveBeenLastCalledWith(true);
		calls[0]?.resolve(ok);
		await flush();
		expect(sync.getState().delayed).toBe(false);
	});

	it("keeps a change after an unknown error until retry, which resends the intended state", async () => {
		const { sync, calls, deps, flush } = harness();
		const failed = vi.fn();
		void sync.apply("r1", "a.ts", [set("k1", "reviewed")]).catch(failed);
		calls[0]?.reject(new ApiError(400, "Unknown state: nope"));
		await flush();
		expect(sync.getState().failure?.message).toBe("Unknown state: nope");
		expect(sync.getState().pending.get("k1")?.change.state).toBe("reviewed");
		expect(failed).toHaveBeenCalled();
		expect(deps.failed).toHaveBeenCalled();
		// Nothing more is sent by itself, even for a new change.
		void sync.apply("r1", "a.ts", [set("k2", "reviewed")]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(1);
		sync.retry();
		expect(sync.getState().failure).toBeNull();
		expect(calls[1]?.changes).toEqual([
			set("k1", "reviewed"),
			set("k2", "reviewed"),
		]);
		calls[1]?.resolve(ok);
		await flush();
		expect(sync.getState().pending.size).toBe(0);
	});

	it("treats a malformed answer as an unknown error", async () => {
		const { sync, calls, stored, flush } = harness();
		void sync.apply("r1", "a.ts", [set("k1", "reviewed")]);
		calls[0]?.resolve({ nope: true });
		await flush();
		expect(sync.getState().failure?.name).toBe("MalformedAnswerError");
		expect(stored).toEqual([]);
		expect(sync.getState().pending.size).toBe(1);
	});

	it("drops the old revision's changes on a 409 and reports it", async () => {
		const { sync, calls, deps, flush } = harness();
		const rejected = vi.fn();
		void sync.apply("r1", "a.ts", [set("k1", "reviewed")]).catch(rejected);
		void sync.apply("r1", "a.ts", [set("k2", "reviewed")]).catch(rejected);
		calls[0]?.reject(new ApiError(409, "stale"));
		await flush();
		expect(sync.getState().pending.size).toBe(0);
		expect(sync.getState().stale).toEqual({ dropped: 2 });
		expect(sync.getState().failure).toBeNull();
		expect(deps.staled).toHaveBeenCalled();
		expect(rejected).toHaveBeenCalledTimes(2);
		expect(calls).toHaveLength(1);
		// A later stored write clears it.
		void sync.apply("r2", "a.ts", [set("k3", "reviewed")]);
		calls[1]?.resolve(ok);
		await flush();
		expect(sync.getState().stale).toBeNull();
	});

	it("keeps changes made on the new revision through a 409 for the old one", async () => {
		const { sync, calls, flush } = harness();
		void sync.apply("r1", "a.ts", [set("k1", "reviewed")]);
		void sync.apply("r2", "a.ts", [set("k9", "reviewed")]);
		calls[0]?.reject(new ApiError(409, "stale"));
		await flush();
		expect([...sync.getState().pending.keys()]).toEqual(["k9"]);
		expect(calls[1]).toMatchObject({ revision: "r2" });
	});

	it("classifies transient failures", () => {
		expect(isTransient(new ApiError(0, ""))).toBe(true);
		expect(isTransient(new ApiError(504, ""))).toBe(true);
		expect(isTransient(new ApiError(400, ""))).toBe(false);
		expect(isTransient(new ApiError(404, ""))).toBe(false);
		expect(isTransient(new Error("x"))).toBe(false);
	});
});

describe("describePending", () => {
	const sync = () =>
		new StateSync({
			post: () => new Promise(() => {}),
			stored: () => {},
			staled: () => {},
			failed: () => {},
		});
	it("names one change and its file, else counts", () => {
		const one = sync();
		void one.apply("r1", "src/a.ts", [set("k1", "crossed-off")]);
		expect(describePending(one.getState().pending)).toBe(
			"Crossed off · src/a.ts",
		);
		void one.apply("r1", "src/a.ts", [set("k2", "reviewed")]);
		expect(describePending(one.getState().pending)).toBe(
			"2 changes · src/a.ts",
		);
		void one.apply("r1", "src/b.ts", [set("k3", "reviewed")]);
		expect(describePending(one.getState().pending)).toBe(
			"3 changes in 2 files",
		);
		expect(pendingFiles(one.getState().pending)).toBe("src/a.ts, src/b.ts");
		for (const name of ["c", "d", "e"]) {
			void one.apply("r1", `src/${name}.ts`, [set(name, "reviewed")]);
		}
		expect(pendingFiles(one.getState().pending)).toBe(
			"src/a.ts, src/b.ts, src/c.ts +2",
		);
	});
});

describe("overlayReview", () => {
	const pendingOf = (
		revision: string,
		changes: StateChange[],
	): ReturnType<StateSync["getState"]>["pending"] =>
		new Map(
			changes.map((change, i) => [
				change.key,
				{ change, revision, path: "a.ts", version: i, since: 0 },
			]),
		);

	it("lays intended states over the view and counts progress again", () => {
		const base = view([
			file("a.ts", [cluster("k1"), cluster("k2", { lines: 3 })]),
			file("b.ts", [cluster("k3")]),
		]);
		const shown = overlayReview(
			base,
			pendingOf("r1", [set("k1", "reviewed"), set("k2", "crossed-off")]),
		);
		expect(shown.files[0]?.clusters.map((c) => c.state)).toEqual([
			"reviewed",
			"crossed-off",
		]);
		expect(shown.files[0]).toMatchObject({
			done: true,
			reviewed: false,
			crossedOff: false,
		});
		// Untouched files keep their identity.
		expect(shown.files[1]).toBe(base.files[1]);
		expect(shown.progress).toEqual({
			clusters: { total: 3, reviewed: 1, crossedOff: 1 },
			lines: { total: 7, reviewed: 2, crossedOff: 3 },
			files: { total: 2, reviewed: 0, crossedOff: 1, done: 1 },
		});
	});

	it("drops a crossed-off reason when a cluster is undone", () => {
		const base = view([
			file("a.ts", [cluster("k1", { state: "crossed-off", reason: "gen" })]),
		]);
		const shown = overlayReview(
			base,
			pendingOf("r1", [set("k1", "unreviewed")]),
		);
		expect(shown.files[0]?.clusters[0]).not.toHaveProperty("reason");
		expect(shown.files[0]?.clusters[0]?.state).toBe("unreviewed");
	});

	it("ignores changes made on another revision", () => {
		const base = view([file("a.ts", [cluster("k1")])], "r2");
		expect(overlayReview(base, pendingOf("r1", [set("k1", "reviewed")]))).toBe(
			base,
		);
	});

	it("never marks a key two clusters share (principle 2)", () => {
		const base = view([
			file("a.ts", [cluster("dup")]),
			file("b.ts", [cluster("dup")]),
		]);
		const shown = overlayReview(
			base,
			pendingOf("r1", [set("dup", "reviewed")]),
		);
		expect(shown.files.flatMap((f) => f.clusters.map((c) => c.state))).toEqual([
			"unreviewed",
			"unreviewed",
		]);
	});

	it("ignores keys that aren't in the view", () => {
		const base = view([file("a.ts", [cluster("k1")])]);
		expect(overlayReview(base, pendingOf("r1", [set("zz", "reviewed")]))).toBe(
			base,
		);
	});
});
