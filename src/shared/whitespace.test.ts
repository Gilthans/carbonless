import { describe, expect, it } from "vitest";
import { bestCpuRatio } from "../../test/cpu.js";
import {
	type HunkPiece,
	SPLIT_CELLS,
	splitHunk,
	stripWhitespace,
	whitespaceEqual,
} from "./whitespace.js";

/** The pieces as a readable trace: `~` whitespace-only, `*` a change, with each side's lines. */
const trace = (
	pieces: HunkPiece[],
	removed: readonly string[],
	added: readonly string[],
) =>
	pieces.map(
		(p) =>
			`${p.whitespaceOnly ? "~" : "*"}${removed.slice(p.removedFrom, p.removedTo).join(",")}|${added.slice(p.addedFrom, p.addedTo).join(",")}`,
	);

/**
 * Principle 2: the pieces cover every removed and added line of the hunk
 * exactly once, in order, none empty; a whitespace-only piece pairs its
 * lines side for side, each pair `-w`-equal (with the same final
 * newline); a change piece never sits next to another change piece, nor a
 * whitespace-only one next to another (runs are whole).
 */
function expectPieces(
	pieces: HunkPiece[],
	removed: readonly string[],
	added: readonly string[],
	noNewlineOld = false,
	noNewlineNew = false,
) {
	let r = 0;
	let a = 0;
	let last: boolean | null = null;
	for (const p of pieces) {
		expect(p.removedFrom).toBe(r);
		expect(p.addedFrom).toBe(a);
		expect(p.removedTo).toBeGreaterThanOrEqual(p.removedFrom);
		expect(p.addedTo).toBeGreaterThanOrEqual(p.addedFrom);
		expect(
			p.removedTo - p.removedFrom + p.addedTo - p.addedFrom,
		).toBeGreaterThan(0);
		if (p.whitespaceOnly) {
			expect(p.removedTo - p.removedFrom).toBe(p.addedTo - p.addedFrom);
			for (let k = 0; k < p.removedTo - p.removedFrom; k++) {
				const i = p.removedFrom + k;
				const j = p.addedFrom + k;
				expect(whitespaceEqual(removed[i] as string, added[j] as string)).toBe(
					true,
				);
				const endOld = noNewlineOld && i === removed.length - 1;
				const endNew = noNewlineNew && j === added.length - 1;
				expect(endOld).toBe(endNew);
			}
		}
		if (pieces.length > 1) expect(p.whitespaceOnly).not.toBe(last);
		last = p.whitespaceOnly;
		r = p.removedTo;
		a = p.addedTo;
	}
	expect(r).toBe(removed.length);
	expect(a).toBe(added.length);
}

function split(
	removed: string[],
	added: string[],
	noNewlineOld = false,
	noNewlineNew = false,
) {
	const pieces = splitHunk(removed, added, noNewlineOld, noNewlineNew);
	expectPieces(pieces, removed, added, noNewlineOld, noNewlineNew);
	return trace(pieces, removed, added);
}

describe("stripWhitespace", () => {
	it("removes ASCII whitespace only, as git -w does", () => {
		expect(stripWhitespace(" a\tb\r\v\fc ")).toBe("abc");
		expect(stripWhitespace("a\u00a0b")).toBe("a\u00a0b");
		expect(whitespaceEqual("  x = 1;", "x=1;\r")).toBe(true);
		expect(whitespaceEqual("x = 1;", "x = 2;")).toBe(false);
	});
});

