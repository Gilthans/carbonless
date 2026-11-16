/**
 * An agent message's ```comment blocks (CAR-83): where each posts, its
 * box's draft, and the post itself. The agent only suggests: a block
 * posts on the reviewer's press alone, exactly the box's text, as the
 * reviewer, where its conversation sits (a new thread on its lines or
 * file at the snapshot's head, or a reply to its GitHub thread).
 *
 * Never twice: each block posts under one client id
 * (agentCommentClientId), the same on every device and after a reload,
 * always as a retry, so the server looks for it on GitHub before posting
 * (newThreads.ts by its marker, threadWrites.ts by its text). Once GitHub
 * has it, `agent-comment-posted` is recorded (POST agent/threads/:tid/posted)
 * and the box shows Posted from then on; until that lands it shows Posted
 * for this page's life (`postedHere`). Nothing posts on its own but a
 * press cut short by a reload, which the box resends once (it may have
 * landed: the server looks first). A refusal is never resent.
 */
import type { QueryClient } from "@tanstack/react-query";
import {
	type AgentAnchor,
	type AgentMessage,
	type AgentPostedComment,
	type AgentPostedRequest,
	type AgentThread,
	agentCommentClientId,
} from "../../shared/agent";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import type { ThreadComments } from "../../shared/types";
import {
	ApiError,
	commentsQuery,
	overviewQuery,
	postReply,
	postThread,
	sessionQuery,
} from "../api";
import { describeSpan } from "../files/selectionActions";
import { isTransient } from "../files/stateSync";
import type { NewTarget } from "../threads/drafts";
import { newThreadError } from "../threads/NewThread";
import { addThread, applyThreadUpdate } from "../threads/threadWrites";
import { agentThreadsQuery, postAgentPosted, withThread } from "./api";

export const LINES_GONE = "These lines are gone in the latest push";
export const THREAD_GONE = "This GitHub thread was deleted";
export const UNTRACED = "Couldn't trace these lines to the latest push";
export const CHANGED = "The code here changed since the agent wrote this";
export const WRITES_OFF = "Not writing to GitHub here";

/** Where a block posts, or why it can't (yet). */
export type CommentPlace =
	/** A reply to the conversation's GitHub thread. */
	| { kind: "reply"; thread: string }
	/** A new thread; `changed`: on the lines that replaced the asked ones. */
	| { kind: "new"; target: NewTarget; changed: boolean }
	/** The placement is on its way: a spinner, never "gone" (principle 8). */
	| { kind: "pending" }
	| { kind: "off"; why: string };

const lineTarget = (
	path: string,
	commit: string,
	a: {
		side: NewTarget["side"];
		line: number;
		startSide: NewTarget["side"];
		startLine: number;
	},
	cols: { startCol?: number | null; endCol?: number | null } | null,
): NewTarget => ({
	path,
	commit,
	subject: "line",
	startSide: a.startSide,
	startLine: a.startLine,
	side: a.side,
	line: a.line,
	...(cols && cols.startCol != null && cols.endCol != null
		? { startCol: cols.startCol, endCol: cols.endCol }
		: {}),
});

/**
 * Where a block of `thread` posts on `head` (the snapshot's), from the
 * conversation's placement there (GET agent/placements?head=): an anchor
 * already on the head as it is; placed keeps lines and columns, changed
 * the lines only, a file comment its file; unplaced or outside are gone.
 * A GitHub-thread conversation replies to its thread, unless it's gone.
 */
export function commentPlace(args: {
	thread: AgentThread;
	head: string | undefined;
	placement: ThreadPlacement | undefined;
	/** The placements: in (`placement` undefined: not traced), on their way, or failed. */
	placing: "in" | "pending" | "failed";
}): CommentPlace {
	const { thread, head, placement, placing } = args;
	const a = thread.anchor;
	if (a.subject === "thread") {
		return thread.orphaned
			? { kind: "off", why: THREAD_GONE }
			: { kind: "reply", thread: a.thread };
	}
	if (!head) return { kind: "pending" };
	if (a.commit === head) {
		return {
			kind: "new",
			changed: false,
			target:
				a.subject === "file"
					? { path: a.path, commit: head, subject: "file" }
					: lineTarget(a.path, head, a, a),
		};
	}
	if (placing === "pending") return { kind: "pending" };
	if (placing === "failed" || !placement) return { kind: "off", why: UNTRACED };
	switch (placement.kind) {
		case "placed":
			return {
				kind: "new",
				changed: false,
				target: lineTarget(
					placement.anchor.path,
					head,
					placement.anchor,
					a.subject === "line" ? a : null,
				),
			};
		case "changed":
			return {
				kind: "new",
				changed: true,
				target: lineTarget(placement.anchor.path, head, placement.anchor, null),
			};
		case "file":
			return {
				kind: "new",
				changed: false,
				target: { path: placement.path, commit: head, subject: "file" },
			};
		default:
			return { kind: "off", why: LINES_GONE };
	}
}

