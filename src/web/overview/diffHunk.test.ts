import { describe, expect, it } from "vitest";
import { codeExcerpt, parseDiffHunk, type ThreadCode } from "./diffHunk";

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

const right = (
	startLine: number,
	endLine: number,
	extra: Partial<ThreadCode> = {},
): ThreadCode => ({
	diffHunk: HUNK,
	commit: "",
	side: "RIGHT",
	startSide: "RIGHT",
	startLine,
	endLine,
	...extra,
});

const shown = (code: ThreadCode, context?: number) =>
	codeExcerpt(code, context).lines.map(
		(l) =>
			`${l.marked ? ">" : " "}${l.oldNo ?? "."}/${l.newNo ?? "."} ${l.text}`,
	);

describe("parseDiffHunk", () => {
	it("numbers old and new lines from the header", () => {
		expect(parseDiffHunk(HUNK).slice(0, 5)).toEqual([
			{ kind: "context", oldNo: 10, newNo: 10, text: "a" },
			{ kind: "context", oldNo: 11, newNo: 11, text: "b" },
			{ kind: "del", oldNo: 12, newNo: null, text: "c" },
			{ kind: "add", oldNo: null, newNo: 12, text: "C" },
			{ kind: "add", oldNo: null, newNo: 13, text: "D" },
		]);
	});

	it("handles one-line headers, no-newline markers, and an empty context line", () => {
		const lines = parseDiffHunk(
			"@@ -0,0 +1 @@\n+x\n\\ No newline at end of file\n\n+y\n",
		);
		expect(lines).toEqual([
			{ kind: "add", oldNo: null, newNo: 1, text: "x", noNewline: true },
			{ kind: "context", oldNo: 0, newNo: 2, text: "" },
			{ kind: "add", oldNo: null, newNo: 3, text: "y" },
		]);
	});

	it("keeps CRs in the text: a CRLF ending and a lone CR stay visible", () => {
		const lines = parseDiffHunk("@@ -1,1 +1,2 @@ x\r\n a\r\n+b\rc");
		expect(lines).toEqual([
			{ kind: "context", oldNo: 1, newNo: 1, text: "a\r" },
			{ kind: "add", oldNo: null, newNo: 2, text: "b\rc" },
		]);
	});

	it("is empty without a header", () => {
		expect(parseDiffHunk("")).toEqual([]);
		expect(parseDiffHunk("+x\n-y")).toEqual([]);
	});
});

describe("codeExcerpt", () => {
	it("shows the last lines up to the commented one, marked", () => {
		expect(shown(right(16, 16))).toEqual([
			" ./12 C",
			" ./13 D",
			" 13/14 e",
			" 14/15 f",
			" 15/. g",
			">16/16 h",
		]);
	});

	it("ends at the commented line even when the hunk goes on", () => {
		expect(shown(right(13, 13), 3)).toEqual([" 12/. c", " ./12 C", ">./13 D"]);
	});

	it("marks a multi-line range and widens past the context to show it all", () => {
		expect(shown(right(11, 17), 3)).toEqual([
			">11/11 b",
			">12/. c",
			">./12 C",
			">./13 D",
			">13/14 e",
			">14/15 f",
			">15/. g",
			">16/16 h",
			">./17 i",
		]);
	});

	it("finds a deleted-side comment by its old number", () => {
		expect(
			shown(right(15, 15, { side: "LEFT", startSide: "LEFT" }), 2),
		).toEqual([" 14/15 f", ">15/. g"]);
	});

	it("marks a range that starts on the old side and ends on the new", () => {
		expect(shown(right(12, 13, { startSide: "LEFT" }), 2)).toEqual([
			">12/. c",
			">./12 C",
			">./13 D",
		]);
	});

	it("falls back to the hunk's last line when the numbers don't match", () => {
		expect(shown(right(99, 99), 2)).toEqual([" 16/16 h", ">./17 i"]);
		expect(shown(right(1, 17), 2)).toEqual([" 16/16 h", ">./17 i"]);
	});

	it("is empty for a hunk it can't read", () => {
		expect(codeExcerpt(right(1, 1, { diffHunk: "garbage" })).lines).toEqual([]);
	});
});