describe("splitHunk", () => {
	it("cuts change / whitespace-only / change into three pieces", () => {
		expect(
			split(["a", "b", "  c", "  d", "e", "f"], ["A", "B", "c", "d", "E", "F"]),
		).toEqual(["*a,b|A,B", "~  c,  d|c,d", "*e,f|E,F"]);
	});

	it("keeps a hunk that is all whitespace one whitespace-only piece", () => {
		expect(split(["  a", "  b"], ["\ta", "\tb"])).toEqual(["~  a,  b|\ta,\tb"]);
	});

	it("keeps a hunk with no whitespace-only line one change", () => {
		expect(split(["a", "b"], ["c", "d"])).toEqual(["*a,b|c,d"]);
	});

	it("splits out a single whitespace-only line between two changes", () => {
		expect(split(["a", " x", "b"], ["A", "x", "B"])).toEqual([
			"*a|A",
			"~ x|x",
			"*b|B",
		]);
	});

	it("never counts a pure addition or deletion as whitespace-only, blank lines too", () => {
		expect(split([], ["", "  "])).toEqual(["*|,  "]);
		expect(split(["", "\t"], [])).toEqual(["*,\t|"]);
	});

	it("pairs a blank line with a whitespace-only one, as git -w does, but an added blank line stays a change", () => {
		// "  " and "" are equal once whitespace is gone: -w shows them as context.
		expect(split(["a", "  "], ["A", ""])).toEqual(["*a|A", "~  |"]);
		// The extra blank line has no twin: a change.
		expect(split(["a"], ["a ", ""])).toEqual(["~a|a ", "*|"]);
	});

	it("treats CRLF to LF and tabs to spaces as whitespace", () => {
		expect(split(["x\r", "\ty"], ["x", "    y"])).toEqual(["~x\r,\ty|x,    y"]);
	});

	it("keeps a line moved across a re-indented block a change", () => {
		expect(split(["m", "  b1", "  b2"], ["b1", "b2", "m"])).toEqual([
			"*m|",
			"~  b1,  b2|b1,b2",
			"*|m",
		]);
	});

	it("matches in order only: a swapped pair is one match and a change", () => {
		const out = split(["x ", "y "], ["y", "x"]);
		expect(out.filter((p) => p.startsWith("~"))).toHaveLength(1);
		expect(out.filter((p) => p.startsWith("*"))).toHaveLength(2);
	});

	it("treats a final newline lost or gained as a real change, like git -w", () => {
		expect(split(["a", " b"], ["a ", "b"], false, true)).toEqual([
			"~a|a ",
			"* b|b",
		]);
		expect(split(["a", " b"], ["a ", "b"], true, true)).toEqual(["~a, b|a ,b"]);
	});

	it("matches a hunk up to the cap, and keeps one over it one change", () => {
		const within = Array.from({ length: 499 }, (_, i) => ` w${i}`);
		expect(
			splitHunk([...within, "x"], [...within.map((l) => l.trim()), "y"]).map(
				(p) => p.whitespaceOnly,
			),
		).toEqual([true, false]);
		const removed = Array.from({ length: 501 }, (_, i) => ` l${i}`);
		expect(removed.length * (removed.length + 1)).toBeGreaterThan(SPLIT_CELLS);
		const added = [...removed.map((l) => l.trim()), "extra"];
		expect(splitHunk(removed, added)).toEqual([
			{
				removedFrom: 0,
				removedTo: removed.length,
				addedFrom: 0,
				addedTo: added.length,
				whitespaceOnly: false,
			},
		]);
		// A wholesale re-indent over the cap still splits (no O(n·m) work).
		expect(splitHunk(removed, added.slice(0, -1))).toEqual([
			{
				removedFrom: 0,
				removedTo: removed.length,
				addedFrom: 0,
				addedTo: removed.length,
				whitespaceOnly: true,
			},
		]);
	});

	it("does no O(n·m) work on a hunk over the cap: it costs about what a re-indent of the same size does", () => {
		const old = Array.from({ length: 2000 }, (_, i) => `  l${i % 50}`);
		const reindent = old.map((l) => l.trim());
		const rewritten = [...old.map((l, i) => (i % 3 ? l.trim() : `${l}!`)), "x"];
		const { ratio } = bestCpuRatio(
			() => splitHunk(old, rewritten),
			() => splitHunk(old, reindent),
		);
		// The matching would be well over 10x (about 50 ms against 2).
		expect(ratio).toBeLessThan(3);
	});

	it("covers every line exactly once and labels only -w-equal pairs, for any generated hunk", () => {
		let s = 11;
		const r = () => {
			s = (s * 1664525 + 1013904223) % 4294967296;
			return s / 4294967296;
		};
		const words = ["a", "b", "c", "", "}"];
		const spaced = (w: string) =>
			[w, ` ${w}`, `\t${w}`, `${w}\r`, `${w}  `][Math.floor(r() * 5)] as string;
		for (let seed = 0; seed < 2000; seed++) {
			const n = Math.floor(r() * 9);
			const m = Math.floor(r() * 9);
			const removed = Array.from({ length: n }, () =>
				spaced(words[Math.floor(r() * words.length)] as string),
			);
			const added = Array.from({ length: m }, () =>
				spaced(words[Math.floor(r() * words.length)] as string),
			);
			if (n + m === 0) continue;
			const noOld = n > 0 && r() < 0.2;
			const noNew = m > 0 && r() < 0.2;
			const pieces = splitHunk(removed, added, noOld, noNew);
			expectPieces(pieces, removed, added, noOld, noNew);
		}
	});
});
