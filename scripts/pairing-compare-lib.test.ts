import { describe, expect, it } from "vitest";
import {
	byWorst,
	type ClusterLayouts,
	changedByStep2,
	farthestMove,
} from "./pairing-compare-lib";

const layouts = (over: Partial<ClusterLayouts> = {}): ClusterLayouts => ({
	today: [
		[0, 2],
		[1, 3],
		[null, 4],
	],
	step2: [
		[0, null],
		[1, 2],
		[null, 3],
		[null, 4],
	],
	todayUnified: [0, 1, 2, 3, 4],
	step2Unified: [0, 1, 2, 3, 4],
	pairs: [[1, 2]],
	todayPairs: [],
	...over,
});

describe("changedByStep2", () => {
	it("is false when rows, unified order and pairs all match today's", () => {
		const l = layouts();
		expect(
			changedByStep2({ ...l, step2: l.today, pairs: [], todayPairs: [] }),
		).toBe(false);
	});
	it("is true when a pair moves rows", () => {
		expect(changedByStep2(layouts())).toBe(true);
	});
	it("is true when only the unified order differs", () => {
		const l = layouts();
		expect(
			changedByStep2({
				...l,
				step2: l.today,
				pairs: [],
				step2Unified: [0, 2, 1, 3, 4],
			}),
		).toBe(true);
	});
	it("is true when only the pairs differ (a mark appears)", () => {
		const l = layouts();
		expect(changedByStep2({ ...l, step2: l.today, pairs: [[0, 2]] })).toBe(
			true,
		);
	});
});

describe("farthestMove", () => {
	it("is the rows between a pair's lines today", () => {
		// line 1 sat on row 1, line 2 on row 0: one row apart
		expect(farthestMove(layouts())).toBe(1);
		expect(farthestMove(layouts({ pairs: [[0, 4]] }))).toBe(2);
	});
	it("is 0 without pairs", () => {
		expect(farthestMove(layouts({ pairs: [] }))).toBe(0);
	});
});

describe("byWorst", () => {
	const c = (minScore: number, move: number, size: number) => ({
		minScore,
		move,
		size,
	});
	it("sorts lowest score, then farthest move, then biggest cluster", () => {
		const sorted = [
			c(0.9, 5, 9),
			c(0.5, 1, 2),
			c(0.5, 3, 2),
			c(0.5, 3, 8),
			c(Infinity, 0, 99),
		].sort(byWorst);
		expect(sorted).toEqual([
			c(0.5, 3, 8),
			c(0.5, 3, 2),
			c(0.5, 1, 2),
			c(0.9, 5, 9),
			c(Infinity, 0, 99),
		]);
	});
});
