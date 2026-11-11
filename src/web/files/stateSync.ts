import { viewOfLines } from "../../shared/pieces";
import { fileFlags, reviewProgress } from "../../shared/progress";
import type { ClusterView, ReviewView, StateChange } from "../../shared/types";
import { ApiError } from "../api";

/** The server's limit on changes per request (MAX_CHANGES in app.ts). */
export const MAX_CHANGES = 1000;
/** A change waiting longer than this shows the "saving" notice. */
export const DELAYED_MS = 5000;
/**
 * Transient failures in a row after which the red notice replaces the yellow
 * one (retrying goes on behind it).
 */
export const STALL_ATTEMPTS = 5;
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
	/** The reviewer's intended states not yet stored, by cluster key (rejected ones too). */
	pending: ReadonlyMap<string, PendingChange>;
	/**
	 * Pending changes the server refused for a reason retrying won't fix
	 * (each isolated in a request of its own): kept, and not sent again until
	 * retry() or a newer change to the cluster. The rest keep syncing.
	 */
	rejected: ReadonlyMap<string, PendingChange>;
	/** The last refusal's error, while any change is rejected. */
	failure: Error | null;
	/** A change being synced (not rejected) has waited over DELAYED_MS. */
	delayed: boolean;
	/** Why it waits: the last transient failure, in a few words; null once a write is stored. */
	waiting: string | null;
	/**
	 * The last transient failure once STALL_ATTEMPTS in a row have failed:
	 * shown red with Retry, while retrying goes on. Null once a write is stored.
	 */
	stalled: Error | null;
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

/** Changes to send on their own, to find out which the server refuses. */
interface Probe {
	revision: string;
	keys: string[];
}

interface Batch {
	revision: string;
	changes: PendingChange[];
	probe: boolean;
}

/** A transient failure in a few words, for the delayed notice. */
export function waitReason(error: unknown): string {
	if (error instanceof ApiError && error.status === 0) return "Can't reach crb";
	return error instanceof Error ? error.message : String(error);
}

/**
 * Syncs the server to the reviewer's intended cluster states. The UI shows
 * the intended state at once (overlayReview); this keeps sending it until
 * the server stores it, and never rolls a change back:
 * - one write at a time, in order, each of one revision; changes to a
 *   cluster queued behind a write coalesce into its latest state, and a
 *   write's answer clears only the versions it sent, so a newer change stays
 *   on top of an older answer;
 * - transient failures retry with backoff (RETRY_DELAYS_MS); a new change
 *   retries at once. After STALL_ATTEMPTS in a row they show as `stalled`
 *   (red), retrying on. No request is ever abandoned on a client timeout: an
 *   abandoned older write could land after its retry and overwrite newer
 *   intent;
 * - a 400 names the refused changes (or, unnamed, is split per file and
 *   then in halves until they are alone): those are rejected (kept until
 *   retry()), the rest sent again; any other refusal rejects the whole
 *   request. Everything else goes on syncing;
 * - a 409 drops the pending changes made on that revision (the snapshot
 *   moved: they can't apply).
 */
