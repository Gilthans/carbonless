import { describe, expect, it } from "vitest";
import { boxesOf, type LineBox, placeAt, yOfLine } from "./keepPlace";

const row = (top: number, line: number, height = 20): LineBox => ({
	top,
	height,
	from: line,
	to: line,
});
const block = (top: number, from: number, to: number, height: number) => ({
	top,
	height,
	from,
	to,
});

describe("placeAt", () => {
	it("is nothing while the view starts below the stack: the reader is at the file's start", () => {
		expect(placeAt([row(200, 1), row(220, 2)], 100)).toBeNull();
		expect(placeAt([], 100)).toBeNull();
	});

	it("is the first row reaching below the stack, at its top", () => {
		const rows = [row(0, 1), row(20, 2), row(40, 3), row(60, 4)];
		expect(placeAt(rows, 45)).toEqual({ line: 3, y: 40 });
	});

	it("inside a block, the line that far down it", () => {
		// Lines 10-19 over 200px: 20px a line; the stack at 150 is 100px in.
		const boxes = [block(50, 10, 19, 200), block(250, 21, 21, 40)];
		expect(placeAt(boxes, 150)).toEqual({ line: 15, y: 150 });
		expect(placeAt(boxes, 155)).toEqual({ line: 15, y: 150 });
	});

	it("is the next row that shows lines when the stack is past the last", () => {
		expect(placeAt([row(0, 1)], 500)).toBeNull();
	});
});

describe("yOfLine", () => {
	it("is the row showing the line, or its share of a block", () => {
		expect(yOfLine([row(0, 1), row(20, 2)], 2)).toBe(20);
		expect(yOfLine([block(100, 10, 19, 200)], 15)).toBe(200);
	});

	it("a line folded away: the first box after it, else the end of the last before it", () => {
		const rows = [row(0, 1), row(20, 2), row(60, 30)];
		expect(yOfLine(rows, 10)).toBe(60);
		expect(yOfLine(rows, 40)).toBe(80);
	});

	it("is nothing for a view with no lines (an image)", () => {
		expect(yOfLine([], 3)).toBeNull();
	});

	it("round-trips: Rendered's place found again in Text keeps the line's y", () => {
		const rendered = [block(-300, 1, 9, 200), block(-100, 10, 19, 400)];
		const place = placeAt(rendered, 60);
		expect(place).toEqual({ line: 14, y: 60 });
		const text = Array.from({ length: 30 }, (_, i) =>
			row(-500 + i * 20, i + 1),
		);
		const y = yOfLine(text, place?.line ?? 0);
		expect(y).toBe(-240);
	});
});

describe("boxesOf", () => {
	it("joins removed rows to the new line after them; drops what isn't drawn", () => {
		expect(
			boxesOf([
				{ top: 0, height: 20, from: 1 },
				{ top: 20, height: 20 },
				{ top: 40, height: 20 },
				{ top: 60, height: 20, from: 2 },
				{ top: 80, height: 0, from: 3 },
				{ top: 80, height: 100, from: 4, to: 9 },
				{ top: 180, height: 20 },
			]),
		).toEqual([
			{ top: 0, height: 20, from: 1, to: 1 },
			{ top: 20, height: 60, from: 2, to: 2 },
			{ top: 80, height: 100, from: 4, to: 9 },
		]);
	});
});
