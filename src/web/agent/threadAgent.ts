/**
 * The thread agent (CAR-120): one private agent conversation per GitHub
 * review thread, behind an agent button in the thread card's header and a
 * panel that slides over the thread's comments. Here: finding a thread's
 * conversation, the card's open state (never stored: a reload shows
 * threads), the text typed to the agent (kept while the panel closes, and
 * counted as unsent by Resolve's close), the comparison a question is sent
 * in, and the seen marks.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { AgentMessage, AgentThread, AgentView } from "../../shared/agent";
import type { ReviewThread } from "../../shared/types";
import { sessionQuery } from "../api";
import type { ComparisonBase, Viewing } from "../files/comparison";
import {
	agentThreadsQuery,
	postAgentSeen,
	useAgentOn,
	withThread,
} from "./api";

/** The comparison a message is sent in; the server fills left/right. */
export type SendView = Omit<AgentView, "left" | "right">;

/** The live conversation of GitHub thread `threadId` in `list` (an orphan is a span thread). */
export function threadConversation(
	list: readonly AgentThread[] | undefined,
	threadId: string,
): AgentThread | undefined {
	if (!threadId) return undefined;
	return list?.find(
		(t) => t.anchor.subject === "thread" && t.anchor.thread === threadId,
	);
}

/** The conversation for a GitHub thread id, from agentThreadsQuery. */
export function useThreadConversation(
	threadId: string,
): AgentThread | undefined {
	const on = useAgentOn();
	const list = useQuery({ ...agentThreadsQuery, enabled: on }).data?.threads;
	return threadConversation(list, threadId);
}

/** The agent threads are asked and not in yet: a spinner, never "none". */
export function useAgentThreadsLoading(): boolean {
	const on = useAgentOn();
	const query = useQuery({ ...agentThreadsQuery, enabled: on });
	return on && query.isPending && !query.isError;
}

/**
 * Whether a thread gets the agent: a session that writes (not --viewer,
 * not --as-of), a thread GitHub gave an id, not deleted.
 */
export function agentFor(thread: ReviewThread, agentOn: boolean): boolean {
	return agentOn && thread.id !== "" && thread.unavailable !== "deleted";
}

/** The agent messages after the last one seen. */
export function unseenMessages(conversation: AgentThread): AgentMessage[] {
	const from = conversation.seenUpTo
		? conversation.messages.findIndex((m) => m.id === conversation.seenUpTo) + 1
		: 0;
	return conversation.messages.slice(from).filter((m) => m.by === "ai");
}

/** The agent button's accessible name. */
export function agentButtonName(
	conversation: AgentThread | undefined,
	open: boolean,
): string {
	if (!conversation) return "Ask agent";
	const n = conversation.messages.length;
	const said = `${n} agent ${n === 1 ? "message" : "messages"}`;
	if (open) return `${said}: hide`;
	const k = conversation.unread ? unseenMessages(conversation).length : 0;
	return k > 0 ? `${said}, ${k} new` : said;
}

/**
 * The message whose "Resolve By Agent Suggestion" stands: the latest
 * finished answer, when it suggests resolving, while the GitHub thread is
 * open and still there. A later answer that doesn't suggest it retracts
 * it; one that failed or was stopped doesn't, nor does a question alone.
 */
export function standingSuggestion(
	conversation: AgentThread | undefined,
	thread: Pick<ReviewThread, "resolved">,
): AgentMessage | undefined {
	if (!conversation || conversation.orphaned || thread.resolved) {
		return undefined;
	}
	const latest = [...conversation.messages]
		.reverse()
		.find((m) => m.by === "ai" && m.stop !== "error" && m.stop !== "cancelled");
	return latest?.suggests === "resolve" ? latest : undefined;
}

// --- The comparison a question is asked in ---------------------------------

/** Files changed's comparison as a message's view; null before it is known. */
export function comparisonView(
	viewing: Viewing | null,
	base: ComparisonBase,
): SendView | null {
	if (!viewing) return null;
	return {
		target:
			viewing.kind === "patchset"
				? { patchset: viewing.number }
				: { head: viewing.oid },
		from: base.kind === "branch" ? { branch: true } : { patchset: base.number },
	};
}

const SendViewContext = createContext<SendView | null>(null);
/** Files changed's comparison (the URL's ps/head/from), for its cards. */
export const SendViewProvider = SendViewContext.Provider;

/**
 * The view to send: Files changed's URL comparison, or the Overview's
 * placements comparison (the latest patch set, else the snapshot head,
 * against the base branch).
 */
export function useSendView(): SendView {
	const given = useContext(SendViewContext);
	const session = useQuery({ ...sessionQuery, enabled: false }).data;
	if (given) return given;
	const latest = session?.patchsets?.at(-1)?.number;
	return {
		target:
			latest !== undefined
				? { patchset: latest }
				: { head: session?.snapshotHead ?? "" },
		from: { branch: true },
	};
}

// --- Text typed to the agent ------------------------------------------------

let drafts: ReadonlyMap<string, string> = new Map();
const draftListeners = new Set<() => void>();
const subscribeDrafts = (l: () => void) => {
	draftListeners.add(l);
	return () => {
		draftListeners.delete(l);
	};
};

/** What is typed to the agent on GitHub thread `threadId` ("" for nothing). */
export const agentDraftText = (threadId: string): string =>
	drafts.get(threadId) ?? "";

export function setAgentDraft(threadId: string, text: string): void {
	const next = new Map(drafts);
	if (text) next.set(threadId, text);
	else next.delete(threadId);
	drafts = next;
	for (const l of draftListeners) l();
}

