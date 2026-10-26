import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
	ReplyRequest,
	ResolveRequest,
	ReviewThread,
	ThreadComments,
	ThreadsView,
	ThreadUpdate,
} from "../../shared/types";
import {
	ApiError,
	commentsQuery,
	overviewQuery,
	postReply,
	postResolved,
	sessionQuery,
} from "../api";
import {
	DELAYED_MS,
	isTransient,
	RETRY_DELAYS_MS,
	STALL_ATTEMPTS,
} from "../files/stateSync";
import {
	type DraftStore,
	draftsFor,
	draftsKey,
	type SendingId,
} from "./drafts";

/** A random id for a reply; unique enough where randomUUID is missing (plain http). */
function newClientId(): string {
	try {
		if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	} catch {}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** How long an Overview card resolved or unresolved fades before it moves. */
export const FADE_MS = 4000;
/** Threads with a write out at once; the others wait their turn. */
export const MAX_IN_FLIGHT = 4;

export type WriteAction = "Reply" | "Resolve" | "Unresolve";

type Op =
	| {
			kind: "reply";
			text: string;
			/** The first attempt, its client id and the comments known then: the server's duplicate check. */
			id: SendingId;
			/** A resend after a failed or unknown attempt: dedupe first. */
			retry: boolean;
	  }
	| { kind: "resolve"; resolved: boolean };

/** A write refused for a reason retrying won't fix: shown red until Retry. */
export interface WriteFailure {
	action: WriteAction;
	error: Error;
	code?: string;
	/** Where to fix it (a pending review: the PR's Files changed on GitHub). */
	url?: string;
}

/** One thread's writes as the UI shows them. */
export interface ThreadWriteView {
	threadId: string;
	/**
	 * The resolved state the reviewer intends while GitHub hasn't confirmed
	 * it (queued, on its way, or refused); undefined once it has.
	 */
	resolved?: boolean;
	/** Replies sent and not yet confirmed, oldest first. */
	replies: { text: string; attemptedAt: string }[];
	/** The write waiting now (the first in line). */
	action: WriteAction | null;
	/** It has waited over DELAYED_MS. */
	delayed: boolean;
	/** Why it waits: the last transient failure, in a few words. */
	waiting: string | null;
	/** The last transient failure once STALL_ATTEMPTS in a row failed (retrying goes on). */
	stalled: Error | null;
	failed: WriteFailure | null;
}

export interface ThreadWritesState {
	/** Threads with a write waiting, refused or intended. */
	threads: ReadonlyMap<string, ThreadWriteView>;
	/** A reply was refused for a pending review on GitHub (409). */
	pendingReview: { url: string } | null;
	/** Anything not yet on GitHub (a refused resolve included). */
	busy: boolean;
}

export interface ThreadWritesDeps {
	reply: (threadId: string, req: ReplyRequest) => Promise<ThreadUpdate>;
	resolve: (threadId: string, req: ResolveRequest) => Promise<ThreadUpdate>;
	/** A write's answer: the thread as GitHub has it now. */
	applied: (update: ThreadUpdate) => void;
	drafts: DraftStore;
	/**
	 * The thread's comment ids as the page has them now, read first if
	 * they aren't in (its opener at least).
	 */
	knownComments: (threadId: string) => string[] | Promise<string[]>;
	/** A new client id for a reply (crypto.randomUUID by default). */
	newId?: () => string;
}

interface Lane {
	ops: Op[];
	/** The first op is out. */
	sending: boolean;
	attempt: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** When the first op started waiting (Date.now()). */
	since: number;
	waiting: string | null;
	lastTransient: Error | null;
	failed: WriteFailure | null;
	/** A refused resolve's intended state, kept until Retry or a newer one. */
	refusedResolved?: boolean;
}

const actionOf = (op: Op): WriteAction =>
	op.kind === "reply" ? "Reply" : op.resolved ? "Resolve" : "Unresolve";

/** The thread's comments couldn't be read: a reply waits (retried like a lost server). */
class NoKnownCommentsError extends ApiError {
	constructor() {
		super(0, "Couldn't read the thread's comments");
		this.name = "NoKnownCommentsError";
	}
}

function waitReason(error: unknown): string {
	if (error instanceof NoKnownCommentsError) return error.message;
	if (error instanceof ApiError && error.status === 0) return "Can't reach crb";
	return error instanceof Error ? error.message : String(error);
}

const asError = (error: unknown) =>
	error instanceof Error ? error : new Error(String(error ?? "Unknown error"));

/**
 * The reviewer's writes to GitHub threads (replies, resolve, unresolve),
 * with the review states' timing (stateSync.ts). Each is one explicit
 * action and shows at once; this sends it until GitHub has it:
 * - one thread's writes go one at a time, in order (a reply then a resolve
 *   lands in that order); threads go in parallel, MAX_IN_FLIGHT at most;
 * - transient failures (unreachable, 408, 429, 5xx) retry with backoff
 *   (RETRY_DELAYS_MS), red after STALL_ATTEMPTS in a row while retrying
 *   goes on. A reply resent after a failed or unknown attempt says
 *   `retry: true` with its first `attemptedAt`, so the server checks GitHub
 *   for it before posting again;
 * - any other refusal (400, 403, 404, 409) is red at once and never sent
 *   again by itself: a refused reply's text goes back into the box, a
 *   refused resolve keeps its intended state, until retry().
 * Nothing is ever written without the reviewer's action: a reply left
 * unconfirmed by a reload is resent only through resume().
 */
export class ThreadWrites {
	readonly #deps: ThreadWritesDeps;
	readonly #lanes = new Map<string, Lane>();
	#inFlight = 0;
	#pendingReview: { url: string } | null = null;
	#lastAttempt = 0;
	#delayTimer: ReturnType<typeof setTimeout> | undefined;
	readonly #listeners = new Set<() => void>();
	#state: ThreadWritesState;

	constructor(deps: ThreadWritesDeps) {
		this.#deps = deps;
		this.#state = this.#build();
	}

	get drafts(): DraftStore {
		return this.#deps.drafts;
	}

	/** Posts `text` as a reply (blank text is never sent); the box clears. */
	reply(threadId: string, text: string): void {
		if (!text.trim()) return;
		const id = this.#newSending();
		const { drafts } = this.#deps;
		drafts.addSending(threadId, text, id);
		drafts.setText(threadId, "");
		const lane = this.#lane(threadId);
		if (lane.failed?.action === "Reply") this.#clearFailure(lane);
		this.#push(lane, { kind: "reply", text, id, retry: false });
	}

	/** Resolves or unresolves the thread. */
	setResolved(threadId: string, resolved: boolean): void {
		const lane = this.#lane(threadId);
		if (lane.refusedResolved !== undefined) this.#clearFailure(lane);
		// A resolve still in line takes the newer intent.
		const last = lane.ops.at(-1);
		const queued = lane.ops.length > (lane.sending ? 1 : 0);
		if (last?.kind === "resolve" && queued) {
			last.resolved = resolved;
			this.#changed();
			return;
		}
		this.#push(lane, { kind: "resolve", resolved });
	}

	/**
	 * Sends the thread's writes again now: a stalled one at once, a refused
	 * reply with what its box holds, a refused resolve as intended.
	 */
	retry(threadId: string): void {
		const lane = this.#lanes.get(threadId);
		if (!lane) return;
		const failed = lane.failed;
		if (failed?.action === "Reply") {
			const text = this.#deps.drafts.text(threadId);
			// Refused for good: a new reply to GitHub (a new client id, and
			// the comments known when it goes), never the refused one again.
			const id = this.#newSending();
			this.#clearFailure(lane);
			if (text.trim()) {
				this.#deps.drafts.addSending(threadId, text, id);
				this.#deps.drafts.setText(threadId, "");
				lane.ops.push({ kind: "reply", text, id, retry: true });
			}
		} else if (lane.refusedResolved !== undefined) {
			const resolved = lane.refusedResolved;
			this.#clearFailure(lane);
			lane.ops.push({ kind: "resolve", resolved });
		}
		if (lane.timer !== undefined) {
			clearTimeout(lane.timer);
			lane.timer = undefined;
		}
		lane.attempt = 0;
		lane.since = Date.now();
		this.#prune(threadId);
		this.#changed();
		this.#pump();
	}

	/**
	 * Resends every reply the drafts hold as sent but unconfirmed (a reload
	 * cut it short), each with `retry: true`: the server finds one that did
	 * land, so it shows once.
	 */
	resume(): void {
		for (const d of this.#deps.drafts.get()) {
			if (!d.sending) continue;
			const { sentOnce: _, ...id } = d.sending;
			const lane = this.#lane(d.threadId);
			const known = lane.ops.some(
				(op) => op.kind === "reply" && op.id.clientId === id.clientId,
			);
			if (known) continue;
			lane.ops.push({ kind: "reply", text: d.text, id, retry: true });
			if (lane.ops.length === 1) lane.since = Date.now();
		}
		this.#changed();
		this.#pump();
	}

	state = (): ThreadWritesState => this.#state;
	getState = this.state;

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	/**
	 * A new reply's identity: now and a client id. The comments it knows
	 * are taken at its first send (#send), once the thread's earlier
	 * writes are answered.
	 */
	#newSending(): SendingId {
		return {
			attemptedAt: this.#stamp(),
			clientId: (this.#deps.newId ?? newClientId)(),
			knownCommentIds: [],
		};
	}

	/** A unique ISO time for a reply's first attempt. */
	#stamp(): string {
		const now = Math.max(Date.now(), this.#lastAttempt + 1);
		this.#lastAttempt = now;
		return new Date(now).toISOString();
	}

	#lane(threadId: string): Lane {
		let lane = this.#lanes.get(threadId);
		if (!lane) {
			lane = {
				ops: [],
				sending: false,
				attempt: 0,
				timer: undefined,
				since: Date.now(),
				waiting: null,
				lastTransient: null,
				failed: null,
			};
			this.#lanes.set(threadId, lane);
		}
		return lane;
	}

	#push(lane: Lane, op: Op) {
		if (lane.ops.length === 0) {
			lane.since = Date.now();
			lane.attempt = 0;
		}
		lane.ops.push(op);
		this.#changed();
		this.#pump();
	}

	#clearFailure(lane: Lane) {
		lane.failed = null;
		lane.refusedResolved = undefined;
	}

	/** Drops a lane with nothing left to show. */
	#prune(threadId: string) {
		const lane = this.#lanes.get(threadId);
		if (
			lane &&
			lane.ops.length === 0 &&
			!lane.failed &&
			lane.timer === undefined
		) {
			this.#lanes.delete(threadId);
		}
	}

	#pump() {
		for (const [threadId, lane] of this.#lanes) {
			if (this.#inFlight >= MAX_IN_FLIGHT) return;
			if (lane.sending || lane.timer !== undefined) continue;
			const op = lane.ops[0];
			if (!op) continue;
			lane.sending = true;
			this.#inFlight++;
			void this.#send(threadId, lane, op);
		}
	}

	async #send(threadId: string, lane: Lane, op: Op) {
		let update: ThreadUpdate;
		try {
			if (op.kind === "reply") {
				if (op.id.knownCommentIds.length === 0) {
					// First send: the thread as it is now, its earlier writes in.
					const found = this.#deps.knownComments(threadId);
					// In the cache: sent at once, no tick lost.
					const known = Array.isArray(found) ? found : await found;
					if (known.length === 0) throw new NoKnownCommentsError();
					op.id = { ...op.id, knownCommentIds: known };
					this.#deps.drafts.setKnown(threadId, op.id.attemptedAt, known);
				}
				const req: ReplyRequest = {
					body: op.text,
					attemptedAt: op.id.attemptedAt,
					retry: op.retry,
					clientId: op.id.clientId,
					knownCommentIds: op.id.knownCommentIds,
				};
				const answer = this.#deps.reply(threadId, req);
				this.#deps.drafts.markSent(threadId, op.id.attemptedAt);
				update = await answer;
			} else {
				update = await this.#deps.resolve(threadId, { resolved: op.resolved });
			}
		} catch (error) {
			lane.sending = false;
			this.#inFlight--;
			this.#failed(threadId, lane, op, error);
			return;
		}
		lane.sending = false;
		this.#inFlight--;
		try {
			this.#deps.applied(update);
		} catch {
			// Showing the answer failed; GitHub has it all the same.
		}
		if (op.kind === "reply") {
			this.#deps.drafts.confirm(threadId, op.id.attemptedAt);
			// GitHub took a reply: a pending review no longer blocks.
			this.#pendingReview = null;
		}
		lane.ops.shift();
		lane.attempt = 0;
		lane.waiting = null;
		lane.lastTransient = null;
		lane.since = Date.now();
		this.#prune(threadId);
		this.#changed();
		this.#pump();
	}

	#failed(threadId: string, lane: Lane, op: Op, error: unknown) {
		if (isTransient(error)) {
			// It may have landed: the resend asks GitHub first.
			if (op.kind === "reply") op.retry = true;
			const wait =
				RETRY_DELAYS_MS[Math.min(lane.attempt, RETRY_DELAYS_MS.length - 1)];
			lane.attempt++;
			lane.waiting = waitReason(error);
			lane.lastTransient = asError(error);
			lane.timer = setTimeout(() => {
				lane.timer = undefined;
				this.#pump();
			}, wait);
			this.#changed();
			this.#pump();
			return;
		}
		lane.ops.shift();
		lane.attempt = 0;
		lane.waiting = null;
		lane.lastTransient = null;
		lane.since = Date.now();
		const write = error instanceof ApiError ? error.write : undefined;
		lane.failed = {
			action: actionOf(op),
			error: asError(error),
			...(write?.code ? { code: write.code } : {}),
			...(write?.url ? { url: write.url } : {}),
		};
		if (op.kind === "reply") {
			lane.refusedResolved = undefined;
			this.#deps.drafts.returnToBox(threadId, op.id.attemptedAt);
			if (write?.code === "pending-review" && write.url) {
				this.#pendingReview = { url: write.url };
			}
		} else {
			// A newer resolve behind it already says what's intended.
			const newer = lane.ops.some((o) => o.kind === "resolve");
			lane.refusedResolved = newer ? undefined : op.resolved;
		}
		this.#changed();
		this.#pump();
	}

	#changed() {
		this.#state = this.#build();
		for (const listener of this.#listeners) listener();
	}

	#build(): ThreadWritesState {
		if (this.#delayTimer !== undefined) clearTimeout(this.#delayTimer);
		this.#delayTimer = undefined;
		const now = Date.now();
		let nextDelay = Number.POSITIVE_INFINITY;
		const threads = new Map<string, ThreadWriteView>();
		let busy = false;
		for (const [threadId, lane] of this.#lanes) {
			const head = lane.ops[0];
			let delayed = false;
			if (head) {
				const left = lane.since + DELAYED_MS - now;
				if (left <= 0) delayed = true;
				else nextDelay = Math.min(nextDelay, left);
			}
			const lastResolve = lane.ops.findLast((op) => op.kind === "resolve");
			const resolved =
				lastResolve?.kind === "resolve"
					? lastResolve.resolved
					: lane.refusedResolved;
			if (head || resolved !== undefined) busy = true;
			threads.set(threadId, {
				threadId,
				...(resolved === undefined ? {} : { resolved }),
				replies: lane.ops.flatMap((op) =>
					op.kind === "reply"
						? [{ text: op.text, attemptedAt: op.id.attemptedAt }]
						: [],
				),
				action: head ? actionOf(head) : null,
				delayed,
				waiting: head ? lane.waiting : null,
				stalled:
					head && lane.attempt >= STALL_ATTEMPTS ? lane.lastTransient : null,
				failed: lane.failed,
			});
		}
		if (nextDelay < Number.POSITIVE_INFINITY) {
			this.#delayTimer = setTimeout(() => {
				this.#delayTimer = undefined;
				this.#changed();
			}, nextDelay);
		}
		return { threads, pendingReview: this.#pendingReview, busy };
	}
}

