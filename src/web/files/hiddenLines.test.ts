import { describe, expect, it } from "vitest";
import type { DiffLine } from "../../shared/types";
import type { Mark } from "../code/Invisibles";
import { hiddenLines } from "./hiddenLines";
import type { DiffRow } from "./whitespace";
import { hunkPairs, hunkWordMarks } from "./wordBlocks";

const del = (text: string, noNewline?: boolean): DiffLine => ({
	kind: "del",
	text,
	clusterKey: "k",
	noNewline,
});
const add = (text: string, noNewline?: boolean): DiffLine => ({
	kind: "add",
	text,
	clusterKey: "k",
	noNewline,
});
const ctx = (text: string): DiffLine => ({ kind: "context", text });
const rows = (...lines: DiffLine[]): DiffRow[] =>
	lines.map((line) => ({ kind: "line", line }));
const marks = (...entries: [DiffLine, Mark[]][]) => new Map(entries);

describe("hiddenLines", () => {
	it("names each marked line whose change doesn't show with hidden characters off", () => {
		const d1 = del("const a = 1;");
		const d2 = del("\tx = 2;");
		const d3 = del("let c = 3;");
		const a1 = add("const a = 1;\r");
		const a2 = add("    x = 2;");
		const a3 = add("let cc = 3;");
		const hidden = hiddenLines(
			rows(ctx("x"), d1, d2, d3, a1, a2, a3, ctx("y")),
			marks(
				[a1, [[12, 13]]],
				[d2, [[0, 1]]],
				[a2, [[0, 4]]],
				[d3, [[4, 5]]],
				[a3, [[4, 6]]],
			),
			4,
		);
		expect([...hidden]).toEqual(expect.arrayContaining([a1, d2, a2]));
		expect(hidden.size).toBe(3);
	});

	it("names a changed line holding a BOM, paired or not", () => {
		const BOM = "\uFEFF";
		const d = del("export const a = 1;");
		const a1 = add(`${BOM}export const a = 1;`);
		const a2 = add("const b = 2;");
		// One removed, two added: no pair, so no marks.
		const r = rows(d, a1, a2);
		expect(hunkWordMarks(r).size).toBe(0);
		expect([...hiddenLines(r, hunkWordMarks(r), 4)]).toEqual([a1]);
		// Paired: its mark on the BOM.
		const p = rows(d, a1);
		expect([...hiddenLines(p, hunkWordMarks(p), 4)]).toEqual([a1]);
		// The BOM removed: the old side warns.
		const old = del(`${BOM}x`);
		const q = rows(old, add("x"));
		expect([...hiddenLines(q, hunkWordMarks(q), 4)]).toEqual([old]);
		// Mid-file (files joined by cat), unpaired.
		const joined = add(`${BOM}echo two`);
		expect([...hiddenLines(rows(joined), new Map(), 4)]).toEqual([joined]);
		// An unchanged line is no change.
		expect(hiddenLines(rows(ctx(`${BOM}x`)), new Map(), 4).size).toBe(0);
	});

	it("compares a pair's lines at the file's tab width", () => {
		const d = del("\tx");
		const a = add("        x");
		const words = marks([d, [[0, 1]]], [a, [[0, 8]]]);
		expect(hiddenLines(rows(d, a), words, 8).size).toBe(2);
		expect(hiddenLines(rows(d, a), words, 4).size).toBe(0);
	});

	it("pairs across runs the way the marks do: a context line ends a block", () => {
		const d = del("\tx");
		const a = add("    x");
		const words = marks([d, [[0, 1]]], [a, [[0, 4]]]);
		// Not a pair: the marks are someone else's (and the look compares nothing).
		expect(hiddenLines(rows(d, ctx("c"), a), words, 4).size).toBe(0);
	});

	it("checks every marked line for a mark that draws nothing, paired or not", () => {
		// Marks from some other pairing than today's equal blocks.
		const d = del("let a = 1;");
		const a1 = add("let a = 1;  ");
		const a2 = add("x\r");
		const hidden = hiddenLines(
			rows(d, a1, a2),
			marks([a1, [[10, 12]]], [a2, [[1, 2]]]),
			4,
		);
		expect([...hidden]).toEqual([a1, a2]);
	});

	it("pairs lines as the word marks do (hunkPairs)", () => {
		const d1 = del("a");
		const d2 = del("\tx");
		const a1 = add("b");
		const a2 = add("    x");
		const ws = rows(ctx("c"), d1, d2, a1, a2, del("z"), ctx("e"));
		expect(hunkPairs(ws)).toEqual([
			[d1, a1],
			[d2, a2],
		]);
		const words = hunkWordMarks(ws);
		expect(hiddenLines(ws, words, 4)).toEqual(new Set([d2, a2]));
	});

	it("names a line whose changed trailing blank is bridged onto a visible change", () => {
		// "a  " → "x \t": the tab changed and draws nothing, bridged to `x`.
		const d = del("a  ");
		const a = add("x \t");
		const ws = rows(d, a);
		const words = hunkWordMarks(ws);
		expect(words.get(a)).toEqual([[0, 3]]);
		expect(hiddenLines(ws, words, 4).has(a)).toBe(true);
	});

	it("reads a last line without a newline as the reader sees it: its \\r is drawn", () => {
		const d = del("x", true);
		const a = add("x\r", true);
		expect(hiddenLines(rows(d, a), marks([a, [[1, 2]]]), 4).size).toBe(0);
	});

	it("names case 65's lines whose change is a kept emoji selector or joiner", () => {
		const pairs = [
			['export const smile = "😀";', 'export const smile = "😀\uFE0F";'],
			['export const pets = "🐶🐱";', 'export const pets = "🐶\u200D🐱";'],
			[
				'export const party = ["🎉", "todo"];',
				'export const party = ["🎉\uFE0F", "done"];',
			],
		];
		for (const [before, after] of pairs) {
			const d = del(before as string);
			const a = add(after as string);
			const ws = rows(d, a);
			const words = hunkWordMarks(ws);
			expect(words.has(a), after).toBe(true);
			expect(hiddenLines(ws, words, 4).has(a), after).toBe(true);
		}
	});

	it("names nothing without marks", () => {
		expect(hiddenLines(rows(del("a "), add("a")), new Map(), 4).size).toBe(0);
	});
});
