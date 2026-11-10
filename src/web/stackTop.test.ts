// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStackTop, visualPan } from "./stackTop";
import { visualTop } from "./sticky";

/** A stand-in visualViewport: `pan` moves it without telling anyone. */
function fakeViewport() {
	const target = new EventTarget();
	const state = { offsetTop: 0, scale: 1 };
	Object.defineProperties(target, {
		offsetTop: { get: () => state.offsetTop },
		scale: { get: () => state.scale },
	});
	vi.stubGlobal("visualViewport", target);
	return {
		state,
		/** Fires `n` scroll events, as one frame's scrolling does. */
		scroll(n: number) {
			for (let i = 0; i < n; i++) target.dispatchEvent(new Event("scroll"));
		},
	};
}

describe("useStackTop", () => {
	let frames: FrameRequestCallback[];
	let writes: string[];
	beforeEach(() => {
		frames = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			frames.push(cb);
			return frames.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		writes = [];
		const style = document.documentElement.style;
		const set = style.setProperty.bind(style);
		vi.spyOn(style, "setProperty").mockImplementation((name, value) => {
			if (name === "--vv-top") writes.push(String(value));
			set(name, value);
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		visualTop.set(0);
	});
	/** Runs the frames asked for so far. */
	const frame = () => {
		for (const cb of frames.splice(0)) cb(0);
	};

	it("writes the root once a frame however many viewport events came, and not at all when the pan is unchanged", () => {
		const vv = fakeViewport();
		renderHook(() => useStackTop(60, true));
		expect(writes).toEqual(["0px"]);
		vv.state.offsetTop = 120;
		vv.scroll(5);
		expect(frames).toHaveLength(1);
		expect(writes).toEqual(["0px"]);
		frame();
		expect(writes).toEqual(["0px", "120px"]);
		expect(
			document.documentElement.style.getPropertyValue("--app-header"),
		).toBe("180px");
		expect(visualTop.get()).toBe(120);
		// Events with the pan as it was: a frame, no write.
		vv.scroll(3);
		frame();
		expect(writes).toEqual(["0px", "120px"]);
	});

	it("doesn't follow a pinch zoom", () => {
		expect(visualPan({ offsetTop: 200, scale: 2 } as VisualViewport)).toBe(0);
		expect(visualPan({ offsetTop: 200.4, scale: 1 } as VisualViewport)).toBe(
			200,
		);
	});
});
