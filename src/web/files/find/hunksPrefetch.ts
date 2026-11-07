import type { QueryClient } from "@tanstack/react-query";
import { type FileView, HUNKS_BATCH } from "../../../shared/types";
import { ApiError, fetchHunksBatch, hunksQuery } from "../../api";

/** Batched requests out at once. */
export const HUNKS_IN_FLIGHT = 2;

export interface PrefetchSnapshot {
	/** Files asked for and not answered yet (queued or in flight). */
	pending: number;
	/** Files whose request failed or whose answer carried an error, by index, in the order they failed. */
	failed: readonly number[];
}

/**
 * Fetches files' hunks in batches of HUNKS_BATCH, HUNKS_IN_FLIGHT requests
 * at a time, in the order queued, and puts each answer in that file's own
 * hunksQuery cache entry (so the diff reads the same data). Skips a file
 * whose entry is already a success or fetching (a file just opened), or
 * already queued. `stop()` drops the queue; answers of requests out still
 * land in the cache.
 *
 * A request that fails with 409 (stale revision) marks nothing failed: the
 * page moves to a new revision and starts a new prefetcher. Any other
 * failure marks every file of the request failed; so does a file the
 * answer leaves out.
 */
export class HunksPrefetcher {
	readonly #client: QueryClient;
	readonly #revision: string;
	readonly #fetchBatch: typeof fetchHunksBatch;
	#queue: number[] = [];
	/** Files of the requests out. */
	#inFlight = new Set<number>();
	#out = 0;
	#failed: number[] = [];
	#stopped = false;
	readonly #listeners = new Set<() => void>();
	#snapshot: PrefetchSnapshot = { pending: 0, failed: [] };

	constructor(
		client: QueryClient,
		revision: string,
		fetchBatch: typeof fetchHunksBatch = fetchHunksBatch,
	) {
		this.#client = client;
		this.#revision = revision;
		this.#fetchBatch = fetchBatch;
	}

	queue(indexes: readonly number[]): void {
		if (this.#stopped) return;
		for (const index of indexes) {
			if (this.#queue.includes(index) || this.#inFlight.has(index)) continue;
			const state = this.#client.getQueryState(
				hunksQuery(this.#revision, index).queryKey,
			);
			if (state?.status === "success" || state?.fetchStatus === "fetching")
				continue;
			this.#queue.push(index);
		}
		this.#flush();
		this.#changed();
	}

	/** Queues the failed files again (in their order) and clears `failed`. */
	retry(): void {
		const again = this.#failed;
		this.#failed = [];
		this.queue(again);
		this.#changed();
	}

	stop(): void {
		this.#stopped = true;
		this.#queue = [];
		this.#inFlight = new Set();
		this.#changed();
	}

	subscribe(onChange: () => void): () => void {
		this.#listeners.add(onChange);
		return () => {
			this.#listeners.delete(onChange);
		};
	}

	snapshot(): PrefetchSnapshot {
		return this.#snapshot;
	}

	#changed(): void {
		const pending = this.#queue.length + this.#inFlight.size;
		const prev = this.#snapshot;
		if (
			prev.pending === pending &&
			prev.failed.length === this.#failed.length &&
			prev.failed.every((n, i) => n === this.#failed[i])
		)
			return;
		this.#snapshot = { pending, failed: [...this.#failed] };
		for (const listener of [...this.#listeners]) listener();
	}

	#flush(): void {
		while (this.#out < HUNKS_IN_FLIGHT && this.#queue.length > 0) {
			const batch = this.#queue.splice(0, HUNKS_BATCH);
			for (const index of batch) this.#inFlight.add(index);
			this.#out++;
			void this.#send(batch);
		}
	}

	async #send(batch: number[]): Promise<void> {
		let failed: number[] = [];
		try {
			const answer = await this.#fetchBatch(this.#revision, batch);
			const answered = new Set<number>();
			for (const file of answer.files) {
				if (!batch.includes(file.index) || answered.has(file.index)) continue;
				if (file.hunks && !file.error) {
					answered.add(file.index);
					this.#client.setQueryData(
						hunksQuery(this.#revision, file.index).queryKey,
						file.hunks,
					);
				} else {
					answered.add(file.index);
					failed.push(file.index);
				}
			}
			for (const index of batch) if (!answered.has(index)) failed.push(index);
		} catch (error) {
			failed = error instanceof ApiError && error.status === 409 ? [] : batch;
		}
		this.#out--;
		if (this.#stopped) return;
		for (const index of batch) this.#inFlight.delete(index);
		this.#failed.push(...failed);
		this.#flush();
		this.#changed();
	}
}

/**
 * The order the prefetch asks for files: the open file's position in
 * `files` (tree order) first, then outward alternating after and before it
 * (i+1, i-1, i+2, i-2, …); from the start when none is open. Files with no
 * lines (binary, submodule) are left out.
 */
export function prefetchOrder(
	files: readonly FileView[],
	openIndex: number | null,
): number[] {
	const at =
		openIndex === null ? -1 : files.findIndex((f) => f.index === openIndex);
	const positions: number[] = [];
	if (at === -1) {
		files.forEach((_, i) => {
			positions.push(i);
		});
	} else {
		positions.push(at);
		for (let d = 1; positions.length < files.length; d++) {
			if (at + d < files.length) positions.push(at + d);
			if (at - d >= 0) positions.push(at - d);
		}
	}
	return positions
		.map((i) => files[i] as FileView)
		.filter((f) => !f.binary && !f.submodule)
		.map((f) => f.index);
}
