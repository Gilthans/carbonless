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
	/** The queue's files, for lookups. */
	#queued = new Set<number>();
	/** Files of the requests out. */
	#inFlight = new Set<number>();
	#out = 0;
	#failed: number[] = [];
	#failedSet = new Set<number>();
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
			if (
				this.#queued.has(index) ||
				this.#inFlight.has(index) ||
				this.#failedSet.has(index) ||
				this.#cached(index)
			)
				continue;
			this.#queue.push(index);
			this.#queued.add(index);
		}
		this.#flush();
		this.#changed();
	}

	/** Only `retry` asks for a failed file again. */
	retry(): void {
		if (this.#stopped) return;
		const again = this.#failed;
		this.#failed = [];
		this.#failedSet = new Set();
		this.queue(again);
		this.#changed();
	}

	/** The file's own entry is answered or being fetched. */
	#cached(index: number): boolean {
		const state = this.#client.getQueryState(
			hunksQuery(this.#revision, index).queryKey,
		);
		return state?.status === "success" || state?.fetchStatus === "fetching";
	}

	stop(): void {
		this.#stopped = true;
		this.#queue = [];
		this.#queued = new Set();
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
			const batch: number[] = [];
			while (batch.length < HUNKS_BATCH && this.#queue.length > 0) {
				const index = this.#queue.shift() as number;
				this.#queued.delete(index);
				// Its own fetch may have started or ended while it waited.
				if (!this.#cached(index)) batch.push(index);
			}
			if (batch.length === 0) continue;
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
					// Built with the query's options, so its gcTime applies.
					const options = this.#client.defaultQueryOptions(
						hunksQuery(this.#revision, file.index),
					);
					this.#client.getQueryCache().build(this.#client, options);
					this.#client.setQueryData(options.queryKey, file.hunks);
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
		for (const index of failed) {
			if (this.#failedSet.has(index)) continue;
			this.#failedSet.add(index);
			this.#failed.push(index);
		}
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
