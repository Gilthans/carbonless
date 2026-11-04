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

describe("tree width", () => {
	afterEach(() => {
		localStorage.clear();
		treeWidth.reset();
	});

	it("defaults to 18rem; either side may be squeezed to a 24px sliver", () => {
		expect(TREE_WIDTH.default).toBe(288);
		expect(TREE_WIDTH.min).toBe(24);
		expect(TREE_WIDTH.sliver).toBe(24);
		expect(TREE_WIDTH.step).toBe(16);
		expect(treeWidth.key).toBe("crb.files.treeWidth");
		expect(treeWidth.read()).toBe(288);
		// The row less the handle: all of it but the diffs' sliver.
		expect(treeWidthMax(1264)).toBe(1240);
		expect(treeWidthMax(1264.8)).toBe(1240);
		// Never below the floor, however narrow the row.
		expect(treeWidthMax(30)).toBe(24);
		expect(treeWidthMax(0)).toBe(24);
	});

	it("clamps a width to the range in hand", () => {
		expect(clampTreeWidth(10, 1240)).toBe(24);
		expect(clampTreeWidth(2000, 1240)).toBe(1240);
		expect(clampTreeWidth(300, 1240)).toBe(300);
		expect(clampTreeWidth(300.6, 1240)).toBe(301);
	});

	it("stores whole pixels, never under the floor", () => {
		treeWidth.set(300.4);
		expect(localStorage.getItem("crb.files.treeWidth")).toBe("300");
		treeWidth.set(5);
		expect(localStorage.getItem("crb.files.treeWidth")).toBe("24");
		localStorage.setItem("crb.files.treeWidth", "wide");
		expect(treeWidth.read()).toBe(288);
	});

	it("steps by key: arrows 16px (Shift 64), Home/End to the ends, Enter to the default", () => {
		const at = { width: 300, min: 24, max: 1240 };
		expect(treeWidthKey("ArrowLeft", false, at)).toBe(284);
		expect(treeWidthKey("ArrowRight", false, at)).toBe(316);
		expect(treeWidthKey("ArrowLeft", true, at)).toBe(236);
		expect(treeWidthKey("ArrowRight", true, at)).toBe(364);
		expect(treeWidthKey("Home", false, at)).toBe(24);
		expect(treeWidthKey("End", false, at)).toBe(1240);
		expect(treeWidthKey("Enter", false, at)).toBe(288);
		expect(treeWidthKey("Tab", false, at)).toBeNull();
		expect(treeWidthKey("a", true, at)).toBeNull();
		// Clamped at the ends.
		expect(treeWidthKey("ArrowLeft", true, { ...at, width: 40 })).toBe(24);
		expect(treeWidthKey("ArrowRight", false, { ...at, width: 1230 })).toBe(
			1240,
		);
		// Enter in a row too narrow for the default goes to its end.
		expect(treeWidthKey("Enter", false, { ...at, max: 200 })).toBe(200);
	});

	it("shows the stored width clamped to the room, re-clamped as the room changes", () => {
		localStorage.setItem("crb.files.treeWidth", "1000");
		const { result, rerender } = renderHook(
			({ room }: { room: number }) => useTreeWidth(room),
			{ initialProps: { room: 1264 } },
		);
		expect(result.current.width).toBe(1000);
		expect(result.current.min).toBe(24);
		expect(result.current.max).toBe(1240);
		// A narrower row: the diffs keep their sliver.
		rerender({ room: 600 });
		expect(result.current.width).toBe(576);
		expect(result.current.max).toBe(576);
		// Back wide: the stored width is still what the viewer chose.
		rerender({ room: 1264 });
		expect(result.current.width).toBe(1000);
		expect(localStorage.getItem("crb.files.treeWidth")).toBe("1000");
		// Setting clamps to the room in hand.
		act(() => result.current.set(5000));
		expect(result.current.width).toBe(1240);
		expect(localStorage.getItem("crb.files.treeWidth")).toBe("1240");
		act(() => result.current.set(1));
		expect(result.current.width).toBe(24);
	});
});
