/**
 * The view switch's bar pinned over `el` (CAR-317): its file's
 * `[data-view-bar]` when `el` is inside what the bar pins over (its
 * parent: the whole file, or an image's view). Null otherwise.
 */
export function viewBarOver(el: Element): HTMLElement | null {
	const bar = el
		.closest("[data-file-index]")
		?.querySelector<HTMLElement>("[data-view-bar]");
	return bar?.parentElement?.contains(el) ? bar : null;
}
