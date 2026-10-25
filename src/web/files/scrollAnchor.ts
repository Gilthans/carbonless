/**
 * Keeps what the reviewer is reading where it is on screen across a change
 * that re-renders the Files page (switching the unit): the first diff row or
 * file at or below the sticky stack is the anchor; afterwards the page
 * scrolls by however far it moved.
 */

/** What to find again after the change, and where it was in the viewport. */
export type ScrollAnchor = {
	el: Element;
	/** Finds the same row again should `el` have been replaced. */
	selector: string;
	top: number;
};

/**
 * Index of the first box whose bottom is below `line`, or -1. The boxes are
 * in document order, which on this page is top to bottom, so bottoms only
 * grow: a binary search finds it without measuring every row.
 */
export function firstBelow(
	count: number,
	bottomOf: (index: number) => number,
	line: number,
): number {
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (bottomOf(mid) > line) hi = mid;
		else lo = mid + 1;
	}
	return lo < count ? lo : -1;
}

/** File sections and the open file's rows, top to bottom. */
const CANDIDATES =
	"[data-file-index], [data-file-index] [data-testid=diff-line]";

/**
 * Where `el` lies in the flow, in viewport px. A file counts as its header,
 * measured from the section's top: an open file's header may be stuck
 * elsewhere, and the section itself spans all its rows (that would break
 * the top-to-bottom order).
 */
function boxOf(el: Element): { top: number; bottom: number } {
	const rect = el.getBoundingClientRect();
	if (!el.matches("[data-file-index]")) return rect;
	const top = rect.top + el.clientTop;
	const header = el.firstElementChild as HTMLElement | null;
	return { top, bottom: top + (header?.offsetHeight ?? 0) };
}

/** A selector for `el` that survives a remount: its file and line numbers. */
function selectorOf(el: Element): string {
	const file = el.closest("[data-file-index]")?.getAttribute("data-file-index");
	const fileSel = `[data-file-index="${file}"]`;
	if (el.matches("[data-file-index]")) return fileSel;
	const old = el.getAttribute("data-old-no");
	const nu = el.getAttribute("data-new-no");
	return `${fileSel} [data-testid=diff-line]${old ? `[data-old-no="${old}"]` : ":not([data-old-no])"}${nu ? `[data-new-no="${nu}"]` : ":not([data-new-no])"}`;
}

/**
 * The first file or diff row in `root` reaching below `line` (the bottom of
 * the sticky stack, in viewport px), with its viewport top.
 */
export function captureAnchor(
	root: ParentNode,
	line: number,
): ScrollAnchor | null {
	const all = Array.from(root.querySelectorAll(CANDIDATES));
	const i = firstBelow(
		all.length,
		(k) => boxOf(all[k] as Element).bottom,
		line,
	);
	const el = all[i];
	if (!el) return null;
	return { el, selector: selectorOf(el), top: boxOf(el).top };
}

/** Scrolls so the anchor is back at its viewport top; no-op if it's gone. */
export function restoreAnchor(anchor: ScrollAnchor, root: ParentNode): void {
	const el = anchor.el.isConnected
		? anchor.el
		: root.querySelector(anchor.selector);
	if (!el) return;
	const delta = boxOf(el).top - anchor.top;
	if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
}
