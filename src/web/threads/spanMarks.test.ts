import { describe, expect, it } from "vitest";
import type { CodeRow } from "../../shared/types";
import { spanMarks, withSpanMarks } from "./spanMarks";

const row = (
	kind: CodeRow["kind"],
	oldNo: number | null,
	newNo: number | null,
	text: string,
	marked = false,
): CodeRow => ({ kind, oldNo, newNo, text, marked });

describe("spanMarks", () => {
	const range = {
		startSide: "RIGHT" as const,
		startLine: 2,
		side: "RIGHT" as const,
		line: 3,
		startCol: 4,
		endCol: 2,
	};

	it("marks from the start column to the end column across rows", () => {
		expect(
			spanMarks(
				[row("add", null, 2, "abcdefg"), row("add", null, 3, "xyz")],
				range,
			),
		).toEqual([[[4, 7]], [[0, 2]]]);
	});

	it("is null (lines only) without columns, or when they don't fit the rows shown", () => {
		const rows = [row("add", null, 2, "abcdefg"), row("add", null, 3, "xyz")];
		expect(spanMarks(rows, { ...range, startCol: null })).toBeNull();
		expect(spanMarks(rows, { ...range, endCol: 9 })).toBeNull();
		expect(spanMarks(rows, { ...range, startLine: 1 })).toBeNull();
		expect(spanMarks([row("add", null, 3, "xyz")], range)).toBeNull();
		expect(
			spanMarks([row("add", null, 3, "xyz")], {
				...range,
				startLine: 3,
				startCol: 2,
				endCol: 2,
			}),
		).toBeNull();
	});

	it("reads LEFT ends by the old number", () => {
		expect(
			spanMarks([row("del", 5, null, "gone")], {
				startSide: "LEFT",
				startLine: 5,
				side: "LEFT",
				line: 5,
				startCol: 1,
				endCol: 3,
			}),
		).toEqual([[[1, 3]]]);
	});
});

describe("withSpanMarks (a thread's code window)", () => {
	const rows = [
		row("context", 1, 1, "before"),
		row("add", null, 2, "abcdefg", true),
		row("add", null, 3, "xyz", true),
		row("context", 3, 4, "after"),
	];
	const anchor = {
		startSide: "RIGHT" as const,
		startLine: 2,
		side: "RIGHT" as const,
		line: 3,
		startCol: 1,
		endCol: 2,
	};

	it("puts the marks on the marked rows only", () => {
		expect(withSpanMarks(rows, anchor).map((r) => r.marks)).toEqual([
			undefined,
			[[1, 7]],
			[[0, 2]],
			undefined,
		]);
	});

	it("leaves the rows as they are when the anchor has no columns or they don't fit", () => {
		expect(withSpanMarks(rows, { ...anchor, startCol: null })).toBe(rows);
		expect(withSpanMarks(rows, { ...anchor, endCol: 50 })).toBe(rows);
		expect(withSpanMarks(rows, null)).toBe(rows);
	});
});
