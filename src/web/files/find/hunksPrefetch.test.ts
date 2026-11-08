// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FileHunks,
	type FileView,
	HUNKS_BATCH,
	type HunksBatch,
} from "../../../shared/types";
import { ApiError, HUNKS_KEPT_MS, hunksQuery } from "../../api";
import { newQueryClient } from "../../queryClient";
import {
	HUNKS_IN_FLIGHT,
	HunksPrefetcher,
	prefetchOrder,
} from "./hunksPrefetch";

const hunks = (tag: string) => ({ tag }) as unknown as FileHunks;
const nums = (from: number, n: number) =>
	Array.from({ length: n }, (_, i) => from + i);

interface Call {
	indexes: readonly number[];
	resolve: (answer: HunksBatch) => void;
	reject: (error: unknown) => void;
}

let client: QueryClient;
let calls: Call[];
const fetchBatch = vi.fn(
	(_revision: string, indexes: readonly number[]) =>
		new Promise<HunksBatch>((resolve, reject) => {
			calls.push({ indexes, resolve, reject });
		}),
);
const prefetcher = () => new HunksPrefetcher(client, "r", fetchBatch);
/** Lets the prefetcher's awaits after a settled promise run. */
const settle = () => new Promise<void>((r) => queueMicrotask(r));
const flushAll = async () => {
	for (let i = 0; i < 5; i++) await settle();
};

beforeEach(() => {
	client = newQueryClient();
	calls = [];
	fetchBatch.mockClear();
});

describe("prefetchOrder", () => {
	const file = (index: number, extra: Partial<FileView> = {}) =>
		({ index, binary: false, submodule: false, ...extra }) as FileView;
	const files = [file(5), file(2), file(8, { binary: true }), file(1), file(9)];

	it("orders files outward from the open one, leaving binary and submodule files out", () => {
		expect(prefetchOrder(files, 8)).toEqual([1, 2, 9, 5]);
		expect(prefetchOrder(files, null)).toEqual([5, 2, 1, 9]);
		expect(
			prefetchOrder([file(0), file(1, { submodule: true }), file(2)], null),
		).toEqual([0, 2]);
	});
});