// ---- The page's writes, per query client ----

const pages = new WeakMap<QueryClient, ThreadWrites>();

/**
 * GitHub's answer to a write, into what the page shows: the thread in
 * every read's thread lists (card, bubble, dot) and its comments
 * (commentsQuery), the read on screen included when they weren't read yet.
 */
export function applyThreadUpdate(
	client: QueryClient,
	update: ThreadUpdate,
): void {
	const { threadId } = update;
	client.setQueriesData<ThreadsView>({ queryKey: ["threads"] }, (view) => {
		if (!view?.threads.some((t) => t.id === threadId)) return view;
		return {
			...view,
			threads: view.threads.map((t) =>
				t.id === threadId
					? {
							...t,
							resolved: update.resolved,
							commentCount: update.commentCount,
							lastActivityAt: update.lastActivityAt,
							attention: update.attention,
							yourTurn: update.yourTurn,
							viewerCan: update.viewerCan,
							hasReply:
								t.hasReply ||
								update.comments.comments.some(
									(c) => !c.pending && c.author !== t.author,
								),
						}
					: t,
			),
		};
	});
	const comments = { ...update.comments, threadId };
	client.setQueriesData<ThreadComments>(
		{
			queryKey: ["comments"],
			predicate: (q) => q.queryKey[2] === threadId,
		},
		(old) => (old ? comments : old),
	);
	const readId = client.getQueryData(overviewQuery.queryKey)?.readId;
	if (readId) {
		client.setQueryData(commentsQuery(readId, threadId).queryKey, comments);
	}
}

