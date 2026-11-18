/**
 * Comment on an agent conversation's card turns the card, in place, into
 * the GitHub thread it will be: its first comment the composer, the
 * conversation that thread's agent conversation (its handle and panel).
 * Here: which conversations a card on screen holds as such a pending
 * thread (so their composer shows nowhere else), what the diff gives a
 * composer drawn inside a card, and the pending thread's agent.
 */
import { useQuery } from "@tanstack/react-query";
import {
	createContext,
	createElement,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { AgentThread } from "../../shared/agent";
import type { ReviewThread } from "../../shared/types";
import type { CodeSpan } from "../files/selectionActions";
import type { LineTexts } from "../threads/drafts";
import type { NewThreadItem } from "../threads/newThreads";
import { agentThreadsQuery, useAgentOn } from "./api";
import type { ThreadAgent } from "./threadAgent";

// --- Conversations a card holds -------------------------------------------

/** Conversation id → how many cards on screen hold its composer. */
let held: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();
const changed = (next: ReadonlyMap<string, number>) => {
	held = next;
	for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
};
const getHeld = () => held;

/**
 * A card of conversation `id` is on screen where its comment's composer
 * shows (null: it isn't): the composer carrying it is drawn in the card,
 * nowhere else. Held from the card's mount, before Comment is pressed,
 * so the composer never shows twice, not even for a frame.
 */
export function useHoldComposer(id: string | null): void {
	useLayoutEffect(() => {
		if (id === null) return;
		changed(new Map(held).set(id, (held.get(id) ?? 0) + 1));
		return () => {
			const next = new Map(held);
			const n = (next.get(id) ?? 1) - 1;
			if (n > 0) next.set(id, n);
			else next.delete(id);
			changed(next);
		};
	}, [id]);
}

/** Whether a new thread's composer is drawn in its conversation's card instead. */
export function useHeldByCard(): (
	item: Pick<NewThreadItem, "agentThread">,
) => boolean {
	const now = useSyncExternalStore(subscribe, getHeld, getHeld);
	return useCallback(
		(item) => item.agentThread !== undefined && now.has(item.agentThread),
		[now],
	);
}

/** Forgets every hold (tests). */
export function resetHeldComposers(): void {
	changed(new Map());
}

// --- What a composer drawn in a card needs from the diff ------------------

/**
 * What the diff gives a composer: the head its composers show on, the
 * span's quote and line texts, what posting does (the thread opens where
 * it lands), and whether the diff shown is the head's yet.
 */
export interface PendingComposers {
	head: string | undefined;
	quote: (span: CodeSpan) => string;
	texts?: (span: CodeSpan) => LineTexts | undefined;
	onPosted?: (item: NewThreadItem) => void;
	headUnsure?: boolean;
}

const PendingComposersContext = createContext<PendingComposers | null>(null);
export const PendingComposersProvider = PendingComposersContext.Provider;
export const usePendingComposers = () => useContext(PendingComposersContext);

/**
 * The diff's PendingComposers with another `onPosted` (a file comment's
 * thread opens in the file's bubble, not under a line).
 */
export function PendingPosted(props: {
	onPosted: (item: NewThreadItem) => void;
	children: ReactNode;
}) {
	const outer = useContext(PendingComposersContext);
	const { onPosted } = props;
	const value = useMemo(
		() => (outer ? { ...outer, onPosted } : null),
		[outer, onPosted],
	);
	return createElement(
		PendingComposersContext.Provider,
		{ value },
		props.children,
	);
}

// --- The pending thread's agent -------------------------------------------

/** A GitHub thread not posted yet, as the thread agent's pieces read one. */
function pendingReviewThread(item: NewThreadItem): ReviewThread {
	return {
		id: `new:${item.clientId}`,
		path: item.span.path,
		resolved: false,
		outdated: false,
		viewerCan: { reply: false, resolve: false, unresolve: false },
	} as ReviewThread;
}

/**
 * The agent of a new thread carrying conversation `item.agentThread`, as a
 * posted thread's (useThreadAgent): that conversation behind its handle,
 * its panel open from the start (the conversation it was a moment ago),
 * read only (the composer is the comment's). Null without a link, or when
 * the conversation is known to be gone.
 */
export function usePendingAgent(item: NewThreadItem): ThreadAgent | null {
	const on = useAgentOn();
	const query = useQuery({ ...agentThreadsQuery, enabled: on });
	const id = item.agentThread;
	const conversation: AgentThread | undefined = id
		? query.data?.threads.find((t) => t.id === id)
		: undefined;
	const gone = query.data !== undefined && conversation === undefined;
	const [open, setOpen] = useState(true);
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const focus = useRef<"composer" | "button" | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on each open and close.
	useEffect(() => {
		const to = focus.current;
		focus.current = null;
		if (to === "composer") composerRef.current?.focus();
		else if (to === "button") buttonRef.current?.focus();
	}, [open]);
	const toggle = useCallback(() => {
		setOpen((o) => {
			focus.current = o ? "button" : "composer";
			return !o;
		});
	}, []);
	const close = useCallback(() => {
		setOpen((o) => {
			if (o) focus.current = "button";
			return false;
		});
	}, []);
	// Sent: the comment shows, as the posted thread will (its panel closed).
	const shut = open && item.sending;
	useEffect(() => {
		if (shut) setOpen(false);
	}, [shut]);
	const clientId = item.clientId;
	const path = item.span.path;
	const thread = useMemo(
		() => pendingReviewThread({ clientId, span: { path } } as NewThreadItem),
		[clientId, path],
	);
	return useMemo(
		() =>
			on && id && !gone
				? {
						thread,
						conversation,
						open: open && !item.sending,
						toggle,
						close,
						buttonRef,
						composerRef,
					}
				: null,
		[on, id, gone, thread, conversation, open, item.sending, toggle, close],
	);
}