/** `L41–44`, `L41:8–44:20` (columns 1-based, the end inclusive), `L3`. */
function shortLines(s: {
	startLine?: number;
	line?: number;
	startCol?: number | null;
	endCol?: number | null;
}): string {
	const end = s.line ?? 0;
	const start = s.startLine ?? end;
	if (s.startCol != null && s.endCol != null) {
		return `L${start}:${s.startCol + 1}–${end}:${s.endCol}`;
	}
	return start === end ? `L${end}` : `L${start}–${end}`;
}

/** The header's target: short (`L41–44`, `File`, `Reply`) and in full for its tooltip. */
export function placeLabel(
	place: CommentPlace,
	anchor: AgentAnchor,
): { short: string; full: string } {
	if (place.kind === "reply") {
		return { short: "Reply", full: "Reply on this GitHub thread" };
	}
	if (place.kind === "new") {
		const t = place.target;
		if (t.subject === "file") {
			return { short: "File", full: `New comment on ${t.path}` };
		}
		const moved = t.commit !== anchor.commit || t.path !== anchor.path;
		return {
			short: shortLines(t),
			full: `New thread on ${t.path}, ${describeSpan(t)}${moved ? ", at the latest push" : ""}`,
		};
	}
	// Where it was asked.
	if (anchor.subject === "file") return { short: "File", full: anchor.path };
	if (anchor.subject === "thread" && anchor.line === undefined) {
		return { short: "Reply", full: "Reply on this GitHub thread" };
	}
	const short = shortLines(anchor);
	return { short, full: `${anchor.path}, ${short}` };
}

/**
 * The thread's comment ids a reply's retry may not take for itself: those
 * published by the time the agent wrote the block (`at`), and pending
 * ones. Any later comment of the viewer's with the same text is this one.
 */
export function knownBefore(
	comments: readonly { id: string; publishedAt: string | null }[],
	at: string,
): string[] {
	const by = Date.parse(at);
	return comments
		.filter(
			(c) =>
				c.id && (c.publishedAt === null || Date.parse(c.publishedAt) <= by),
		)
		.map((c) => c.id);
}

/** Why GitHub (or crb) refused the post, in a few words. */
export function refusalText(error: Error, place: CommentPlace): string {
	const code = error instanceof ApiError ? error.write?.code : undefined;
	if (place.kind === "reply" && code === "gone") return THREAD_GONE;
	return newThreadError(
		{ ...(code ? { code } : {}), error },
		place.kind === "new" ? { subject: place.target.subject } : undefined,
	);
}

// ---- Per block, in this browser: its draft and a press on its way. ----

/** What the browser keeps for one block (by client id). */
interface Kept {
	/** The box's text, when it differs from the agent's. */
	text?: string;
	/** Pressed, GitHub's answer not seen yet: resent once on the next load. */
	sending?: { attemptedAt: string; body: string; known?: string[] };
}

const keyOf = (clientId: string) => `crb:agent-comment:${clientId}`;

function storage(): Storage | undefined {
	try {
		return globalThis.localStorage ?? undefined;
	} catch {
		return undefined;
	}
}

/** Memory, where storage throws or is missing (and in front of it). */
const memory = new Map<string, Kept>();
const listeners = new Set<() => void>();

export function keptOf(clientId: string): Kept {
	const inMemory = memory.get(clientId);
	if (inMemory) return inMemory;
	try {
		const raw = storage()?.getItem(keyOf(clientId));
		if (!raw) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return {};
		const p = parsed as Kept;
		const s = p.sending;
		return {
			...(typeof p.text === "string" ? { text: p.text } : {}),
			...(s &&
			typeof s.attemptedAt === "string" &&
			typeof s.body === "string" &&
			(s.known === undefined ||
				(Array.isArray(s.known) && s.known.every((x) => typeof x === "string")))
				? { sending: s }
				: {}),
		};
	} catch {
		return {};
	}
}

function setKept(clientId: string, kept: Kept): void {
	const empty = kept.text === undefined && kept.sending === undefined;
	if (empty) memory.delete(clientId);
	else memory.set(clientId, kept);
	try {
		const s = storage();
		if (empty) s?.removeItem(keyOf(clientId));
		else s?.setItem(keyOf(clientId), JSON.stringify(kept));
	} catch {
		// Memory only: the page keeps it for its life.
	}
	for (const l of listeners) l();
}

/** The box's text now edited to `text` (kept while it differs from the agent's). */
export function setDraft(clientId: string, text: string, agent: string): void {
	const { text: _, ...rest } = keptOf(clientId);
	setKept(clientId, text === agent ? rest : { ...rest, text });
}

