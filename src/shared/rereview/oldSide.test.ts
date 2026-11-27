import { describe, expect, it } from "vitest";
import { hunkOldRows, oldSideShift } from "./oldSide";

const HUNK = "@@ -8,3 +8,2 @@\n l 8\n l 9\n-l 10";
const L = Array.from({ length: 20 }, (_, i) => `l ${i + 1}`);

describe("hunkOldRows", () => {
	it("keeps context and removed rows by their old numbers, added ones left out, CRs dropped", () => {
		expect(hunkOldRows("@@ -2,2 +2,2 @@\n a\r\n+b\n-c")).toEqual([
			{ line: 2, text: "a" },
			{ line: 3, text: "c" },
		]);
		expect(hunkOldRows("")).toEqual([]);
	});
});

describe("oldSideShift", () => {
	const rows = hunkOldRows(HUNK);

	it("0 where the hunk numbers its rows", () => {
		expect(oldSideShift(rows, L, 10)).toBe(0);
	});

	it("the shift to the one place the run of rows sits", () => {
		expect(oldSideShift(rows, ["x", "y", "z", ...L], 10)).toBe(3);
		expect(oldSideShift(rows, L.slice(2), 10)).toBe(-2);
	});

	it("null when the rows are nowhere, twice, or the text is missing", () => {
		expect(
			oldSideShift(
				rows,
				L.map((l) => `${l}!`),
				10,
			),
		).toBeNull();
		expect(oldSideShift(rows, ["x", ...L.slice(7, 10), ...L], 10)).toBeNull();
		expect(oldSideShift(rows, null, 10)).toBeNull();
	});

	it("null when the hunk doesn't hold the commented line, or has no old rows", () => {
		expect(oldSideShift(rows, L, 11)).toBeNull();
		expect(oldSideShift([], L, 10)).toBeNull();
	});

	it("a CRLF text matches an LF hunk", () => {
		expect(
			oldSideShift(
				rows,
				L.map((l) => `${l}\r`),
				10,
			),
		).toBe(0);
	});

	it("never moves a run that tells too little: a brace, a blank and one statement found once elsewhere", () => {
		const boiler = hunkOldRows("@@ -10,3 +10,3 @@\n }\n \n-return null;");
		const text = [
			...Array.from({ length: 20 }, (_, i) => `code ${i + 1}`),
			"}",
			"",
			"return null;",
		];
		// As numbered it's wrong (lines 10–12 are code), and the run sits
		// once at 21–23: still not moved there.
		expect(oldSideShift(boiler, text, 12)).toBeNull();
		// Three rows, two of them telling: moved.
		const telling = hunkOldRows(
			"@@ -10,3 +10,3 @@\n }\n const a = 1;\n-return a;",
		);
		expect(
			oldSideShift(
				telling,
				[...text.slice(0, 20), "}", "const a = 1;", "return a;"],
				12,
			),
		).toBe(11);
		// Two rows, both telling: too short to move.
		const short = hunkOldRows("@@ -10,2 +10,1 @@\n const a = 1;\n-return a;");
		expect(
			oldSideShift(
				short,
				[...text.slice(0, 20), "const a = 1;", "return a;"],
				11,
			),
		).toBeNull();
	});
});
