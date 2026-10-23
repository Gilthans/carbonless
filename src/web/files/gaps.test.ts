import { describe, expect, it } from "vitest";
import type { DisplayHunk } from "../../shared/types";
import { EXPAND_STEP, fileGaps, gapState } from "./gaps";

const hunk = (newStart: number, newCount: number): DisplayHunk => ({
	oldStart: newStart,
	oldCount: newCount,
	newStart,
	newCount,
	lines: [],
});

describe("fileGaps", () => {
	it("finds the unchanged ranges above, between and below hunks", () => {
		expect(fileGaps([hunk(2, 7), hunk(13, 7)], 79)).toEqual([
			{ index: 0, from: 1, to: 1, above: false, below: true },
			{ index: 1, from: 9, to: 12, above: true, below: true },
			{ index: 2, from: 20, to: 79, above: true, below: false },
		]);
	});

	it("has no gaps at the file's edges when the hunks reach them", () => {
		expect(fileGaps([hunk(1, 5)], 5)).toEqual([]);
	});

	it("has no gaps without hunks or in an emptied file", () => {
		expect(fileGaps([], 40)).toEqual([]);
		expect(fileGaps([{ ...hunk(0, 0), oldCount: 3 }], 0)).toEqual([]);
	});
});

describe("gapState", () => {
	const gap = { index: 1, from: 21, to: 80, above: true, below: true };

	it("counts loaded lines from each edge", () => {
		const loaded = new Set([21, 22, 23, 78, 79, 80, 50]);
		expect(gapState(gap, loaded)).toEqual({
			top: 3,
			bottom: 3,
			remaining: 54,
		});
	});

	it("never counts a line twice when the edges meet", () => {
		const loaded = new Set(Array.from({ length: 60 }, (_, i) => 21 + i));
		expect(gapState(gap, loaded)).toEqual({ top: 60, bottom: 0, remaining: 0 });
	});

	it("steps by 20", () => {
		expect(EXPAND_STEP).toBe(20);
	});
});
