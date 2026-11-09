import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReviewThread } from "../../shared/types";
import {
	type ThreadWritesState,
	useThreadWriter,
} from "../threads/threadWrites";

/**
 * Resolve in Files changed closes the thread to its bubble (the owner,
 * 2026-11-09: "Resolving a comment should close it down to its bubble").
 * It closes on the press: the resolve goes to GitHub through the thread's
 * write queue as before, and a resolve GitHub refuses opens the bubble
 * again (besides its notice), so a failed write never disappears with the
 * thread. When other threads of the bubble are still showing, only the
 * resolved one is hidden; once none shows, the bubble closes, and opening
 * it again shows all its threads. A thread whose reply box holds a draft
 * stays open: unsent text never hides behind a bubble. Unresolve closes
 * nothing.
 */

/** Threads by id, each with the bubble (its open key) it is under. */
export type ByThread<K> = ReadonlyMap<string, K>;

/** Whether Resolve hides `thread` from its open bubble (it stays resolved). */
export const hiddenIn = <K>(hidden: ByThread<K>, thread: ReviewThread) =>
	hidden.has(thread.id) && thread.resolved;

/**
 * Resolve pressed on `thread` in the bubble `key` showing `shown`: hidden
 * there while others still show, else the bubble closes (and shows all its
 * threads when opened again).
 */
export function closeResolved<K>(
	hidden: ByThread<K>,
	key: K,
	thread: ReviewThread,
	shown: readonly ReviewThread[],
): { hidden: ByThread<K>; closeBubble: boolean } {
	const rest = shown.filter((t) => t.id !== thread.id && !hiddenIn(hidden, t));
	if (rest.length > 0) {
		return { hidden: new Map(hidden).set(thread.id, key), closeBubble: false };
	}
	return { hidden: forBubble(hidden, key), closeBubble: true };
}

/** `hidden` without the threads of the bubble `key` (it was toggled, or closed). */
export function forBubble<K>(hidden: ByThread<K>, key: K): ByThread<K> {
	if (![...hidden.values()].includes(key)) return hidden;
	return new Map([...hidden].filter(([, k]) => k !== key));
}

/**
 * The closed threads' resolves as the writes have them now: one GitHub
 * refused (and not being retried) leaves the watch and its bubble opens
 * again; one GitHub has (or that was undone) leaves the watch.
 */
export function settleWatch<K>(
	watch: ByThread<K>,
	writes: Pick<ThreadWritesState, "threads">,
): { watch: ByThread<K>; reopen: { id: string; key: K }[] } {
	const reopen: { id: string; key: K }[] = [];
	const next = new Map<string, K>();
	for (const [id, key] of watch) {
		const view = writes.threads.get(id);
		if (view?.refused.some((f) => f.resolved === true && !f.retrying)) {
			reopen.push({ id, key });
		} else if (view?.resolved === true) next.set(id, key);
	}
	return { watch: next.size === watch.size ? watch : next, reopen };
}

/** How far down the page's sticky stack (app header, Files bar, the file's header) reaches. */
function stickyTop(el: Element): number {
	const section = el.closest("section");
	const header = section?.querySelector("header");
	const vars = getComputedStyle(el);
	return (
		(Number.parseFloat(vars.getPropertyValue("--app-header")) || 0) +
		(Number.parseFloat(vars.getPropertyValue("--files-bar")) || 0) +
		(header?.getBoundingClientRect().height ?? 0)
	);
}

/** Where a bubble was before its thread closed, and where Resolve was pressed. */
interface Pin {
	bubble: Element;
	top: number;
	press: number | null;
	closed: boolean;
}

/**
 * The bubble stays where the reader is looking: where it was when in view;
 * if it was above the view (a long thread) and its row closed, where
 * Resolve was pressed, so the reader lands on the line, not further on.
 */
export function pinTarget(pin: Omit<Pin, "bubble">, sticky: number): number {
	if (pin.top >= sticky || !pin.closed) return pin.top;
	return Math.max(sticky, pin.press ?? sticky);
}

/** What a diff (or a file's header) does with its bubbles. */
export interface Bubbles<K> {
	open: (key: K) => void;
	close: (key: K) => void;
	/** Focus the bubble once shown. */
	focus: (key: K) => void;
	/** The bubble's button, while its threads are open. */
	element: (key: K) => Element | null;
}

export interface ResolveCollapse<K> {
	/** Whether an opened bubble shows the thread (Resolve didn't hide it). */
	shows: (thread: ReviewThread) => boolean;
	/** Resolve was pressed on `thread`, opened under `key` with `shown`. */
	resolved: (
		key: K,
		thread: ReviewThread,
		shown: readonly ReviewThread[],
		from?: Element,
	) => void;
	/** The bubble was opened or closed by hand: it shows all its threads. */
	toggled: (key: K) => void;
}

export function useResolveCollapse<K>(bubbles: Bubbles<K>): ResolveCollapse<K> {
	const writer = useThreadWriter();
	const [hidden, setHidden] = useState<ByThread<K>>(() => new Map());
	const [watch, setWatch] = useState<ByThread<K>>(() => new Map());
	const pin = useRef<Pin | null>(null);
	const latest = useRef(bubbles);
	latest.current = bubbles;
	// Only while a closed thread's resolve is out: every file's diff has
	// this, and most never watch anything.
	useEffect(() => {
		if (watch.size === 0) return;
		const check = () => {
			const settled = settleWatch(watch, writer.getState());
			if (settled.watch === watch) return;
			setWatch(settled.watch);
			if (settled.reopen.length === 0) return;
			setHidden((h) => {
				const next = new Map(h);
				for (const r of settled.reopen) next.delete(r.id);
				return next;
			});
			for (const r of settled.reopen) latest.current.open(r.key);
		};
		check();
		return writer.subscribe(check);
	}, [watch, writer]);
	// After the close is drawn, before it's painted.
	useLayoutEffect(() => {
		const p = pin.current;
		pin.current = null;
		if (!p?.bubble.isConnected) return;
		const target = pinTarget(p, stickyTop(p.bubble));
		const delta = p.bubble.getBoundingClientRect().top - target;
		if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
	});
	return {
		shows: (t) => !hiddenIn(hidden, t),
		resolved: (key, thread, shown, from) => {
			// Unsent text stays in sight (it is kept either way: drafts.ts).
			if (writer.drafts.text(thread.id).trim()) return;
			const { closeBubble } = closeResolved(hidden, key, thread, shown);
			const bubble = latest.current.element(key);
			pin.current = bubble
				? {
						bubble,
						top: bubble.getBoundingClientRect().top,
						press: from?.getBoundingClientRect().top ?? null,
						closed: closeBubble,
					}
				: null;
			setHidden((h) => closeResolved(h, key, thread, shown).hidden);
			setWatch((w) => new Map(w).set(thread.id, key));
			if (closeBubble) latest.current.close(key);
			latest.current.focus(key);
		},
		toggled: (key) => setHidden((h) => forBubble(h, key)),
	};
}
