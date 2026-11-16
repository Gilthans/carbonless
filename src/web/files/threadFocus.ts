import {
	type RefObject,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { usePageActive } from "../pageActive";
import { stickyBottom } from "./scrollAnchor";

/**
 * The one way a conversation's card is asked to show: a Threads tab row,
 * and a link to an agent conversation (a citation, Go to your request, a
 * Started row; conversationLinks.ts) alike. Whatever holds the card opens
 * (a line's or a hidden run's bubble, the file bubble, a collapsed card,
 * a review thread's agent panel), and the card scrolls in just below the
 * sticky stack; a message named is outlined for a moment.
 *
 * A request lasts until a card on screen takes it, however long the page
 * takes to place it (no timer), and no longer than the reviewer stays: it
 * is dropped on a move to another page (and coming back doesn't bring it
 * back), and the page cancels it on any other navigation there (another
 * pick, a find step, a link, a file opened or closed; a row's also on
 * another comparison or read: its `scope`). A new request replaces the
 * last, so the same row again still scrolls.
 */
export interface ThreadFocus {
	seq: number;
	/** The card's id: a review thread's (GitHub's), or an agent thread's. */
	id: string;
	/** An agent conversation that opens too: in its review thread's panel, or its own card. */
	conversation?: string;
	/** A message of that conversation to outline. */
	message?: string;
	/** What the request was made in (a row's comparison); none for a link. */
	scope?: string;
}

/** The message a request landed on, outlined once its card took it. */
export interface Outline {
	message: string;
	seq: number;
	/** When its card took it (ms): it lights only for OUTLINE_MS after. */
	at: number;
}

let current: ThreadFocus | null = null;
/**
 * The request a card just took, for a moment (SETTLE_MS): should that
 * card go (it moved: a file's threads placed once the tracer answers, from
 * the file bubble to their fates), the request is pending again for the
 * card that shows it now.
 */
let held: { focus: ThreadFocus; owner: object; at: number } | null = null;
/** How long a taken request comes back if its card goes. */
const SETTLE_MS = 3000;
/** The page path the request was made on: dropped once the reviewer leaves it. */
let requestPath: string | null = null;
let outline: Outline | null = null;
let lastSeq = 0;
const listeners = new Set<() => void>();
const notify = () => {
	for (const l of listeners) l();
};
const currentPath = () =>
	typeof window === "undefined" ? "" : window.location.pathname;

/** Drops the request (and any outline) once the path isn't the request's. */
function leftPage() {
	if ((current === null && held === null) || requestPath === currentPath())
		return;
	drop();
}

/** Ends whatever is pending, held or outlined; a frame still to scroll for it won't. */
function drop() {
	current = null;
	held = null;
	outline = null;
	lastSeq += 1;
	notify();
}

/** The request still pending here, or null (dropped once the path changed). */
function pending(): ThreadFocus | null {
	const snapshot = current;
	if (!snapshot) return null;
	if (requestPath !== currentPath()) {
		// Read during render: dropped just after it, so coming back to that
		// page never brings it back.
		queueMicrotask(leftPage);
		return null;
	}
	return snapshot;
}

/**
 * Every move to another page drops the request, whether or not anything
 * reads it while there: the router moves by the history API, and back and
 * forward by popstate. Wrapped once per window.
 */
function watchMoves() {
	if (typeof window === "undefined") return;
	const w = window as Window & { __crbThreadFocusMoves?: true };
	if (w.__crbThreadFocusMoves) return;
	w.__crbThreadFocusMoves = true;
	for (const name of ["pushState", "replaceState"] as const) {
		const original = history[name];
		history[name] = function (this: History, ...args) {
			const result = original.apply(this, args);
			leftPage();
			return result;
		} as History[typeof name];
	}
	window.addEventListener("popstate", leftPage);
}
watchMoves();

export const threadFocus = {
	request(target: {
		id: string;
		conversation?: string;
		message?: string;
		scope?: string;
	}): ThreadFocus {
		lastSeq += 1;
		current = {
			seq: lastSeq,
			id: target.id,
			...(target.conversation ? { conversation: target.conversation } : {}),
			...(target.message ? { message: target.message } : {}),
			...(target.scope !== undefined ? { scope: target.scope } : {}),
		};
		requestPath = currentPath();
		// A newer request: an earlier one's outline, not yet seen, is not;
		// nor does an earlier one come back.
		outline = null;
		held = null;
		notify();
		return current;
	},
	/** The pending request, if any, on the path it was made on. */
	get: pending,
	/** Ends request `seq`: its card took it; its message, if any, is outlined. */
	taken(seq: number, owner: object = {}) {
		if (current?.seq !== seq) return;
		if (current.message) {
			outline = { message: current.message, seq, at: Date.now() };
		}
		held = { focus: current, owner, at: Date.now() };
		current = null;
		notify();
	},
	/**
	 * The card that took the request is gone: within SETTLE_MS, and with
	 * nothing newer asked or cancelled, it is pending again for whichever
	 * card shows it now.
	 */
	release(owner: object) {
		if (held?.owner !== owner) return;
		const { focus, at } = held;
		held = null;
		if (
			Date.now() - at >= SETTLE_MS ||
			lastSeq !== focus.seq ||
			requestPath !== currentPath()
		)
			return;
		current = focus;
		notify();
		// Back only for the card that shows it now: not for one opened by
		// hand much later.
		setTimeout(() => {
			if (current !== focus) return;
			current = null;
			notify();
		}, SETTLE_MS);
	},
	/** Ends any pending request: the reviewer went elsewhere. */
	cancel() {
		if (current === null && outline === null && held === null) return;
		drop();
	},
	/** Ends a pending request made in another scope than `scope` (a row's, in another comparison). */
	cancelOutside(scope: string) {
		const scoped = current ?? held?.focus;
		if (scoped?.scope === undefined || scoped.scope === scope) return;
		drop();
	},
	/** The last message outlined. */
	outline: () => outline,
	/** Its outline shown: it doesn't light again on a later mount. */
	outlined(seq: number) {
		if (outline?.seq !== seq) return;
		outline = null;
		notify();
	},
	/** The newest request's number, pending or taken. */
	latest: () => lastSeq,
	/** Forgets everything (tests). */
	reset() {
		current = null;
		held = null;
		requestPath = null;
		outline = null;
		notify();
	},
	subscribe(listener: () => void) {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},
};

/** The pending request on the page showing, whatever it names. */
export function usePendingFocus(): ThreadFocus | null {
	const active = usePageActive();
	const focus = useSyncExternalStore(threadFocus.subscribe, threadFocus.get);
	return active ? focus : null;
}

/**
 * Whether `el` is drawn where the reviewer can see it: in the document and
 * not inside a hidden or inert part (a kept page that isn't showing, a
 * closed sheet), nor itself unrendered where the browser can tell.
 */
export function onScreen(el: Element | null): el is Element {
	if (!el?.isConnected || el.closest("[inert],[hidden]") !== null) return false;
	const check = (el as { checkVisibility?: () => boolean }).checkVisibility;
	return typeof check === "function" ? check.call(el) : true;
}

/**
 * Scrolls `el`'s top just below the sticky stack over it: the app header,
 * the Files bar and its file's header (as a thread link's landing does).
 */
function scrollUnder(el: Element, margin = 8) {
	window.scrollTo({
		top:
			el.getBoundingClientRect().top +
			window.scrollY -
			stickyBottom(el) -
			margin,
	});
}

/**
 * The pending request matching `matches`, once per request, on the page
 * showing: what a container (a file's bubbles, a review thread's agent
 * panel) opens for it.
 */
export function useFocusWhere(
	matches: (focus: ThreadFocus) => boolean,
	open: (focus: ThreadFocus) => void,
) {
	const active = usePageActive();
	// Only a request it matches re-renders it.
	const hit = useSyncExternalStore(threadFocus.subscribe, () => {
		const focus = threadFocus.get();
		return active && focus && matches(focus) ? focus : null;
	});
	const seq = hit?.seq ?? 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per request it matches.
	useEffect(() => {
		if (hit) open(hit);
	}, [seq]);
}

/** A request for one of a container's threads, by the card's id (`has`). */
export function useFocusAmong(
	has: (id: string) => boolean,
	open: (focus: ThreadFocus) => void,
) {
	useFocusWhere((f) => has(f.id), open);
}

/**
 * A card that can be asked for: when a request names `id` and the card is
 * on screen (on the page showing, not a hidden copy elsewhere), it takes
 * the request: it opens (`open`: expands, opens its conversation) and,
 * once drawn, scrolls in below the sticky stack (unless the page scrolls
 * it itself: `scroll` false). A copy that isn't on screen neither opens
 * nor takes it, and of two on screen only the first takes it.
 */
export function useFocusCard(
	id: string | undefined,
	ref: RefObject<Element | null>,
	open?: (focus: ThreadFocus) => void,
	options: {
		scroll?: boolean;
		/**
		 * Whether it can serve the request yet: a review thread's card whose
		 * agent conversation, asked for too, isn't known yet (the agent
		 * threads still on their way) leaves it pending until it is.
		 */
		ready?: (focus: ThreadFocus) => boolean;
	} = {},
) {
	const scroll = options.scroll !== false;
	const ready = options.ready;
	const active = usePageActive();
	// Only a request for this card re-renders it.
	const hit = useSyncExternalStore(threadFocus.subscribe, () => {
		const focus = threadFocus.get();
		return active && focus && id && focus.id === id && (!ready || ready(focus))
			? focus
			: null;
	});
	const seq = hit?.seq ?? 0;
	// The scroll's frames: taking the request re-renders the card (no
	// request names it any more), which must not cancel them; only
	// unmounting does.
	const frames = useRef<number[]>([]);
	// This card, as the store knows who took a request.
	const owner = useRef({});
	useEffect(
		() => () => {
			for (const f of frames.current) cancelAnimationFrame(f);
			// Gone right after taking it (moved elsewhere): the copy that
			// shows it now takes it again.
			threadFocus.release(owner.current);
		},
		[],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per request that names this card.
	useEffect(() => {
		// Still asked for: no other copy took it, nothing cancelled it.
		if (!hit || threadFocus.get()?.seq !== hit.seq || !onScreen(ref.current))
			return;
		open?.(hit);
		threadFocus.taken(hit.seq, owner.current);
		if (!scroll) return;
		// After what opening it draws; not once a newer request came.
		const outer = requestAnimationFrame(() => {
			const inner = requestAnimationFrame(() => {
				const el = ref.current;
				if (threadFocus.latest() !== hit.seq || !onScreen(el)) return;
				// A message named: it, centred (its outline), not the card's top.
				const message = hit.message
					? el.querySelector(`[data-message-id="${hit.message}"]`)
					: null;
				if (message) {
					message.scrollIntoView?.({ block: "center" });
					return;
				}
				scrollUnder(el);
				// The stack may still settle (the opened file's header sticks,
				// a bar wraps): once more, if the card ended up under it.
				const again = requestAnimationFrame(() => {
					if (threadFocus.latest() !== hit.seq || !onScreen(el)) return;
					if (el.getBoundingClientRect().top < stickyBottom(el) - 1) {
						scrollUnder(el);
					}
				});
				frames.current = [again];
			});
			frames.current = [inner];
		});
		frames.current = [outer];
	}, [seq]);
}

/** How long a message landed on keeps its outline. */
export const OUTLINE_MS = 2000;

/**
 * The message of `messages` a request landed on, while it is outlined:
 * scrolled into view (centred) as its card takes it, its outline gone
 * after OUTLINE_MS.
 */
export function useOutlinedMessage(
	messages: readonly { id: string }[] | undefined,
): string | null {
	const active = usePageActive();
	const landed = useSyncExternalStore(
		threadFocus.subscribe,
		threadFocus.outline,
	);
	const mine =
		active &&
		landed &&
		Date.now() - landed.at < OUTLINE_MS &&
		messages?.some((m) => m.id === landed.message)
			? landed
			: null;
	const [lit, setLit] = useState<Outline | null>(null);
	const seq = mine?.seq ?? 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per outline here.
	useEffect(() => {
		if (!mine) return;
		setLit(mine);
		threadFocus.outlined(mine.seq);
		document
			.querySelector(`[data-message-id="${mine.message}"]`)
			?.scrollIntoView?.({ block: "center" });
	}, [seq]);
	useEffect(() => {
		if (!lit) return;
		const timer = setTimeout(() => setLit(null), OUTLINE_MS);
		return () => clearTimeout(timer);
	}, [lit]);
	return lit?.message ?? null;
}
