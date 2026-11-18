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
import { stickyBottom } from "../files/scrollAnchor";
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
	endLanding();
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
 * Conversation id → what to keep still as GitHub's thread takes its
 * pending thread's place, measured right before the swap:
 * - `thread`: the pending thread was in view; the new thread shows where
 *   it was (its top against its file's section, as the swap moves it);
 * - `view`: it was above the viewport (the reader scrolled on); what they
 *   are looking at (`el`, at the viewport's middle) stays where it is.
 */
type Landing =
	| { kind: "thread"; top: number }
	| { kind: "view"; el: Element; top: number };
const landing = new Map<string, Landing>();

const topInSection = (el: Element) =>
	el.getBoundingClientRect().top -
	(el.closest("section")?.getBoundingClientRect().top ?? 0);

/**
 * How long after the handover a landing is waited for: the swap is the
 * next task; past this the entry is dropped (never applied late) and the
 * browser's anchoring is back.
 */
export const LANDING_MS = 2000;
let expiry: ReturnType<typeof setTimeout> | undefined;

/**
 * The browser's scroll anchoring off on the page's scroller (its own
 * adjustment when the line's boxes change would add to useLandWhere's),
 * or back on.
 */
function holdAnchoring(off: boolean): void {
	// index.css: html[data-landing] { overflow-anchor: none }.
	const root = document.documentElement;
	if (off) root.dataset.landing = "";
	else delete root.dataset.landing;
}

function endLanding(conversation?: string): void {
	if (conversation === undefined) landing.clear();
	else landing.delete(conversation);
	if (landing.size > 0) return;
	clearTimeout(expiry);
	expiry = undefined;
	holdAnchoring(false);
}

/** The pending thread carrying `conversation`, as drawn now. */
const pendingBox = (conversation: string) =>
	document.querySelector(
		`[data-testid="new-thread"][data-agent-thread="${CSS.escape(conversation)}"]`,
	);

/** Whether `el` is (partly) in sight: in the viewport, below the sticky stack over it. */
function inView(el: Element): boolean {
	const r = el.getBoundingClientRect();
	return (
		r.bottom > stickyBottom(el) && r.top < window.innerHeight && r.height > 0
	);
}

/**
 * What the reader is looking at: the first element from the top of what
 * is in sight (below the sticky stack, from `top`) that is smaller than
 * the viewport, so its top moves with what changes above it (a page-wide
 * container's wouldn't).
 */
function readingAt(top: number): Element | null {
	const x = window.innerWidth / 2;
	for (const f of [0, 0.25, 0.5, 0.75]) {
		const y = top + 1 + (window.innerHeight - top) * f;
		const el = document.elementFromPoint?.(x, y);
		if (el && el.getBoundingClientRect().height < window.innerHeight) {
			return el;
		}
	}
	return null;
}

/**
 * GitHub took the thread of the pending thread carrying `conversation`,
 * and it is about to take its place (the same task's notify): what to
 * keep still then. In view, the pending thread's spot; above the
 * viewport, what is in the viewport's middle (the browser's own anchoring
 * doesn't reach into the diff's scroller); below it, nothing above the
 * reader changes.
 */
export function prepareLanding(conversation: string): void {
	const box = pendingBox(conversation);
	if (!box) return;
	let at: Landing | undefined;
	if (inView(box)) {
		at = { kind: "thread", top: topInSection(box) };
	} else if (box.getBoundingClientRect().bottom <= stickyBottom(box)) {
		const el = readingAt(stickyBottom(box));
		if (el && !box.contains(el)) {
			at = { kind: "view", el, top: el.getBoundingClientRect().top };
		}
	}
	if (!at) return;
	landing.set(conversation, at);
	holdAnchoring(true);
	clearTimeout(expiry);
	expiry = setTimeout(() => endLanding(), LANDING_MS);
}

/**
 * The GitHub thread a pending thread became (its conversation's): drawn
 * where the line's threads go, which may be above other threads or cards
 * the pending one was below. Before it is painted, the page scrolls so
 * that what prepareLanding kept is where it was: the new thread where the
 * pending one showed, or what the reader is looking at, unmoved.
 */
export function useLandWhere(
	conversation: string | undefined,
	ref: RefObject<Element | null>,
): void {
	useLayoutEffect(() => {
		const el = ref.current;
		if (!conversation || !el) return;
		const at = landing.get(conversation);
		if (at === undefined) return;
		const delta =
			at.kind === "thread"
				? topInSection(el) - at.top
				: at.el.isConnected
					? at.el.getBoundingClientRect().top - at.top
					: 0;
		if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
		endLanding(conversation);
	}, [conversation, ref]);
}

/** Whether a landing is waited for (tests). */
export const landingFor = (conversation: string): Landing | undefined =>
	landing.get(conversation);

/** Forgets every landing (tests). */
export function resetLanding(): void {
	endLanding();
}
