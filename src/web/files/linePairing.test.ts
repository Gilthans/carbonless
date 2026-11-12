import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	ALIGN_CAP,
	alignCluster,
	lineSimilarity,
	PAIR_MIN_SIMILARITY,
} from "./linePairing";

// Case 5, verbatim from the spec's appendix.
const CASE5_OLD = [
	"// IsCacheSkippedForDomain reports whether planning requests for domain must bypass the cache entirely, per the",
];
const CASE5_NEW = [
	"// flagsOr lets a handler's own flags replace the process-wide ones, so tests can run in parallel.",
	"func flagsOr(flags *PlanningCacheFeatureFlags) PlanningCacheFeatureFlags {",
	"    if flags != nil {",
	"        return *flags",
	"    }",
	"    return GetFeatureFlags()",
	"}",
	"// SkipsCacheFor reports whether planning requests for domain must bypass the cache entirely, per the",
];

describe("lineSimilarity", () => {
	it("scores word tokens, ignoring whitespace", () => {
		expect(
			lineSimilarity("  const timeout = 30;", "  const timeout = 60;"),
		).toBeCloseTo(2 / 3);
		expect(lineSimilarity("sendEmail(user);", "queue.push(job);")).toBe(0);
		expect(lineSimilarity("  'beta'", "  'beta',")).toBe(1);
	});
	it("counts every token when a side has no word", () => {
		expect(lineSimilarity("}", "},")).toBeCloseTo(2 / 3);
		expect(lineSimilarity("}", "  return err")).toBe(0);
	});
	it("scores 0 for a line of WORD_DIFF_MAX characters", () => {
		expect(lineSimilarity("x".repeat(1024), "x".repeat(1024))).toBe(0);
	});
});

describe("alignCluster", () => {
	it("case 1: list item added", () => {
		expect(alignCluster(["  'beta'"], ["  'beta',", "  'gamma'"])).toEqual([
			[0, 0],
		]);
	});
	it("case 2: comment above a change", () => {
		expect(
			alignCluster(
				["  const timeout = 30;"],
				["  // seconds (API docs)", "  const timeout = 60;"],
			),
		).toEqual([[0, 1]]);
	});
	it("case 3: line removed from the middle", () => {
		expect(
			alignCluster(
				["retry(getUser, 3)", "log(msg)", "retry(getOrders, 3)"],
				["retry(getUser, 5)", "retry(getOrders, 5)"],
			),
		).toEqual([
			[0, 0],
			[2, 1],
		]);
	});
	it("case 4: nothing similar", () => {
		expect(
			alignCluster(
				["sendEmail(user);"],
				["queue.push(job);", "metrics.inc('jobs');"],
			),
		).toEqual([]);
	});
	it("case 5: helper above a renamed function", () => {
		expect(alignCluster(CASE5_OLD, CASE5_NEW)).toEqual([[0, 7]]);
	});
	it("ties keep position pairs, then the earliest", () => {
		expect(alignCluster(["}"], ["}", "}"])).toEqual([[0, 0]]);
		expect(alignCluster(["return err", "return err"], ["return err"])).toEqual([
			[0, 0],
		]);
	});
	it("pairs nothing above the cap", () => {
		const line = (i: number) => `same ${i}`;
		const mk = (n: number) => Array.from({ length: n }, (_, i) => line(i));
		expect(ALIGN_CAP).toBe(2500);
		expect(alignCluster(mk(51), mk(50))).toEqual([]);
		expect(alignCluster(mk(50), mk(50))).toEqual(
			Array.from({ length: 50 }, (_, i) => [i, i]),
		);
	});

	const vocab = fc.constantFrom("a", "b", "c", "d", "(", ")", ";", "=", " ");
	const lines = fc.array(
		fc.array(vocab, { minLength: 0, maxLength: 6 }).map((t) => t.join(" ")),
		{ maxLength: 7 },
	);
	it("property: increasing, allowed, one partner each", () => {
		fc.assert(
			fc.property(lines, lines, (dels, adds) => {
				const pairs = alignCluster(dels, adds);
				for (let k = 0; k < pairs.length; k++) {
					const [i, j] = pairs[k] as [number, number];
					expect(
						lineSimilarity(dels[i] as string, adds[j] as string),
					).toBeGreaterThanOrEqual(PAIR_MIN_SIMILARITY);
					if (k > 0) {
						const [pi, pj] = pairs[k - 1] as [number, number];
						expect(i).toBeGreaterThan(pi);
						expect(j).toBeGreaterThan(pj);
					}
				}
			}),
		);
	});
	it("property: equal sizes with every position pair allowed give the identity", () => {
		fc.assert(
			fc.property(lines, (dels) => {
				const adds = dels.map((l) => `${l} x`);
				const ok = dels.every(
					(l, i) => lineSimilarity(l, adds[i] as string) >= PAIR_MIN_SIMILARITY,
				);
				fc.pre(ok);
				expect(alignCluster(dels, adds)).toEqual(dels.map((_, i) => [i, i]));
			}),
		);
	});
});
