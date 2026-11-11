import { describe, expect, it } from "vitest";
import {
	contains,
	covers,
	fromIndexes,
	MAX_RANGES,
	normalize,
	parseRanges,
	size,
	subtract,
	union,
	within,
} from "./lineRanges";

describe("line ranges", () => {
	it("normalizes: sorted, merged when overlapping or touching, empty ones dropped", () => {
		expect(
			normalize([
				[5, 7],
				[0, 2],
				[2, 3],
				[6, 9],
				[4, 4],
			]),
		).toEqual([
			[0, 3],
			[5, 9],
		]);
	});

	it("parses only lists of [start, end) pairs of non-negative integers", () => {
		expect(
			parseRanges([
				[3, 4],
				[0, 1],
			]),
		).toEqual([
			[0, 1],
			[3, 4],
		]);
		expect(parseRanges([])).toEqual([]);
		for (const bad of [
			null,
			"0-1",
			[[0]],
			[[0, 1, 2]],
			[[1, 1]],
			[[2, 1]],
			[[-1, 1]],
			[[0, 1.5]],
			[["0", 1]],
			[[0, Number.MAX_SAFE_INTEGER + 2]],
			[{ 0: 0, 1: 1 }],
		]) {
			expect(parseRanges(bad)).toBeNull();
		}
		const many = Array.from({ length: MAX_RANGES + 1 }, (_, i) => [
			2 * i,
			2 * i + 1,
		]);
		expect(parseRanges(many)).toBeNull();
		expect(parseRanges(many.slice(1))).toHaveLength(MAX_RANGES);
	});

	it("unions, subtracts, sizes and tests containment", () => {
		expect(union([[0, 2]], [[4, 6]])).toEqual([
			[0, 2],
			[4, 6],
		]);
		expect(subtract([[0, 10]], [[2, 4]])).toEqual([
			[0, 2],
			[4, 10],
		]);
		expect(
			subtract(
				[[0, 10]],
				[
					[0, 3],
					[8, 12],
				],
			),
		).toEqual([[3, 8]]);
		expect(subtract([[0, 3]], [[0, 3]])).toEqual([]);
		expect(
			size([
				[0, 2],
				[5, 6],
			] as [number, number][]),
		).toBe(3);
		expect(contains([[0, 10]], [[2, 4]])).toBe(true);
		expect(
			contains(
				[
					[0, 3],
					[4, 10],
				],
				[[2, 5]],
			),
		).toBe(false);
		expect(covers([[0, 5]], 5)).toBe(true);
		expect(covers([[0, 4]], 5)).toBe(false);
		expect(covers([], 0)).toBe(false);
		expect(within([[0, 5]], 5)).toBe(true);
		expect(within([[0, 6]], 5)).toBe(false);
		expect(fromIndexes([4, 0, 1, 2])).toEqual([
			[0, 3],
			[4, 5],
		]);
	});
});
