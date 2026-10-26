import { fileFlags, reviewProgress } from "../../shared/progress";
import type { ClusterView, ReviewView, StateChange } from "../../shared/types";
import { ApiError } from "../api";

/** The server's limit on changes per request (MAX_CHANGES in app.ts). */
export const MAX_CHANGES = 1000;
/** A change waiting longer than this shows the "saving" notice. */
export const DELAYED_MS = 5000;
/** Waits before each retry of a transient failure; the last one repeats. */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];

/** One cluster's intended state, not yet stored. */
export interface PendingChange {
	change: StateChange;
	/** The ReviewView.revision it was made on. */
	revision: string;
	/** The file it is in, to say what is waiting. */
	path: string;
	/** Grows with every change: a stored answer clears only what it sent. */
	version: number;
	/** When the cluster first had an unsaved change (Date.now()). */
	since: number;
}

export interface SyncState {
	/** The reviewer's intended states not yet stored, by cluster key. */
	pending: ReadonlyMap<string, PendingChange>;
	/** Some change has waited over DELAYED_MS. */
	delayed: boolean;
	/** A write failed for a reason retrying won't fix: sync waits for retry(). */
	failure: Error | null;
	/** The last write was refused because the snapshot moved; `dropped` changes were lost. */
	stale: { dropped: number } | null;
}

export interface SyncDeps {
	post: (revision: string, changes: StateChange[]) => Promise<ReviewView>;
	/** A write's answer: what the server stores now. */
	stored: (view: ReviewView) => void | Promise<void>;
	/** The snapshot moved (409). */
	staled: () => void;
	/** A write failed for good; the server may hold part of a batch. */
	failed: () => void;
}

export const isStale = (error: unknown) =>
	error instanceof ApiError && error.status === 409;

/**
 * Failures a retry may fix by itself: carbonless unreachable (status 0),
 * a timeout, too many requests, or a server error.
 */
export function isTransient(error: unknown): boolean {
	if (!(error instanceof ApiError)) return false;
	const s = error.status;
	return s === 0 || s === 408 || s === 429 || s >= 500;
}

/** A 2xx answer that isn't a review view. */
export class MalformedAnswerError extends Error {
	constructor() {
		super("The server's answer wasn't a review");
		this.name = "MalformedAnswerError";
	}
}

function isReviewView(value: unknown): value is ReviewView {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Partial<ReviewView>;
	return (
		typeof v.revision === "string" &&
		Array.isArray(v.files) &&
		v.files.every(
			(f) =>
				typeof f === "object" &&
				f !== null &&
				typeof f.path === "string" &&
				Array.isArray(f.clusters),
		) &&
		typeof v.progress === "object" &&
		v.progress !== null
	);
}

interface Waiter {
	versions: Map<string, number>;
	resolve: () => void;
	reject: (error: unknown) => void;
}

/**
 * Syncs the server to the reviewer's intended cluster states. The UI shows
 * the intended state at once (overlayReview); this keeps sending it until
 * the server stores it, and never rolls a change back:
 * - one write at a time, in order; changes to a cluster queued behind a
 *   write coalesce into its latest state, and a write's answer clears only
 *   the versions it sent, so a newer change stays on top of an older answer;
 * - transient failures retry with backoff (RETRY_DELAYS_MS);
 * - any other failure stops until retry(), the changes kept;
 * - a 409 drops the pending changes made on that revision (the snapshot
 *   moved: they can't apply).
 */
export class StateSync {
	readonly #deps: SyncDeps;
	readonly #pending = new Map<string, PendingChange>();
	#version = 0;
	#sending = false;
	#attempt = 0;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#delayTimer: ReturnType<typeof setTimeout> | undefined;
	#failure: Error | null = null;
	#stale: SyncState["stale"] = null;
	readonly #waiters = new Set<Waiter>();
	readonly #listeners = new Set<() => void>();
	#state: SyncState;

	constructor(deps: SyncDeps) {
		this.#deps = deps;
		this.#state = this.#build();
	}

