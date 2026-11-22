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
	type AgentMessage,
	type AgentPostedComment,
	type AgentPostedRequest,
	type AgentSpanAnchor,
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
export const GITHUB_UNKNOWN = "Couldn't read GitHub's threads";
export const SIBLING_SENDING = "Waiting for the other comment";

/**
 * Another block of the same conversation, as this browser has it
 * (siblingOf): one GitHub took as a new thread, its record not in yet
 * (the conversation is that thread's: reply to it), or one on its way or
 * in doubt (wait: it may start the thread).
 */
export type Sibling = { kind: "reply"; thread: string } | { kind: "pending" };

/** A conversation a block can post from: on lines, a file or a GitHub thread. */
export type PostingThread = Omit<AgentThread, "anchor"> & {
	anchor: AgentSpanAnchor;
};

const POSTS_FROM: ReadonlySet<string> = new Set(["line", "file", "thread"]);

/**
 * Whether the conversation has a place to post (an allowlist: the whole
 * review's, or any kind added later, shows its blocks read-only).
 */
export const postsFrom = (thread: AgentThread): thread is PostingThread =>
	POSTS_FROM.has(thread.anchor.subject);

/** Where a block posts, or why it can't (yet). */
export type CommentPlace =
	/** A reply to the conversation's GitHub thread. */
	| { kind: "reply"; thread: string }
	/** A new thread; `changed`: on the lines that replaced the asked ones. */
	| { kind: "new"; target: NewTarget; changed: boolean }
	/**
	 * The placement is on its way, or another block of the conversation is
	 * (`why`): a spinner, never "gone" (principle 8).
	 */
	| { kind: "pending"; why?: string }
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
 * A GitHub-thread conversation replies to its thread, unless it's gone;
 * so does one whose comment started its thread (CAR-236: the server
 * serves it on that thread). Shown on its lines only because GitHub
 * couldn't be read (`githubUnknown`), it is off: it may have a thread,
 * and a second one is never started.
 */
export function commentPlace(args: {
	thread: PostingThread;
	head: string | undefined;
	placement: ThreadPlacement | undefined;
	/** The placements: in (`placement` undefined: not traced), on their way, or failed. */
	placing: "in" | "pending" | "failed";
	/** Another block of the conversation this browser posted or is posting (siblingOf). */
	sibling?: Sibling;
}): CommentPlace {
	const { sibling } = args;
	const base = ownPlace(args);
	// Its record not in yet (CAR-236): the thread another block started (a
	// reply needs no lines, so it wins over an off); while another is on
	// its way, a block that would start a thread waits. An off keeps its
	// reason: a sibling left in doubt where it can't be pressed never
	// spins this one forever.
	if (sibling?.kind === "reply" && base.kind !== "reply") {
		if (base.kind !== "off" || !args.thread.githubUnknown) return sibling;
	}
	if (
		sibling?.kind === "pending" &&
		(base.kind === "new" || base.kind === "pending")
	) {
		return { kind: "pending", why: SIBLING_SENDING };
	}
	return base;
}

