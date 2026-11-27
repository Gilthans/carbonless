import { type RefObject, type UIEvent, useLayoutEffect, useRef } from "react";

/**
 * A scroll box opened at its end that keeps to it while the reader is
 * there: what grows in it (a new message, a streamed answer, a spinner
 * giving way to the answer) keeps it at the end. Scrolled up, what the
 * reader is on stays put: new content lands below it, and content changing
 * height above it (a resolve suggestion going from an earlier answer) is
 * made up for by the pin, which keeps its anchor (readingAnchor) where it
 * was (CAR-316).
 *
 * The browser's scroll anchoring is off in the box (`[overflow-anchor:none]`,
 * END_PIN): its adjustments (a stored reply taking the streamed one's place)
 * fired scroll events that read as the reader leaving the end, and the pin
 * let go (seen on a phone, CAR-246). Nor would it keep what is read: it
 * anchors on the first thing in sight, so a change between that and what
 * is read below still moved it.
 *
 * Not flex-col-reverse: in a reversed box, a reader scrolled up jumped when
 * a reply landed (measured 70px, CAR-246 and CAR-316).
 *
 * `box` is the scroll box, `content` what grows in it (both observed).
 * The pin starts (at the end) whenever `active` turns true with the box
 * mounted. `onChange` runs on every resize and scroll (the code card's
 * floating question); `held` says a jump is under way, while which a
 * scroll never counts as reaching the end and nothing is made up for.
 * Returns the box's onScroll and `leave()`, which lets go of the end until
 * the reader comes back to it.
 */
export function useEndPin(
	box: RefObject<HTMLElement | null>,
	content: RefObject<HTMLElement | null>,
	options: {
		active?: boolean;
		onChange?: () => void;
		held?: () => boolean;
	} = {},
): { onScroll: (e: UIEvent<HTMLElement>) => void; leave: () => void } {
	const active = options.active ?? true;
	const atEnd = useRef(true);
	// Where the last pin left scrollTop: its scroll event comes a frame
	// later, maybe after the content grew again, and must not read as the
	// reader leaving the end.
	const pinned = useRef<number | null>(null);
	// Its scrollTop and scrollHeight as last seen (a pin or a scroll
	// event): moved since by someone else while the content didn't shrink
	// (a landing's scrollIntoView, in the same frame as the content grew),
	// the pin lets go rather than undo it. Content that shrank moves it by
	// a clamp, maybe one restored later (React puts back the scrollTop it
	// read mid-commit when it refocuses, as Preview hides the comment's
	// box): that pins again.
	const seen = useRef({ top: 0, height: 0 });
	// Scrolled up: what the reader is on, and where it was in the box.
	const anchor = useRef<Anchor | null>(null);
	// The latest callbacks, read by the observer set up once per activation.
	const latest = useRef(options);
	latest.current = options;
	const mark = () => {
		const el = box.current;
		const inner = content.current;
		anchor.current =
			el && inner && !atEnd.current ? readingAnchor(el, inner) : null;
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: mark reads refs only.
	useLayoutEffect(() => {
		const el = box.current;
		const inner = content.current;
		if (!active || !el || !inner) return;
		atEnd.current = true;
		anchor.current = null;
		const changed = () => latest.current.onChange?.();
		const toEnd = () => {
			el.scrollTop = el.scrollHeight;
			pinned.current = el.scrollTop;
			seen.current = { top: el.scrollTop, height: el.scrollHeight };
		};
		toEnd();
		if (typeof ResizeObserver === "undefined") return;
		const pin = new ResizeObserver(() => {
			changed();
			if (!atEnd.current) {
				// What changed above the reader's anchor moved it: back.
				const a = anchor.current;
				const now = a && !latest.current.held?.() ? anchorOffset(el, a) : null;
				if (a && now !== null && Math.abs(now - a.offset) >= 1) {
					el.scrollTop += now - a.offset;
					seen.current = { top: el.scrollTop, height: el.scrollHeight };
				}
				mark();
				return;
			}
			const moved = Math.abs(el.scrollTop - seen.current.top) >= 1;
			const shrank = el.scrollHeight < seen.current.height;
			const end = isAtEnd(el);
			if (moved && !shrank && !end) {
				atEnd.current = false;
				pinned.current = null;
				seen.current = { top: el.scrollTop, height: el.scrollHeight };
				mark();
				return;
			}
			toEnd();
			changed();
		});
		pin.observe(inner);
		pin.observe(el);
		return () => pin.disconnect();
	}, [active, box, content]);
	return {
		onScroll: (e) => {
			const el = e.currentTarget;
			seen.current = { top: el.scrollTop, height: el.scrollHeight };
			latest.current.onChange?.();
			if (
				pinned.current !== null &&
				Math.abs(el.scrollTop - pinned.current) < 1
			)
				return;
			pinned.current = null;
			atEnd.current = !latest.current.held?.() && isAtEnd(el);
			mark();
		},
		leave: () => {
			atEnd.current = false;
			pinned.current = null;
			mark();
		},
	};
}

/** At the end of its scroll (2px of slack for fractional sizes). */
export function isAtEnd(el: {
	scrollTop: number;
	clientHeight: number;
	scrollHeight: number;
}): boolean {
	return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
}

/** A box's classes for the pin: the browser's scroll anchoring off (useEndPin). */
export const END_PIN = "[overflow-anchor:none]";

/** What the reader is on: an element, the edge kept, its offset from the box's top. */
interface Anchor {
	el: Element;
	edge: "top" | "bottom";
	offset: number;
}

/**
 * What the reader is on in `box`: the focused element inside `content`
 * when it is in sight (a comment being typed in: by its bottom while its
 * top is scrolled out, the line typed on being below), else the deepest
 * element across the box's middle, by its top. Null when there is none.
 */
export function readingAnchor(box: Element, content: Element): Anchor | null {
	const b = box.getBoundingClientRect();
	const focused = document.activeElement;
	if (focused && focused !== content && content.contains(focused)) {
		const r = focused.getBoundingClientRect();
		if (r.height > 0 && r.bottom > b.top && r.top < b.bottom) {
			const edge = r.top < b.top ? "bottom" : "top";
			return { el: focused, edge, offset: r[edge] - b.top };
		}
	}
	const middle = b.top + box.clientHeight / 2;
	let at: Element = content;
	for (;;) {
		const next = [...at.children].find((c) => {
			const r = c.getBoundingClientRect();
			return r.height > 0 && r.top <= middle && r.bottom > middle;
		});
		if (!next) break;
		at = next;
	}
	if (at === content) return null;
	return {
		el: at,
		edge: "top",
		offset: at.getBoundingClientRect().top - b.top,
	};
}

/** The anchor's offset from the box's top now; null once it is gone or hidden. */
function anchorOffset(box: Element, a: Anchor): number | null {
	if (!a.el.isConnected) return null;
	const r = a.el.getBoundingClientRect();
	if (r.height === 0) return null;
	return r[a.edge] - box.getBoundingClientRect().top;
}
