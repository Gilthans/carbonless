import { describe, expect, it } from "vitest";
import { suggestionRemoved } from "./OverviewPage";

const code = {
	diffHunk: "@@ -10,3 +10,3 @@\n a\n-b\n+B\n c",
	commit: "",
	side: "RIGHT" as const,
	startSide: "RIGHT" as const,
	startLine: 11,
	endLine: 12,
};

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

	it("ignores a CR GitHub's HTML can't carry", () => {
		const crlf = { ...code, diffHunk: "@@ -10,2 +10,2 @@\n a\r\n+B\r" };
		expect(
			suggestionRemoved({ ...crlf, startLine: 11, endLine: 11 }, ["B"]),
		).toEqual([{ kind: "del", oldNo: 11, newNo: null, text: "B\r" }]);
	});
});