	/**
	 * Takes `changes` (made on `revision`, in file `path`) as intended now and
	 * queues them. Resolves once each is stored or superseded by a later
	 * change; rejects on a failure retrying won't fix, or a 409 that dropped
	 * it. Transient failures keep it waiting.
	 */
	apply(revision: string, path: string, changes: StateChange[]): Promise<void> {
		if (changes.length === 0) return Promise.resolve();
		const now = Date.now();
		const versions = new Map<string, number>();
		for (const change of changes) {
			const prior = this.#pending.get(change.key);
			const version = ++this.#version;
			this.#pending.set(change.key, {
				change,
				revision,
				path,
				version,
				since: prior?.since ?? now,
			});
			versions.set(change.key, version);
		}
		const done = new Promise<void>((resolve, reject) => {
			this.#waiters.add({ versions, resolve, reject });
		});
		done.catch(() => {});
		this.#changed();
		this.#pump();
		return done;
	}

	/** After a failure: send the current intended state again. */
	retry() {
		if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
		this.#retryTimer = undefined;
		this.#failure = null;
		this.#attempt = 0;
		this.#changed();
		this.#pump();
	}

	getState = (): SyncState => this.#state;

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	#pump() {
		if (this.#sending || this.#retryTimer !== undefined || this.#failure) {
			return;
		}
		const first = this.#pending.values().next().value;
		if (!first) return;
		const batch: PendingChange[] = [];
		for (const p of this.#pending.values()) {
			if (p.revision !== first.revision) continue;
			batch.push(p);
			if (batch.length === MAX_CHANGES) break;
		}
		this.#sending = true;
		void this.#send(first.revision, batch);
	}

	async #send(revision: string, batch: PendingChange[]) {
		let view: ReviewView;
		try {
			const answer: unknown = await this.#deps.post(
				revision,
				batch.map((p) => p.change),
			);
			if (!isReviewView(answer)) throw new MalformedAnswerError();
			view = answer;
		} catch (error) {
			this.#sending = false;
			this.#failed(error, revision);
			return;
		}
		try {
			await this.#deps.stored(view);
		} catch {
			// Showing the answer failed; it is stored all the same.
		}
		this.#sending = false;
		this.#attempt = 0;
		this.#stale = null;
		for (const p of batch) {
			if (this.#pending.get(p.change.key)?.version === p.version) {
				this.#pending.delete(p.change.key);
			}
		}
		this.#settle();
		this.#changed();
		this.#pump();
	}

	#failed(error: unknown, revision: string) {
		if (isStale(error)) {
			const dropped = new Set<number>();
			for (const [key, p] of this.#pending) {
				if (p.revision !== revision) continue;
				this.#pending.delete(key);
				dropped.add(p.version);
			}
			this.#stale = { dropped: dropped.size };
			this.#attempt = 0;
			this.#settle(
				(w) => [...w.versions.values()].some((v) => dropped.has(v)),
				error,
			);
			this.#deps.staled();
			this.#changed();
			this.#pump();
			return;
		}
		if (isTransient(error)) {
			const wait =
				RETRY_DELAYS_MS[Math.min(this.#attempt, RETRY_DELAYS_MS.length - 1)];
			this.#attempt++;
			this.#retryTimer = setTimeout(() => {
				this.#retryTimer = undefined;
				this.#pump();
			}, wait);
			this.#changed();
			return;
		}
		this.#failure =
			error instanceof Error
				? error
				: new Error(String(error ?? "Unknown error"));
		this.#settle((w) => this.#waiting(w), error);
		this.#deps.failed();
		this.#changed();
	}

	#waiting(w: Waiter) {
		for (const [key, version] of w.versions) {
			if (this.#pending.get(key)?.version === version) return true;
		}
		return false;
	}

	/** Rejects the waiters `failed` picks with `error`; resolves those done. */
	#settle(failed?: (w: Waiter) => boolean, error?: unknown) {
		for (const w of this.#waiters) {
			if (failed?.(w)) {
				this.#waiters.delete(w);
				w.reject(error);
			} else if (!this.#waiting(w)) {
				this.#waiters.delete(w);
				w.resolve();
			}
		}
	}

	#changed() {
		this.#state = this.#build();
		for (const listener of this.#listeners) listener();
	}

	/** The last state's pending map still holds (kept, so overlays stay cached). */
	#samePending(): boolean {
		// Unset while the constructor builds the first state.
		const last = this.#state?.pending;
		if (!last || last.size !== this.#pending.size) return false;
		for (const [key, p] of this.#pending) if (last.get(key) !== p) return false;
		return true;
	}

	#build(): SyncState {
		if (this.#delayTimer !== undefined) clearTimeout(this.#delayTimer);
		this.#delayTimer = undefined;
		let oldest = Number.POSITIVE_INFINITY;
		for (const p of this.#pending.values()) oldest = Math.min(oldest, p.since);
		let delayed = false;
		if (this.#pending.size > 0) {
			const left = oldest + DELAYED_MS - Date.now();
			if (left <= 0) delayed = true;
			else {
				this.#delayTimer = setTimeout(() => {
					this.#delayTimer = undefined;
					this.#changed();
				}, left);
			}
		}
		return {
			pending: this.#samePending()
				? this.#state.pending
				: new Map(this.#pending),
			delayed,
			failure: this.#failure,
			stale: this.#stale,
		};
	}
}

