// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	clampTreeWidth,
	TREE_WIDTH,
	treeWidth,
	treeWidthKey,
	treeWidthMax,
	useTreeWidth,
} from "./treeWidth";

const setViewport = (width: number) => {
	Object.defineProperty(window, "innerWidth", {
		configurable: true,
		writable: true,
		value: width,
	});
	window.dispatchEvent(new Event("resize"));
};

describe("tree width", () => {
	afterEach(() => {
		localStorage.clear();
		treeWidth.reset();
		setViewport(1024);
	});

	it("defaults to 18rem, at least 160px, at most half the viewport", () => {
		expect(TREE_WIDTH.default).toBe(288);
		expect(TREE_WIDTH.min).toBe(160);
		expect(TREE_WIDTH.step).toBe(16);
		expect(treeWidth.key).toBe("crb.files.treeWidth");
		expect(treeWidth.read()).toBe(288);
		expect(treeWidthMax(1280)).toBe(640);
		expect(treeWidthMax(1281)).toBe(640);
		// Never below the minimum, however narrow the window.
		expect(treeWidthMax(300)).toBe(160);
	});

	it("clamps a width to the viewport's range", () => {
		expect(clampTreeWidth(100, 1280)).toBe(160);
		expect(clampTreeWidth(2000, 1280)).toBe(640);
		expect(clampTreeWidth(300, 1280)).toBe(300);
		expect(clampTreeWidth(300.6, 1280)).toBe(301);
	});

	it("stores whole pixels, never under the minimum", () => {
		treeWidth.set(300.4);
		expect(localStorage.getItem("crb.files.treeWidth")).toBe("300");
		treeWidth.set(5);
		expect(localStorage.getItem("crb.files.treeWidth")).toBe("160");
		localStorage.setItem("crb.files.treeWidth", "wide");
		expect(treeWidth.read()).toBe(288);
	});

	it("steps by key: arrows 16px (Shift 64), Home/End to the ends, Enter to the default", () => {
		const at = { width: 300, min: 160, max: 640 };
		expect(treeWidthKey("ArrowLeft", false, at)).toBe(284);
		expect(treeWidthKey("ArrowRight", false, at)).toBe(316);
		expect(treeWidthKey("ArrowLeft", true, at)).toBe(236);
		expect(treeWidthKey("ArrowRight", true, at)).toBe(364);
		expect(treeWidthKey("Home", false, at)).toBe(160);
		expect(treeWidthKey("End", false, at)).toBe(640);
		expect(treeWidthKey("Enter", false, at)).toBe(288);
		expect(treeWidthKey("Tab", false, at)).toBeNull();
		expect(treeWidthKey("a", true, at)).toBeNull();
		// Clamped at the ends.
		expect(treeWidthKey("ArrowLeft", true, { ...at, width: 170 })).toBe(160);
		expect(treeWidthKey("ArrowRight", false, { ...at, width: 636 })).toBe(640);
	});

	it("shows the stored width clamped to the viewport, re-clamped on resize", () => {
		localStorage.setItem("crb.files.treeWidth", "600");
		setViewport(1280);
		const { result } = renderHook(() => useTreeWidth());
		expect(result.current.width).toBe(600);
		expect(result.current.min).toBe(160);
		expect(result.current.max).toBe(640);
		// A narrower window: the diffs keep at least half of it.
		act(() => setViewport(1000));
		expect(result.current.width).toBe(500);
		expect(result.current.max).toBe(500);
		// Back wide: the stored width is still what the viewer chose.
		act(() => setViewport(1280));
		expect(result.current.width).toBe(600);
		// Setting clamps to the viewport in hand.
		act(() => result.current.set(5000));
		expect(result.current.width).toBe(640);
		expect(localStorage.getItem("crb.files.treeWidth")).toBe("640");
		act(() => result.current.set(100));
		expect(result.current.width).toBe(160);
	});
});
