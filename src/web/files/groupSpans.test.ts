import { describe, expect, it } from "vitest";
import type { LineGroup } from "../../shared/hunkPairs";
import type { DiffLine } from "../../shared/types";
import { groupLabel, groupSpans } from "./groupSpans";

const del = (oldNo: number): DiffLine => ({
	kind: "del",
	oldNo,
	text: `d${oldNo}`,
	clusterKey: "k",
});
const add = (newNo: number): DiffLine => ({
	kind: "add",
	newNo,
	text: `a${newNo}`,
	clusterKey: "k",
});

const split = (one: number, from: number, to: number): LineGroup => ({
	one: del(one),
	run: Array.from({ length: to - from + 1 }, (_, i) => add(from + i)),
});
const join = (from: number, to: number, one: number): LineGroup => ({
	one: add(one),
	run: Array.from({ length: to - from + 1 }, (_, i) => del(from + i)),
});

describe("groupLabel", () => {
	it("names a split and a join, with an en dash", () => {
		expect(groupLabel(split(12, 12, 16))).toBe("Line 12 split into 12–16");
		expect(groupLabel(join(7, 9, 7))).toBe("Lines 7–9 joined into 7");
	});
	it("a run of two", () => {
		expect(groupLabel(split(12, 12, 13))).toBe("Line 12 split into 12–13");
		expect(groupLabel(join(3, 4, 5))).toBe("Lines 3–4 joined into 5");
	});
});

describe("groupLabel without old numbers (the since view's orphans, CAR-216)", () => {
	/** An orphan removed line: its base number, no `oldNo`. */
	const orphan = (baseNo: number | null): DiffLine => ({
		kind: "del",
		baseNo,
		text: `o${baseNo}`,
		clusterKey: "k",
		orphan: true,
	});
	it("a split or join of orphan lines reads their base numbers", () => {
		expect(
			groupLabel({ one: orphan(5), run: [add(1), add(2), add(3), add(4)] }),
		).toBe("Line 5 split into 1–4");
		expect(groupLabel({ one: add(9), run: [orphan(7), orphan(8)] })).toBe(
			"Lines 7–8 joined into 9",
		);
	});
	it("with no number at all, a numberless form, never `undefined`", () => {
		expect(groupLabel({ one: orphan(null), run: [add(1), add(2)] })).toBe(
			"A line split into 1–2",
		);
		expect(
			groupLabel({ one: add(9), run: [orphan(null), orphan(null), orphan(3)] }),
		).toBe("3 lines joined into 9");
	});
});

describe("groupSpans", () => {
	it("unified: each line's place in its group's rows, and the label", () => {
		const s = split(12, 12, 14);
		const j = join(7, 9, 7);
		const spans = groupSpans({ pairs: [[del(1), add(1)]], groups: [s, j] });
		expect(spans.size).toBe(8);
		// A split reads −one, +run…: the one line first, the run's last last.
		expect([s.one, ...s.run].map((l) => spans.get(l)?.at)).toEqual([
			"first",
			"mid",
			"mid",
			"last",
		]);
		// A join reads −run…, +one.
		expect([...j.run, j.one].map((l) => spans.get(l)?.at)).toEqual([
			"first",
			"mid",
			"mid",
			"last",
		]);
		for (const l of [s.one, ...s.run]) {
			expect(spans.get(l)?.group).toBe(s);
			expect(spans.get(l)?.label).toBe("Line 12 split into 12–14");
		}
	});
	it("side by side: the one line shares the first row with the run's first", () => {
		const s = split(12, 12, 14);
		const j = join(7, 8, 7);
		const spans = groupSpans({ pairs: [], groups: [s, j] }, "side-by-side");
		expect([s.one, ...s.run].map((l) => spans.get(l)?.at)).toEqual([
			"first",
			"first",
			"mid",
			"last",
		]);
		expect([j.one, ...j.run].map((l) => spans.get(l)?.at)).toEqual([
			"first",
			"first",
			"last",
		]);
	});
});
