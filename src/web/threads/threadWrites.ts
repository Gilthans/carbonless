import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
	EditRequest,
	NewThreadAnswer,
	NewThreadRequest,
	ReplyRequest,
	ResolveRequest,
	ReviewThread,
	ThreadComment,
	ThreadComments,
	ThreadGone,
	ThreadsView,
	ThreadUpdate,
} from "../../shared/types";
import {
	ApiError,
	commentsQuery,
	deleteComment,
	overviewQuery,
	patchComment,
	postReply,
	postResolved,
	postThread,
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
	NEW_THREAD,
	newThreadKey,
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
/** How long a deleted comment can be undone before the delete is sent. */
export const DELETE_UNDO_MS = 5000;

export type WriteAction =
	| "Reply"
	| "Resolve"
	| "Unresolve"
	| "Edit"
	| "Delete"
	| "New comment";

type Op =
	| {
			kind: "reply";
			text: string;
			/** The first attempt, its client id and the comments known then: the server's duplicate check. */
			id: SendingId;
			/** A resend after a failed or unknown attempt: dedupe first. */
			retry: boolean;
			/** Resent on load, left unconfirmed by an earlier page. */
			resumed?: boolean;
			/** The reviewer discarded it: not sent again (one already out may land). */
			discarded?: boolean;
	  }
	| { kind: "resolve"; resolved: boolean }
	| {
			kind: "edit";
			commentId: string;
			text: string;
			/** The body the edit started from: refused (409) if GitHub's differs. */
			from: string;
			/** "Save anyway": no check. */
			force: boolean;
			/** Resent on load, left unconfirmed by an earlier page (always with the check). */
			resumed?: boolean;
			/** The reviewer discarded it: not sent again (one already out may land). */
			discarded?: boolean;
	  }
	| { kind: "delete"; commentId: string }
	| {
			kind: "create";
			clientId: string;
			/** A resend after a failed or unknown attempt: the server looks for it first. */
			retry: boolean;
			/** Resent on load, left unconfirmed by an earlier page. */
			resumed?: boolean;
			/** The reviewer discarded it: not sent again (one already out may land). */
			discarded?: boolean;
	  };

/** A write refused for a reason retrying won't fix: shown red until Retry. */
export interface WriteFailure {
	action: WriteAction;
	error: Error;
	code?: string;
	/** Where to fix it (a pending review: the PR's Files changed on GitHub). */
	url?: string;
	/** An edit or delete: the comment it was for. */
	commentId?: string;
	/** An edit refused as `changed`: the comment as GitHub has it now. */
	current?: ThreadComment;
	/** A refused "Save anyway": its Retry saves anyway too. */
	force?: boolean;
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
	/** Edits saved and not yet confirmed: the comment's new text, shown at once. */
	edits: { commentId: string; text: string }[];
	/**
	 * Comments deleted and not yet confirmed: `undo` while the delete waits
	 * out DELETE_UNDO_MS (nothing sent yet), then on its way.
	 */
	deletes: { commentId: string; undo: boolean }[];
	/** The write waiting now (the first in line). */
	action: WriteAction | null;
	/** A reply an earlier page left unconfirmed is being resent (it can be discarded). */
	resumed: boolean;
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
	/** Anything not yet on GitHub (a refused resolve and a delete still undoable included). */
	busy: boolean;
	/**
	 * Threads whose last comment the viewer deleted: gone on GitHub, still
	 * listed for FADE_MS (an Overview card fades) before the page drops them.
	 */
	gone: ReadonlySet<string>;
}

export interface ThreadWritesDeps {
	reply: (threadId: string, req: ReplyRequest) => Promise<ThreadUpdate>;
	resolve: (threadId: string, req: ResolveRequest) => Promise<ThreadUpdate>;
	edit: (
		threadId: string,
		commentId: string,
		req: EditRequest,
	) => Promise<ThreadUpdate>;
	remove: (
		threadId: string,
		commentId: string,
	) => Promise<ThreadUpdate | ThreadGone>;
	/** The thread is gone on GitHub (its last comment deleted): drop it from the page. */
	gone: (threadId: string) => void;
	/** "Show theirs": the comment as GitHub has it now, into the page. */
	theirs: (threadId: string, comment: ThreadComment) => void;
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
	/** Whether GitHub has the thread resolved, as last read or answered; undefined if unknown. */
	confirmedResolved?: (threadId: string) => boolean | undefined;
	/** A reply was newly posted: no pending review stands in the way any more. */
	posted?: () => void;
	/** Starts a thread (`POST /api/threads`). */
	create?: (req: NewThreadRequest) => Promise<NewThreadAnswer>;
	/** A new thread's answer: into every thread list and its comments. */
	created?: (answer: NewThreadAnswer) => void;
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
	/** Deletes waiting out DELETE_UNDO_MS, by comment id: nothing sent yet. */
	undo: Map<string, ReturnType<typeof setTimeout>>;
}

const actionOf = (op: Op): WriteAction =>
	op.kind === "create"
		? "New comment"
		: op.kind === "reply"
			? "Reply"
			: op.kind === "edit"
				? "Edit"
				: op.kind === "delete"
					? "Delete"
					: op.resolved
						? "Resolve"
						: "Unresolve";

const isGone = (answer: ThreadUpdate | ThreadGone): answer is ThreadGone =>
	(answer as Partial<ThreadGone>).gone === true;

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
 * The reviewer's writes to GitHub threads (replies, resolve, unresolve,
 * editing and deleting their comments), with the review states' timing
 * (stateSync.ts). Each is one explicit
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
 *   refused resolve keeps its intended state, a refused edit goes back to
 *   its editor (the draft kept), until retry();
 * - a delete waits DELETE_UNDO_MS first (undoDelete() cancels it, nothing
 *   sent), then goes in line like the rest.
 * Nothing is ever written without the reviewer's action: a reply left
 * unconfirmed by a reload is resent only through resume() (an edit too:
 * the server finds it landed).
 */
