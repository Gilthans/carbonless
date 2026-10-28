// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	captureAnchor,
	firstBelow,
	restoreAnchor,
	selectorsOf,
} from "./scrollAnchor";

describe("firstBelow", () => {
	const bottoms = [10, 20, 30, 40];
	const at = (i: number) => bottoms[i] ?? Number.NaN;
	it("finds the first box reaching below the line", () => {
		expect(firstBelow(4, at, 0)).toBe(0);
		expect(firstBelow(4, at, 10)).toBe(1);
		expect(firstBelow(4, at, 25)).toBe(2);
		expect(firstBelow(4, at, 39.5)).toBe(3);
	});
	it("is -1 when everything is above the line, or there is nothing", () => {
		expect(firstBelow(4, at, 40)).toBe(-1);
		expect(firstBelow(0, at, 0)).toBe(-1);
	});
});

/** Places `el` at viewport `top` (and `height` tall). */
function place(el: Element, top: number, height = 20) {
	el.getBoundingClientRect = () =>
		({ top, bottom: top + height, height }) as DOMRect;
}

/**
 * Two files: 0 closed, 1 open with rows old/new 1..3 (row 2 is an added
 * line, no old number). Headers 40px tall.
 */
function page(tops: { files: [number, number]; rows: number[] }) {
	const root = document.createElement("div");
	root.innerHTML = `
		<section data-file-index="0"><header></header></section>
		<section data-file-index="1"><header></header><table><tbody>
			<tr data-testid="diff-line" data-old-no="1" data-new-no="1"></tr>
			<tr data-testid="diff-line" data-new-no="2"></tr>
			<tr data-testid="diff-line" data-old-no="2" data-new-no="3"></tr>
		</tbody></table></section>`;
	document.body.append(root);
	for (const header of root.querySelectorAll("header")) {
		Object.defineProperty(header, "offsetHeight", { value: 40 });
	}
	const sections = root.querySelectorAll("section");
	sections.forEach((s, i) => {
		place(s, tops.files[i] ?? 0, 1000);
	});
	root.querySelectorAll("tr").forEach((r, i) => {
		place(r, tops.rows[i] ?? 0);
	});
	return root;
}

