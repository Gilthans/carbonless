import { describe, expect, it } from "vitest";
import type { DiffLine } from "../../shared/types";
import type { DiffRow } from "./whitespace";
import { hunkWordMarks } from "./wordBlocks";

const del = (text: string, clusterKey = "k"): DiffLine => ({
	kind: "del",
	text,
	clusterKey,
});
const add = (text: string, clusterKey = "k"): DiffLine => ({
	kind: "add",
	text,
	clusterKey,
});
const ctx = (text: string): DiffLine => ({ kind: "context", text });
const rows = (...lines: DiffLine[]): DiffRow[] =>
	lines.map((line) => ({ kind: "line", line }));

describe("hunkWordMarks", () => {
	it("pairs an equal block's i-th removed line with its i-th added line", () => {
		const d1 = del("const a = 1;");
		const d2 = del("const b = 2;");
		const a1 = add("const a = 10;");
		const a2 = add("const bee = 2;");
		const marks = hunkWordMarks(rows(ctx("x"), d1, d2, a1, a2, ctx("y")));
		expect(marks.get(d1)).toEqual([[10, 11]]);
		expect(marks.get(a1)).toEqual([[10, 12]]);
		expect(marks.get(d2)).toEqual([[6, 7]]);
		expect(marks.get(a2)).toEqual([[6, 9]]);
		expect(marks.size).toBe(4);
	});

	it("leaves unequal blocks plain", () => {
		for (const [n, m] of [
			[1, 2],
			[3, 1],
			[2, 3],
			[1, 0],
			[0, 1],
		] as const) {
			const lines = [
				...Array.from({ length: n }, (_, i) => del(`old ${i}`)),
				...Array.from({ length: m }, (_, i) => add(`new ${i}`)),
			];
			expect(hunkWordMarks(rows(...lines)).size).toBe(0);
		}
	});

	it("never pairs across a context line", () => {
		const d = del("a = 1");
		const a = add("a = 2");
		expect(hunkWordMarks(rows(d, ctx("between"), a)).size).toBe(0);
		// Two blocks, each 1/1.
		const d1 = del("a = 1");
		const a1 = add("a = 2");
		const d2 = del("b = 1");
		const a2 = add("b = 3");
		const marks = hunkWordMarks(rows(d1, a1, ctx("between"), d2, a2));
		expect([...marks.keys()]).toEqual([d1, a1, d2, a2]);
	});

	it("ends a block at an added line followed by a removed one", () => {
		const a1 = add("x = 1");
		const d1 = del("y = 1");
		const a2 = add("y = 2");
		// 0/1, then 1/1.
		const marks = hunkWordMarks(rows(a1, d1, a2));
		expect([...marks.keys()]).toEqual([d1, a2]);
	});

	it("ends a block at a whitespace-only row (Ignore whitespace)", () => {
		const d1 = del("a = 1");
		const wd = del("  b");
		const wa = add("b");
		const a1 = add("a = 2");
		const r: DiffRow[] = [
			{ kind: "line", line: d1 },
			{ kind: "ws", del: wd, add: wa },
			{ kind: "line", line: a1 },
		];
		expect(hunkWordMarks(r).size).toBe(0);
		// A one-sided `~` row ends it too.
		const r2: DiffRow[] = [
			{ kind: "line", line: d1 },
			{ kind: "ws", add: wa },
			{ kind: "line", line: a1 },
		];
		expect(hunkWordMarks(r2).size).toBe(0);
		// And the whitespace-only lines themselves are never marked.
		const r3: DiffRow[] = [{ kind: "ws", del: wd, add: wa }];
		expect(hunkWordMarks(r3).size).toBe(0);
	});

	it("pairs across clusters: the hunk's rows, not its runs", () => {
		const d1 = del("one = 1", "a");
		const d2 = del("two = 2", "a");
		const a1 = add("one = 11", "b");
		const a2 = add("two = 22", "b");
		const marks = hunkWordMarks(rows(d1, d2, a1, a2));
		expect(marks.get(d1)).toEqual([[6, 7]]);
		expect(marks.get(a1)).toEqual([[6, 8]]);
		expect(marks.get(d2)).toEqual([[6, 7]]);
		expect(marks.get(a2)).toEqual([[6, 8]]);
	});

	it("keeps the other pairs' marks when one pair is too long", () => {
		const d1 = del("a".repeat(1024));
		const d2 = del("x = 1");
		const a1 = add("b");
		const a2 = add("x = 2");
		const marks = hunkWordMarks(rows(d1, d2, a1, a2));
		expect([...marks.keys()]).toEqual([d2, a2]);
	});

	it("marks a trailing \\r only one line of a pair has (owner, 2026-11-04)", () => {
		const d = del("same\r");
		const a = add("same");
		const marks = hunkWordMarks(rows(d, a));
		expect(marks.get(d)).toEqual([[4, 5]]);
		expect(marks.has(a)).toBe(false);
	});
});
