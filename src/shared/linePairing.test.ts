import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { alikeAtLeast, lineSimilarity, similarityMemo } from "./linePairing";

/*
 * The tracer's helpers in linePairing (CAR-95 step 3); the pairing itself
 * is tested from the side-by-side view (src/web/files/linePairing.test.ts).
 */

const word = fc.constantFrom(
	"a",
	"b",
	"c",
	"d",
	"e",
	"f",
	"g",
	"h",
	"x1",
	"y_2",
);
const line = fc
	.array(word, { maxLength: 8 })
	.map((ws) => ws.join(" ( ").replace(/ \( $/u, ""));

describe("alikeAtLeast (CAR-95)", () => {
	it("finds exactly the lines a scan of every one finds, at every threshold", () => {
		fc.assert(
			fc.property(
				fc.array(line, { maxLength: 30 }),
				line,
				fc.constantFrom(0.5, 0.6, 0.75, 0.9, 1),
				(adds, old, min) => {
					const scan = adds.flatMap((a, j) =>
						/\w/u.test(a) && lineSimilarity(old, a) >= min ? [j] : [],
					);
					expect(alikeAtLeast(adds)(old, min)).toEqual(scan);
				},
			),
			{ numRuns: 500 },
		);
	});

	it("past its cap of candidates: null (too common to tell)", () => {
		const adds = Array.from({ length: 50 }, (_, i) => `call(items, x${i})`);
		const alike = alikeAtLeast(adds);
		expect(alike("call(items, x7)", 0.5, 10)).toBeNull();
		expect(alike("call(items, x7)", 0.5)).toHaveLength(50);
		// A rare word narrows the candidates: under the cap.
		expect(alike("call(items, x7)", 0.9, 10)).toEqual([7]);
	});
});

describe("similarityMemo (CAR-95)", () => {
	it("scores as lineSimilarity does", () => {
		fc.assert(
			fc.property(line, line, (a, b) => {
				const sim = similarityMemo();
				expect(sim(a, b)).toBe(lineSimilarity(a, b));
				expect(sim(a, b)).toBe(lineSimilarity(a, b));
			}),
		);
	});
});
