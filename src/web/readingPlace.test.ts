// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepReadingPlace, readingPlace } from "./readingPlace";

/** An element in the page whose box is at `top` (or no box at all). */
function placed(top: number | null, inside?: string): HTMLElement {
	const el = document.createElement("span");
	const parent = document.createElement("div");
	if (inside) parent.setAttribute(inside, "");
	parent.append(el);
	document.body.append(parent);
	el.getBoundingClientRect = () =>
		(top === null
			? { top: 0, width: 0, height: 0 }
			: { top, width: 100, height: 20 }) as DOMRect;
	return el;
}

describe("readingPlace", () => {
	let at: Element | null;
	beforeEach(() => {
		at = null;
		document.elementFromPoint = () => at;
		vi.spyOn(window, "scrollY", "get").mockReturnValue(500);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.replaceChildren();
	});

	it("notes the element mid-window and its top", () => {
		at = placed(300);
		expect(readingPlace()).toEqual({ el: at, top: 300 });
	});

	it("notes nothing at the top of the page: the swap shows there", () => {
		vi.spyOn(window, "scrollY", "get").mockReturnValue(0);
		at = placed(300);
		expect(readingPlace()).toBeNull();
	});

	it("notes nothing in the app header or the find bar: they are what changes", () => {
		at = placed(300, "data-app-header");
		expect(readingPlace()).toBeNull();
		at = placed(300, "data-find-float");
		expect(readingPlace()).toBeNull();
	});

	it("notes nothing where nothing is mid-window", () => {
		expect(readingPlace()).toBeNull();
	});
});

describe("keepReadingPlace", () => {
	let scrollBy: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		scrollBy = vi.fn();
		window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
	});
	afterEach(() => document.body.replaceChildren());

	it("scrolls by however far the element moved", () => {
		const el = placed(256);
		keepReadingPlace({ el, top: 300 });
		expect(scrollBy).toHaveBeenCalledWith(0, -44);
	});

	it("leaves the page alone when it didn't move", () => {
		const el = placed(300.2);
		keepReadingPlace({ el, top: 300 });
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("leaves the page alone for an element gone from it", () => {
		const el = placed(100);
		el.remove();
		keepReadingPlace({ el, top: 300 });
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("leaves the page alone for an element out of the layout (no box)", () => {
		const el = placed(null);
		keepReadingPlace({ el, top: 300 });
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("does nothing without a place", () => {
		keepReadingPlace(null);
		expect(scrollBy).not.toHaveBeenCalled();
	});
});
