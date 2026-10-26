import { describe, expect, it } from "vitest";
import type { ReviewThread } from "../../shared/types";
import { filesPrefetchOrder } from "./filesPrefetch";

const t = (id: string, path: string, line: number | null): ReviewThread =>
	({
		id,
		path,
		anchor: line === null ? null : { line },
		unavailable: undefined,
	}) as unknown as ReviewThread;

describe("filesPrefetchOrder", () => {
	const files = [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }];
	const threads = [
		t("c1", "c.ts", 3),
		t("a2", "a.ts", 9),
		t("b1", "b.ts", 1),
		t("a1", "a.ts", 2),
		t("af", "a.ts", null),
		t("x", "not-shown.ts", 1),
	];

	it("goes in file order, each file's threads top down, its file comments first", () => {
		expect(filesPrefetchOrder(files, threads, null)).toEqual([
			"af",
			"a1",
			"a2",
			"b1",
			"c1",
		]);
	});

	it("puts the open file's threads first, then the other files in file order", () => {
		expect(filesPrefetchOrder(files, threads, 1)).toEqual([
			"b1",
			"af",
			"a1",
			"a2",
			"c1",
		]);
	});

	it("asks for no thread without an id or that will never come", () => {
		const gone = {
			...t("g", "a.ts", 1),
			unavailable: "deleted",
		} as ReviewThread;
		expect(
			filesPrefetchOrder(
				files,
				[t("", "a.ts", 1), gone, t("ok", "a.ts", 2)],
				null,
			),
		).toEqual(["ok"]);
	});
});

describe("filesPrefetchOrder with hunks", () => {
	it("orders LEFT and RIGHT threads by their new-side line", () => {
		const left = {
			id: "left",
			path: "a.ts",
			anchor: { side: "LEFT", line: 10 },
		} as unknown as ReviewThread;
		const right = {
			id: "right",
			path: "a.ts",
			anchor: { side: "RIGHT", line: 11 },
		} as unknown as ReviewThread;
		// Five lines added at the top: old 10 is new 15, below RIGHT 11.
		const hunks = {
			hunks: [
				{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 6, lines: [] },
			],
			newLineCount: 40,
		};
		expect(filesPrefetchOrder([{ path: "a.ts" }], [left, right], null)).toEqual(
			["left", "right"],
		);
		expect(
			filesPrefetchOrder([{ path: "a.ts" }], [left, right], null, () => hunks),
		).toEqual(["right", "left"]);
	});
});
