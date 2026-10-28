import { type RefObject, useEffect } from "react";

/**
 * While `active` (a write of this box was refused), scrolls the page so the
 * box sits above the bottom notices (`--sync-notices`, SyncNotices): the
 * text that came back and its button stay in view, not under the notice.
 */
export function useClearOfNotices(
	el: RefObject<HTMLElement | null>,
	active: boolean,
): void {
	useEffect(() => {
		if (!active) return;
		let frame = requestAnimationFrame(() => {
			// The notice measures itself in a layout effect: a frame later.
			frame = requestAnimationFrame(() => {
				const box = el.current;
				if (!box) return;
				const reach =
					Number.parseFloat(
						getComputedStyle(document.documentElement).getPropertyValue(
							"--sync-notices",
						),
					) || 0;
				const over =
					box.getBoundingClientRect().bottom - (window.innerHeight - reach);
				if (over > 0) window.scrollBy(0, over + 8);
			});
		});
		return () => cancelAnimationFrame(frame);
	}, [el, active]);
}