/** The agent composer's text for a thread: it outlives the panel closing. */
export function useAgentDraft(
	threadId: string,
): [string, (text: string) => void] {
	const text = useSyncExternalStore(
		subscribeDrafts,
		() => agentDraftText(threadId),
		() => agentDraftText(threadId),
	);
	const set = useCallback(
		(t: string) => setAgentDraft(threadId, t),
		[threadId],
	);
	return [text, set];
}

/** Forgets every agent draft (tests). */
export function resetAgentDrafts(): void {
	drafts = new Map();
	seenPosted.clear();
	for (const l of draftListeners) l();
}

// --- Seen ---------------------------------------------------------------------

/** How long an unseen answer is in view before it counts as seen. */
export const SEEN_AFTER_MS = 1000;
/** Seen marks sent from this page (thread:upTo): each at most once. */
const seenPosted = new Set<string>();

/**
 * Marks the conversation seen up to its last agent message once that has
 * been in view (`el` on screen, the page visible) for SEEN_AFTER_MS while
 * `open`. Nothing is written while nothing is unseen, so there is at most
 * one mark per agent message (principle 3).
 */
export function useSeenWriter(
	conversation: AgentThread | undefined,
	open: boolean,
	el: RefObject<HTMLElement | null>,
): void {
	const client = useQueryClient();
	const last = conversation?.unread
		? [...conversation.messages].reverse().find((m) => m.by === "ai")?.id
		: undefined;
	const id = conversation?.id;
	const [inView, setInView] = useState(true);
	useEffect(() => {
		const node = el.current;
		if (!open || !node || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver((entries) => {
			setInView(entries.some((e) => e.isIntersecting));
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [open, el]);
	useEffect(() => {
		if (!open || !inView || !id || !last) return;
		const key = `${id}:${last}`;
		if (seenPosted.has(key)) return;
		const timer = setTimeout(() => {
			if (document.visibilityState === "hidden" || seenPosted.has(key)) {
				return;
			}
			seenPosted.add(key);
			postAgentSeen(id, last).then(
				(saved) =>
					client.setQueryData(agentThreadsQuery.queryKey, (list) =>
						withThread(list, saved),
					),
				() => seenPosted.delete(key),
			);
		}, SEEN_AFTER_MS);
		return () => clearTimeout(timer);
	}, [open, inView, id, last, client]);
}

// --- A card's open state ---------------------------------------------------------

/** One card's thread agent, as its header, comments and composer share it. */
export interface ThreadAgent {
	thread: ReviewThread;
	conversation: AgentThread | undefined;
	open: boolean;
	toggle: () => void;
	close: () => void;
	/** The agent button: focus comes back to it on close. */
	buttonRef: RefObject<HTMLButtonElement | null>;
	/** The composer's input: focus goes to it on open. */
	composerRef: RefObject<HTMLTextAreaElement | null>;
	/** Told after a resolve by the suggestion (Files changed's close, the Overview's fade). */
	onToggle?: (resolved: boolean, from: Element) => void;
}

export const ThreadAgentContext = createContext<ThreadAgent | null>(null);

/** The card's thread agent, or null where the thread has none. */
export const useThreadAgentContext = () => useContext(ThreadAgentContext);

/**
 * A card's thread agent: its conversation and its own open state (several
 * cards may be open at once). Resolving the thread folds the conversation
 * with it; unresolving opens it again if the resolve closed it. Focus goes
 * to the composer on open and back to the agent button on close. Null
 * where the thread gets no agent (agentFor).
 */
export function useThreadAgent(
	thread: ReviewThread,
	options: {
		/** Told when it opens (the card shows its composer row). */
		onOpen?: () => void;
		onToggle?: (resolved: boolean, from: Element) => void;
	} = {},
): ThreadAgent | null {
	const on = useAgentOn();
	const conversation = useThreadConversation(thread.id);
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const focus = useRef<"composer" | "button" | null>(null);
	const { onOpen } = options;
	// Resolving folds it; unresolving opens it again if that folded it.
	const [wasResolved, setWasResolved] = useState(thread.resolved);
	const [folded, setFolded] = useState(false);
	if (wasResolved !== thread.resolved) {
		setWasResolved(thread.resolved);
		if (thread.resolved && open) {
			setOpen(false);
			setFolded(true);
		} else if (!thread.resolved && folded) {
			setOpen(true);
			setFolded(false);
		}
	}
	// After each open or close is drawn: the focus goes where it was asked.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on each open and close.
	useEffect(() => {
		const to = focus.current;
		focus.current = null;
		if (to === "composer") composerRef.current?.focus();
		else if (to === "button") buttonRef.current?.focus();
	}, [open]);
	const toggle = useCallback(() => {
		setFolded(false);
		setOpen((o) => {
			focus.current = o ? "button" : "composer";
			return !o;
		});
	}, []);
	useEffect(() => {
		if (open) onOpen?.();
	}, [open, onOpen]);
	const close = useCallback(() => {
		setFolded(false);
		setOpen((o) => {
			if (o) focus.current = "button";
			return false;
		});
	}, []);
	// The caller's onToggle is usually a fresh closure: kept in a ref, so
	// the context value changes only when what it says does.
	const onToggleRef = useRef(options.onToggle);
	onToggleRef.current = options.onToggle;
	const hasOnToggle = options.onToggle !== undefined;
	const onToggle = useCallback(
		(resolved: boolean, from: Element) => onToggleRef.current?.(resolved, from),
		[],
	);
	const available = agentFor(thread, on);
	return useMemo(
		() =>
			available
				? {
						thread,
						conversation,
						open,
						toggle,
						close,
						buttonRef,
						composerRef,
						onToggle: hasOnToggle ? onToggle : undefined,
					}
				: null,
		[
			available,
			thread,
			conversation,
			open,
			toggle,
			close,
			hasOnToggle,
			onToggle,
		],
	);
}
