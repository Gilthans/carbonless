// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { resizeKeepingScroll } from "./keepScroll";

afterEach(() => document.body.replaceChildren());

/**
 * A scroll box (top edge at 0) holding a textarea whose top sits at
 * `top - scrollTop`; heights and scrollTop are the test's.
 */
function layout(textTop: number, scrollTop: number, height: number) {
	const box = document.createElement("div");
	box.style.overflowY = "auto";
	const text = document.createElement("textarea");
	box.append(text);
	document.body.append(box);
	const s = { top: scrollTop, height };
	Object.defineProperty(box, "scrollTop", {
		get: () => s.top,
		set: (v: number) => {
			s.top = v;
		},
	});
	Object.defineProperty(text, "offsetHeight", { get: () => s.height });
	box.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
	text.getBoundingClientRect = () => ({ top: textTop - s.top }) as DOMRect;
	return { box, s };
}

describe("resizeKeepingScroll", () => {
	it("its top in sight: the box keeps its scrollTop across a collapse", () => {
		const { box, s } = layout(250, 200, 60);
		resizeKeepingScroll(box.firstElementChild as HTMLElement, () => {
			s.top = 150; // the collapse clamped it
			s.height = 80;
		});
		expect(box.scrollTop).toBe(200);
	});

	it("its top scrolled out: the box moves by what it grew, though the collapse brought its top into sight", () => {
		// Top at 180 - 200 = -20: scrolled out.
		const { box, s } = layout(180, 200, 60);
		resizeKeepingScroll(box.firstElementChild as HTMLElement, () => {
			// The collapse near the box's end clamps scrollTop: its top reads
			// 180 - 150 = 30, in sight, until the scrollTop is put back.
			s.top = 150;
			s.height = 80;
		});
		expect(box.scrollTop).toBe(220);
	});
});
