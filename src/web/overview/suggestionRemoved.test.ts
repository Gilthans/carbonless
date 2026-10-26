import { describe, expect, it } from "vitest";
import { codeFromHunk } from "../../../test/code-window";
import { suggestionRemoved } from "../threads/CommentBody";

const code = codeFromHunk("@@ -10,3 +10,3 @@\n a\n-b\n+B\n c", {
	startLine: 11,
	line: 12,
});

describe("suggestionRemoved", () => {
	it("deletes the thread's commented lines on its own side, numbered", () => {
		expect(suggestionRemoved(code, ["B", "c"])).toEqual([
			{ kind: "del", oldNo: 11, newNo: null, text: "B" },
			{ kind: "del", oldNo: 12, newNo: null, text: "c" },
		]);
	});

	it("takes GitHub's lines, unnumbered, when the thread has no code", () => {
		expect(suggestionRemoved(null, ["x"])).toEqual([
			{ kind: "del", oldNo: null, newNo: null, text: "x" },
		]);
	});

	it("refuses when GitHub's block replaces other lines than the thread's", () => {
		expect(suggestionRemoved(code, ["B"])).toBeNull();
		expect(suggestionRemoved(code, ["B", "C"])).toBeNull();
	});

	it("reads only the marked rows: context around the range isn't replaced", () => {
		const wide = codeFromHunk("@@ -10,5 +10,5 @@\n a\n b\n-c\n+C\n d\n e", {
			line: 12,
		});
		expect(wide.rows.length).toBeGreaterThan(1);
		expect(suggestionRemoved(wide, ["C"])).toEqual([
			{ kind: "del", oldNo: 12, newNo: null, text: "C" },
		]);
	});

	it("ignores a CR GitHub's HTML can't carry", () => {
		const crlf = codeFromHunk("@@ -10,2 +10,2 @@\n a\r\n+B\r", { line: 11 });
		expect(suggestionRemoved(crlf, ["B"])).toEqual([
			{ kind: "del", oldNo: 11, newNo: null, text: "B\r" },
		]);
	});
});
