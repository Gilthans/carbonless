import { describe, expect, it } from "vitest";
import type { FileView } from "../../../shared/types";
import type { Hit } from "./findInPr";
import {
	displayPath,
	headerPathMarks,
	nameMarks,
	oldNameMarks,
} from "./pathMarks";

const renamed = {
	index: 0,
	path: "src/save.ts",
	oldPath: "src/old/save.ts",
} as FileView;
const hit = (side: Hit["side"], col: number, index = 0): Hit => ({
	index,
	side,
	line: 0,
	col,
	len: 4,
});
const hits = [hit("path", 4), hit("oldPath", 8)];
const caret = { index: 0, side: "path" as const, line: 0, col: 4 };

describe("pathMarks", () => {
	it("shows a rename as old → new, else the path", () => {
		expect(displayPath(renamed)).toBe("src/old/save.ts → src/save.ts");
		expect(displayPath({ path: "a/b.ts" })).toBe("a/b.ts");
	});

	it("marks the header's display string, the caret's hit current", () => {
		expect(headerPathMarks(renamed, hits, caret)).toEqual([
			{ from: 8, to: 12, current: false },
			{ from: 22, to: 26, current: true },
		]);
	});

	it("marks a plain path's hits at their columns", () => {
		const plain = { index: 0, path: "src/save.ts" } as FileView;
		expect(headerPathMarks(plain, [hit("path", 4)], null)).toEqual([
			{ from: 4, to: 8, current: false },
		]);
	});

	it("ignores other files' hits and line hits", () => {
		expect(
			headerPathMarks(
				renamed,
				[hit("path", 4, 1), { ...hit("RIGHT", 2), line: 3 }],
				null,
			),
		).toEqual([]);
	});

	it("marks the name from the path hits inside it, relative to the name", () => {
		expect(nameMarks(renamed, hits, caret)).toEqual([
			{ from: 0, to: 4, current: true },
		]);
	});

	it("gives no name mark for a hit in a folder part", () => {
		expect(nameMarks(renamed, [hit("path", 0)], null)).toEqual([]);
	});

	it("marks a moved entry's old name from the oldPath hits inside it", () => {
		expect(oldNameMarks(renamed, hits, caret)).toEqual([
			{ from: 0, to: 4, current: false },
		]);
		expect(oldNameMarks(renamed, [hit("oldPath", 0)], null)).toEqual([]);
	});

	it("paints the caret on an old-path hit", () => {
		const c = { index: 0, side: "oldPath" as const, line: 0, col: 8 };
		expect(oldNameMarks(renamed, hits, c)).toEqual([
			{ from: 0, to: 4, current: true },
		]);
	});
});
