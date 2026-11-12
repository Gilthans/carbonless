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

describe("lineSimilarity against a plain token LCS", () => {
	const word = fc.constantFrom("a", "b", "c", "d", "e", "f");
	const line = fc.array(word, { maxLength: 90 }).map((t) => t.join(" "));
	it("property", () => {
		fc.assert(
			fc.property(line, line, (x, y) => {
				const a = x.split(" ").filter(Boolean);
				const b = y.split(" ").filter(Boolean);
				const dp = Array.from({ length: a.length + 1 }, () =>
					new Array<number>(b.length + 1).fill(0),
				);
				for (let i = 1; i <= a.length; i++)
					for (let j = 1; j <= b.length; j++)
						(dp[i] as number[])[j] =
							a[i - 1] === b[j - 1]
								? ((dp[i - 1] as number[])[j - 1] as number) + 1
								: Math.max(
										(dp[i - 1] as number[])[j] as number,
										(dp[i] as number[])[j - 1] as number,
									);
				const l = (dp[a.length] as number[])[b.length] as number;
				const total = a.length + b.length;
				const want = total === 0 ? 0 : (2 * l) / total;
				const got = lineSimilarity(x, y);
				// Below the pairing threshold a bound may cut the score to 0.
				if (want >= PAIR_MIN_SIMILARITY) expect(got).toBeCloseTo(want);
				else expect(got === 0 || Math.abs(got - want) < 1e-9).toBe(true);
			}),
		);
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
	it("ties with no position pair go to the earliest", () => {
		expect(alignCluster(["x"], ["a", "x", "x"])).toEqual([[0, 1]]);
		expect(alignCluster(["}", "}"], ["a", "b", "}"])).toEqual([[0, 2]]);
	});
	it("worst case inside the cap stays under 50 ms of CPU", () => {
		// 50 x 50 distinct ~800-character lines, each sharing half its tokens
		// with every line on the other side, so no cell is skipped.
		const mk = (side: string) =>
			Array.from({ length: 50 }, (_, i) =>
				Array.from({ length: 160 }, (_, k) =>
					k % 2 === 0 ? `w${(k * 7 + i) % 80}` : `${side}${i}_${k}`,
				).join(" "),
			);
		const dels = mk("d");
		const adds = mk("a");
		alignCluster(dels.slice(0, 5), adds.slice(0, 5)); // warm-up
		const before = process.threadCpuUsage();
		alignCluster(dels, adds);
		const spent = process.threadCpuUsage(before);
		expect((spent.user + spent.system) / 1000).toBeLessThan(50);
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
