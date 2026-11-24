import type { RouterHistory } from "@tanstack/react-router";
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
 * sticky stack, and stays there while the page settles around it until
 * the reviewer acts (keepInPlace); a message named is outlined for a moment.
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
/**
 * The router histories followed (`threadFocus.follow`), one entry per
 * follow still on, newest last: the path is the newest's. Each history is
 * subscribed once however often it is followed.
 */
const followed: RouterHistory[] = [];
const unsubscribes = new Map<RouterHistory, () => void>();
const currentPath = () => {
	const moves = followed.at(-1);
	if (moves) return moves.location.pathname;
	return typeof window === "undefined" ? "" : window.location.pathname;
};

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
	/**
	 * Every move to another page drops the request, whether or not anything
	 * reads it while there: `history` is the router's, which tells of each
	 * push and replace, and of back and forward. The app follows its router
	 * from its creation (main.tsx), and the root while mounted. The returned
	 * function stops this follow: the one followed before is the path again.
	 */
	follow(history: RouterHistory): () => void {
		if (!unsubscribes.has(history))
			unsubscribes.set(history, history.subscribe(leftPage));
		followed.push(history);
		let on = true;
		return () => {
			if (!on) return;
			on = false;
			followed.splice(followed.lastIndexOf(history), 1);
			if (followed.includes(history)) return;
			unsubscribes.get(history)?.();
			unsubscribes.delete(history);
		};
	},
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

/** How many keepInPlace holds are on: the browser's scroll anchoring is off while any is. */
let anchoringHolds = 0;

/**
 * The browser's scroll anchoring off on the page's scroller while a card is
 * held in place (index.css: html[data-focus-hold] { overflow-anchor: none }),
 * or back on with the last hold. Its own attribute: a pending thread's
 * landing (pendingThread.ts, data-landing) turns it off and on by itself.
 */
function holdAnchoring(off: boolean): void {
	anchoringHolds = Math.max(0, anchoringHolds + (off ? 1 : -1));
	const root = document.documentElement;
	if (anchoringHolds > 0) root.dataset.focusHold = "";
	else delete root.dataset.focusHold;
}

/** What the reviewer does that ends keepInPlace: they move the page themselves. */
const REVIEWER_INPUT = [
	"wheel",
	"touchstart",
	"pointerdown",
	"keydown",
] as const;

/**
 * Keeps a card just scrolled in where it landed, below the sticky stack,
 * while the page settles around it: whatever above it changes height (the
 * tracer's placements answering move a thread out of the file bubble
 * above it to the list under the header; the stack sticks or wraps), the
 * page scrolls by as much, so the card asked for never ends up under the
 * stack or out of view (CAR-239). The browser's scroll anchoring is off
 * meanwhile (its adjustments would add to these). It lasts until the
 * reviewer acts (a wheel, a touch, a click, a key), the page scrolls by
 * anything else,
 * `wanted` turns false (a newer request, a cancel, the card gone) or the
 * returned stop is called. Checked in the frame after it starts and after
 * each change to the document, never on a timer.
 */
export function keepInPlace(el: Element, wanted: () => boolean): () => void {
	const offset = () => el.getBoundingClientRect().top - stickyBottom(el);
	const landed = offset();
	let frame = 0;
	let stopped = false;
	/** Where it left the page: a scroll elsewhere, with nothing changed, isn't its own. */
	let leftAt = window.scrollY;
	const check = () => {
		frame = 0;
		if (stopped) return;
		if (!wanted()) {
			stop();
			return;
		}
		const delta = offset() - landed;
		if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
		leftAt = window.scrollY;
	};
	const changed = () => {
		if (!stopped && frame === 0) frame = requestAnimationFrame(check);
	};
	// The browser's own scroll anchoring stays out while it holds, so the
	// page moves only by its scrolls or someone else's: any scroll not to
	// where it left the page is someone else's (the scrollbar dragged, a
	// find step, a screen reader, a status-bar tap), and it lets go.
	holdAnchoring(true);
	const scrolled = () => {
		if (Math.abs(window.scrollY - leftAt) >= 1) stop();
	};
	window.addEventListener("scroll", scrolled, { passive: true });
	const mutations = new MutationObserver(changed);
	mutations.observe(document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		characterData: true,
	});
	const sizes =
		typeof ResizeObserver === "undefined" ? null : new ResizeObserver(changed);
	sizes?.observe(document.documentElement);
	const unsubscribe = threadFocus.subscribe(() => {
		if (!wanted()) stop();
	});
	const options = { capture: true, passive: true } as const;
	function stop() {
		if (stopped) return;
		stopped = true;
		if (frame !== 0) cancelAnimationFrame(frame);
		mutations.disconnect();
		sizes?.disconnect();
		unsubscribe();
		window.removeEventListener("scroll", scrolled);
		holdAnchoring(false);
		for (const type of REVIEWER_INPUT) {
			window.removeEventListener(type, stop, options);
		}
	}
	for (const type of REVIEWER_INPUT) {
		window.addEventListener(type, stop, options);
	}
	// Once in the next frame whatever happens: the stack may settle (the
	// opened file's header sticks) with nothing to observe.
	changed();
	return stop;
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
	// Keeping it where it landed (keepInPlace), until the reviewer acts.
	const hold = useRef<(() => void) | null>(null);
	useEffect(
		() => () => {
			for (const f of frames.current) cancelAnimationFrame(f);
			hold.current?.();
			hold.current = null;
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
					? el.querySelector(`[data-message-id="${CSS.escape(hit.message)}"]`)
					: null;
				if (message) {
					message.scrollIntoView?.({ block: "center" });
					return;
				}
				scrollUnder(el);
				// The page may still settle under it (the opened file's header
				// sticks, a bar wraps, the placements answer and move the
				// threads above it): it stays where it landed until the
				// reviewer acts (CAR-239).
				hold.current?.();
				hold.current = keepInPlace(
					el,
					() => threadFocus.latest() === hit.seq && onScreen(el),
				);
				frames.current = [];
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
 * after OUTLINE_MS. `landed` is the caller's own element for that message
 * (the one it outlines): only it scrolls, never another copy of the
 * message elsewhere on the page (a kept page, a closed sheet, another
 * card), and only while it is on screen.
 */
export function useOutlinedMessage(
	messages: readonly { id: string }[] | undefined,
	landed: RefObject<Element | null>,
): string | null {
	const active = usePageActive();
	const outlined = useSyncExternalStore(
		threadFocus.subscribe,
		threadFocus.outline,
	);
	const mine =
		active &&
		outlined &&
		Date.now() - outlined.at < OUTLINE_MS &&
		messages?.some((m) => m.id === outlined.message)
			? outlined
			: null;
	const [lit, setLit] = useState<Outline | null>(null);
	const seq = mine?.seq ?? 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per outline here.
	useEffect(() => {
		if (!mine) return;
		setLit(mine);
		threadFocus.outlined(mine.seq);
	}, [seq]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `landed` is a ref, read once lit drew it.
	useEffect(() => {
		if (!lit) return;
		// Drawn lit by now: the caller's element for it, if it shows.
		const el = landed.current;
		if (onScreen(el)) el.scrollIntoView?.({ block: "center" });
		const timer = setTimeout(() => setLit(null), OUTLINE_MS);
		return () => clearTimeout(timer);
	}, [lit]);
	return lit?.message ?? null;
}
