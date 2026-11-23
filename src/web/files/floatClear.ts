import { type RefObject, useCallback, useLayoutEffect, useState } from "react";

/**
 * The phone's floating Files button makes way while a card's control is
 * under it (CAR-248). Cards (TailRow: threads, composers, agent cards)
 * register themselves here; the button watches only them, so nothing else
 * on the page (diff lines, their gutter buttons, toasts) costs it anything.
 */

const cards = new Set<HTMLElement>();
const changed = new Set<() => void>();

function notify() {
	for (const f of changed) f();
}

/** A ref callback for a card the Files button keeps clear of. */
export function useFloatClearCard(): (el: HTMLElement | null) => () => void {
	return useCallback((el: HTMLElement | null) => {
		if (!el) return () => {};
		cards.add(el);
		notify();
		return () => {
			cards.delete(el);
			notify();
		};
	}, []);
}

/**
 * What a tap acts on: a control, not a time stamp's tooltip or a focusable
 * preview (those only show more).
 */
const CONTROLS =
	'button:not(:disabled), a[href], textarea:not(:disabled), select:not(:disabled), input:not([type="hidden"]):not(:disabled)';

/** Counted as under the button this close to it, not only on it. */
const SLACK = 4;

type Box = { left: number; top: number; right: number; bottom: number };

const overlaps = (a: Box, b: Box) =>
	a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Whether a control of one of `among` overlaps `fab` (the button's
 * viewport rect, grown by SLACK). Each card's own rect first, then the
 * controls of only those cards that reach the button: the cost follows
 * the cards, never the rest of the page.
 */
export function controlUnder(among: Iterable<Element>, fab: Box): boolean {
	const near = {
		left: fab.left - SLACK,
		top: fab.top - SLACK,
		right: fab.right + SLACK,
		bottom: fab.bottom + SLACK,
	};
	for (const card of among) {
		if (!overlaps(card.getBoundingClientRect(), near)) continue;
		for (const control of card.querySelectorAll(CONTROLS)) {
			const r = control.getBoundingClientRect();
			if (r.width > 0 && r.height > 0 && overlaps(r, near)) return true;
		}
	}
	return false;
}

/**
 * Watches the registered cards for `fab`, calling `report` with whether a
 * control is under it whenever that may have changed: the page or a
 * scroller scrolled, the viewport (a phone's toolbar) or a card resized, a
 * card's contents changed, a card came or went. Checked at most once a
 * frame, and only the cards on screen. The button's rect is read live:
 * it stays laid out while hidden (`invisible`), so no viewport arithmetic.
 * Returns a stop.
 */
export function watchFloat(
	fab: HTMLElement,
	report: (under: boolean) => void,
): () => void {
	// The cards on screen (all of them without an IntersectionObserver).
	const shown = new Set<Element>();
	const watched = new Set<HTMLElement>();
	let frame = 0;
	const check = (among: Set<Element> = io ? shown : watched) => {
		frame = 0;
		const r = fab.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return report(false);
		report(controlUnder(among, r));
	};
	const schedule = () => {
		if (frame) return;
		frame = requestAnimationFrame(() => check());
	};
	const io =
		typeof IntersectionObserver === "undefined"
			? null
			: new IntersectionObserver((entries) => {
					for (const e of entries) {
						if (e.isIntersecting) shown.add(e.target);
						else shown.delete(e.target);
					}
					schedule();
				});
	const ro =
		typeof ResizeObserver === "undefined"
			? null
			: new ResizeObserver(() => schedule());
	// Each card's own contents: a change anywhere else never syncs.
	const mo = new MutationObserver(() => schedule());
	const onCards = () => {
		for (const card of watched) {
			if (cards.has(card)) continue;
			watched.delete(card);
			shown.delete(card);
			io?.unobserve(card);
			ro?.unobserve(card);
			// The MutationObserver keeps the detached card: it never changes.
		}
		for (const card of cards) {
			if (watched.has(card)) continue;
			watched.add(card);
			io?.observe(card);
			ro?.observe(card);
			mo.observe(card, { childList: true, subtree: true });
		}
		schedule();
	};
	changed.add(onCards);
	onCards();
	const opts = { capture: true, passive: true } as const;
	window.addEventListener("scroll", schedule, opts);
	window.addEventListener("resize", schedule);
	window.visualViewport?.addEventListener("resize", schedule);
	ro?.observe(fab);
	// Before the first paint, every card (the IntersectionObserver hasn't
	// reported yet): no frame with the button over a control.
	check(watched);
	return () => {
		changed.delete(onCards);
		cancelAnimationFrame(frame);
		window.removeEventListener("scroll", schedule, opts);
		window.removeEventListener("resize", schedule);
		window.visualViewport?.removeEventListener("resize", schedule);
		io?.disconnect();
		ro?.disconnect();
		mo.disconnect();
	};
}

/** Whether a card's control sits under the fixed element `fab`, while `on`. */
export function useControlUnder(
	fab: RefObject<HTMLElement | null>,
	on: boolean,
): boolean {
	const [under, setUnder] = useState(false);
	useLayoutEffect(() => {
		const el = fab.current;
		if (!on || !el) {
			setUnder(false);
			return;
		}
		return watchFloat(el, setUnder);
	}, [fab, on]);
	return on && under;
}
