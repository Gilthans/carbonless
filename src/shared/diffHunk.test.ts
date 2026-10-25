import { describe, expect, it } from "vitest";
import { parseDiffHunk } from "./diffHunk";

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
