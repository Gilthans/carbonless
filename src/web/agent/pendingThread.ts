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
	type RefObject,
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

/**
 * Whether a new thread shows where composers do (not in a card): a card
 * draws only one on the head shown, so one on another head always shows
 * here, held or not; never nowhere.
 */
export function shownOutsideCard(
	item: Pick<NewThreadItem, "agentThread" | "span">,
	head: string | undefined,
	held: (item: Pick<NewThreadItem, "agentThread">) => boolean,
): boolean {
	return !(item.span.commit === head && held(item));
}

/** Forgets every hold (tests). */
export function resetHeldComposers(): void {
	changed(new Map());
	fromCard.clear();
	landing.clear();
}

// --- The frame's fade: only right after Comment ---------------------------

/** Conversation id → when its card's Comment was pressed. */
const fromCard = new Map<string, number>();
/** How long after Comment a pending thread drawn counts as the card turning into it. */
const TURNING_MS = 1000;

/** Comment pressed on conversation `id`'s card: its pending thread fades in from the card's frame. */
export function commentedFromCard(id: string): void {
	fromCard.set(id, Date.now());
}

/** Whether the pending thread of `id` is the card turning into it just now (not a later remount). */
export function turnedFromCard(id: string | undefined): boolean {
	const at = id === undefined ? undefined : fromCard.get(id);
	return at !== undefined && Date.now() - at < TURNING_MS;
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

// --- Where a posted pending thread lands -----------------------------------

/**
 * Conversation id → where its pending thread was when posted: its top
 * against its file's section (so scrolling meanwhile doesn't count).
 */
const landing = new Map<string, number>();

const topInSection = (el: Element) =>
	el.getBoundingClientRect().top -
	(el.closest("section")?.getBoundingClientRect().top ?? 0);

/** How long a landing is waited for before the browser's own anchoring is back. */
const LANDING_MS = 30_000;
let anchoringOff: ReturnType<typeof setTimeout> | undefined;

/**
 * The browser's scroll anchoring off (its own adjustment when the line's
 * boxes change would add to useLandWhere's), until the thread lands.
 */
function holdAnchoring(on: boolean): void {
	const root = document.scrollingElement as HTMLElement | null;
	if (!root) return;
	clearTimeout(anchoringOff);
	anchoringOff = undefined;
	if (on) {
		root.style.overflowAnchor = "none";
		anchoringOff = setTimeout(() => holdAnchoring(false), LANDING_MS);
	} else root.style.removeProperty("overflow-anchor");
}

/** The pending thread carrying `conversation` is posted from `el`. */
export function noteLanding(conversation: string, el: Element): void {
	landing.set(conversation, topInSection(el));
	holdAnchoring(true);
}

/** The page's scroller around `el`: the nearest that scrolls up and down, else the window. */
function scrollerOf(el: Element): { scrollBy: (x: number, y: number) => void } {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const y = getComputedStyle(p).overflowY;
		if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight) {
			return p;
		}
	}
	return window;
}

/**
 * The GitHub thread a pending thread became (its conversation's): drawn
 * where the line's threads go, which may be above other threads or cards
 * the pending one was below. Before it is painted, the page scrolls by
 * the difference, so it shows where the pending thread was and what was
 * above it moves instead.
 */
export function useLandWhere(
	conversation: string | undefined,
	ref: RefObject<Element | null>,
): void {
	useLayoutEffect(() => {
		const el = ref.current;
		if (!conversation || !el) return;
		const was = landing.get(conversation);
		if (was === undefined) return;
		landing.delete(conversation);
		const delta = topInSection(el) - was;
		if (Math.abs(delta) >= 1) scrollerOf(el).scrollBy(0, delta);
		if (landing.size === 0) holdAnchoring(false);
	}, [conversation, ref]);
}

/** Forgets where pending threads were posted from (tests). */
export function resetLanding(): void {
	landing.clear();
	holdAnchoring(false);
}