export function subscribeKept(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Blocks posted on this page whose record may not have been written. */
const postedHere = new Map<string, AgentPostedComment>();

export function postedOnPage(clientId: string): AgentPostedComment | undefined {
	return postedHere.get(clientId);
}

/** Forgets this page's memory (tests: a reload). */
export function resetAgentComments(): void {
	postedHere.clear();
	memory.clear();
	resent.clear();
	for (const l of listeners) l();
}

/** Blocks this page has looked at for a press a reload cut short (once each). */
const resent = new Set<string>();

/**
 * A press an earlier page left on its way, to resend now: asked once per
 * block per page, so a press made on this page is never taken for one.
 */
export function takeResend(clientId: string): Kept["sending"] | undefined {
	if (resent.has(clientId)) return undefined;
	resent.add(clientId);
	if (postedHere.has(clientId)) return undefined;
	return keptOf(clientId).sending;
}

/** A failed post: refused (shown, never resent) or in doubt (it may have landed). */
export class AgentCommentError extends Error {
	constructor(
		override readonly cause: Error,
		readonly inDoubt: boolean,
	) {
		super(cause.message);
		this.name = "AgentCommentError";
	}
}

/** The conversation's GitHub thread's comment ids, as the page has them or reads them. */
async function threadCommentIds(
	client: QueryClient,
	threadId: string,
	at: string,
): Promise<string[]> {
	const readId = client.getQueryData(overviewQuery.queryKey)?.readId;
	if (!readId) return [];
	const q = commentsQuery(readId, threadId);
	const cached = client.getQueryData<ThreadComments>(q.queryKey);
	const comments = cached ?? (await client.fetchQuery(q).catch(() => null));
	return knownBefore(comments?.comments ?? [], at);
}

/**
 * Posts block `block` of `message` (in conversation `thread`) to GitHub at
 * `place`, as `body` (the box's text): always as a retry under the
 * block's client id, so it never posts twice. Then records it; a record
 * that fails leaves it Posted for this page, and the next press (after a
 * reload) finds it on GitHub instead of posting again.
 */
export async function postAgentComment(
	client: QueryClient,
	args: {
		thread: AgentThread;
		message: AgentMessage;
		block: number;
		body: string;
		place: Extract<CommentPlace, { kind: "reply" | "new" }>;
		/** A resend of a press cut short by a reload: as it was sent. */
		resend?: NonNullable<Kept["sending"]>;
	},
): Promise<AgentPostedComment> {
	const { thread, message, block, place } = args;
	const clientId = agentCommentClientId(thread.id, message.id, block);
	const kept = keptOf(clientId);
	const sending = args.resend ??
		kept.sending ?? {
			attemptedAt: new Date().toISOString(),
			body: args.body,
		};
	// A new press sends the box as it is now; a resend as it was sent.
	const body = args.resend ? args.resend.body : args.body;
	let github: AgentPostedRequest["github"];
	let url: string | undefined;
	try {
		if (place.kind === "reply") {
			const known =
				sending.known ??
				(await threadCommentIds(client, place.thread, message.at));
			if (known.length === 0) {
				throw new ApiError(0, "Couldn't read the thread's comments");
			}
			setKept(clientId, {
				...keptOf(clientId),
				sending: { ...sending, body, known },
			});
			const answer = await postReply(place.thread, {
				body,
				attemptedAt: sending.attemptedAt,
				retry: true,
				clientId,
				knownCommentIds: known,
			});
			try {
				applyThreadUpdate(client, answer);
			} catch {
				// Showing it failed; GitHub has it all the same.
			}
			github = {
				thread: answer.threadId,
				comment: answer.comment?.id || answer.threadId,
				url: "",
			};
			url = answer.url;
		} else {
			setKept(clientId, {
				...keptOf(clientId),
				sending: { ...sending, body },
			});
			const answer = await postThread({
				...place.target,
				clientId,
				body,
				attemptedAt: sending.attemptedAt,
				retry: true,
			});
			try {
				addThread(client, answer);
			} catch {
				// Showing it failed; GitHub has it all the same.
			}
			github = {
				thread: answer.thread.id,
				comment: answer.comments.comments[0]?.id || answer.thread.id,
				url: "",
			};
			url = answer.url;
		}
	} catch (error) {
		const e = error instanceof Error ? error : new Error(String(error));
		const inDoubt = isTransient(error);
		// Refused: not on GitHub, and never resent by itself.
		if (!inDoubt) {
			const { sending: _, ...rest } = keptOf(clientId);
			setKept(clientId, rest);
		}
		throw new AgentCommentError(e, inDoubt);
	}
	const prUrl = client.getQueryData(sessionQuery.queryKey)?.pr.url ?? "";
	github.url = url ?? prUrl;
	const posted: AgentPostedComment = {
		block,
		url: github.url,
		at: new Date().toISOString(),
		text: body,
	};
	postedHere.set(clientId, posted);
	setKept(clientId, {});
	try {
		const t = await postAgentPosted(thread.id, {
			message: message.id,
			block,
			github,
			text: body,
		});
		client.setQueryData(agentThreadsQuery.queryKey, (old) =>
			withThread(old, t),
		);
	} catch {
		// Posted all the same: shown so for this page; a press after a
		// reload finds it on GitHub.
	}
	return posted;
}
