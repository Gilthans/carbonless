/** The line being read: an element and its top on screen. */
export interface ReadingPlace {
	el: Element;
	top: number;
}

/**
 * The element mid-window and its top, to keep in place across a layout
 * change above it. None at the top of the page (the change shows there), in
 * the app header or the find bar (they are what changes), or where the
 * browser can't tell.
 */
export function readingPlace(): ReadingPlace | null {
	if (window.scrollY <= 0 || typeof document.elementFromPoint !== "function")
		return null;
	const el = document.elementFromPoint(
		window.innerWidth / 2,
		window.innerHeight / 2,
	);
	if (!el || el.closest("[data-app-header], [data-find-float]")) return null;
	return { el, top: el.getBoundingClientRect().top };
}

/**
 * Scrolls the page by however far `place` moved on screen. Nothing for an
 * element gone from the page or out of its layout (no box).
 */
export function keepReadingPlace(place: ReadingPlace | null): void {
	if (!place?.el.isConnected) return;
	const box = place.el.getBoundingClientRect();
	if (box.width === 0 && box.height === 0) return;
	const by = box.top - place.top;
	if (Math.abs(by) >= 0.5) window.scrollBy(0, by);
}
