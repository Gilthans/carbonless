/**
 * Questions and replies to the agent on their way to the server. One press
 * is one write. A transient failure (no answer, 5xx, 408, 429) is sent again
 * by itself after RETRY_DELAYS_MS, with the same clientId, so the server
 * (which dedupes by it) keeps one thread or message however many attempts
 * land. Any other refusal stays on the item, shown inline, and is sent again
 * only by retryAgentWrite. Kept apart from threadWrites.ts: those are
 * GitHub's writes and their unions stay closed.
 */
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { AgentThread, AgentView } from "../../shared/agent";
import { ApiError } from "../api";
import type { CodeSpan } from "../files/selectionActions";
import { isTransient, RETRY_DELAYS_MS } from "../files/stateSync";
import {
	agentStatusQuery,
	agentThreadsQuery,
	postAgentMessage,
	postAgentThread,
	withThread,
} from "./api";
import { anchorOf, closeAgentComposer } from "./askAgentAction";

export interface AgentWrite {
	/** A new thread's span, or the thread a reply goes to. */
	span?: CodeSpan;
	thread?: string;
	/** A new conversation on this GitHub review thread (its id). */
	githubThread?: string;
	/** The comparison on screen when it was sent. */
	view?: Omit<AgentView, "left" | "right">;
	text: string;
	/** Refused: why, until a retry or a drop. */
	error?: ApiError | Error;
	/** Failed transiently: sent again by itself. */
	retrying: boolean;
}

export interface AgentWriteState {
	pending: ReadonlyMap<string, AgentWrite>;
}

let state: AgentWriteState = { pending: new Map() };
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const attempts = new Map<string, number>();
const listeners = new Set<() => void>();
/** Threads opened by a question from this page, until their row opens them. */
const justAsked = new Set<string>();

/** Whether `thread` was just asked from this page (once: it is forgotten). */
export function takeJustAsked(thread: string): boolean {
	return justAsked.delete(thread);
}

function set(clientId: string, item: AgentWrite | null): void {
	const next = new Map(state.pending);
	if (item) next.set(clientId, item);
	else next.delete(clientId);
	state = { pending: next };
	for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
};
const getState = () => state;

export function useAgentWrites(): AgentWriteState {
	return useSyncExternalStore(subscribe, getState, getState);
}

export const getAgentWrites = getState;

function send(client: QueryClient, clientId: string): void {
	const item = state.pending.get(clientId);
	if (!item) return;
	let write: Promise<AgentThread>;
	const view = item.view ? { view: item.view } : {};
	if (item.thread !== undefined) {
		write = postAgentMessage(item.thread, {
			clientId,
			text: item.text,
			...view,
		});
	} else if (item.githubThread !== undefined) {
		write = postAgentThread({
			clientId,
			text: item.text,
			thread: item.githubThread,
			...view,
		}).catch((error: unknown) => {
			// Opened meanwhile (the other device): the question joins it.
			const tid = conversationOf(error);
			if (tid === null || state.pending.get(clientId) !== item) throw error;
			return postAgentMessage(tid, { clientId, text: item.text, ...view });
		});
	} else {
		const span = item.span && anchorOf(item.span);
		if (!span) {
			set(clientId, {
				...item,
				retrying: false,
				error: new Error("Pick a line or the file to ask about"),
			});
			return;
		}
		write = postAgentThread({ clientId, text: item.text, span, ...view });
	}
	write.then(
		(thread) => {
			// Dropped meanwhile: the answer still lands in the list.
			attempts.delete(clientId);
			client.setQueryData(agentThreadsQuery.queryKey, (list) =>
				withThread(list, thread),
			);
			void client.invalidateQueries({ queryKey: agentStatusQuery.queryKey });
			if (state.pending.get(clientId) === item) set(clientId, null);
			if (item.span) {
				justAsked.add(thread.id);
				closeAgentComposer(clientId);
			}
		},
		(error: unknown) => {
			if (state.pending.get(clientId) !== item) return;
			if (isTransient(error) && !githubUnread(client, item, error)) {
				const n = attempts.get(clientId) ?? 0;
				attempts.set(clientId, n + 1);
				const wait = RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length - 1)];
				const again = { ...item, retrying: true };
				set(clientId, again);
				timers.set(
					clientId,
					setTimeout(() => {
						timers.delete(clientId);
						send(client, clientId);
					}, wait),
				);
				return;
			}
			set(clientId, {
				...item,
				retrying: false,
				error:
					error instanceof Error ? error : new Error(String(error ?? "Failed")),
			});
		},
	);
}

