import { describe, expect, it } from "vitest";
import { nextPageEnd } from "./holdPageEnd";

const viewport = 800;
/** The header sticks past a 1000px scroll: every pull here moves it. */
const stick = 1000;

describe("nextPageEnd", () => {
	it("starts from what it sees, with no room under the page", () => {
		expect(
			nextPageEnd(null, { y: 30, bottom: 1000, top: 100, viewport, stick }),
		).toEqual({
			end: { y: 30, bottom: 1000, top: 100, spacer: 0 },
			scrollTo: null,
		});
	});

	it("a page shorter under a reader at its end: the scroll the browser pulled back is put back, the room kept under the page", () => {
		// At the end (200 = 1000 - 800); 24px go, the browser clamps to 176.
		const last = { y: 200, bottom: 1000, top: 100, spacer: 0 };
		expect(
			nextPageEnd(last, { y: 176, bottom: 976, top: 100, viewport, stick }),
		).toEqual({
			end: { y: 200, bottom: 976, top: 100, spacer: 24 },
			scrollTo: 200,
		});
		// Seen before the browser clamped: the same room, nothing to put back.
		expect(
			nextPageEnd(last, { y: 200, bottom: 976, top: 100, viewport, stick }),
		).toEqual({
			end: { y: 200, bottom: 976, top: 100, spacer: 24 },
			scrollTo: null,
		});
	});

	it("a short page pulled to the top keeps its scroll too", () => {
		const last = { y: 16, bottom: 816, top: 100, spacer: 0 };
		expect(
			nextPageEnd(last, { y: 0, bottom: 796, top: 100, viewport, stick }),
		).toEqual({
			end: { y: 16, bottom: 796, top: 100, spacer: 20 },
			scrollTo: 16,
		});
	});

	it("a page shorter well below the window: no room needed, the scroll left alone", () => {
		const last = { y: 100, bottom: 3000, top: 100, spacer: 0 };
		expect(
			nextPageEnd(last, { y: 100, bottom: 2976, top: 100, viewport, stick }),
		).toEqual({
			end: { y: 100, bottom: 2976, top: 100, spacer: 0 },
			scrollTo: null,
		});
	});

	it("the reader scrolling up as the page shrinks, away from its end, is their scroll", () => {
		const last = { y: 200, bottom: 1000, top: 100, spacer: 0 };
		expect(
			nextPageEnd(last, { y: 50, bottom: 976, top: 100, viewport, stick }),
		).toEqual({
			end: { y: 50, bottom: 976, top: 100, spacer: 0 },
			scrollTo: null,
		});
	});

	it("the page shorter because a bar above the content closed is no shrink to hold: the bar keeps the reading place itself", () => {
		const last = { y: 200, bottom: 1000, top: 140, spacer: 0 };
		expect(
			nextPageEnd(last, { y: 160, bottom: 960, top: 100, viewport, stick }),
		).toEqual({
			end: { y: 160, bottom: 960, top: 100, spacer: 0 },
			scrollTo: null,
		});
	});

	it("a pull past where the header sticks moves nothing of it: the browser's (and the page's own) scroll stands", () => {
		const last = { y: 2200, bottom: 3000, top: 100, spacer: 0 };
		expect(
			nextPageEnd(last, { y: 2176, bottom: 2976, top: 100, viewport, stick }),
		).toEqual({
			end: { y: 2176, bottom: 2976, top: 100, spacer: 0 },
			scrollTo: null,
		});
	});

	it("the room shrinks only by what's out of sight: as the reader scrolls up, or the page grows back", () => {
		const held = { y: 200, bottom: 976, top: 100, spacer: 24 };
		// 10px up: 10px of room is below the window now.
		expect(
			nextPageEnd(held, { y: 190, bottom: 976, top: 100, viewport, stick }).end,
		).toEqual({
			y: 190,
			bottom: 976,
			top: 100,
			spacer: 14,
		});
		// Far up: none left.
		expect(
			nextPageEnd(held, { y: 0, bottom: 976, top: 100, viewport, stick }).end
				.spacer,
		).toBe(0);
		// The page grows 30px back: the room goes, the page's end where it was or lower.
		expect(
			nextPageEnd(held, { y: 200, bottom: 1006, top: 100, viewport, stick })
				.end,
		).toEqual({
			y: 200,
			bottom: 1006,
			top: 100,
			spacer: 0,
		});
		// Never grows by a scroll.
		expect(
			nextPageEnd(held, { y: 200, bottom: 976, top: 100, viewport: 900, stick })
				.end.spacer,
		).toBe(24);
	});
});
