import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReviewThread } from "../../shared/types";
import { agentDraftText } from "../agent/threadAgent";
import type { DraftStore } from "../threads/drafts";
import {
	type ThreadWritesState,
	useThreadWriter,
} from "../threads/threadWrites";
import { stickyBottom } from "./scrollAnchor";

/**
 * Resolve in Files changed closes the thread to its bubble (the owner,
 * 2026-11-09: "Resolving a comment should close it down to its bubble").
 * It closes on the press: the resolve goes to GitHub through the thread's
 * write queue as before. Any write of the thread GitHub refuses opens the
 * bubble again (beside its notice), so a failed write never disappears
 * with the thread. When other threads of the bubble are still showing,
 * only the resolved one is hidden (until it is seen unresolved) and focus
 * goes to the next one; once none shows, the bubble closes and takes the
 * focus, and opening it again shows all its threads. A thread with
 * unsent text (its reply box, an edit) or a reply, edit or delete still
 * on its way stays open. Unresolve closes nothing.
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

/** `hidden` without the threads seen unresolved: a later resolve by anyone else hides nothing. */
export function pruneHidden<K>(
	hidden: ByThread<K>,
	threads: readonly ReviewThread[],
): ByThread<K> {
	if (hidden.size === 0) return hidden;
	const open = new Set(threads.filter((t) => !t.resolved).map((t) => t.id));
	if (![...hidden.keys()].some((id) => open.has(id))) return hidden;
	return new Map([...hidden].filter(([id]) => !open.has(id)));
}

/**
 * The thread has something not yet on GitHub that closing would hide:
 * text in its reply box (or typed to its agent), an edit in progress, a reply, edit or delete
 * on its way, or a refused write still listed (closing would only reopen).
 */
export function unsettled(
	threadId: string,
	drafts: Pick<DraftStore, "text" | "get">,
	writes: Pick<ThreadWritesState, "threads">,
): boolean {
	if (drafts.text(threadId).trim()) return true;
	// Typed to its agent and not sent: kept open, as an unsent reply is.
	if (agentDraftText(threadId).trim()) return true;
	if (
		drafts.get().some((d) => d.threadId === threadId && (d.edit || d.sending))
	) {
		return true;
	}
	const view = writes.threads.get(threadId);
	return Boolean(
		view &&
			(view.refused.length > 0 ||
				view.replies.length > 0 ||
				view.edits.length > 0 ||
				view.deletes.length > 0),
	);
}

/**
 * The closed threads as the writes have them now: one with a write GitHub
 * refused (not being retried) leaves the watch and its bubble opens again;
 * one with nothing left on its way leaves the watch.
 */
export function settleWatch<K>(
	watch: ByThread<K>,
	writes: Pick<ThreadWritesState, "threads">,
): { watch: ByThread<K>; reopen: { id: string; key: K }[] } {
	const reopen: { id: string; key: K }[] = [];
	const next = new Map<string, K>();
	for (const [id, key] of watch) {
		const view = writes.threads.get(id);
		if (view?.refused.some((f) => !f.retrying)) reopen.push({ id, key });
		else if (
			view &&
			(view.resolved === true ||
				view.refused.length > 0 ||
				view.replies.length > 0 ||
				view.edits.length > 0 ||
				view.deletes.length > 0)
		) {
			next.set(id, key);
		}
	}
	return { watch: next.size === watch.size ? watch : next, reopen };
}

/** The first control of a thread's card: where focus goes when a sibling closes. */
const CONTROLS = "button:not([disabled]), textarea, input, a[href]";

/** What a diff (or a file's header) does with its bubbles. */
export interface Bubbles<K> {
	open: (key: K) => void;
	/** Close the bubble `key`, open under any of `keys` too. */
	close: (key: K, keys: readonly K[]) => void;
	/** Focus the bubble once shown. */
	focus: (key: K) => void;
	/** The bubble's button, while its threads are open. */
	element: (key: K) => Element | null;
}

export interface ResolveCollapse<K> {
	/** Whether an opened bubble shows the thread (Resolve didn't hide it). */
	shows: (thread: ReviewThread) => boolean;
	/**
	 * Resolve was pressed on `thread`, opened under `key` (and `keys`) with
	 * `shown`, from the button `from`. What it did: the thread stayed
	 * (unsent text, a write on its way), was hidden while others still
	 * show, or closed the bubble.
	 */
	resolved: (press: {
		key: K;
		keys?: readonly K[];
		thread: ReviewThread;
		shown: readonly ReviewThread[];
		from?: Element;
	}) => "kept" | "hidden" | "closed";
	/** The bubble was opened or closed by hand: it shows all its threads. */
	toggled: (key: K) => void;
}

/** After a close: the bubble to bring down from above the view, or the card to focus. */
type After = { bubble: Element } | { card: Element };

export function useResolveCollapse<K>(
	/** The threads as shown (a thread seen unresolved is never hidden again). */
	threads: readonly ReviewThread[] | undefined,
	bubbles: Bubbles<K>,
): ResolveCollapse<K> {
	const writer = useThreadWriter();
	const [hidden, setHidden] = useState<ByThread<K>>(() => new Map());
	const [watch, setWatch] = useState<ByThread<K>>(() => new Map());
	const after = useRef<After | null>(null);
	const [closed, setClosed] = useState(0);
	const latest = useRef(bubbles);
	latest.current = bubbles;
	useEffect(() => {
		if (threads) setHidden((h) => pruneHidden(h, threads));
	}, [threads]);
	// Only while a closed thread has a write out: every file's diff has
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs after each close.
	useLayoutEffect(() => {
		const a = after.current;
		after.current = null;
		if (!a) return;
		if ("card" in a) {
			a.card.querySelector<HTMLElement>(CONTROLS)?.focus();
			return;
		}
		// The bubble was above the view (a long thread): bring its line down
		// to just under the sticky headers, not past it to what followed.
		const sticky = stickyBottom(a.bubble);
		const top = a.bubble.getBoundingClientRect().top;
		if (top < sticky) window.scrollBy(0, top - sticky);
	}, [closed]);
	return {
		shows: (t) => !hiddenIn(hidden, t),
		resolved: ({ key, keys = [], thread, shown, from }) => {
			if (unsettled(thread.id, writer.drafts, writer.getState())) {
				return "kept";
			}
			const { closeBubble } = closeResolved(hidden, key, thread, shown);
			if (closeBubble) {
				const bubble = latest.current.element(key);
				const above =
					bubble && bubble.getBoundingClientRect().top < stickyBottom(bubble);
				after.current = above ? { bubble } : null;
			} else {
				// The next card shown (else the one before) takes the focus: it
				// is where the reader is, the bubble may be far above.
				const card = from?.closest("article");
				const sibling = (el: Element | null | undefined, next: boolean) => {
					let s = next ? el?.nextElementSibling : el?.previousElementSibling;
					while (s && s.tagName !== "ARTICLE") {
						s = next ? s.nextElementSibling : s.previousElementSibling;
					}
					return s ?? null;
				};
				const to = sibling(card, true) ?? sibling(card, false);
				after.current = to ? { card: to } : null;
			}
			setClosed((n) => n + 1);
			setHidden((h) => closeResolved(h, key, thread, shown).hidden);
			setWatch((w) => new Map(w).set(thread.id, key));
			if (closeBubble) {
				latest.current.close(key, keys);
				latest.current.focus(key);
			}
			return closeBubble ? "closed" : "hidden";
		},
		toggled: (key) => setHidden((h) => forBubble(h, key)),
	};
}
