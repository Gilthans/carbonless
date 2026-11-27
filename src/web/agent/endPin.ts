import { type RefObject, type UIEvent, useLayoutEffect, useRef } from "react";

/**
 * A scroll box opened at its end that keeps to it while the reader is
 * there: what grows in it (a new message, a streamed answer, a spinner
 * giving way to the answer) keeps it at the end; scrolled up, nothing
 * moves (new content lands below what is in sight). The box's CSS turns
 * the browser's scroll anchoring off (`[overflow-anchor:none]`, END_PIN):
 * its adjustments (a stored reply taking the streamed one's place) fire
 * scroll events that read as the reader leaving the end, and the pin let
 * go (seen on a phone, CAR-246).
 *
 * Not flex-col-reverse: in a reversed box, Chromium's scroll anchoring let
 * a reader scrolled up jump when a reply landed (measured 70px, CAR-246
 * and CAR-316).
 *
 * `box` is the scroll box, `content` what grows in it (both observed).
 * The pin starts (at the end) whenever `active` turns true with the box
 * mounted. `onChange` runs on every resize and scroll (the code card's
 * floating question); `held` says a jump is under way, while which a
 * scroll never counts as reaching the end. Returns the box's onScroll and
 * `leave()`, which lets go of the end until the reader comes back to it.
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
	// The latest callbacks, read by the observer set up once per activation.
	const latest = useRef(options);
	latest.current = options;
	useLayoutEffect(() => {
		const el = box.current;
		const inner = content.current;
		if (!active || !el || !inner) return;
		atEnd.current = true;
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
			if (!atEnd.current) return;
			const moved = Math.abs(el.scrollTop - seen.current.top) >= 1;
			const shrank = el.scrollHeight < seen.current.height;
			const end = isAtEnd(el);
			if (moved && !shrank && !end) {
				atEnd.current = false;
				pinned.current = null;
				seen.current = { top: el.scrollTop, height: el.scrollHeight };
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
		},
		leave: () => {
			atEnd.current = false;
			pinned.current = null;
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