/** The page's one ThreadWrites (and its drafts), per query client. */
export function threadWritesFor(client: QueryClient): ThreadWrites {
	let writes = pages.get(client);
	if (!writes) {
		writes = new ThreadWrites({
			reply: postReply,
			resolve: postResolved,
			applied: (update) => applyThreadUpdate(client, update),
			drafts: draftsFor(client),
			knownComments: (threadId) => {
				const readId = client.getQueryData(overviewQuery.queryKey)?.readId;
				if (!readId) return [];
				const ids = (c: ThreadComments | undefined) =>
					(c?.comments ?? []).map((x) => x.id).filter(Boolean);
				const cached = client.getQueryData<ThreadComments>(
					commentsQuery(readId, threadId).queryKey,
				);
				if (cached) return ids(cached);
				return client
					.fetchQuery(commentsQuery(readId, threadId))
					.then(ids, () => []);
			},
		});
		pages.set(client, writes);
	}
	return writes;
}

/** Pending, stalled and refused writes per thread, for notices and the threads. */
export function useThreadWrites(): ThreadWritesState {
	const writes = threadWritesFor(useQueryClient());
	return useSyncExternalStore(
		writes.subscribe,
		writes.getState,
		writes.getState,
	);
}

/** The page's writes, to act with. */
export function useThreadWriter(): ThreadWrites {
	return threadWritesFor(useQueryClient());
}

