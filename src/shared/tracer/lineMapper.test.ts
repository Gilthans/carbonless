import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createLineMapper, IDENTITY, type MapHunk } from "./lineMapper";

// A file with three hunks (git's -U0 convention): old lines 3-4 replaced by
// three lines (new 3-5), two lines added after old 8 (new 10-11), old lines
// 12-13 deleted (they sat after new 14).
const REPLACE: MapHunk = { oldStart: 3, oldCount: 2, newStart: 3, newCount: 3 };
const ADD: MapHunk = { oldStart: 8, oldCount: 0, newStart: 10, newCount: 2 };
const CUT: MapHunk = { oldStart: 12, oldCount: 2, newStart: 14, newCount: 0 };
const HUNKS: MapHunk[] = [REPLACE, ADD, CUT];

describe("createLineMapper", () => {
	const mapper = createLineMapper(HUNKS);

	it("oldToNew is identity before the first hunk and shifts by the net delta after each", () => {
		expect(mapper.oldToNew(1)).toBe(1);
		expect(mapper.oldToNew(2)).toBe(2);
		// After hunk 1 (+1).
		expect(mapper.oldToNew(5)).toBe(6);
		expect(mapper.oldToNew(8)).toBe(9);
		// After hunk 2 (+1 +2).
		expect(mapper.oldToNew(9)).toBe(12);
		expect(mapper.oldToNew(11)).toBe(14);
		// After hunk 3 (+1 +2 -2).
		expect(mapper.oldToNew(14)).toBe(15);
		expect(mapper.oldToNew(100)).toBe(101);
	});

	it("oldToNew is null inside a removed range", () => {
		expect(mapper.oldToNew(3)).toBeNull();
		expect(mapper.oldToNew(4)).toBeNull();
		expect(mapper.oldToNew(12)).toBeNull();
		expect(mapper.oldToNew(13)).toBeNull();
	});

	it("newToOld mirrors oldToNew and is null inside an added range", () => {
		expect(mapper.newToOld(1)).toBe(1);
		expect(mapper.newToOld(2)).toBe(2);
		expect(mapper.newToOld(3)).toBeNull();
		expect(mapper.newToOld(4)).toBeNull();
		expect(mapper.newToOld(5)).toBeNull();
		expect(mapper.newToOld(6)).toBe(5);
		expect(mapper.newToOld(9)).toBe(8);
		expect(mapper.newToOld(10)).toBeNull();
		expect(mapper.newToOld(11)).toBeNull();
		expect(mapper.newToOld(12)).toBe(9);
		expect(mapper.newToOld(14)).toBe(11);
		expect(mapper.newToOld(15)).toBe(14);
		expect(mapper.newToOld(101)).toBe(100);
	});

	it("hunkRemovingOld returns the hunk whose old range contains the line", () => {
		expect(mapper.hunkRemovingOld(3)).toEqual(REPLACE);
		expect(mapper.hunkRemovingOld(4)).toEqual(REPLACE);
		expect(mapper.hunkRemovingOld(13)).toEqual(CUT);
		expect(mapper.hunkRemovingOld(2)).toBeNull();
		expect(mapper.hunkRemovingOld(5)).toBeNull();
		// A pure addition removes nothing, whatever its oldStart.
		expect(mapper.hunkRemovingOld(8)).toBeNull();
	});

	it("hunkAddingNew returns the hunk whose new range contains the line", () => {
		expect(mapper.hunkAddingNew(3)).toEqual(REPLACE);
		expect(mapper.hunkAddingNew(5)).toEqual(REPLACE);
		expect(mapper.hunkAddingNew(10)).toEqual(ADD);
		expect(mapper.hunkAddingNew(11)).toEqual(ADD);
		expect(mapper.hunkAddingNew(6)).toBeNull();
		expect(mapper.hunkAddingNew(12)).toBeNull();
		// A pure deletion adds nothing, whatever its newStart.
		expect(mapper.hunkAddingNew(14)).toBeNull();
	});

	it("returns only the four range fields of a hunk given with more", () => {
		const cluster = {
			...REPLACE,
			key: "k",
			removed: ["a", "b"],
			added: ["A", "B", "C"],
		} as MapHunk;
		expect(createLineMapper([cluster]).hunkRemovingOld(3)).toStrictEqual(
			REPLACE,
		);
	});

	it("handles a pure addition at the top (oldStart 0) and a deletion at the top (newStart 0)", () => {
		const top = createLineMapper([
			{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
		]);
		expect(top.oldToNew(1)).toBe(3);
		expect(top.newToOld(1)).toBeNull();
		expect(top.newToOld(3)).toBe(1);
		const cut = createLineMapper([
			{ oldStart: 1, oldCount: 2, newStart: 0, newCount: 0 },
		]);
		expect(cut.oldToNew(1)).toBeNull();
		expect(cut.oldToNew(3)).toBe(1);
		expect(cut.newToOld(1)).toBe(3);
	});

	it("sorts hunks given out of order", () => {
		const shuffled = createLineMapper([CUT, REPLACE, ADD]);
		for (let n = 1; n <= 20; n++) {
			expect(shuffled.oldToNew(n)).toBe(mapper.oldToNew(n));
			expect(shuffled.newToOld(n)).toBe(mapper.newToOld(n));
		}
		expect(shuffled.hunkRemovingOld(12)).toEqual(CUT);
		expect(shuffled.hunkAddingNew(10)).toEqual(ADD);
	});

	it("handles adjacent hunks: old ranges that touch, with no context between", () => {
		// Old 3-4 became new 3-5; old 5 (right after) became new 6.
		const first: MapHunk = {
			oldStart: 3,
			oldCount: 2,
			newStart: 3,
			newCount: 3,
		};
		const second: MapHunk = {
			oldStart: 5,
			oldCount: 1,
			newStart: 6,
			newCount: 1,
		};
		const adjacent = createLineMapper([first, second]);
		expect(adjacent.oldToNew(2)).toBe(2);
		expect(adjacent.oldToNew(3)).toBeNull();
		expect(adjacent.oldToNew(4)).toBeNull();
		expect(adjacent.oldToNew(5)).toBeNull();
		expect(adjacent.oldToNew(6)).toBe(7);
		expect(adjacent.newToOld(2)).toBe(2);
		expect(adjacent.newToOld(5)).toBeNull();
		expect(adjacent.newToOld(6)).toBeNull();
		expect(adjacent.newToOld(7)).toBe(6);
		expect(adjacent.hunkRemovingOld(4)).toEqual(first);
		expect(adjacent.hunkRemovingOld(5)).toEqual(second);
		expect(adjacent.hunkRemovingOld(6)).toBeNull();
		expect(adjacent.hunkAddingNew(5)).toEqual(first);
		expect(adjacent.hunkAddingNew(6)).toEqual(second);
		// A pure deletion right after an addition that sits on the same old line.
		const touching = createLineMapper([
			{ oldStart: 4, oldCount: 0, newStart: 5, newCount: 2 },
			{ oldStart: 5, oldCount: 1, newStart: 6, newCount: 0 },
		]);
		expect(touching.oldToNew(4)).toBe(4);
		expect(touching.oldToNew(5)).toBeNull();
		expect(touching.oldToNew(6)).toBe(7);
		expect(touching.newToOld(5)).toBeNull();
		expect(touching.newToOld(6)).toBeNull();
		expect(touching.newToOld(7)).toBe(6);
		expect(touching.hunkRemovingOld(5)).toEqual({
			oldStart: 5,
			oldCount: 1,
			newStart: 6,
			newCount: 0,
		});
	});

	it("does not mutate the hunks it is given", () => {
		const input = [CUT, REPLACE, ADD];
		createLineMapper(input);
		expect(input).toEqual([CUT, REPLACE, ADD]);
	});
});

describe("IDENTITY", () => {
	it("maps every line to itself and contains no hunk", () => {
		for (const n of [1, 2, 7, 1000]) {
			expect(IDENTITY.oldToNew(n)).toBe(n);
			expect(IDENTITY.newToOld(n)).toBe(n);
			expect(IDENTITY.hunkRemovingOld(n)).toBeNull();
			expect(IDENTITY.hunkAddingNew(n)).toBeNull();
		}
	});
});

/**
 * A random sorted, non-overlapping hunk list in git's -U0 convention: each
 * hunk sits after at least one untouched line (the first may start at the
 * top), removes `oldCount` lines and adds `newCount`, at least one of them.
 */
const hunkListArb: fc.Arbitrary<MapHunk[]> = fc
	.array(
		fc.record({
			gap: fc.integer({ min: 1, max: 5 }),
			oldCount: fc.integer({ min: 0, max: 4 }),
			newCount: fc.integer({ min: 0, max: 4 }),
		}),
		{ maxLength: 12 },
	)
	.chain((steps) =>
		fc.boolean().map((atTop) => {
			const hunks: MapHunk[] = [];
			let oldPos = 1;
			let newPos = 1;
			steps.forEach((step, i) => {
				const gap = i === 0 && atTop ? 0 : step.gap;
				const oldCount =
					step.oldCount + step.newCount === 0 ? 1 : step.oldCount;
				const { newCount } = step;
				const oldFrom = oldPos + gap;
				const newFrom = newPos + gap;
				hunks.push({
					oldStart: oldCount > 0 ? oldFrom : oldFrom - 1,
					oldCount,
					newStart: newCount > 0 ? newFrom : newFrom - 1,
					newCount,
				});
				oldPos = oldFrom + oldCount;
				newPos = newFrom + newCount;
			});
			return hunks;
		}),
	);

describe("round trip", () => {
	it("newToOld(oldToNew(n)) is n for every old line outside a removed range", () => {
		fc.assert(
			fc.property(hunkListArb, fc.integer({ min: 1, max: 120 }), (hunks, n) => {
				const mapper = createLineMapper(hunks);
				const removed = hunks.some(
					(h) =>
						h.oldCount > 0 && n >= h.oldStart && n < h.oldStart + h.oldCount,
				);
				const mapped = mapper.oldToNew(n);
				if (removed) {
					expect(mapped).toBeNull();
					expect(mapper.hunkRemovingOld(n)).not.toBeNull();
					return;
				}
				expect(mapped).not.toBeNull();
				expect(mapper.hunkRemovingOld(n)).toBeNull();
				expect(mapper.hunkAddingNew(mapped as number)).toBeNull();
				expect(mapper.newToOld(mapped as number)).toBe(n);
			}),
		);
	});

	it("oldToNew(newToOld(m)) is m for every new line outside an added range", () => {
		fc.assert(
			fc.property(hunkListArb, fc.integer({ min: 1, max: 120 }), (hunks, m) => {
				const mapper = createLineMapper(hunks);
				const added = hunks.some(
					(h) =>
						h.newCount > 0 && m >= h.newStart && m < h.newStart + h.newCount,
				);
				const mapped = mapper.newToOld(m);
				if (added) {
					expect(mapped).toBeNull();
					expect(mapper.hunkAddingNew(m)).not.toBeNull();
					return;
				}
				expect(mapped).not.toBeNull();
				expect(mapper.oldToNew(mapped as number)).toBe(m);
			}),
		);
	});
});
