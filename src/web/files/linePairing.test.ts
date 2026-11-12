import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bestCpuRatio } from "../../../test/cpu";
import {
	pairingCluster,
	pairingClusters,
} from "../../../test/pairing-fixtures";
import {
	ALIGN_CAP,
	ALIGN_CHARS,
	ALIGN_WORD_OPS,
	alignCluster,
	lineSimilarity,
	PAIR_MIN_SIMILARITY,
} from "./linePairing";
import { tokenize, WORD_DIFF_MAX } from "./wordDiff";

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
	const line = fc
		.array(word, { maxLength: 200, size: "max" })
		.map((t) => t.join(" "));
	it("carries between 32-token words (71 and 40 tokens)", () => {
		const a = Array.from({ length: 71 }, (_, i) => (i % 3 ? "a" : "b"));
		const b = Array.from({ length: 40 }, (_, i) => (i % 5 ? "b" : "a"));
		expect(lineSimilarity(a.join(" "), b.join(" "))).toBeCloseTo(62 / 111);
	});
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
	// The gallery's step 2 cases (test/fixtures/pairing, mirrored by
	// scripts/pairing-fixtures.mjs): each cluster of a case, git's own diff.
	it("case 1: list item added", () => {
		const { dels, adds } = pairingCluster("01-list-item.ts");
		expect(alignCluster(dels, adds)).toEqual([[0, 0]]);
	});
	it("case 2: comment above a change", () => {
		const { dels, adds } = pairingCluster("02-comment-above.ts");
		expect(alignCluster(dels, adds)).toEqual([[0, 1]]);
	});
	it("case 3: line removed from the middle", () => {
		const { dels, adds } = pairingCluster("03-removed-middle.ts");
		expect(alignCluster(dels, adds)).toEqual([
			[0, 0],
			[2, 1],
		]);
	});
	it("case 4: nothing similar", () => {
		const { dels, adds } = pairingCluster("04-nothing-similar.ts");
		expect(alignCluster(dels, adds)).toEqual([]);
	});
	it("case 5: helper above a renamed function", () => {
		const [helper, equal] = pairingClusters("05-helper-above.go");
		expect(helper?.dels).toHaveLength(1);
		expect(helper?.adds).toHaveLength(8);
		expect(alignCluster(helper?.dels ?? [], helper?.adds ?? [])).toEqual([
			[0, 7],
		]);
		// The signature and body of the renamed function: equal counts, so
		// hunkPairs pairs them by position and alignCluster agrees.
		expect(equal?.dels).toHaveLength(2);
		expect(equal?.adds).toHaveLength(2);
		expect(alignCluster(equal?.dels ?? [], equal?.adds ?? [])).toEqual([
			[0, 0],
			[1, 1],
		]);
	});
	it("case 6: Clear's old signature pairs with Touch's, past the new functions", () => {
		const clusters = pairingClusters("06-clear-touch.go");
		expect(clusters.map((c) => [c.dels.length, c.adds.length])).toEqual([
			[1, 15],
			[3, 5],
			[3, 1],
		]);
		const [first, second, third] = clusters.map((c) =>
			alignCluster(c.dels, c.adds),
		);
		// Clear's old signature pairs with Touch's (the 15th added line, the
		// same parameters), past GetFingerprint and SetFingerprint; the new
		// Clear is in the next cluster.
		expect(first).toEqual([[0, 14]]);
		expect(second).toEqual([
			[0, 0],
			[2, 4],
		]);
		expect(third).toEqual([[1, 0]]);
	});
	it("case 7: extract method pairs one partner per line, never crossing", () => {
		// What step 2 makes of it today; the line the extraction draws on two
		// old ones (the owner's example) is a later step.
		const { dels, adds } = pairingCluster("07-extract-method.ts");
		expect(dels).toHaveLength(8);
		expect(adds).toHaveLength(5);
		expect(alignCluster(dels, adds)).toEqual([
			[0, 0],
			[1, 1],
			[2, 2],
			[3, 3],
		]);
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
	// CPU budgets (CLAUDE.md: a ratio to a reference measured in the same
	// test, test/cpu.ts, never an absolute time). alignCluster is O(n*m)
	// scoring by design inside ALIGN_CAP, and a score is a bit-parallel token
	// LCS, about tokens*tokens/32 word steps, so no scaling check (4x the
	// input against a quarter) can read 1x: each reference below is of
	// comparable intended cost instead, and a cost beyond it shows as a
	// ratio that grows. Measured idle, and with a busy loop per core
	// (`pnpm flake-check ... --load 16`): the ratios in the comments.
	const LOADED = 60_000;
	/** `n` pseudo-random lines of `t` punctuation tokens (a token a character). */
	const marks = Array.from("()[]{};,=+-*/<>!&|");
	const punctuation = (n: number, t: number, seed: number) => {
		let state = seed;
		const next = () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state >>> 8;
		};
		return Array.from({ length: n }, () =>
			Array.from({ length: t }, () => marks[next() % marks.length]).join(""),
		);
	};
	/** `n` lines of `t` words, half of them shared with every other line. */
	const sharing = (side: string, n: number, t: number) =>
		Array.from({ length: n }, (_, i) =>
			Array.from({ length: t }, (_, k) =>
				k % 2 === 0
					? `w${(k * 7 + i) % 80}`
					: `${side}${(i * t + k).toString(36)}`,
			).join(" "),
		);
	const chars = (lines: readonly string[]) =>
		lines.reduce((sum, l) => sum + l.length, 0);

	it(
		"lineSimilarity of lines just inside WORD_DIFF_MAX costs about tokens x tokens/32",
		() => {
			// 1,000 tokens a side is 1,000 x 1,000/32 word steps; four pairs of
			// 500 tokens are 4 x 500 x 500/32, the same steps with twice the
			// tokens to scan. Measured 0.4-0.6x. A cost that grows faster than
			// the square of the tokens (a table per token, a pass per word)
			// would read far above 2.
			const [a, b] = punctuation(2, 1000, 1) as [string, string];
			const small = punctuation(8, 500, 2);
			const { best, ref, ratio } = bestCpuRatio(
				() => lineSimilarity(a, b),
				() => {
					for (let i = 0; i < small.length; i += 2)
						lineSimilarity(small[i] as string, small[i + 1] as string);
				},
			);
			console.info(
				`lineSimilarity 1000 tokens: ${best} µs, ${ratio.toFixed(2)}x four 500-token pairs (${ref} µs)`,
			);
			expect(ratio).toBeLessThan(2);
		},
		LOADED,
	);
	it(
		"lineSimilarity of lines past WORD_DIFF_MAX costs linear in their length",
		() => {
			// They score 0 after being tokenized: 4x the length against four
			// runs of the quarter, the same work in all (1.0-1.1x; quadratic
			// would read 4x).
			const [a, b] = punctuation(2, 100_000, 3) as [string, string];
			const quarter = punctuation(8, 25_000, 4);
			const { best, ref, ratio } = bestCpuRatio(
				() => expect(lineSimilarity(a, b)).toBe(0),
				() => {
					for (let i = 0; i < quarter.length; i += 2)
						lineSimilarity(quarter[i] as string, quarter[i + 1] as string);
				},
			);
			console.info(
				`lineSimilarity 100,000 chars: ${best} µs, ${ratio.toFixed(2)}x four of 25,000 (${ref} µs)`,
			);
			expect(ratio).toBeLessThan(2);
		},
		LOADED,
	);
	it(
		"alignCluster 50 x 50 lines of 192 tokens, just inside ALIGN_WORD_OPS, stays near its yardstick",
		() => {
			// The most expensive shape ALIGN_WORD_OPS lets through (about 20-40
			// ms): every pair of lines shares half its words, so all 2,500
			// scores run. The yardstick is the same 100 lines as 50 clusters
			// of one removed and one added line: the same characters tokenized
			// and the same cells, but 50 scores in place of 2,500. So the
			// ratio is what the other 2,450 scores add to the cost of reading
			// the lines (measured 1.5x idle), and an extra cost per cell or per
			// line pair beyond the score (a chain copied per cell, an index
			// walked per pair) grows it.
			const dels = sharing("d", 50, 192);
			const adds = sharing("a", 50, 192);
			expect(chars([...dels, ...adds])).toBeLessThanOrEqual(ALIGN_CHARS);
			expect(Math.max(...[...dels, ...adds].map((l) => l.length))).toBeLessThan(
				WORD_DIFF_MAX,
			);
			expect(50 * 6 * 50 * 192).toBeLessThanOrEqual(ALIGN_WORD_OPS);
			expect(alignCluster(dels, adds)).toEqual(
				Array.from({ length: 50 }, (_, i) => [i, i]),
			);
			const { best, ref, ratio } = bestCpuRatio(
				() => alignCluster(dels, adds),
				() => {
					dels.forEach((d, i) => {
						alignCluster([d], [adds[i] as string]);
					});
				},
			);
			console.info(
				`alignCluster 50x50 of 192 tokens: ${best} µs, ${ratio.toFixed(2)}x as 50 one-line clusters (${ref} µs)`,
			);
			expect(ratio).toBeLessThan(3);
		},
		LOADED,
	);
	it(
		"alignCluster 1 x 2,500 lines just inside ALIGN_CHARS costs what the same lines in 50 clusters do",
		() => {
			// Tokenizing the lines is most of it (about 20 ms). The yardstick is
			// the same removed line against the same added lines in 50 clusters
			// of 50: the same lines read and the same cells, and each cluster
			// keeps the removed line's table. Linear in the lines both ways, so
			// it reads about 1x (1.0-1.1); a cost per cell that grows with the
			// cluster's width (a row copied per cell) reads far above 2.
			const del = "w1 x2 y z q0 (3);";
			const adds = Array.from({ length: 2500 }, (_, i) =>
				`w${i % 7} x${i % 5} y z q${i % 3} (${i % 11}); // item ${i}`
					.padEnd(47, ".")
					.slice(0, 47),
			);
			expect(chars([del, ...adds])).toBeLessThanOrEqual(ALIGN_CHARS);
			expect(chars([del, ...adds])).toBeGreaterThan(ALIGN_CHARS * 0.9);
			expect(alignCluster([del], adds)).toHaveLength(1);
			const { best, ref, ratio } = bestCpuRatio(
				() => alignCluster([del], adds),
				() => {
					for (let k = 0; k < 50; k++)
						alignCluster([del], adds.slice(k * 50, k * 50 + 50));
				},
			);
			console.info(
				`alignCluster 1x2500: ${best} µs, ${ratio.toFixed(2)}x as 50 clusters of 1x50 (${ref} µs)`,
			);
			expect(ratio).toBeLessThan(2);
		},
		LOADED,
	);
	it(
		"alignCluster just over ALIGN_WORD_OPS costs about reading its lines, not scoring them",
		() => {
			// 50 x 50 lines of 1,021 tokens (51,050 characters a side): over the
			// word-step guard, so no pair is scored. Reading the lines is all it
			// costs: the yardstick is tokenizing each line once (measured 3.3x:
			// the code per token, the filters and the join come on top). Without
			// the guard these 2,500 scores are about 80 million word steps,
			// well over 100x.
			const wide = punctuation(50, 1021, 5);
			expect(alignCluster(wide, wide)).toEqual([]);
			const { best, ref, ratio } = bestCpuRatio(
				() => alignCluster(wide, wide),
				() => {
					for (const l of [...wide, ...wide]) tokenize(l);
				},
			);
			console.info(
				`alignCluster over ALIGN_WORD_OPS: ${best} µs, ${ratio.toFixed(2)}x tokenizing the lines (${ref} µs)`,
			);
			expect(ratio).toBeLessThan(8);
		},
		LOADED,
	);
	it(
		"alignCluster over ALIGN_CHARS costs less than reading its lines",
		() => {
			// 1 x 2,501 lines, 120,000 characters and more: the guard sums the
			// lengths and returns, so it costs less than tokenizing even once
			// (measured 0).
			const adds = punctuation(2501, 48, 6);
			expect(chars(adds)).toBeGreaterThan(ALIGN_CHARS);
			expect(alignCluster(["x"], adds)).toEqual([]);
			const { best, ref, ratio } = bestCpuRatio(
				() => alignCluster(["x"], adds),
				() => {
					for (const l of adds) tokenize(l);
				},
			);
			console.info(
				`alignCluster over ALIGN_CHARS: ${best} µs, ${ratio.toFixed(3)}x tokenizing the lines (${ref} µs)`,
			);
			expect(ratio).toBeLessThan(0.5);
		},
		LOADED,
	);
	it("a cluster just inside ALIGN_CHARS pairs, just over has none", () => {
		const pad = (n: number) => `x${" ".repeat(n - 1)}`;
		const dels = Array.from({ length: 119 }, () => pad(1000));
		const inside = [...dels, pad(1000)]; // 120 x 1000 chars: dels + 1 add
		expect(ALIGN_CHARS).toBe(120_000);
		expect(alignCluster(inside.slice(0, 119), inside.slice(119))).toEqual([
			[0, 0],
		]);
		expect(alignCluster(inside.slice(0, 119), [pad(1001)])).toEqual([]);
	});
	it("a cluster just inside ALIGN_WORD_OPS pairs, just over has none", () => {
		// 50 x 50 equal lines of t tokens: 50·⌈t/32⌉ · 50·t steps.
		const line = (t: number) => "(".repeat(t);
		const mk = (t: number) => Array.from({ length: 50 }, () => line(t));
		expect(ALIGN_WORD_OPS).toBe(3_000_000);
		expect(50 * 6 * 50 * 192).toBeLessThanOrEqual(ALIGN_WORD_OPS);
		expect(50 * 7 * 50 * 193).toBeGreaterThan(ALIGN_WORD_OPS);
		expect(alignCluster(mk(192), mk(192))).toEqual(
			Array.from({ length: 50 }, (_, i) => [i, i]),
		);
		expect(alignCluster(mk(193), mk(193))).toEqual([]);
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