describe("captureAnchor / restoreAnchor", () => {
	afterEach(() => {
		document.body.innerHTML = "";
		vi.restoreAllMocks();
	});

	it("anchors to the first row below the sticky stack, past a stuck header", () => {
		// File 1 scrolled far up: its header is stuck, its section top is off screen.
		const root = page({ files: [-900, -400], rows: [90, 110, 130] });
		const anchor = captureAnchor(root, 100);
		expect(anchor?.el.getAttribute("data-new-no")).toBe("1");
		expect(anchor?.top).toBe(90);
	});

	it("anchors to a file header when no row reaches below the line", () => {
		const root = page({ files: [80, 200], rows: [240, 260, 280] });
		const anchor = captureAnchor(root, 100);
		expect(anchor?.el.getAttribute("data-file-index")).toBe("0");
		expect(anchor?.top).toBe(80);
	});

	it("is null when nothing reaches below the line", () => {
		const root = page({ files: [-900, -400], rows: [-300, -280, -260] });
		expect(captureAnchor(root, 100)).toBeNull();
	});

	it("scrolls by however far the anchor moved", () => {
		const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
		const root = page({ files: [-900, -400], rows: [90, 110, 130] });
		const anchor = captureAnchor(root, 100);
		if (!anchor) throw new Error("no anchor");
		place(anchor.el, 110);
		restoreAnchor(anchor, root);
		expect(scrollBy).toHaveBeenCalledWith(0, 20);
	});

	it("doesn't scroll when the anchor stayed put", () => {
		const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
		const root = page({ files: [-900, -400], rows: [90, 110, 130] });
		const anchor = captureAnchor(root, 100);
		if (!anchor) throw new Error("no anchor");
		restoreAnchor(anchor, root);
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("finds a remounted row again by its file and line numbers", () => {
		const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
		const root = page({ files: [-900, -400], rows: [70, 95, 130] });
		const anchor = captureAnchor(root, 100);
		// The added line (new 2, no old number).
		expect(anchor?.el.getAttribute("data-new-no")).toBe("2");
		if (!anchor) throw new Error("no anchor");
		const tbody = root.querySelector("tbody");
		if (!tbody) throw new Error("no rows");
		tbody.innerHTML = `
			<tr data-testid="diff-line" data-old-no="1" data-new-no="1"></tr>
			<tr data-testid="diff-line" data-new-no="2"></tr>
			<tr data-testid="diff-line" data-old-no="2" data-new-no="3"></tr>`;
		const rows = tbody.querySelectorAll("tr");
		rows.forEach((r, i) => {
			place(r, [60, 80, 100][i] ?? 0);
		});
		restoreAnchor(anchor, root);
		expect(scrollBy).toHaveBeenCalledWith(0, -15);
	});

	it("names the row by its exact numbers, then by either number alone", () => {
		const root = page({ files: [-900, -400], rows: [90, 110, 130] });
		const row = (sel: string) => {
			const el = root.querySelector(sel);
			if (!el) throw new Error(`no ${sel}`);
			return el;
		};
		const rows = root.querySelector("tbody");
		if (!rows) throw new Error("no rows");
		rows.insertAdjacentHTML(
			"beforeend",
			`<tr data-testid="diff-line" data-old-no="5"></tr>
			<tr data-testid="diff-line" data-old-no="5" data-new-no="7"></tr>`,
		);
		const file = '[data-file-index="1"] [data-testid=diff-line]';
		// A del row: exact, then by its old number.
		const del = row('[data-old-no="5"]:not([data-new-no])');
		place(del, 90);
		expect(captureAnchor(root, 100)?.el).toBe(row('[data-new-no="1"]'));
		place(del, 150);
		expect(selectorsOf(del)).toEqual([
			`${file}[data-old-no="5"]:not([data-new-no])`,
			`${file}[data-old-no="5"]`,
		]);
		// An add row: exact, then by its new number.
		expect(selectorsOf(row('[data-new-no="2"]'))).toEqual([
			`${file}:not([data-old-no])[data-new-no="2"]`,
			`${file}[data-new-no="2"]`,
		]);
		// A context row and a side-by-side pair row: exact, old, new.
		expect(selectorsOf(row('[data-old-no="2"]'))).toEqual([
			`${file}[data-old-no="2"][data-new-no="3"]`,
			`${file}[data-old-no="2"]`,
			`${file}[data-new-no="3"]`,
		]);
		expect(selectorsOf(row('[data-new-no="7"]'))).toEqual([
			`${file}[data-old-no="5"][data-new-no="7"]`,
			`${file}[data-old-no="5"]`,
			`${file}[data-new-no="7"]`,
		]);
		// A file: itself.
		expect(selectorsOf(row('[data-file-index="0"]'))).toEqual([
			'[data-file-index="0"]',
		]);
	});

	/** Replaces file 1's rows with `html`, placing them at `tops`. */
	function relayout(root: Element, html: string, tops: number[]) {
		const tbody = root.querySelector("tbody");
		if (!tbody) throw new Error("no rows");
		tbody.innerHTML = html;
		tbody.querySelectorAll("tr").forEach((r, i) => {
			place(r, tops[i] ?? 0);
		});
	}

	it("finds a unified del row again as the side-by-side pair row", () => {
		const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
		const root = page({ files: [-900, -400], rows: [50, 70, 130] });
		relayout(
			root,
			`<tr data-testid="diff-line" data-old-no="4" data-new-no="4"></tr>
			<tr data-testid="diff-line" data-old-no="5"></tr>
			<tr data-testid="diff-line" data-new-no="5"></tr>`,
			[70, 90, 110],
		);
		const anchor = captureAnchor(root, 100);
		expect(anchor?.el.getAttribute("data-old-no")).toBe("5");
		expect(anchor?.top).toBe(90);
		if (!anchor) throw new Error("no anchor");
		// Side by side: old 5 and new 5 share a row, which sits 30px higher.
		relayout(
			root,
			`<tr data-testid="diff-line" data-old-no="4" data-new-no="4"></tr>
			<tr data-testid="diff-line" data-old-no="5" data-new-no="5"></tr>`,
			[40, 60],
		);
		restoreAnchor(anchor, root);
		expect(scrollBy).toHaveBeenCalledWith(0, -30);
	});

	it("finds a side-by-side pair row again as the unified row of its old line", () => {
		const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
		const root = page({ files: [-900, -400], rows: [50, 70, 130] });
		relayout(
			root,
			`<tr data-testid="diff-line" data-old-no="4" data-new-no="4"></tr>
			<tr data-testid="diff-line" data-old-no="5" data-new-no="5"></tr>`,
			[70, 90],
		);
		const anchor = captureAnchor(root, 100);
		expect(anchor?.el.getAttribute("data-new-no")).toBe("5");
		if (!anchor) throw new Error("no anchor");
		// Unified: the del row of old 5 comes first, 25px lower.
		relayout(
			root,
			`<tr data-testid="diff-line" data-old-no="4" data-new-no="4"></tr>
			<tr data-testid="diff-line" data-old-no="5"></tr>
			<tr data-testid="diff-line" data-new-no="5"></tr>`,
			[95, 115, 135],
		);
		restoreAnchor(anchor, root);
		expect(scrollBy).toHaveBeenCalledWith(0, 25);
	});

	it("finds a unified add row again as the side-by-side pair row of its new line", () => {
		const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
		const root = page({ files: [-900, -400], rows: [50, 70, 130] });
		relayout(
			root,
			`<tr data-testid="diff-line" data-old-no="5"></tr>
			<tr data-testid="diff-line" data-old-no="6"></tr>
			<tr data-testid="diff-line" data-new-no="5"></tr>`,
			[50, 70, 90],
		);
		const anchor = captureAnchor(root, 100);
		expect(anchor?.el.getAttribute("data-new-no")).toBe("5");
		if (!anchor) throw new Error("no anchor");
		relayout(
			root,
			`<tr data-testid="diff-line" data-old-no="5" data-new-no="5"></tr>
			<tr data-testid="diff-line" data-old-no="6"></tr>`,
			[50, 70],
		);
		restoreAnchor(anchor, root);
		expect(scrollBy).toHaveBeenCalledWith(0, -40);
	});

	it("does nothing when the anchor is gone", () => {
		const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
		const root = page({ files: [-900, -400], rows: [90, 110, 130] });
		const anchor = captureAnchor(root, 100);
		if (!anchor) throw new Error("no anchor");
		root.querySelector("tbody")?.replaceChildren();
		restoreAnchor(anchor, root);
		expect(scrollBy).not.toHaveBeenCalled();
	});
});