/** Where a block posts, from its own conversation alone (commentPlace without siblings). */
function ownPlace(args: {
	thread: PostingThread;
	head: string | undefined;
	placement: ThreadPlacement | undefined;
	placing: "in" | "pending" | "failed";
}): CommentPlace {
	const { thread, head, placement, placing } = args;
	const a = thread.anchor;
	if (a.subject === "thread") {
		return thread.orphaned
			? { kind: "off", why: THREAD_GONE }
			: { kind: "reply", thread: a.thread };
	}
	// Joined (CAR-236), shown where it was asked: its thread isn't in this
	// view (an earlier patch set), or GitHub's threads couldn't be read.
	if (thread.githubUnknown) return { kind: "off", why: GITHUB_UNKNOWN };
	// Back on its lines because its thread is gone: a new thread, as
	// before the post (the fold adds it; the join moves it there).
	if (thread.joined && !thread.orphaned) {
		return { kind: "reply", thread: thread.joined.thread };
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
	anchor: AgentSpanAnchor,
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

/**
 * What a reply of block `message` may not take for itself on a retry:
 * knownBefore the agent's message, and always the thread's opener (the
 * first listed). A reply is never
 * the opener, so it never hides a real send; a thread younger than the
 * message (one its conversation's block started, CAR-236) has it known.
 */
export function knownForReply(
	comments: readonly { id: string; publishedAt: string | null }[],
	message: Pick<AgentMessage, "at">,
): string[] {
	const known = knownBefore(comments, message.at);
	// GitHub lists a thread's comments in order: the first is its opener.
	const opener = comments.find((c) => c.id);
	if (opener && !known.includes(opener.id)) known.unshift(opener.id);
	return known;
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

// ---- Per block, in this browser: its draft, a press, a post not yet recorded. ----

/** A post GitHub took whose record (`agent-comment-posted`) isn't known to be written. */
export interface KeptPosted extends AgentPostedComment {
	github: AgentPostedRequest["github"];
}

/** What the browser keeps for one block (by client id). */
interface Kept {
	/** The box's text, when it differs from the agent's. */
	text?: string;
	/**
	 * Pressed, GitHub's answer not seen yet: its body is fixed from then on
	 * (a retry looks for exactly it), and it is resent once on the next load.
	 */
	sending?: { attemptedAt: string; body: string; known?: string[] };
	/** On GitHub, the record not yet written: shown Posted, the record retried. */
	posted?: KeptPosted;
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

const isStr = (v: unknown): v is string => typeof v === "string";

function parseSending(v: unknown): Kept["sending"] | undefined {
	if (typeof v !== "object" || v === null) return undefined;
	const s = v as Record<string, unknown>;
	if (!isStr(s.attemptedAt) || !isStr(s.body)) return undefined;
	const known = s.known;
	if (known !== undefined && !(Array.isArray(known) && known.every(isStr))) {
		return undefined;
	}
	return {
		attemptedAt: s.attemptedAt,
		body: s.body,
		...(known ? { known: known as string[] } : {}),
	};
}

function parsePosted(v: unknown): KeptPosted | undefined {
	if (typeof v !== "object" || v === null) return undefined;
	const p = v as Record<string, unknown>;
	const g = p.github as Record<string, unknown> | null | undefined;
	if (
		typeof p.block !== "number" ||
		!isStr(p.url) ||
		!isStr(p.at) ||
		!isStr(p.text) ||
		typeof g !== "object" ||
		g === null ||
		!isStr(g.thread) ||
		!isStr(g.comment) ||
		!isStr(g.url)
	) {
		return undefined;
	}
	return {
		block: p.block,
		url: p.url,
		at: p.at,
		text: p.text,
		github: { thread: g.thread, comment: g.comment, url: g.url },
	};
}

export function keptOf(clientId: string): Kept {
	const inMemory = memory.get(clientId);
	if (inMemory) return inMemory;
	try {
		const raw = storage()?.getItem(keyOf(clientId));
		if (!raw) {
			memory.set(clientId, {});
			return memory.get(clientId) as Kept;
		}
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return {};
		const p = parsed as Record<string, unknown>;
		const sending = parseSending(p.sending);
		const posted = parsePosted(p.posted);
		const kept: Kept = {
			...(isStr(p.text) ? { text: p.text } : {}),
			...(sending ? { sending } : {}),
			...(posted ? { posted } : {}),
		};
		// Read once: later reads (useSyncExternalStore's) see one object.
		memory.set(clientId, kept);
		return kept;
	} catch {
		return {};
	}
}

function setKept(clientId: string, kept: Kept): void {
	const empty =
		kept.text === undefined &&
		kept.sending === undefined &&
		kept.posted === undefined;
	memory.set(clientId, kept);
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

const PREFIX = "crb:agent-comment:";
let listening = false;

/**
 * Another tab's writes: its block's entry is read from storage again (a
 * press it made fixes the text here too, a post it made shows Posted).
 */
function listenToOtherTabs(): void {
	if (listening || typeof window === "undefined") return;
	listening = true;
	window.addEventListener("storage", (e) => {
		if (e.key === null) memory.clear();
		else if (e.key.startsWith(PREFIX))
			memory.delete(e.key.slice(PREFIX.length));
		else return;
		for (const l of listeners) l();
	});
}

/** The client ids this browser keeps anything for that start with `prefix`. */
function keptIds(prefix: string): string[] {
	const ids = new Set<string>();
	for (const id of memory.keys()) if (id.startsWith(prefix)) ids.add(id);
	try {
		const s = storage();
		for (let i = 0; s && i < s.length; i++) {
			const key = s.key(i);
			if (key?.startsWith(PREFIX + prefix)) ids.add(key.slice(PREFIX.length));
		}
	} catch {
		// Memory only.
	}
	return [...ids];
}

/**
 * Another block of conversation `thread` than `clientId`, as this browser
 * keeps it (CAR-236): GitHub took one as a new thread and its record isn't
 * in (the earliest such: reply to its thread), else one is on its way or
 * in doubt (pending: it may start the thread). Encoded as a string
 * (`reply:<thread>`, `pending`, ""), for useSyncExternalStore.
 */
export function siblingKey(thread: string, clientId: string): string {
	let first: KeptPosted | undefined;
	let sending = false;
	for (const id of keptIds(`ag.${thread}.`)) {
		if (id === clientId) continue;
		const kept = keptOf(id);
		if (kept.posted) {
			if (!first || Date.parse(kept.posted.at) < Date.parse(first.at)) {
				first = kept.posted;
			}
		} else if (kept.sending) sending = true;
	}
	if (first) return `reply:${first.github.thread}`;
	return sending ? "pending" : "";
}

/** The Sibling a siblingKey names. */
export function siblingOf(key: string): Sibling | undefined {
	if (key.startsWith("reply:")) return { kind: "reply", thread: key.slice(6) };
	return key === "pending" ? { kind: "pending" } : undefined;
}

/** Drops a block's kept post (its record is in the agent ref). */
export function dropKeptPosted(clientId: string): void {
	const kept = keptOf(clientId);
	if (!kept.posted) return;
	const { posted: _, ...rest } = kept;
	setKept(clientId, rest);
}

export function subscribeKept(listener: () => void): () => void {
	listenToOtherTabs();
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Forgets this page's memory (tests: a reload). */
export function resetAgentComments(): void {
	memory.clear();
	resent.clear();
	recording.clear();
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
	const kept = keptOf(clientId);
	return kept.posted ? undefined : kept.sending;
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

/**
 * The conversation's GitHub thread's comment ids, as the page has them or
 * reads them; null when they can't be had (nothing is sent then).
 */
async function threadCommentIds(
	client: QueryClient,
	threadId: string,
	at: string,
): Promise<string[] | null> {
	const readId = client.getQueryData(overviewQuery.queryKey)?.readId;
	if (!readId) return null;
	const q = commentsQuery(readId, threadId);
	const cached = client.getQueryData<ThreadComments>(q.queryKey);
	const comments = cached ?? (await client.fetchQuery(q).catch(() => null));
	if (!comments) return null;
	const known = knownForReply(comments.comments, { at });
	return known.length ? known : null;
}

/** Blocks whose record this page is writing (once each). */
const recording = new Set<string>();

/**
 * Writes the record of a post GitHub took (POST agent/threads/:tid/posted)
 * and, once it's in, drops the browser's copy. A failure keeps the copy:
 * the box stays Posted, and the next load tries again.
 */
export async function recordPosted(
	client: QueryClient,
	thread: string,
	message: string,
	clientId: string,
	posted: KeptPosted,
): Promise<boolean> {
	if (recording.has(clientId)) return false;
	recording.add(clientId);
	try {
		const t = await postAgentPosted(thread, {
			message,
			block: posted.block,
			github: posted.github,
			text: posted.text,
		});
		client.setQueryData(agentThreadsQuery.queryKey, (old) =>
			withThread(old, t),
		);
		const { posted: _, ...rest } = keptOf(clientId);
		setKept(clientId, rest);
		return true;
	} catch {
		// Posted all the same: kept here, recorded on a later load.
		return false;
	} finally {
		recording.delete(clientId);
	}
}

/**
 * Posts block `block` of `message` (in conversation `thread`) to GitHub at
 * `place`, always as a retry under the block's client id, so it never
 * posts twice. The body is the box's text, unless a press is already on
 * its way or in doubt: then the body it was sent with, so a retry looks
 * for exactly what may have landed. Then records it (recordPosted); until
 * the record is in, the post is kept in the browser and shows Posted.
 * Answers what was posted and the GitHub thread it's on.
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
): Promise<AgentPostedComment & { githubThread: string; recorded: boolean }> {
	const { thread, message, block, place } = args;
	const clientId = agentCommentClientId(thread.id, message.id, block);
	const sending = args.resend ??
		keptOf(clientId).sending ?? {
			attemptedAt: new Date().toISOString(),
			body: args.body,
		};
	const { body } = sending;
	let github: AgentPostedRequest["github"];
	let url: string | undefined;
	let text: string | undefined;
	try {
		if (place.kind === "reply") {
			const known =
				sending.known ??
				(await threadCommentIds(client, place.thread, message.at));
			// Nothing sent: a refusal, never "may have landed".
			if (!known) throw new Error("Couldn't read the thread's comments");
			setKept(clientId, {
				...keptOf(clientId),
				sending: { ...sending, known },
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
			text = answer.comment?.body;
		} else {
			setKept(clientId, { ...keptOf(clientId), sending });
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
			const opener = answer.comments.comments[0];
			github = {
				thread: answer.thread.id,
				comment: opener?.id || answer.thread.id,
				url: "",
			};
			url = answer.url;
			text = opener?.body;
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
	const posted: KeptPosted = {
		block,
		url: github.url,
		at: new Date().toISOString(),
		// What GitHub has (as typed): a retry may have found an earlier send.
		text: text?.trim() ? text : body,
		github,
	};
	// Kept until the record is in: a reload shows Posted, never the box.
	setKept(clientId, { posted });
	const recorded = await recordPosted(
		client,
		thread.id,
		message.id,
		clientId,
		posted,
	);
	const { github: _, ...shown } = posted;
	return { ...shown, githubThread: github.thread, recorded };
}

/**
 * Whether a post's GitHub thread card should open with the conversation:
 * the conversation sat on lines or a file and the record is in, so it is
 * that thread's now (CAR-236) and leaves the card it was pressed in. A
 * record that failed joins nothing this load: no request left waiting.
 */
export function opensThreadCard(
	thread: Pick<AgentThread, "anchor">,
	recorded: boolean,
): boolean {
	return recorded && thread.anchor.subject !== "thread";
}
