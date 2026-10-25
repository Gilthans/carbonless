import { describe, expect, it } from "vitest";
import { parseDiffHunk } from "../shared/diffHunk";
import type { CodeAnchor, CodeRow } from "../shared/types";
import { hunkWindowRows, windowRows } from "./codeWindow";

// Old 10..16, new 10..17: c replaced by C D, g deleted, i added.
const HUNK = [
	"@@ -10,7 +10,8 @@ export class Cache {",
	" a",
	" b",
	"-c",
	"+C",
	"+D",
	" e",
	" f",
	"-g",
	" h",
	"+i",
].join("\n");
const LINES = parseDiffHunk(HUNK);

const anchor = (
	startLine: number,
	line: number,
	extra: Partial<CodeAnchor> = {},
): CodeAnchor => ({
	path: "a.ts",
	commit: "",
	side: "RIGHT",
	line,
	startSide: "RIGHT",
	startLine,
	at: "",
	...extra,
});

const shown = (rows: CodeRow[] | null) =>
	rows?.map(
		(l) =>
			`${l.marked ? ">" : " "}${l.oldNo ?? "."}/${l.newNo ?? "."} ${l.text}`,
	) ?? null;

describe("windowRows", () => {
	it("keeps three rows before and after a commented line", () => {
		expect(shown(windowRows(LINES, anchor(14, 14)))).toEqual([
			" 12/. c",
			" ./12 C",
			" ./13 D",
			">13/14 e",
			" 14/15 f",
			" 15/. g",
			" 16/16 h",
		]);
	});

	it("clips the context at the file's start and end", () => {
		expect(shown(windowRows(LINES, anchor(10, 10)))).toEqual([
			">10/10 a",
			" 11/11 b",
			" 12/. c",
			" ./12 C",
		]);
		expect(shown(windowRows(LINES, anchor(17, 17)))).toEqual([
			" 14/15 f",
			" 15/. g",
			" 16/16 h",
			">./17 i",
		]);
	});

	it("marks every row of a multi-line range, deleted rows within it too", () => {
		expect(shown(windowRows(LINES, anchor(12, 15)))).toEqual([
			" 10/10 a",
			" 11/11 b",
			" 12/. c",
			">./12 C",
			">./13 D",
			">13/14 e",
			">14/15 f",
			" 15/. g",
			" 16/16 h",
			" ./17 i",
		]);
	});

	it("finds a deleted-side range by its old numbers", () => {
		expect(
			shown(
				windowRows(LINES, anchor(15, 15, { side: "LEFT", startSide: "LEFT" })),
			),
		).toEqual([
			" ./13 D",
			" 13/14 e",
			" 14/15 f",
			">15/. g",
			" 16/16 h",
			" ./17 i",
		]);
	});

	it("marks a range that starts on the old side and ends on the new", () => {
		expect(
			shown(windowRows(LINES, anchor(12, 13, { startSide: "LEFT" }))),
		).toEqual([
			" 10/10 a",
			" 11/11 b",
			">12/. c",
			">./12 C",
			">./13 D",
			" 13/14 e",
			" 14/15 f",
			" 15/. g",
		]);
	});

	it("gives nothing, never a guess, when either end of the range is missing", () => {
		expect(windowRows(LINES, anchor(99, 99))).toBeNull();
		// The end is there but the start isn't (before it).
		expect(windowRows(LINES, anchor(1, 12))).toBeNull();
		// A start after the end isn't found looking back from the end.
		expect(windowRows(LINES, anchor(16, 12, { startSide: "LEFT" }))).toBeNull();
	});
});

describe("hunkWindowRows (a host's own hunk)", () => {
	it("ends with the hunk: context before the range only", () => {
		const hunk = HUNK.split("\n").slice(0, 7).join("\n");
		expect(shown(hunkWindowRows(hunk, anchor(14, 14)))).toEqual([
			" 12/. c",
			" ./12 C",
			" ./13 D",
			">13/14 e",
		]);
	});

	it("marks the hunk's last line when the range's numbers aren't in it", () => {
		expect(shown(hunkWindowRows(HUNK, anchor(99, 99)))).toEqual([
			" 14/15 f",
			" 15/. g",
			" 16/16 h",
			">./17 i",
		]);
		// A start that isn't there: the end alone.
		expect(shown(hunkWindowRows(HUNK, anchor(1, 13)))).toEqual([
			" 11/11 b",
			" 12/. c",
			" ./12 C",
			">./13 D",
			" 13/14 e",
			" 14/15 f",
			" 15/. g",
		]);
	});

	it("is empty for a hunk it can't read", () => {
		expect(hunkWindowRows("garbage", anchor(1, 1))).toEqual([]);
		expect(hunkWindowRows("", anchor(1, 1))).toEqual([]);
	});
});
