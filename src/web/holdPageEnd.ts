import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/** What the page's end was last seen as: the scroll, the content's end, the room under it. */
export interface PageEnd {
	/** The window's scroll. */
	y: number;
	/** Where the content ends (the spacer's top), in page coordinates. */
	bottom: number;
	/** Where the content starts (under the header and the bars above it). */
	top: number;
	/** The spacer's height under the content. */
	spacer: number;
}

/** The page as measured now. */
export interface PageSeen {
	y: number;
	bottom: number;
	top: number;
	/** The window's height. */
	viewport: number;
	/** The scroll from which the app header is stuck (only its last row left). */
	stick: number;
}

/**
 * The page's end after a measure: the spacer under the content and the
 * scroll to put back, if any. When the content gets shorter under a reader
 * at its end (a mark drops a line from the verdict), the browser pulls the
 * scroll back by as much; on a short page, back above where the header
 * sticks, the header comes back down and its buttons move under the finger
 * (CAR-310). Then instead the room the content gave up is kept as a spacer
 * below it and the scroll stays. Only then: further down the header stays
 * put anyway, and the page's own scrolls (a file closed from deep inside
 * it, a thread landing above the line being read) keep their place.
 * The spacer only ever shrinks after that, as the reader scrolls up or the
 * content grows back, by exactly what's out of sight: nothing on screen
 * moves for it. A change above the content (a bar opening or closing over
 * the header, which keeps the line being read in place itself) is no
 * shrink to hold.
 */
export function nextPageEnd(
	last: PageEnd | null,
	now: PageSeen,
): { end: PageEnd; scrollTo: number | null } {
	if (!last) {
		return {
			end: { y: now.y, bottom: now.bottom, top: now.top, spacer: 0 },
			scrollTo: null,
		};
	}
	if (now.bottom < last.bottom && Math.abs(now.top - last.top) < 0.5) {
		// The browser pulled the scroll back to the page's new end, without
		// the reader scrolling: keep where they were.
		const end = Math.max(0, now.bottom + last.spacer - now.viewport);
		const pulled = now.y < last.y && now.y >= end - 1 && now.y < now.stick;
		const y = pulled ? last.y : now.y;
		return {
			end: {
				y,
				bottom: now.bottom,
				top: now.top,
				spacer: Math.max(0, y + now.viewport - now.bottom),
			},
			scrollTo: pulled ? y : null,
		};
	}
	return {
		end: {
			y: now.y,
			bottom: now.bottom,
			top: now.top,
			spacer: Math.max(
				0,
				Math.min(last.spacer, now.y + now.viewport - now.bottom),
			),
		},
		scrollTo: null,
	};
}

/**
 * Keeps the window's scroll when `content` gets shorter under the reader
 * (nextPageEnd), by giving `spacer` (an empty block after it) the height the
 * content gave up. `watched`: the elements whose size moves the page's end
 * (not the spacer's parent, which would see its own change). `reset`: a value that changes on navigation,
 * when a new page's height is no shrink to hold.
 */
export function useHoldPageEnd(
	content: RefObject<HTMLElement | null>,
	spacer: RefObject<HTMLElement | null>,
	/** The scroll from which the app header is stuck (PageSeen's `stick`). */
	stick: () => number,
	watched: RefObject<HTMLElement | null>[],
	reset: unknown,
) {
	const last = useRef<PageEnd | null>(null);
	const check = useRef(() => {});
	check.current = () => {
		const el = spacer.current;
		const from = content.current;
		if (!el || !from) return;
		const y = window.scrollY;
		const next = nextPageEnd(last.current, {
			y,
			bottom: el.getBoundingClientRect().top + y,
			top: from.getBoundingClientRect().top + y,
			viewport: document.documentElement.clientHeight,
			stick: stick(),
		});
		last.current = next.end;
		const height = `${next.end.spacer}px`;
		if (el.style.height !== height) el.style.height = height;
		if (next.scrollTo !== null) window.scrollTo(0, next.scrollTo);
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: on navigation only.
	useLayoutEffect(() => {
		if (spacer.current) spacer.current.style.height = "0px";
		last.current = null;
		check.current();
	}, [reset]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the refs are stable.
	useEffect(() => {
		let frame = 0;
		const schedule = () => {
			if (!frame)
				frame = requestAnimationFrame(() => {
					frame = 0;
					check.current();
				});
		};
		window.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		// Before paint, in the frame the content changed: the scroll the
		// browser pulled back is put back before it shows.
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(() => check.current());
		for (const ref of watched) if (ref.current) observer?.observe(ref.current);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
			observer?.disconnect();
		};
	}, []);
}