/** The conversation a 409 on opening one names (it exists already). */
function conversationOf(error: unknown): string | null {
	if (!(error instanceof ApiError) || error.status !== 409) return null;
	const tid = (error.body as { thread?: unknown } | undefined)?.thread;
	return typeof tid === "string" && tid !== "" ? tid : null;
}

/**
 * A 502 on a write to a GitHub thread's conversation: the server couldn't
 * read GitHub, so it can't tell whether the thread is open. Shown with
 * Retry, never sent again silently. Any other 502 (a proxy's, while crb
 * restarts) is transient and resent as before.
 */
function githubUnread(
	client: QueryClient,
	item: AgentWrite,
	error: unknown,
): boolean {
	if (!(error instanceof ApiError) || error.status !== 502) return false;
	if (item.githubThread !== undefined) return true;
	if (item.thread === undefined) return false;
	const conversation = client
		.getQueryData(agentThreadsQuery.queryKey)
		?.threads.find((t) => t.id === item.thread);
	return conversation?.anchor.subject === "thread";
}

function start(client: QueryClient, clientId: string, item: AgentWrite): void {
	// One press, one write: a press while one is out sends nothing more.
	const out = state.pending.get(clientId);
	if (out && !out.error) return;
	set(clientId, item);
	send(client, clientId);
}

/** Opens a thread on the span with the reviewer's question. */
export function askAgent(
	client: QueryClient,
	span: CodeSpan,
	text: string,
	clientId: string,
	view?: Omit<AgentView, "left" | "right">,
): void {
	start(client, clientId, { span, text, view, retrying: false });
}

/** Opens the conversation of GitHub thread `githubThread` with a question. */
export function askAgentOnThread(
	client: QueryClient,
	githubThread: string,
	text: string,
	clientId: string,
	view?: Omit<AgentView, "left" | "right">,
): void {
	start(client, clientId, { githubThread, text, view, retrying: false });
}

/** Adds the reviewer's reply to an agent thread. */
export function replyAgent(
	client: QueryClient,
	thread: string,
	text: string,
	clientId: string,
	view?: Omit<AgentView, "left" | "right">,
): void {
	start(client, clientId, { thread, text, view, retrying: false });
}

/** Sends a refused (or waiting) write again, now. */
export function retryAgentWrite(client: QueryClient, clientId: string): void {
	const item = state.pending.get(clientId);
	if (!item) return;
	const timer = timers.get(clientId);
	if (timer) clearTimeout(timer);
	timers.delete(clientId);
	const again = { ...item, retrying: false, error: undefined };
	set(clientId, again);
	send(client, clientId);
}

/** Forgets a write: its retries stop; what is typed goes back to the caller. */
export function dropAgentWrite(clientId: string): void {
	const timer = timers.get(clientId);
	if (timer) clearTimeout(timer);
	timers.delete(clientId);
	attempts.delete(clientId);
	if (state.pending.has(clientId)) set(clientId, null);
}

/** Forgets every write (tests). */
export function resetAgentWrites(): void {
	for (const t of timers.values()) clearTimeout(t);
	timers.clear();
	attempts.clear();
	justAsked.clear();
	state = { pending: new Map() };
	for (const l of listeners) l();
}
