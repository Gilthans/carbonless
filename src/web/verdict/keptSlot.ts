import { useRouterState } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Keys that scroll the page (outside a text field). */
const SCROLL_KEYS = new Set([
	"PageUp",
	"PageDown",
	"ArrowUp",
	"ArrowDown",
	"Home",
	"End",
	" ",
]);

const editing = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	(target.isContentEditable ||
		target.closest("input, textarea, select") !== null);

/**
 * A line that goes away on its own (no act of the reader's: a mark starting
 * a patch set drops the verdict's "an older commit") keeps its room, empty,
 * until the reader's next own scroll (wheel, touch, a scroll key) or another
 * page. Gone at once, it would shorten the page under a reader at its end:
 * the browser pulls the scroll back, and on a short page the header comes
 * back down and its buttons move under the finger (CAR-310).
 *
 * `ref` goes on the line while it shows; `kept` is the height to keep in
 * its place once it has gone, or null.
 */
export function useKeptSlot<T extends HTMLElement>(shown: boolean) {
	const ref = useRef<T>(null);
	const height = useRef(0);
	const [released, setReleased] = useState(false);
	const path = useRouterState({ select: (state) => state.location.pathname });
	// Measured while it shows. The room is in the very commit that drops the
	// line: a layout read in between would let the browser pull the scroll.
	useLayoutEffect(() => {
		if (!shown) return;
		height.current = ref.current?.offsetHeight ?? 0;
		setReleased(false);
	});
	const kept =
		!shown && !released && height.current > 0 ? height.current : null;
	// Another page lets it go.
	const lastPath = useRef(path);
	useEffect(() => {
		if (lastPath.current === path) return;
		lastPath.current = path;
		setReleased(true);
	}, [path]);
	const keeping = kept !== null;
	useEffect(() => {
		if (!keeping) return;
		const release = () => setReleased(true);
		const onKey = (event: KeyboardEvent) => {
			if (SCROLL_KEYS.has(event.key) && !editing(event.target)) release();
		};
		window.addEventListener("wheel", release, { passive: true });
		window.addEventListener("touchmove", release, { passive: true });
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("wheel", release);
			window.removeEventListener("touchmove", release);
			window.removeEventListener("keydown", onKey);
		};
	}, [keeping]);
	return { ref, kept };
}