/** Whether this session writes to GitHub at all (not as of a cutoff or as another viewer). */
export function useWritesOn(): boolean {
	const overview = useQuery({ ...overviewQuery, enabled: false });
	return overview.data?.writes === "on";
}

/**
 * Keeps drafts under the session's PR from the moment it's known, and once
 * the overview says writing is on, resends the replies a reload left
 * unconfirmed (once per page).
 */
export function useThreadWritesSetup(): void {
	const client = useQueryClient();
	const writes = threadWritesFor(client);
	const session = useQuery({ ...sessionQuery, enabled: false });
	const pr = session.data?.pr;
	const key = pr ? draftsKey(pr) : null;
	const on = useWritesOn();
	const resumed = useRef(false);
	useEffect(() => {
		if (!key) return;
		writes.drafts.bind(key);
		if (on && !resumed.current) {
			resumed.current = true;
			writes.resume();
		}
	}, [writes, key, on]);
}

/** Threads as the reviewer intends them: a resolve not yet confirmed shows at once. */
export function overlayThreads<T extends ReviewThread>(
	threads: readonly T[],
	state: ThreadWritesState,
): T[] {
	if (state.threads.size === 0) return threads as T[];
	let changed = false;
	const next = threads.map((t) => {
		const resolved = state.threads.get(t.id)?.resolved;
		if (resolved === undefined || resolved === t.resolved) return t;
		changed = true;
		return { ...t, resolved };
	});
	return changed ? next : (threads as T[]);
}