export class StateSync {
	readonly #deps: SyncDeps;
	readonly #pending = new Map<string, PendingChange>();
	readonly #rejected = new Map<string, PendingChange>();
	#probes: Probe[] = [];
	#version = 0;
	#sending = false;
	#attempt = 0;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#delayTimer: ReturnType<typeof setTimeout> | undefined;
	#lastRefusal: Error | null = null;
	/** A refusal since the last reread (#reread). */
	#unread = false;
	#waitingFor: string | null = null;
	#lastTransient: Error | null = null;
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
	 * change; rejects when one is refused for good, or dropped by a 409.
	 * Transient failures keep it waiting.
	 */
	apply(revision: string, path: string, changes: StateChange[]): Promise<void> {
		if (changes.length === 0) return Promise.resolve();
		const now = Date.now();
		const versions = new Map<string, number>();
		for (const change of changes) {
			const prior = this.#pending.get(change.key);
			const version = ++this.#version;
			// A newer intent for a refused cluster is worth sending.
			this.#rejected.delete(change.key);
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
		// The reviewer is back at work: don't sit out a long backoff.
		if (this.#retryTimer !== undefined) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = undefined;
		}
		this.#changed();
		this.#pump();
		return done;
	}

	/** Sends every unsaved change again, the rejected ones too. */
	retry() {
		if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
		this.#retryTimer = undefined;
		this.#rejected.clear();
		this.#attempt = 0;
		// A fresh start: the delayed notice counts from now.
		const now = Date.now();
		for (const [key, p] of this.#pending) {
			this.#pending.set(key, { ...p, since: now });
		}
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

	#sendable(p: PendingChange | undefined): p is PendingChange {
		return p !== undefined && !this.#rejected.has(p.change.key);
	}

	#next(): Batch | undefined {
		while (this.#probes.length > 0) {
			const [probe] = this.#probes;
			if (!probe) break;
			const changes = probe.keys
				.map((key) => this.#pending.get(key))
				.filter(
					(p): p is PendingChange =>
						this.#sendable(p) && p.revision === probe.revision,
				);
			if (changes.length > 0) {
				return { revision: probe.revision, changes, probe: true };
			}
			this.#probes.shift();
		}
		let revision: string | undefined;
		const changes: PendingChange[] = [];
		for (const p of this.#pending.values()) {
			if (!this.#sendable(p)) continue;
			revision ??= p.revision;
			// One revision per request: a change made on an old snapshot must
			// never be stored on a new one.
			if (p.revision !== revision) continue;
			changes.push(p);
			if (changes.length === MAX_CHANGES) break;
		}
		return revision === undefined
			? undefined
			: { revision, changes, probe: false };
	}

	#pump() {
		if (this.#sending || this.#retryTimer !== undefined) return;
		const batch = this.#next();
		if (!batch) return;
		this.#sending = true;
		void this.#send(batch);
	}

	async #send(batch: Batch) {
		let view: ReviewView;
		try {
			const answer: unknown = await this.#deps.post(
				batch.revision,
				batch.changes.map((p) => p.change),
			);
			if (!isReviewView(answer)) throw new MalformedAnswerError();
			view = answer;
		} catch (error) {
			this.#sending = false;
			this.#failed(error, batch);
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
		this.#waitingFor = null;
		if (batch.probe) this.#probes.shift();
		this.#reread();
		const now = Date.now();
		for (const p of batch.changes) {
			const current = this.#pending.get(p.change.key);
			if (current?.version === p.version) {
				this.#pending.delete(p.change.key);
			} else if (current) {
				// A newer change, not yet sent: its wait starts now.
				this.#pending.set(p.change.key, { ...current, since: now });
			}
		}
		this.#settle();
		this.#changed();
		this.#pump();
	}

	#failed(error: unknown, batch: Batch) {
		const { revision } = batch;
		if (isStale(error)) {
			const dropped = new Set<number>();
			for (const [key, p] of this.#pending) {
				if (p.revision !== revision) continue;
				this.#pending.delete(key);
				this.#rejected.delete(key);
				dropped.add(p.version);
			}
			this.#probes = this.#probes.filter((p) => p.revision !== revision);
			this.#stale = { dropped: dropped.size };
			this.#attempt = 0;
			this.#waitingFor = null;
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
			this.#waitingFor = waitReason(error);
			this.#lastTransient =
				error instanceof Error ? error : new Error(String(error));
			this.#retryTimer = setTimeout(() => {
				this.#retryTimer = undefined;
				this.#pump();
			}, wait);
			this.#changed();
			return;
		}
		if (batch.probe) this.#probes.shift();
		// Only a 400 is about what the request says; any other refusal (401,
		// 404, 413…, or a malformed answer) refuses the whole request at once.
		const validation = error instanceof ApiError && error.status === 400;
		const named = new Set(validation ? (error.keys ?? []) : []);
		const keys = batch.changes.map((p) => p.change.key);
		let refusedKeys = keys;
		if (named.size > 0 && keys.some((k) => named.has(k))) {
			// The server named the refused changes: the rest go again, at once.
			refusedKeys = keys.filter((k) => named.has(k));
			const rest = keys.filter((k) => !named.has(k));
			if (rest.length > 0) this.#probes.unshift({ revision, keys: rest });
		} else if (validation && keys.length > 1) {
			// Unnamed: send its parts alone, per file and then in halves down to
			// single changes, so the rest stores and only the refused stay behind.
			const byPath = new Map<string, string[]>();
			for (const p of batch.changes) {
				const group = byPath.get(p.path) ?? [];
				group.push(p.change.key);
				byPath.set(p.path, group);
			}
			const half = Math.ceil(keys.length / 2);
			const parts =
				byPath.size > 1
					? [...byPath.values()]
					: [keys.slice(0, half), keys.slice(half)];
			this.#probes.unshift(...parts.map((part) => ({ revision, keys: part })));
			this.#unread = true;
			this.#changed();
			this.#pump();
			return;
		}
		this.#lastRefusal =
			error instanceof Error
				? error
				: new Error(String(error ?? "Unknown error"));
		const refused = new Set<number>();
		for (const key of refusedKeys) {
			const current = this.#pending.get(key);
			const sent = batch.changes.find((p) => p.change.key === key);
			if (!current || current.version !== sent?.version) continue;
			this.#rejected.set(key, current);
			refused.add(current.version);
		}
		this.#settle(
			(w) => [...w.versions.values()].some((v) => refused.has(v)),
			error,
		);
		this.#unread = true;
		this.#reread();
		this.#changed();
		this.#pump();
	}

	/**
	 * Once a refusal's splitting is over: reread what the server has (a
	 * batch over several requests may be partly stored), once.
	 */
	#reread() {
		if (!this.#unread || this.#probes.length > 0) return;
		this.#unread = false;
		this.#deps.failed();
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

	/** `map` is still `last`'s content (kept, so overlays stay cached). */
	static #same(
		last: ReadonlyMap<string, PendingChange> | undefined,
		map: Map<string, PendingChange>,
	): boolean {
		if (!last || last.size !== map.size) return false;
		for (const [key, p] of map) if (last.get(key) !== p) return false;
		return true;
	}

	#build(): SyncState {
		if (this.#delayTimer !== undefined) clearTimeout(this.#delayTimer);
		this.#delayTimer = undefined;
		let oldest = Number.POSITIVE_INFINITY;
		for (const p of this.#pending.values()) {
			if (this.#sendable(p)) oldest = Math.min(oldest, p.since);
		}
		let delayed = false;
		if (oldest < Number.POSITIVE_INFINITY) {
			const left = oldest + DELAYED_MS - Date.now();
			if (left <= 0) delayed = true;
			else {
				this.#delayTimer = setTimeout(() => {
					this.#delayTimer = undefined;
					this.#changed();
				}, left);
			}
		}
		// Unset while the constructor builds the first state.
		const last = this.#state as SyncState | undefined;
		return {
			pending: StateSync.#same(last?.pending, this.#pending)
				? (last?.pending ?? new Map())
				: new Map(this.#pending),
			rejected: StateSync.#same(last?.rejected, this.#rejected)
				? (last?.rejected ?? new Map())
				: new Map(this.#rejected),
			failure: this.#rejected.size > 0 ? this.#lastRefusal : null,
			delayed,
			waiting: this.#waitingFor,
			stalled:
				this.#attempt >= STALL_ATTEMPTS && oldest < Number.POSITIVE_INFINITY
					? this.#lastTransient
					: null,
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
	const { reason: _, reviewedLines: had, crossedLines: hadX, ...rest } = c;
	if (change.reviewedLines !== undefined || change.crossedLines !== undefined) {
		// Part of the cluster (pieces.ts): its lines as the change says.
		return (
			viewOfLines(
				rest,
				change.reviewedLines ?? [],
				change.crossedLines ?? [],
			) ?? {
				...rest,
				state: "unreviewed",
			}
		);
	}
	if (change.state === "crossed-off") {
		const reason = change.reason?.trim();
		if (c.state === "crossed-off" && c.reason === (reason || undefined)) {
			return c;
		}
		return reason
			? { ...rest, state: "crossed-off", reason }
			: { ...rest, state: "crossed-off" };
	}
	if (c.state === change.state && c.reason === undefined && !had && !hadX) {
		return c;
	}
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
	// Marks on since-only pieces: the pending one replaces its comparison's.
	let sinceMarks = view.sinceMarks;
	for (const p of pending.values()) {
		const mark = p.change.sinceMark;
		if (!mark || p.revision !== view.revision) continue;
		sinceMarks = [
			...(sinceMarks ?? []).filter(
				(m) => m.since !== mark.since || m.path !== mark.path,
			),
			mark,
		];
	}
	const marksChanged = sinceMarks !== view.sinceMarks;
	if (!changed && !marksChanged) return view;
	return {
		...view,
		...(changed ? { files, progress: reviewProgress(files) } : {}),
		...(sinceMarks ? { sinceMarks } : {}),
	};
}