const STATE_WORDS: Record<StateChange["state"], string> = {
	reviewed: "Reviewed",
	"crossed-off": "Crossed off",
	unreviewed: "Unreviewed",
};

/**
 * What is waiting, in a few words: the change and its file for one, the
 * count and the file for several in one file, else the counts.
 */
export function describePending(
	pending: ReadonlyMap<string, PendingChange>,
): string {
	const all = [...pending.values()];
	const paths = new Set(all.map((p) => p.path));
	const [only] = all;
	if (all.length === 1 && only) {
		return `${STATE_WORDS[only.change.state]} · ${only.path}`;
	}
	const changes = `${all.length} changes`;
	if (paths.size === 1) return `${changes} · ${[...paths][0]}`;
	return `${changes} in ${paths.size} files`;
}

/**
 * The files with something waiting, for under a count: one change as
 * describePending says it, else up to three paths and how many more.
 */
export function pendingFiles(
	pending: ReadonlyMap<string, PendingChange>,
): string {
	if (pending.size === 1) return describePending(pending);
	const paths = [...new Set([...pending.values()].map((p) => p.path))];
	const shown = paths.slice(0, 3).join(", ");
	return paths.length > 3 ? `${shown} +${paths.length - 3}` : shown;
}

function withState(c: ClusterView, change: StateChange): ClusterView {
	const { reason: _, ...rest } = c;
	if (change.state === "crossed-off") {
		const reason = change.reason?.trim();
		if (c.state === "crossed-off" && c.reason === (reason || undefined)) {
			return c;
		}
		return reason
			? { ...rest, state: "crossed-off", reason }
			: { ...rest, state: "crossed-off" };
	}
	if (c.state === change.state && c.reason === undefined) return c;
	return { ...rest, state: change.state };
}

/**
 * `view` as the reviewer intends it: each pending change made on its
 * revision replaces its cluster's state, and file flags and progress are
 * counted again. Like the server's coverage join, a key two clusters share
 * stays as the server has it (unreviewed), so a bad key can't look reviewed.
 * Unchanged files keep their identity.
 */
export function overlayReview(
	view: ReviewView,
	pending: ReadonlyMap<string, PendingChange>,
): ReviewView {
	if (pending.size === 0) return view;
	const keyCount = new Map<string, number>();
	for (const file of view.files) {
		for (const c of file.clusters) {
			keyCount.set(c.key, (keyCount.get(c.key) ?? 0) + 1);
		}
	}
	let changed = false;
	const files = view.files.map((file) => {
		let fileChanged = false;
		const clusters = file.clusters.map((c) => {
			const p = pending.get(c.key);
			if (!p || p.revision !== view.revision || keyCount.get(c.key) !== 1) {
				return c;
			}
			const next = withState(c, p.change);
			if (next !== c) fileChanged = true;
			return next;
		});
		if (!fileChanged) return file;
		changed = true;
		return { ...file, clusters, ...fileFlags(clusters) };
	});
	return changed ? { ...view, files, progress: reviewProgress(files) } : view;
}
