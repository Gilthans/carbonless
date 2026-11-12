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
		// Provisional: these exact pairs are pinned as a regression detector
		// until the owner's pass over the real-PR comparison; a different
		// answer from the owner changes them.
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
	// ratio that grows. The two scoring tests' references share no code
	// with the LCS (plainWordSteps), so swapping the LCS shows. Measured idle, and with a busy loop per core
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
	const chars = (lines: readonly string[]) =>
		lines.reduce((sum, l) => sum + l.length, 0);
	/**
	 * A yardstick that shares no code with the LCS: `steps` word steps (the
	 * unit ALIGN_WORD_OPS counts: an and, an add with carry, an or) in a
	 * plain loop, so replacing the LCS by another algorithm changes the
	 * cost under test and not the yardstick.
	 */
	const sink = new Uint32Array(1);
	const plainWordSteps = (steps: number) => {
		const v = new Uint32Array(6).fill(0xffffffff);
		const mask = Uint32Array.from(
			{ length: 6 },
			(_, i) => 0x9e3779b1 * (i + 1),
		);
		let carry = 0;
		for (let n = 0; n < steps; n += 6) {
			for (let w = 0; w < 6; w++) {
				const x = v[w] as number;
				const u = (x & (mask[w] as number)) >>> 0;
				const sum = x + u + carry;
				carry = sum > 0xffffffff ? 1 : 0;
				v[w] = (sum | (x & ~(mask[w] as number))) >>> 0;
			}
		}
		sink[0] = (sink[0] as number) ^ (v[0] as number) ^ carry;
	};

	it(
		"lineSimilarity of lines just inside WORD_DIFF_MAX costs about tokens x tokens/32",
		() => {
			// 1,000 tokens a side is 1,000 x 1,000/32 = 31,250 word steps. The
			// yardstick shares no code with the LCS: tokenizing both lines and
			// the same number of word steps in a plain loop (plainWordSteps),
			// so a correct implementation reads about 3x (the line
			// preparation and masks come on top). An LCS of another kind (a
			// plain table, 1,000,000 cells for 31,250 steps) reads about 39x,
			// one that grows faster than tokens x tokens/32 more.
			const [a, b] = punctuation(2, 1000, 1) as [string, string];
			const { best, ref, ratio } = bestCpuRatio(
				() => lineSimilarity(a, b),
				() => {
					tokenize(a);
					tokenize(b);
					plainWordSteps(31_250);
				},
			);
			console.info(
				`lineSimilarity 1000 tokens: ${best} µs, ${ratio.toFixed(2)}x tokenizing and 31,250 plain word steps (${ref} µs)`,
			);
			expect(ratio).toBeLessThan(8);
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
			// The most expensive shape ALIGN_WORD_OPS lets through: the lines
			// of 192 punctuation tokens share enough with every line on the
			// other side to pass score()'s bound, so all 2,500 scores run
			// their LCS (2.88 million word steps, ALIGN_WORD_OPS is 3
			// million). Lines that share too little skip the LCS and measure
			// nothing here. The yardstick shares no code with the LCS: the
			// 100 lines tokenized plus 2,880,000 word steps in a plain loop
			// (plainWordSteps), so a correct implementation reads about 3x
			// (the line preparation and masks come on top) and an LCS of
			// another kind, a plain table of 192 x 192 cells a pair, reads
			// about 55x. Extra work per cell or per pair on top shows too.
			const dels = punctuation(50, 192, 7);
			const adds = punctuation(50, 192, 8);
			expect(chars([...dels, ...adds])).toBeLessThanOrEqual(ALIGN_CHARS);
			expect(Math.max(...[...dels, ...adds].map((l) => l.length))).toBeLessThan(
				WORD_DIFF_MAX,
			);
			expect(50 * 6 * 50 * 192).toBeLessThanOrEqual(ALIGN_WORD_OPS);
			// Every pair clears the bound: the lines share most of their tokens.
			for (const d of dels.slice(0, 3))
				for (const a of adds.slice(0, 3))
					expect(lineSimilarity(d, a)).toBeGreaterThan(0.2);
			const { best, ref, ratio } = bestCpuRatio(
				() => alignCluster(dels, adds),
				() => {
					for (const l of [...dels, ...adds]) tokenize(l);
					plainWordSteps(50 * 6 * 50 * 192);
				},
			);
			console.info(
				`alignCluster 50x50 of 192 tokens: ${best} µs, ${ratio.toFixed(2)}x tokenizing and 2.88M plain word steps (${ref} µs)`,
			);
			expect(ratio).toBeLessThan(6);
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
			// cluster's width would read above 2. (Not mutation-tested: this
			// shape's cost is mostly reading the lines, scoring one removed
			// line against each added line.)
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
