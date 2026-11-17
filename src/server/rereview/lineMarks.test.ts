import { describe, expect, it } from "vitest";
import type { LineRanges } from "../../shared/lineRanges";
import type { Cluster } from "../../shared/types";
import { type SinceReviewed, sinceLineMarks } from "./engine";

/** An earlier cluster adding `added` (and removing `removed`), as reviewed as `reviewed` says. */
const then = (
	key: string,
	added: string[],
	reviewed: LineRanges,
	removed: string[] = [],
): [string, SinceReviewed] => [
	key,
	{
		cluster: {
			key,
			kind: "lines",
			oldStart: 1,
			oldCount: removed.length,
			newStart: 1,
			newCount: added.length,
			removed,
			added,
			lines: removed.length + added.length,
		} as Cluster,
		reviewed,
	},
];
const keyed = (key: string, from: number, to: number) =>
	Object.fromEntries(
		Array.from({ length: to - from }, (_, i) => [from + i, key]),
	);

describe("sinceLineMarks (CAR-195)", () => {
	// The old side: a const, a blank, then K's run (comment, set, blank), then code.
	const old = ["const", "", "// c", "set", "", "code"];
	const K = ["// c", "set", ""];

	it("vouches for a line K added only when that line of K is reviewed", () => {
		const whole = sinceLineMarks(
			new Map([then("K", K, [[0, 3]])]),
			keyed("K", 3, 6),
			{},
			old,
		);
		expect([3, 4, 5].map(whole.added)).toEqual([true, true, true]);
		const part = sinceLineMarks(
			new Map([then("K", K, [[1, 2]])]),
			keyed("K", 3, 6),
			{},
			old,
		);
		expect([3, 4, 5].map(part.added)).toEqual([false, true, false]);
	});

	it("a slider twin above the run takes the mark of the run's last line", () => {
		const marks = (reviewed: LineRanges) =>
			sinceLineMarks(
				new Map([then("K", K, reviewed)]),
				keyed("K", 3, 6),
				{},
				old,
			);
		// Line 2 (the blank above) is the twin of line 5 (K's blank).
		expect(marks([[2, 3]]).added(2)).toBe(true);
		expect(marks([[0, 2]]).added(2)).toBe(false);
		// The const reads unlike "set": no twin, nothing slides further.
		expect(marks([[0, 3]]).added(1)).toBe(false);
		// Below the run "code" reads unlike "// c": no twin.
		expect(marks([[0, 3]]).added(6)).toBe(false);
	});

	it("slides down and on: each line further takes the twin of the line it stands in for", () => {
		// Run "x" at 1; below it "x", "x": both twins of line 1.
		const marks = sinceLineMarks(
			new Map([then("K", ["x"], [[0, 1]])]),
			keyed("K", 1, 2),
			{},
			["x", "x", "x", "y"],
		);
		expect([2, 3, 4].map(marks.added)).toEqual([true, true, false]);
	});

	it("a line two runs claim needs both twins reviewed", () => {
		// A ("x") at 1, an unchanged "x" at 2, B ("x") at 3: line 2 is A's
		// twin slid down and B's slid up.
		const addedThen = { ...keyed("A", 1, 2), ...keyed("B", 3, 4) };
		const both = (a: LineRanges, b: LineRanges) =>
			sinceLineMarks(
				new Map([then("A", ["x"], a), then("B", ["x"], b)]),
				addedThen,
				{},
				["x", "x", "x"],
			).added(2);
		expect(both([[0, 1]], [[0, 1]])).toBe(true);
		expect(both([[0, 1]], [])).toBe(false);
		expect(both([], [[0, 1]])).toBe(false);
	});

	it("fails closed: a cluster whose lines don't all map vouches only when wholly reviewed", () => {
		// K added 3 lines; only two map to the old side.
		const marks = (reviewed: LineRanges) =>
			sinceLineMarks(
				new Map([then("K", K, reviewed)]),
				keyed("K", 3, 5),
				{},
				old,
			);
		expect(marks([[0, 2]]).added(3)).toBe(false);
		expect(marks([[0, 3]]).added(3)).toBe(true);
	});

	it("a removed base line: vouched when that removed line of the cluster is reviewed", () => {
		const marks = sinceLineMarks(
			new Map([then("R", ["new"], [[1, 2]], ["one", "two"])]),
			{},
			keyed("R", 10, 12),
			[],
		);
		expect([10, 11].map(marks.removed)).toEqual([false, true]);
		expect(marks.removed(12)).toBe(false);
	});

	it("an unknown cluster, or no mark at all, vouches for nothing", () => {
		const marks = sinceLineMarks(new Map(), keyed("K", 3, 6), {}, old);
		expect([2, 3, 4, 5].map(marks.added)).toEqual([false, false, false, false]);
	});
});
