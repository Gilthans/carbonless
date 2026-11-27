/**
 * The element scroll boxes around `el` that are scrolled, with their
 * scrollTop (not the page's: body and html are left out).
 */
export function scrolledAncestors(el: Element): [Element, number][] {
	const kept: [Element, number][] = [];
	for (
		let a = el.parentElement;
		a && a !== document.body && a !== document.documentElement;
		a = a.parentElement
	) {
		if (a.scrollTop <= 0) continue;
		const y = getComputedStyle(a).overflowY;
		if (y === "auto" || y === "scroll") kept.push([a, a.scrollTop]);
	}
	return kept;
}

/**
 * Runs `resize` (which changes `el`'s height, maybe collapsing it to
 * measure first) without moving the scroll boxes around `el`: each keeps
 * the scrollTop it had (a collapse clamps it), and one whose top edge
 * `el`'s top was above (scrolled out) moves by what `el` grew, so `el`
 * grows upward there and what is below it stays put (CAR-246, CAR-316).
 * Where `el`'s top was is read before `resize`: a collapse near a box's end
 * clamps its scrollTop and moves `el` until it is put back.
 */
export function resizeKeepingScroll(el: HTMLElement, resize: () => void): void {
	const kept = scrolledAncestors(el).map(([a, top]) => ({
		a,
		top,
		above: el.getBoundingClientRect().top < a.getBoundingClientRect().top,
	}));
	const was = el.offsetHeight;
	resize();
	const grew = el.offsetHeight - was;
	for (const { a, top, above } of kept) {
		const want = above ? top + grew : top;
		if (a.scrollTop !== want) a.scrollTop = want;
	}
}
