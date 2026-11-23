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
});
