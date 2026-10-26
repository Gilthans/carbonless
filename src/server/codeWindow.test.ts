import { describe, expect, it } from "vitest";
import { parseDiffHunk } from "../shared/diffHunk";
import type { CodeAnchor, CodeRow } from "../shared/types";
import { hunkWindowRows, snapshotOf, windowRows } from "./codeWindow";

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

describe("snapshotOf", () => {
	/** The PR's diff of the whole file: HUNK with three context rows above. */
	const FILE = parseDiffHunk(
		["@@ -7,10 +7,11 @@", " x", " y", " z", ...HUNK.split("\n").slice(1)].join(
			"\n",
		),
	);
	const host = (lines: string[]) => lines.join("\n");
	const SAME = host(["@@ -9,6 +9,7 @@", " z", " a", " b", "-c", "+C", "+D"]);
	const differs = { same: false, reason: "diff-differs" };

	it("is the same when the host's hunk is a run of the diff holding the range", () => {
		expect(snapshotOf(SAME, FILE, anchor(12, 13))).toEqual({ same: true });
		// From the file's first row, with a trailing newline.
		expect(snapshotOf("@@ -7,2 +7,2 @@\n x\n y\n", FILE, anchor(8, 8))).toEqual(
			{ same: true },
		);
		// A deleted line, by its old number.
		expect(
			snapshotOf(
				host(["@@ -11,2 +11,1 @@", " b", "-c"]),
				FILE,
				anchor(12, 12, { side: "LEFT", startSide: "LEFT" }),
			),
		).toEqual({ same: true });
	});

	it("can't vouch for code with no host hunk", () => {
		const none = { same: false, reason: "no-host-diff" };
		expect(snapshotOf("", FILE, anchor(13, 13))).toEqual(none);
		expect(snapshotOf("@@ -9,6 +9,7 @@\n", FILE, anchor(13, 13))).toEqual(none);
		expect(snapshotOf("garbage", FILE, anchor(13, 13))).toEqual(none);
	});

	it("flags another old side", () => {
		expect(
			snapshotOf(
				host(["@@ -9,6 +9,7 @@", " z", " a", " b", "-c earlier", "+C", "+D"]),
				FILE,
				anchor(13, 13),
			),
		).toEqual(differs);
	});

	it("flags lines changed in one diff but context in the other", () => {
		// The host had b as added: a diff against an older commit of the PR.
		expect(
			snapshotOf(
				host(["@@ -9,5 +9,7 @@", " z", " a", "+b", "-c", "+C", "+D"]),
				FILE,
				anchor(13, 13),
			),
		).toEqual(differs);
		// And the other way: the host shows as context what the diff changes.
		expect(
			snapshotOf(
				host(["@@ -9,4 +9,4 @@", " z", " a", " b", " C"]),
				FILE,
				anchor(12, 12),
			),
		).toEqual(differs);
	});

	it("flags other line numbers", () => {
		expect(
			snapshotOf(
				host(["@@ -19,6 +19,7 @@", " z", " a", " b", "-c", "+C", "+D"]),
				FILE,
				anchor(23, 23),
			),
		).toEqual(differs);
		// Off by one on the old side only.
		expect(
			snapshotOf(
				host(["@@ -10,6 +9,7 @@", " z", " a", " b", "-c", "+C", "+D"]),
				FILE,
				anchor(13, 13),
			),
		).toEqual(differs);
	});

	it("flags a host hunk that doesn't hold both ends of the range", () => {
		// The range's end is past the hunk.
		expect(snapshotOf(SAME, FILE, anchor(13, 15))).toEqual(differs);
		// Its start is above the hunk.
		expect(snapshotOf(SAME, FILE, anchor(8, 13))).toEqual(differs);
	});

	it("takes a last line without a newline as the same when the host's hunk stops before the marker", () => {
		// The file's diff: its last line, added, has no newline at the end.
		const eof = parseDiffHunk(
			"@@ -1,2 +1,2 @@\n a\n-b\n+B\n\\ No newline at end of file",
		);
		expect(eof.at(-1)?.noNewline).toBe(true);
		// GitHub's hunk ends at the commented line, before the marker.
		expect(
			snapshotOf("@@ -1,2 +1,2 @@\n a\n-b\n+B", eof, anchor(2, 2)),
		).toEqual({ same: true });
		// With the marker, too.
		expect(
			snapshotOf(
				"@@ -1,2 +1,2 @@\n a\n-b\n+B\n\\ No newline at end of file",
				eof,
				anchor(2, 2),
			),
		).toEqual({ same: true });
		// Only on the host's last row: a marker left out above it differs.
		const oldEof = parseDiffHunk(
			"@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file",
		);
		expect(
			snapshotOf("@@ -1,2 +1,2 @@\n a\n-b\n+B", oldEof, anchor(2, 2)),
		).toEqual({ same: false, reason: "diff-differs" });
	});

	it("compares CRLF lines as their text, a CR kept on either side or both", () => {
		const crlf = parseDiffHunk("@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r");
		const range = anchor(2, 2);
		// GitHub keeps the CRs, as git does.
		expect(
			snapshotOf("@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r", crlf, range),
		).toEqual({ same: true });
		// One side without them is the same text.
		expect(snapshotOf("@@ -1,2 +1,2 @@\n a\n-b\n+B", crlf, range)).toEqual({
			same: true,
		});
		// Other text still differs.
		expect(
			snapshotOf("@@ -1,2 +1,2 @@\n a\r\n-b\r\n+X\r", crlf, range),
		).toEqual({ same: false, reason: "diff-differs" });
	});

	it("flags a hunk that runs past the diff's end, or another end of file", () => {
		expect(
			snapshotOf(
				host(["@@ -16,1 +16,3 @@", " h", "+i", "+j"]),
				FILE,
				anchor(17, 18),
			),
		).toEqual(differs);
		expect(
			snapshotOf(
				host(["@@ -16,1 +16,2 @@", " h", "+i", "\\ No newline at end of file"]),
				FILE,
				anchor(17, 17),
			),
		).toEqual(differs);
	});
});
