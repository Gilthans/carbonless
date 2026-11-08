import type { Hit } from "./findInPr";

/** The find bar's element on the page (FindBar's root). */
export const findBarElement = () =>
	document.querySelector<HTMLElement>('[data-testid="find-bar"]');

/**
 * The characters painting `hit` as the current one, where the page shows
 * them: a path's in its file's header path, a line's in the code of its row
 * (by its side's number; side by side, in its side's cell). Null when they
 * aren't rendered (a closed file, a collapsed cluster), or when what is
 * painted current is another hit (a search still trailing the typed term).
 */
function paintedHit(hit: Hit): Element | null {
	const section = document.getElementById(`file-${hit.index}`);
	if (!section) return null;
	if (hit.side === "path" || hit.side === "oldPath")
		return section.querySelector(
			':scope > header [data-testid="file-path"] [data-find-current]',
		);
	const number = hit.side === "LEFT" ? "data-old-no" : "data-new-no";
	for (const el of section.querySelectorAll(
		"[data-code] [data-find-current]",
	)) {
		if (el.closest("tr")?.getAttribute(number) !== String(hit.line)) continue;
		const cell = el.closest<HTMLElement>("td[data-side]");
		if (cell && cell.dataset.side !== hit.side) continue;
		return el;
	}
	return null;
}

const overlaps = (a: DOMRect, b: DOMRect) =>
	a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Whether the reviewer sees `hit` now: its painted characters are on screen,
 * below `stackTop` (the sticky stack over them: for a line, its file's
 * header too) and clear of the find bar floating over the page.
 */
export function hitSeen(hit: Hit, stackTop: number): boolean {
	const el = paintedHit(hit);
	if (!el) return false;
	const r = el.getBoundingClientRect();
	if (r.width === 0 && r.height === 0) return false;
	const section = el.closest("section");
	const header =
		hit.side === "path" || hit.side === "oldPath"
			? 0
			: ((section?.querySelector(":scope > header") as HTMLElement | null)
					?.offsetHeight ?? 0);
	if (r.top < stackTop + header - 1 || r.bottom > window.innerHeight + 1)
		return false;
	const bar = findBarElement()?.getBoundingClientRect();
	return !bar || !overlaps(r, bar);
}
