import { describe, expect, it } from "vitest";
import type { DiffLine, DisplayHunk } from "../../shared/types";
import { canMove, spanTexts } from "./draftMove";

const ctx = (o: number, n: number, text: string): DiffLine => ({
	kind: "context",
	oldNo: o,
	newNo: n,
	text,
});
const add = (n: number, text: string): DiffLine => ({
	kind: "add",
	newNo: n,
	text,
});
const hunk = (lines: DiffLine[]): DisplayHunk => ({
	oldStart: 1,
	oldCount: 1,
	newStart: 1,
	newCount: 1,
	lines,
});
const one = (line: number) => ({
	startSide: "RIGHT" as const,
	startLine: line,
	side: "RIGHT" as const,
	line,
});

describe("spanTexts", () => {
	it("gives the span's lines and up to three of its hunk's lines around it", () => {
		const h = hunk([
			ctx(1, 1, "a"),
			ctx(2, 2, "b"),
			add(3, "c"),
			add(4, "d"),
			ctx(3, 5, "e"),
		]);
		expect(spanTexts([h], { ...one(4), startLine: 3 })).toEqual({
			lines: ["c", "d"],
			before: ["a", "b"],
			after: ["e"],
		});
		// Not a hunk's line, or backwards: none.
		expect(spanTexts([h], one(9))).toBeNull();
		expect(spanTexts([h], { ...one(3), startLine: 4 })).toBeNull();
	});
});

describe("canMove", () => {
	const at = (lines: string[], line: number) =>
		spanTexts([hunk(lines.map((t, i) => ctx(i + 1, i + 1, t)))], one(line));

	it("moves when the span and its context read the same", () => {
		const file = ["if (a) {", "  run();", "}", "next();"];
		expect(canMove(at(file, 2), at(file, 2))).toBe(true);
	});

	it("not a lone } that a line above shifted by one", () => {
		const before = ["if (a) {", "  run();", "}", "", "x();"];
		const after = ["if (a) {", "  run();", "  more();", "}", "", "x();"];
		// Line 3 was the }; on the new head line 3 is "  more();", and the }
		// now at 4 isn't at the draft's number. And a } at 3 with other
		// context around it:
		const other = ["if (b) {", "  stop();", "}", "y();"];
		expect(canMove(at(before, 3), at(after, 3))).toBe(false);
		expect(canMove(at(before, 3), at(other, 3))).toBe(false);
	});

	it("not when a middle line of the span changed", () => {
		const a = ["x", "first();", "middle();", "last();", "y"];
		const b = ["x", "first();", "changed();", "last();", "y"];
		const span = { ...one(4), startLine: 2 };
		const t = (f: string[]) =>
			spanTexts([hunk(f.map((s, i) => ctx(i + 1, i + 1, s)))], span);
		expect(canMove(t(a), t(b))).toBe(false);
	});

	it("a blank or lone-punctuation span with no context to agree on stays put; one that says something moves", () => {
		expect(
			canMove(
				{ lines: ["}"], before: [], after: [] },
				{ lines: ["}"], before: [], after: [] },
			),
		).toBe(false);
		expect(
			canMove(
				{ lines: [""], before: [], after: ["z"] },
				{ lines: [""], before: [], after: ["z"] },
			),
		).toBe(false);
		expect(
			canMove(
				{ lines: ["const total = sum(xs);"], before: [], after: [] },
				{ lines: ["const total = sum(xs);"], before: [], after: [] },
			),
		).toBe(true);
	});

	it("not without stored text, or with an earlier draft's other shape", () => {
		const now = { lines: ["a"], before: ["b", "c"], after: [] };
		expect(canMove(undefined, now)).toBe(false);
		expect(canMove({ start: "a", end: "a" }, now)).toBe(false);
		expect(canMove(now, null)).toBe(false);
	});
});