export class ThreadWrites {
	readonly #deps: ThreadWritesDeps;
	readonly #lanes = new Map<string, Lane>();
	#inFlight = 0;
	#pendingReview: { url: string } | null = null;
	#lastAttempt = 0;
	#delayTimer: ReturnType<typeof setTimeout> | undefined;
	/** Threads gone on GitHub, fading before the page drops them. */
	readonly #gone = new Map<string, ReturnType<typeof setTimeout>>();
	/** `#gone`'s ids as the state shows them: a new set only when they change. */
	#goneIds: ReadonlySet<string> = new Set();
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

	/**
	 * Posts the new thread's draft (drafts.ts `create`, blank never sent): it
	 * shows at once as sending, the draft kept until GitHub has it. Its lane
	 * is `new:<clientId>`.
	 */
	createThread(clientId: string): void {
		const { drafts } = this.#deps;
		const draft = drafts.newThread(clientId);
		if (!draft?.create || !draft.text.trim() || draft.create.sending) return;
		const lane = this.#lane(newThreadKey(clientId));
		if (lane.failed) this.#clearFailure(lane);
		drafts.markNewSending(clientId, this.#stamp());
		this.#push(lane, { kind: "create", clientId, retry: false });
	}

	/**
	 * Resolves or unresolves the thread. Back to the state GitHub has with
	 * none of it on its way (an undo, a refused one let go): nothing is sent,
	 * and what waited in line for it is dropped.
	 */
	setResolved(threadId: string, resolved: boolean): void {
		const lane = this.#lane(threadId);
		if (lane.refusedResolved !== undefined) this.#clearFailure(lane);
		const outResolve = lane.sending && lane.ops[0]?.kind === "resolve";
		if (!outResolve && this.#deps.confirmedResolved?.(threadId) === resolved) {
			lane.ops = lane.ops.filter(
				(op, i) => op.kind !== "resolve" || (i === 0 && lane.sending),
			);
			this.#prune(threadId);
			this.#changed();
			return;
		}
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
				// Certainly new: nothing to look for first.
				lane.ops.push({ kind: "reply", text, id, retry: false });
			}
		} else if (failed?.action === "New comment") {
			this.#clearFailure(lane);
			const clientId = threadId.slice(NEW_THREAD.length);
			const draft = this.#deps.drafts.newThread(clientId);
			if (draft?.create && draft.text.trim()) {
				this.#deps.drafts.markNewSending(clientId, this.#stamp());
				// Refused (4xx): it didn't land, but a look first costs little.
				lane.ops.push({ kind: "create", clientId, retry: true });
			}
		} else if (failed?.action === "Edit" && failed.commentId) {
			this.#clearFailure(lane);
			const op = this.#editOp(failed.commentId, failed.force === true);
			if (op) lane.ops.push(op);
		} else if (failed?.action === "Delete" && failed.commentId) {
			this.#clearFailure(lane);
			// Asked for again, explicitly: sent now, no second undo window.
			lane.ops.push({ kind: "delete", commentId: failed.commentId });
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
			if (d.create?.sending) {
				const { clientId } = d.create;
				const lane = this.#lane(d.threadId);
				const known = lane.ops.some(
					(op) => op.kind === "create" && op.clientId === clientId,
				);
				if (known) continue;
				lane.ops.push({
					kind: "create",
					clientId,
					retry: true,
					resumed: true,
				});
				if (lane.ops.length === 1) lane.since = Date.now();
				continue;
			}
			if (d.edit?.saving) {
				const { commentId } = d.edit;
				const lane = this.#lane(d.threadId);
				const known = lane.ops.some(
					(op) => op.kind === "edit" && op.commentId === commentId,
				);
				if (known) continue;
				// The server finds it landed (GitHub's body is the new text);
				// never forced: GitHub may have a newer edit since.
				lane.ops.push({
					kind: "edit",
					commentId,
					text: d.text,
					from: d.edit.from,
					force: false,
					resumed: true,
				});
				if (lane.ops.length === 1) lane.since = Date.now();
				continue;
			}
			if (!d.sending) continue;
			const { sentOnce: _, ...id } = d.sending;
			const lane = this.#lane(d.threadId);
			const known = lane.ops.some(
				(op) => op.kind === "reply" && op.id.clientId === id.clientId,
			);
			if (known) continue;
			lane.ops.push({
				kind: "reply",
				text: d.text,
				id,
				retry: true,
				resumed: true,
			});
			if (lane.ops.length === 1) lane.since = Date.now();
		}
		this.#changed();
		this.#pump();
	}

	/**
	 * Lets a refused write go: a refused resolve or unresolve is dropped
	 * (GitHub's state shows again); a refused reply's notice clears, its
	 * text staying in the box as a draft.
	 */
	dismiss(threadId: string): void {
		const lane = this.#lanes.get(threadId);
		if (!lane?.failed) return;
		this.#clearFailure(lane);
		this.#prune(threadId);
		this.#changed();
	}

	/**
	 * Drops the thread's draft, its edit drafts and its replies and edits not
	 * yet sent or resent (one already out may still land: GitHub then shows
	 * it). The reviewer's
	 * explicit choice; nothing else ever drops typed text.
	 */
	discard(threadId: string): void {
		const lane = this.#lanes.get(threadId);
		if (lane) {
			lane.ops = lane.ops.filter((op, i) => {
				if (op.kind === "edit") return i === 0 && lane.sending;
				if (op.kind === "create") {
					if (i === 0 && lane.sending) {
						op.discarded = true;
						return true;
					}
					return false;
				}
				if (op.kind !== "reply") return true;
				if (i === 0 && lane.sending) {
					op.discarded = true;
					return true;
				}
				return false;
			});
			if (
				lane.failed?.action === "Reply" ||
				lane.failed?.action === "Edit" ||
				lane.failed?.action === "New comment"
			) {
				this.#clearFailure(lane);
			}
			if (lane.ops.length === 0 && lane.timer !== undefined) {
				clearTimeout(lane.timer);
				lane.timer = undefined;
			}
			this.#prune(threadId);
		}
		this.#deps.drafts.discard(threadId);
		this.#changed();
	}

	/**
	 * Drops only the replies and edits resent from an earlier page (their
	 * drafts too): the box and writes made since stay. One already out is
	 * marked so it's never sent again (if it lands, GitHub shows it).
	 */
	discardResumed(threadId: string): void {
		const lane = this.#lanes.get(threadId);
		if (!lane) return;
		const dropped: string[] = [];
		const edits: string[] = [];
		const created: string[] = [];
		lane.ops = lane.ops.filter((op, i) => {
			if (op.kind === "edit" && op.resumed) {
				edits.push(op.commentId);
				if (i === 0 && lane.sending) {
					op.discarded = true;
					return true;
				}
				return false;
			}
			if (op.kind === "create" && op.resumed) {
				created.push(op.clientId);
				if (i === 0 && lane.sending) {
					op.discarded = true;
					return true;
				}
				return false;
			}
			if (op.kind !== "reply" || !op.resumed) return true;
			dropped.push(op.id.attemptedAt);
			if (i === 0 && lane.sending) {
				op.discarded = true;
				return true;
			}
			return false;
		});
		// The one waiting out a backoff is gone: the next goes now.
		if (
			dropped.length + edits.length + created.length > 0 &&
			!lane.sending &&
			lane.timer !== undefined
		) {
			clearTimeout(lane.timer);
			lane.timer = undefined;
			lane.attempt = 0;
			lane.waiting = null;
			lane.lastTransient = null;
			lane.since = Date.now();
		}
		for (const at of dropped) this.#deps.drafts.confirm(threadId, at);
		for (const id of edits) this.#deps.drafts.dropEdit(id);
		for (const id of created) this.#deps.drafts.discard(newThreadKey(id));
		this.#prune(threadId);
		this.#changed();
		this.#pump();
	}

	/**
	 * Saves the comment's edit draft to GitHub (`force`: "Save anyway", no
	 * changed-on-GitHub check). Its new text shows at once; the editor
	 * closes. Nothing when the draft is blank or unchanged.
	 */
	saveEdit(threadId: string, commentId: string, force = false): void {
		const lane = this.#lane(threadId);
		const op = this.#editOp(commentId, force);
		if (!op) {
			this.#prune(threadId);
			return;
		}
		if (lane.failed?.commentId === commentId) this.#clearFailure(lane);
		this.#push(lane, op);
	}

	/** Lets the comment's edit go: its draft dropped, a refusal of it cleared. */
	cancelEdit(threadId: string, commentId: string): void {
		this.#deps.drafts.dropEdit(commentId);
		const lane = this.#lanes.get(threadId);
		if (
			lane?.failed?.action === "Edit" &&
			lane.failed.commentId === commentId
		) {
			this.#clearFailure(lane);
			this.#prune(threadId);
		}
		this.#changed();
	}

	/**
	 * An edit refused as changed on GitHub: GitHub's text into the page, and
	 * the draft starts from it now (the reviewer has seen theirs: a Save
	 * then saves over it). The draft stays in the editor.
	 */
	showTheirs(threadId: string): void {
		const lane = this.#lanes.get(threadId);
		const failed = lane?.failed;
		if (!lane || failed?.action !== "Edit" || !failed.commentId) return;
		if (failed.current) {
			try {
				this.#deps.theirs(threadId, failed.current);
			} catch {}
			this.#deps.drafts.setFrom(failed.commentId, failed.current.body);
		}
		this.#clearFailure(lane);
		this.#prune(threadId);
		this.#changed();
	}

	/**
	 * Deletes the comment: shown deleted at once, sent after DELETE_UNDO_MS
	 * unless undone (GitHub blanks a thread's opener with replies after it
	 * to "[deleted]" instead; the server decides).
	 */
	deleteComment(threadId: string, commentId: string): void {
		if (!commentId) return;
		const lane = this.#lane(threadId);
		const out = lane.ops.some(
			(op) => op.kind === "delete" && op.commentId === commentId,
		);
		if (out || lane.undo.has(commentId)) return;
		if (lane.failed?.commentId === commentId) this.#clearFailure(lane);
		lane.undo.set(
			commentId,
			setTimeout(() => {
				lane.undo.delete(commentId);
				this.#push(lane, { kind: "delete", commentId });
			}, DELETE_UNDO_MS),
		);
		this.#changed();
	}

	/** Undoes a delete still waiting out its window: nothing is sent. */
	undoDelete(threadId: string, commentId: string): void {
		const lane = this.#lanes.get(threadId);
		const timer = lane?.undo.get(commentId);
		if (!lane || timer === undefined) return;
		clearTimeout(timer);
		lane.undo.delete(commentId);
		this.#prune(threadId);
		this.#changed();
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

	/** The edit draft's save, or null when blank or unchanged (the draft is dropped then). */
	#editOp(commentId: string, force: boolean): Op | null {
		const { drafts } = this.#deps;
		const draft = drafts.edit(commentId);
		if (!draft?.edit) return null;
		if (!draft.text.trim() || draft.text === draft.edit.from) {
			if (draft.text === draft.edit.from) drafts.dropEdit(commentId);
			return null;
		}
		drafts.markSaving(commentId, true);
		return {
			kind: "edit",
			commentId,
			text: draft.text,
			from: draft.edit.from,
			force,
		};
	}

	/** The thread is gone on GitHub: listed as gone for FADE_MS, then dropped. */
	#markGone(threadId: string) {
		if (this.#gone.has(threadId)) return;
		this.#gone.set(
			threadId,
			setTimeout(() => this.#dropGone(threadId), FADE_MS),
		);
		this.#goneIds = new Set(this.#gone.keys());
	}

	#dropGone(threadId: string) {
		clearTimeout(this.#gone.get(threadId));
		this.#gone.delete(threadId);
		this.#goneIds = new Set(this.#gone.keys());
		try {
			this.#deps.gone(threadId);
		} catch {}
		this.#changed();
	}

	/** Those of these threads fading out as gone leave now (the list was switched). */
	settleGone(threadIds: Iterable<string>): void {
		for (const id of threadIds) if (this.#gone.has(id)) this.#dropGone(id);
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
				undo: new Map(),
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
			lane.timer === undefined &&
			lane.undo.size === 0
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
		if (op.kind === "create") return this.#sendCreate(threadId, lane, op);
		let update: ThreadUpdate | ThreadGone;
		try {
			if (op.kind === "reply") {
				if (op.id.knownCommentIds.length === 0) {
					// First send: the thread as it is now, its earlier writes in.
					const found = this.#deps.knownComments(threadId);
					// In the cache: sent at once, no tick lost.
					const known = Array.isArray(found) ? found : await found;
					// Discarded while the comments were read: never posted.
					if (op.discarded) throw new Error("Discarded");
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
			} else if (op.kind === "edit") {
				update = await this.#deps.edit(threadId, op.commentId, {
					body: op.text,
					from: op.from,
					force: op.force,
				});
			} else if (op.kind === "delete") {
				update = await this.#deps.remove(threadId, op.commentId);
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
		this.#landed(threadId, op, update);
		if (op.kind === "reply") {
			this.#deps.drafts.confirm(threadId, op.id.attemptedAt);
			// GitHub took a new reply: a pending review no longer blocks. (A
			// retry may have found an earlier one while a review is pending.)
			if (!op.retry) {
				this.#pendingReview = null;
				this.#deps.posted?.();
			}
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

	/** A new thread's post: its draft is the request (the text as it is now). */
	async #sendCreate(
		laneId: string,
		lane: Lane,
		op: Extract<Op, { kind: "create" }>,
	) {
		const { drafts } = this.#deps;
		let answer: NewThreadAnswer;
		try {
			const draft = drafts.newThread(op.clientId);
			const c = draft?.create;
			if (!draft || !c || op.discarded) throw new Error("Discarded");
			if (!this.#deps.create) throw new Error("Can't start threads here");
			const { clientId: _, createdAt: __, sending, ...target } = c;
			const req: NewThreadRequest = {
				...target,
				clientId: op.clientId,
				body: draft.text,
				attemptedAt: sending?.attemptedAt ?? this.#stamp(),
				retry: op.retry || sending?.sentOnce === true,
			};
			const out = this.#deps.create(req);
			drafts.markNewSent(op.clientId);
			answer = await out;
		} catch (error) {
			lane.sending = false;
			this.#inFlight--;
			this.#failed(laneId, lane, op, error);
			return;
		}
		lane.sending = false;
		this.#inFlight--;
		try {
			this.#deps.created?.(answer);
		} catch {
			// Showing it failed; GitHub has it all the same.
		}
		drafts.discard(laneId);
		if (!op.retry) {
			this.#pendingReview = null;
			this.#deps.posted?.();
		}
		lane.ops.shift();
		lane.attempt = 0;
		lane.waiting = null;
		lane.lastTransient = null;
		lane.since = Date.now();
		this.#prune(laneId);
		this.#changed();
		this.#pump();
	}

	/** GitHub's answer into the page, and what it settles. */
	#landed(threadId: string, op: Op, answer: ThreadUpdate | ThreadGone) {
		try {
			if (isGone(answer)) this.#markGone(threadId);
			else this.#deps.applied(answer);
		} catch {
			// Showing the answer failed; GitHub has it all the same.
		}
		if (op.kind === "edit") {
			// Saved: the draft has served (unless typed in again since).
			const draft = this.#deps.drafts.edit(op.commentId);
			if (draft?.edit?.saving && draft.text === op.text) {
				this.#deps.drafts.dropEdit(op.commentId);
			}
		} else if (op.kind === "delete") {
			this.#deps.drafts.dropEdit(op.commentId);
		}
	}

	#failed(threadId: string, lane: Lane, op: Op, error: unknown) {
		if (
			(op.kind === "reply" || op.kind === "edit" || op.kind === "create") &&
			op.discarded
		) {
			// Discarded while out: it didn't land, or a reload shows it did.
			lane.ops.shift();
			lane.attempt = 0;
			lane.waiting = null;
			lane.lastTransient = null;
			lane.since = Date.now();
			this.#prune(threadId);
			this.#changed();
			this.#pump();
			return;
		}
		if (isTransient(error)) {
			// It may have landed: the resend asks GitHub first.
			if (op.kind === "reply" || op.kind === "create") op.retry = true;
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
		const write = error instanceof ApiError ? error.write : undefined;
		if (op.kind === "delete" && write?.code === "gone") {
			// The thread is gone on GitHub (a comment already gone answers
			// 200): what the delete wanted, at the least.
			this.#landed(threadId, op, { threadId, gone: true });
			lane.ops.shift();
			lane.attempt = 0;
			lane.waiting = null;
			lane.lastTransient = null;
			lane.since = Date.now();
			this.#prune(threadId);
			this.#changed();
			this.#pump();
			return;
		}
		lane.ops.shift();
		lane.attempt = 0;
		lane.waiting = null;
		lane.lastTransient = null;
		lane.since = Date.now();
		lane.failed = {
			action: actionOf(op),
			error: asError(error),
			...(write?.code ? { code: write.code } : {}),
			...(write?.url ? { url: write.url } : {}),
			...(op.kind === "edit" || op.kind === "delete"
				? { commentId: op.commentId }
				: {}),
			...(op.kind === "edit" && write?.current
				? { current: write.current }
				: {}),
			...(op.kind === "edit" && op.force ? { force: true } : {}),
		};
		if (op.kind === "edit") {
			// Back in its editor, as typed: nothing typed is lost.
			lane.refusedResolved = undefined;
			this.#deps.drafts.markSaving(op.commentId, false);
		} else if (op.kind === "delete") {
			// The comment shows again; Retry deletes it.
			lane.refusedResolved = undefined;
		} else if (op.kind === "reply" || op.kind === "create") {
			lane.refusedResolved = undefined;
			// Back to its box, as typed: nothing typed is lost.
			if (op.kind === "reply") {
				this.#deps.drafts.returnToBox(threadId, op.id.attemptedAt);
			} else this.#deps.drafts.markNewSending(op.clientId, null);
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
			if (head || resolved !== undefined || lane.undo.size > 0) busy = true;
			threads.set(threadId, {
				threadId,
				...(resolved === undefined ? {} : { resolved }),
				replies: lane.ops.flatMap((op) =>
					op.kind === "reply"
						? [{ text: op.text, attemptedAt: op.id.attemptedAt }]
						: [],
				),
				edits: lane.ops.flatMap((op) =>
					op.kind === "edit"
						? [{ commentId: op.commentId, text: op.text }]
						: [],
				),
				deletes: [
					...[...lane.undo.keys()].map((commentId) => ({
						commentId,
						undo: true,
					})),
					...lane.ops.flatMap((op) =>
						op.kind === "delete"
							? [{ commentId: op.commentId, undo: false }]
							: [],
					),
				],
				action: head ? actionOf(head) : null,
				resumed:
					(head?.kind === "reply" ||
						head?.kind === "edit" ||
						head?.kind === "create") &&
					head.resumed === true &&
					!head.discarded,
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
		return {
			threads,
			pendingReview: this.#pendingReview,
			busy,
			gone: this.#goneIds,
		};
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
	// An edit or blanking of the opener: the card shows its new text.
	const first = update.comments.comments[0];
	const opener =
		update.comment && first && update.comment.id === first.id
			? openerText(first)
			: {};
	client.setQueriesData<ThreadsView>({ queryKey: ["threads"] }, (view) => {
		if (!view?.threads.some((t) => t.id === threadId)) return view;
		return {
			...view,
			threads: view.threads.map((t) =>
				t.id === threadId
					? {
							...t,
							...opener,
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

/**
 * A new thread GitHub took, into the page: listed first in every read's
 * thread lists (no one else has it twice), its comments in.
 */
export function addThread(client: QueryClient, answer: NewThreadAnswer): void {
	const { thread } = answer;
	client.setQueriesData<ThreadsView>({ queryKey: ["threads"] }, (view) =>
		!view || view.threads.some((t) => t.id === thread.id)
			? view
			: { ...view, threads: [thread, ...view.threads] },
	);
	const comments = { ...answer.comments, threadId: thread.id };
	const readId = client.getQueryData(overviewQuery.queryKey)?.readId;
	if (readId) {
		client.setQueryData(commentsQuery(readId, thread.id).queryKey, comments);
	}
}

/** A thread's opener text fields, from its first comment. */
const openerText = (c: ThreadComment) => ({
	html: c.html,
	body: c.body,
	excerpt: c.text.replace(/\s+/g, " ").trim().slice(0, 200),
});

/** The comment as GitHub has it now ("Show theirs"), into the page. */
export function applyComment(
	client: QueryClient,
	threadId: string,
	comment: ThreadComment,
): void {
	let first = false;
	client.setQueriesData<ThreadComments>(
		{
			queryKey: ["comments"],
			predicate: (q) => q.queryKey[2] === threadId,
		},
		(old) => {
			if (!old) return old;
			const i = old.comments.findIndex((c) => c.id === comment.id);
			if (i < 0) return old;
			if (i === 0) first = true;
			const comments = [...old.comments];
			comments[i] = comment;
			return { ...old, comments };
		},
	);
	if (!first) return;
	client.setQueriesData<ThreadsView>({ queryKey: ["threads"] }, (view) =>
		view?.threads.some((t) => t.id === threadId)
			? {
					...view,
					threads: view.threads.map((t) =>
						t.id === threadId ? { ...t, ...openerText(comment) } : t,
					),
				}
			: view,
	);
}

/** A thread gone on GitHub (its last comment deleted): out of every list, its comments gone. */
export function dropThread(client: QueryClient, threadId: string): void {
	client.setQueriesData<ThreadsView>({ queryKey: ["threads"] }, (view) =>
		view?.threads.some((t) => t.id === threadId)
			? { ...view, threads: view.threads.filter((t) => t.id !== threadId) }
			: view,
	);
	client.setQueriesData<ThreadComments>(
		{
			queryKey: ["comments"],
			predicate: (q) => q.queryKey[2] === threadId,
		},
		(old) => (old ? { threadId, comments: [], unavailable: "deleted" } : old),
	);
}

/** The page's one ThreadWrites (and its drafts), per query client. */
export function threadWritesFor(client: QueryClient): ThreadWrites {
	let writes = pages.get(client);
	if (!writes) {
		writes = new ThreadWrites({
			reply: postReply,
			resolve: postResolved,
			edit: patchComment,
			remove: deleteComment,
			create: postThread,
			created: (answer) => addThread(client, answer),
			applied: (update) => applyThreadUpdate(client, update),
			gone: (threadId) => dropThread(client, threadId),
			theirs: (threadId, comment) => applyComment(client, threadId, comment),
			drafts: draftsFor(client),
			confirmedResolved: (threadId) => {
				const lists = client.getQueriesData<ThreadsView>({
					queryKey: ["threads"],
				});
				for (let i = lists.length - 1; i >= 0; i--) {
					const t = lists[i]?.[1]?.threads.find((x) => x.id === threadId);
					if (t) return t.resolved;
				}
				return undefined;
			},
			posted: () => {
				client.setQueryData(overviewQuery.queryKey, (o) =>
					o?.pendingReview ? { ...o, pendingReview: null } : o,
				);
			},
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
		// Resolved waits on no one (the server's rule): the dot goes at once.
		return resolved
			? { ...t, resolved, attention: [], yourTurn: false }
			: { ...t, resolved };
	});
	return changed ? next : (threads as T[]);
}
