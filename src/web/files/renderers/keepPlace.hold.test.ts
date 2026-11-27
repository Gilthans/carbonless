// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Frames, keepPlace } from "./keepPlace";

/*
 * keepPlace's hold, on a section whose boxes are laid out by hand (jsdom
 * has no layout): tops in page px, the viewport's top at `scroll`.
 */

let scroll = 0;
const layout = new WeakMap<Element, { top: number; height: number }>();
function at(el: Element, top: number, height: number) {
	layout.set(el, { top, height });
	el.getBoundingClientRect = () => {
		const b = layout.get(el) ?? { top: 0, height: 0 };
		const y = b.top - scroll;
		return {
			top: y,
			bottom: y + b.height,
			height: b.height,
			y,
			left: 0,
			right: 100,
			width: 100,
			x: 0,
			toJSON: () => ({}),
		};
	};
}
/** Moves every laid-out box under `root` down by `dy`. */
function shift(root: Element, dy: number) {
	for (const el of root.querySelectorAll("*")) {
		const b = layout.get(el);
		if (b) layout.set(el, { ...b, top: b.top + dy });
	}
}

/** Frames run only when the test says so: nothing waits on a clock. */
let queue: Map<number, () => void>;
const frames: Frames = {
	request: (run) => {
		const id = queue.size + Math.random();
		queue.set(id, run);
		return id;
	},
	cancel: (id) => {
		queue.delete(id);
	},
};
/** Delivers the mutation records (a microtask), then runs one frame. */
async function frame() {
	await Promise.resolve();
	await Promise.resolve();
	const runs = [...queue.values()];
	queue.clear();
	for (const run of runs) run();
}

let section: HTMLElement;
/** Rendered: one-line blocks 1..20, 50px each from the page's top. */
function rendered() {
	section.innerHTML = "";
	section.setAttribute("data-renderer", "markdown");
	const bar = document.createElement("div");
	bar.setAttribute("data-view-bar", "");
	section.append(bar);
	for (let n = 1; n <= 20; n++) {
		const row = document.createElement("div");
		row.setAttribute("data-new-lines", `${n}-${n}`);
		section.append(row);
		at(row, (n - 1) * 50, 50);
	}
}
/** Text: rows 1..20, 20px each from `top`; a busy region while `busy`. */
function text(top: number, busy: boolean) {
	for (const el of [...section.children])
		if (!el.hasAttribute("data-view-bar")) el.remove();
	section.setAttribute("data-renderer", "text");
	if (busy) {
		const pending = document.createElement("div");
		pending.setAttribute("aria-busy", "true");
		section.append(pending);
	}
	for (let n = 1; n <= 20; n++) {
		const row = document.createElement("div");
		row.setAttribute("data-testid", "diff-line");
		row.setAttribute("data-new-no", String(n));
		section.append(row);
		at(row, top + (n - 1) * 20, 20);
	}
}
const lineTop = (n: number) =>
	section.querySelector(`[data-new-no="${n}"]`)?.getBoundingClientRect().top;

beforeEach(() => {
	queue = new Map();
	scroll = 0;
	Object.defineProperty(window, "scrollY", {
		configurable: true,
		get: () => scroll,
	});
	window.scrollBy = ((o: ScrollToOptions) => {
		scroll += o.top ?? 0;
	}) as typeof window.scrollBy;
	section = document.createElement("section");
	section.setAttribute("data-file-index", "0");
	document.body.append(section);
	rendered();
	// Line 11's block straddles the viewport's top: 25px of it above.
	scroll = 525;
});
afterEach(() => {
	section.remove();
	vi.useRealTimers();
});

/** Picks Text: the place is taken, the hold starts, the view changes. */
async function pickText(busy = true) {
	const hold = keepPlace(section, frames);
	expect(hold).not.toBeNull();
	hold?.("text");
	text(400, busy);
	await frame();
}

describe("keepPlace's hold", () => {
	it("puts the line back, keeps it there while the section is busy, and lets go one frame after it isn't", async () => {
		await pickText();
		// Line 11 back at -25 (its block's line 11 was there).
		expect(lineTop(11)).toBe(-25);
		// Idle frames while busy don't end it.
		await frame();
		await frame();
		// A late row lands above while busy: held.
		shift(section, 40);
		section.append(document.createElement("span"));
		await frame();
		expect(lineTop(11)).toBe(-25);
		// No longer busy: one more frame, then the hold ends.
		section.querySelector('[aria-busy="true"]')?.remove();
		await frame();
		await frame();
		expect(queue.size).toBe(0);
		expect(document.documentElement.style.overflowAnchor).toBe("");
		shift(section, 40);
		section.append(document.createElement("span"));
		await frame();
		expect(lineTop(11)).toBe(15);
	});

	it("holds while busy however long it takes: no timer ends it", async () => {
		vi.useFakeTimers();
		await pickText();
		vi.advanceTimersByTime(60_000);
		shift(section, 30);
		section.append(document.createElement("span"));
		await frame();
		expect(lineTop(11)).toBe(-25);
	});

	it("waits through a busy view with no lines yet, a scroll it didn't make before its first write included", async () => {
		const hold = keepPlace(section, frames);
		hold?.("text");
		for (const el of [...section.querySelectorAll("[data-new-lines]")])
			el.remove();
		const pending = document.createElement("div");
		pending.setAttribute("aria-busy", "true");
		section.append(pending);
		await frame();
		// The shorter page clamps the scroll: not the reader's.
		scroll = 100;
		window.dispatchEvent(new Event("scroll"));
		text(400, true);
		await frame();
		expect(lineTop(11)).toBe(-25);
	});

	it("yields to the reader's pointer", async () => {
		await pickText();
		window.dispatchEvent(new Event("pointerdown"));
		shift(section, 40);
		section.append(document.createElement("span"));
		await frame();
		expect(lineTop(11)).toBe(15);
	});

	it("yields to a scroll it didn't make (a scrollbar drag, a link)", async () => {
		await pickText();
		scroll += 300;
		window.dispatchEvent(new Event("scroll"));
		shift(section, 40);
		section.append(document.createElement("span"));
		await frame();
		expect(lineTop(11)).toBe(-285);
	});

	it("isn't taken at the file's start", () => {
		scroll = 0;
		expect(keepPlace(section, frames)).toBeNull();
	});
});