describe("HunksPrefetcher", () => {
	it("sends HUNKS_BATCH files a request, two requests at a time, in the order queued", async () => {
		const p = prefetcher();
		p.queue(nums(0, 60));
		expect(HUNKS_IN_FLIGHT).toBe(2);
		expect(calls.map((c) => c.indexes)).toEqual([
			nums(0, HUNKS_BATCH),
			nums(25, 25),
		]);
		expect(p.snapshot().pending).toBe(60);
		calls[0]?.resolve({ files: [] });
		await flushAll();
		expect(calls).toHaveLength(3);
		expect(calls[2]?.indexes).toEqual(nums(50, 10));
		expect(p.snapshot().pending).toBe(35);
		calls[1]?.resolve({ files: [] });
		await flushAll();
		expect(calls).toHaveLength(3);
		expect(p.snapshot().pending).toBe(10);
		calls[2]?.resolve({ files: [] });
		await flushAll();
		expect(p.snapshot().pending).toBe(0);
	});

	it("puts each answer in the file's own hunksQuery entry and skips cached or fetching files", async () => {
		client.setQueryData(hunksQuery("r", 3).queryKey, hunks("cached"));
		void client.fetchQuery({
			...hunksQuery("r", 4),
			queryFn: () => new Promise<FileHunks>(() => {}),
		});
		const p = prefetcher();
		p.queue([3, 4, 5, 5]);
		expect(calls.map((c) => c.indexes)).toEqual([[5]]);
		const h = hunks("five");
		calls[0]?.resolve({ files: [{ index: 5, hunks: h }] });
		await flushAll();
		expect(client.getQueryData(hunksQuery("r", 5).queryKey)).toBe(h);
		expect(p.snapshot()).toEqual({ pending: 0, failed: [] });
	});

	it("a failed request marks its files, a per-file error marks that file, and retry asks again", async () => {
		const p = prefetcher();
		p.queue([1, 2]);
		calls[0]?.reject(new Error("down"));
		await flushAll();
		expect(p.snapshot().failed).toEqual([1, 2]);
		expect(p.snapshot().pending).toBe(0);

		p.queue([7, 8]);
		const h = hunks("eight");
		calls[1]?.resolve({
			files: [
				{ index: 7, error: "boom" },
				{ index: 8, hunks: h },
			],
		});
		await flushAll();
		expect(p.snapshot().failed).toEqual([1, 2, 7]);
		expect(client.getQueryData(hunksQuery("r", 8).queryKey)).toBe(h);

		p.retry();
		expect(p.snapshot().failed).toEqual([]);
		expect(calls).toHaveLength(3);
		expect(calls[2]?.indexes).toEqual([1, 2, 7]);
		expect(p.snapshot().pending).toBe(3);
	});

	it("a file the answer leaves out is failed", async () => {
		const p = prefetcher();
		p.queue([1, 2]);
		calls[0]?.resolve({ files: [{ index: 1, hunks: hunks("one") }] });
		await flushAll();
		expect(p.snapshot()).toEqual({ pending: 0, failed: [2] });
	});

	it("a 409 keeps its files pending, asks for nothing more and tells onStale once", async () => {
		const onStale = vi.fn();
		const p = new HunksPrefetcher(client, "r", fetchBatch, onStale);
		// Three batches: two out, one waiting its turn.
		p.queue(nums(0, HUNKS_BATCH * 3));
		expect(calls).toHaveLength(2);
		calls[0]?.reject(new ApiError(409, "stale"));
		await flushAll();
		expect(onStale).toHaveBeenCalledTimes(1);
		// The stale revision's files are neither searched nor failed: pending.
		expect(p.snapshot().failed).toEqual([]);
		expect(p.snapshot().pending).toBe(HUNKS_BATCH * 3);
		// The waiting batch isn't sent to a revision known to be stale.
		expect(calls).toHaveLength(2);
		calls[1]?.reject(new ApiError(409, "stale"));
		await flushAll();
		expect(onStale).toHaveBeenCalledTimes(1);
		expect(p.snapshot().pending).toBe(HUNKS_BATCH * 3);
		expect(calls).toHaveLength(2);
	});

	it("subscribers are told on each change; stop drops the queue but keeps an answer in flight", async () => {
		const p = prefetcher();
		const onChange = vi.fn();
		p.subscribe(onChange);
		p.queue(nums(0, 80));
		expect(onChange).toHaveBeenCalledTimes(1);
		p.stop();
		expect(onChange).toHaveBeenCalledTimes(2);
		expect(p.snapshot().pending).toBe(0);
		const h = hunks("zero");
		calls[0]?.resolve({ files: [{ index: 0, hunks: h }] });
		await flushAll();
		expect(calls).toHaveLength(2);
		expect(client.getQueryData(hunksQuery("r", 0).queryKey)).toBe(h);
	});

	it("an answer's entry is kept HUNKS_KEPT_MS, like a query's own", async () => {
		const p = prefetcher();
		p.queue([5]);
		calls[0]?.resolve({ files: [{ index: 5, hunks: hunks("five") }] });
		await flushAll();
		expect(
			client.getQueryCache().find({ queryKey: hunksQuery("r", 5).queryKey })
				?.gcTime,
		).toBe(HUNKS_KEPT_MS);
	});

	it("a failed file is not asked for again by queue, only by retry, and leaves failed once answered", async () => {
		const p = prefetcher();
		p.queue([1]);
		calls[0]?.reject(new Error("down"));
		await flushAll();
		p.queue([1]);
		expect(calls).toHaveLength(1);
		expect(p.snapshot().failed).toEqual([1]);
		p.retry();
		expect(calls).toHaveLength(2);
		calls[1]?.resolve({ files: [{ index: 1, hunks: hunks("one") }] });
		await flushAll();
		expect(p.snapshot().failed).toEqual([]);
	});

	it("a queued file whose own fetch started while it waited is dropped", async () => {
		const p = prefetcher();
		p.queue(nums(0, 51));
		expect(calls).toHaveLength(2);
		void client.fetchQuery({
			...hunksQuery("r", 50),
			queryFn: () => new Promise<FileHunks>(() => {}),
		});
		calls[0]?.resolve({ files: [] });
		await flushAll();
		expect(calls).toHaveLength(2);
		expect(p.snapshot().pending).toBe(25);
	});

	it("retry after stop changes nothing", async () => {
		const p = prefetcher();
		p.queue([1]);
		calls[0]?.reject(new Error("down"));
		await flushAll();
		p.stop();
		const onChange = vi.fn();
		p.subscribe(onChange);
		p.retry();
		expect(onChange).not.toHaveBeenCalled();
		expect(p.snapshot().failed).toEqual([1]);
	});
});
