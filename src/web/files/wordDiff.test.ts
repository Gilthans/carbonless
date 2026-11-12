import DiffMatchPatch from "diff-match-patch";
import { describe, expect, it } from "vitest";
import type { Mark } from "../code/Invisibles";
import { tokenize, tokenMarks, WORD_DIFF_MAX, wordMarks } from "./wordDiff";

/** A small seeded PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The text outside the marks. */
const unmarked = (text: string, marks: readonly Mark[]): string => {
	let out = "";
	let at = 0;
	for (const [from, to] of marks) {
		out += text.slice(at, from);
		at = to;
	}
	return out + text.slice(at);
};

/** Token start offsets, plus the end. */
const boundaries = (text: string): Set<number> => {
	const set = new Set<number>([0]);
	let at = 0;
	for (const t of tokenize(text)) {
		at += t.length;
		set.add(at);
	}
	return set;
};

describe("tokenize", () => {
	it("keeps word runs whole and splits every other code point", () => {
		expect(tokenize("café_1 + x👍")).toEqual([
			"café_1",
			" ",
			"+",
			" ",
			"x",
			"👍",
		]);
	});

	it("keeps combining marks in their word", () => {
		expect(tokenize("e\u0301t")).toEqual(["e\u0301t"]);
		expect(tokenize("ét")).toEqual(["ét"]);
	});

	it("splits each space and punctuation mark apart", () => {
		expect(tokenize("  a=>b")).toEqual([" ", " ", "a", "=", ">", "b"]);
		expect(tokenize("")).toEqual([]);
	});
});

describe("wordMarks", () => {
	it("case 06: marks only the changed spaces, never the unchanged `width`", () => {
		// Owner QA of PR #13 (gallery #14, case 06): only whitespace changed around `=` and `*`.
		const a = "const area = width * height + margin;";
		const b = "const area  =  width*height + margin;";
		const marks = wordMarks(a, b);
		// Old: the spaces either side of `*` went. New: one space each side of
		// `=` came (placed after the kept one, as diff-match-patch does).
		expect(marks).toEqual({
			old: [
				[18, 19],
				[20, 21],
			],
			new: [
				[11, 12],
				[14, 15],
			],
		});
		const widthAt = (text: string) => [
			text.indexOf("width"),
			text.indexOf("width") + 5,
		];
		for (const [text, ranges] of [
			[a, marks.old],
			[b, marks.new],
		] as const) {
			const [from, to] = widthAt(text) as [number, number];
			for (const [f, t] of ranges) expect(t <= from || f >= to).toBe(true);
			// Every mark is whitespace only.
			for (const [f, t] of ranges) expect(text.slice(f, t).trim()).toBe("");
		}
	});

	it("case 13: marks each changed quote and the `;` on its own, never the words between", () => {
		// Owner QA of PR #13 (gallery #14, case 13), 2026-11-04: punctuation marked
		// separately, not folded into one mark with the words.
		const a = "const items = ['alpha', 'beta', 'gamma'];";
		const b = 'const items = ["alpha", "beta", "gamma"],';
		const quotes: [number, number][] = [
			[15, 16],
			[21, 22],
			[24, 25],
			[29, 30],
			[32, 33],
			[38, 39],
			[40, 41],
		];
		expect(wordMarks(a, b)).toEqual({ old: quotes, new: quotes });
	});

	it("bridges the spaces between two changes: one mark per side", () => {
		// Owner, 2026-11-04: "Merge the spaces between two changes into one.
		// That makes sense."
		expect(wordMarks("a b c d", "w x y z")).toEqual({
			old: [[0, 7]],
			new: [[0, 7]],
		});
	});

	it("bridges a tab run and a mixed space/tab run between two changes", () => {
		expect(wordMarks("a\t\tb", "x\t\ty")).toEqual({
			old: [[0, 4]],
			new: [[0, 4]],
		});
		expect(wordMarks("a \t b;", "x \t y;")).toEqual({
			old: [[0, 5]],
			new: [[0, 5]],
		});
	});

	it("never bridges a word, a digit run or punctuation between two changes", () => {
		expect(wordMarks("foo(a, b)", "bar(a, c)")).toEqual({
			old: [
				[0, 3],
				[7, 8],
			],
			new: [
				[0, 3],
				[7, 8],
			],
		});
		expect(wordMarks("x a y", "z a w")).toEqual({
			old: [
				[0, 1],
				[4, 5],
			],
			new: [
				[0, 1],
				[4, 5],
			],
		});
		expect(wordMarks("x 42 y", "z 42 w")).toEqual({
			old: [
				[0, 1],
				[5, 6],
			],
			new: [
				[0, 1],
				[5, 6],
			],
		});
		expect(wordMarks("x , y", "z , w")).toEqual({
			old: [
				[0, 1],
				[4, 5],
			],
			new: [
				[0, 1],
				[4, 5],
			],
		});
	});

	it("bridges only spaces and tabs: other whitespace keeps two changes apart", () => {
		// No-break, ideographic and zero-width no-break spaces draw as
		// \uXXXX escapes; a mid-line \r, \v, \f and U+2028 are not plain blanks.
		const two = {
			old: [
				[0, 1],
				[2, 3],
			],
			new: [
				[0, 1],
				[2, 3],
			],
		};
		for (const sep of [
			"\u00a0",
			"\u3000",
			"\ufeff",
			"\r",
			"\v",
			"\f",
			"\u2028",
		]) {
			expect({ sep, marks: wordMarks(`a${sep}b`, `x${sep}y`) }).toEqual({
				sep,
				marks: two,
			});
		}
	});

	it("never bridges whitespace next to only one change", () => {
		expect(wordMarks("a  ", "b  ")).toEqual({ old: [[0, 1]], new: [[0, 1]] });
		expect(wordMarks("  a b", "  x y")).toEqual({
			old: [[2, 5]],
			new: [[2, 5]],
		});
		expect(wordMarks("a b \t", "x y \t")).toEqual({
			old: [[0, 3]],
			new: [[0, 3]],
		});
		expect(wordMarks("a b c", "a b")).toEqual({ old: [[3, 5]], new: [] });
	});

	it("marks a renamed identifier as one token", () => {
		expect(wordMarks("const userCount = 1;", "const memberCount = 1;")).toEqual(
			{ old: [[6, 15]], new: [[6, 17]] },
		);
	});

	it("leaves equal lines and a \\r both lines end in alone", () => {
		expect(wordMarks("abc", "abc")).toEqual({ old: [], new: [] });
		expect(wordMarks("a\r", "a\r")).toEqual({ old: [], new: [] });
		const { old, new: young } = wordMarks("a b\r", "a c\r");
		expect(old).toEqual([[2, 3]]);
		expect(young).toEqual([[2, 3]]);
	});

	it("case 22: marks a trailing \\r only one line has", () => {
		// Owner QA of PR #13 (gallery #14, case 22), 2026-11-04: "it's very confusing to see
		// there's a diff despite having nothing visibly change. Also, when
		// hidden characters are shown, the \\r is not highlighted - it should be."
		const a = "const eol = detectLineEnding(text);";
		const b = "const eol = detectLineEnding(text);\r";
		expect(wordMarks(a, b)).toEqual({ old: [], new: [[35, 36]] });
		expect(wordMarks(b, a)).toEqual({ old: [[35, 36]], new: [] });
		expect(wordMarks("a\r", "b")).toEqual({ old: [[0, 2]], new: [[0, 1]] });
	});

	it("marks the whole other line when one side is empty", () => {
		expect(wordMarks("", "x y")).toEqual({ old: [], new: [[0, 3]] });
		expect(wordMarks("x y", "")).toEqual({ old: [[0, 3]], new: [] });
		expect(wordMarks("", "")).toEqual({ old: [], new: [] });
	});

	it("leaves a pair plain from 1,024 characters on", () => {
		expect(WORD_DIFF_MAX).toBe(1024);
		const none = { old: [], new: [] };
		expect(wordMarks("a".repeat(1024), "b")).toEqual(none);
		expect(wordMarks("b", "a".repeat(1024))).toEqual(none);
		expect(wordMarks("a".repeat(1023), "b")).toEqual({
			old: [[0, 1023]],
			new: [[0, 1]],
		});
	});

	it("never splits a surrogate pair or a combining mark", () => {
		expect(wordMarks("ok 👍", "ok 👎")).toEqual({
			old: [[3, 5]],
			new: [[3, 5]],
		});
		expect(wordMarks("cafe\u0301 x", "cafe\u0301 y")).toEqual({
			old: [[6, 7]],
			new: [[6, 7]],
		});
	});

	it("before bridging, is exactly a token diff, for any pair (500 seeded pairs)", () => {
		const alphabet = ["a", "b", "c", " ", "_", ".", "é", "👍", "\t", "1"];
		const random = rng(20261102);
		const line = () => {
			let s = "";
			const n = Math.floor(random() * 24);
			for (let i = 0; i < n; i++) {
				s += alphabet[Math.floor(random() * alphabet.length)];
			}
			return random() < 0.1 ? `${s}\r` : s;
		};
		for (let k = 0; k < 500; k++) {
			const a = line();
			const b = line();
			const { old, new: young } = tokenMarks(a, b);
			// A \r both lines end in is never marked; one only one has is a token.
			const both = a.endsWith("\r") && b.endsWith("\r");
			const strip = (s: string) => (both ? s.slice(0, -1) : s);
			for (const [text, marks] of [
				[a, old],
				[b, young],
			] as const) {
				const edges = boundaries(text);
				let last = -1;
				for (const [from, to] of marks) {
					expect(from).toBeGreaterThan(last); // sorted, apart (merged)
					expect(to).toBeGreaterThan(from);
					expect(to).toBeLessThanOrEqual(strip(text).length);
					expect(edges.has(from) && edges.has(to)).toBe(true);
					last = to;
				}
			}
			expect(unmarked(strip(a), old)).toBe(unmarked(strip(b), young));
			if (strip(a) === strip(b))
				expect({ old, young }).toEqual({ old: [], young: [] });
		}
	});

	it("before bridging, never marks a token the diff keeps: shared words first, then spaces (1,000 seeded pairs)", () => {
		// Words first: the non-whitespace tokens left unmarked are a longest
		// common subsequence of the two lines' non-whitespace tokens (no shared
		// word is traded for a space). Then nothing folds: between two kept
		// words, the kept tokens are a longest common subsequence of that gap.
		const blank = (t: string) => /^\s$/u.test(t);
		const lcs = (xs: readonly string[], ys: readonly string[]) => {
			let prev = new Array<number>(ys.length + 1).fill(0);
			for (const x of xs) {
				const row = [0];
				ys.forEach((y, j) => {
					row.push(
						x === y
							? (prev[j] as number) + 1
							: Math.max(prev[j + 1] as number, row[j] as number),
					);
				});
				prev = row;
			}
			return prev[ys.length] as number;
		};
		/** Each token with whether it is marked. */
		const tokens = (text: string, marks: readonly Mark[], both: boolean) => {
			let at = 0;
			return tokenize(both ? text.slice(0, -1) : text).map((t) => {
				const marked = marks.some(([f, to]) => at >= f && at < to);
				at += t.length;
				return { t, marked };
			});
		};
		/** The tokens between kept words: gap i is before kept word i. */
		const gaps = (ts: { t: string; marked: boolean }[]) => {
			const out: { t: string; marked: boolean }[][] = [[]];
			for (const x of ts) {
				if (!x.marked && !blank(x.t)) out.push([]);
				else out[out.length - 1]?.push(x);
			}
			return out;
		};
		// Whitespace runs, an emoji (a surrogate pair) and both forms of `é`
		// among the words; a step may add only its separator, so a line can
		// be whitespace only.
		const words = ["width", "x", "a", "b", "=", "*", "(", ")", ";", "'"].concat(
			["  ", "\t", "😀", "é", "e\u0301"],
		);
		const random = rng(20261104);
		const line = () => {
			let s = "";
			const n = Math.floor(random() * 16);
			for (let i = 0; i < n; i++) {
				const r = random();
				s += r < 0.35 ? (r < 0.05 ? "\t" : " ") : "";
				if (r < 0.1) continue;
				s += words[Math.floor(random() * words.length)];
			}
			return random() < 0.1 ? `${s}\r` : s;
		};
		for (let k = 0; k < 1000; k++) {
			const a = line();
			const b = line();
			const { old, new: young } = tokenMarks(a, b);
			const both = a.endsWith("\r") && b.endsWith("\r");
			const ta = tokens(a, old, both);
			const tb = tokens(b, young, both);
			const keptWords = (ts: typeof ta) =>
				ts.filter((x) => !x.marked && !blank(x.t)).map((x) => x.t);
			const ka = keptWords(ta);
			expect({ a, b, kept: ka }).toEqual({ a, b, kept: keptWords(tb) });
			expect({ a, b, words: ka.length }).toEqual({
				a,
				b,
				words: lcs(
					ta.filter((x) => !blank(x.t)).map((x) => x.t),
					tb.filter((x) => !blank(x.t)).map((x) => x.t),
				),
			});
			const ga = gaps(ta);
			const gb = gaps(tb);
			ga.forEach((gap, i) => {
				const other = gb[i] ?? [];
				const kept = (g: typeof gap) =>
					g.filter((x) => !x.marked).map((x) => x.t);
				expect({ a, b, i, kept: kept(gap) }).toEqual({
					a,
					b,
					i,
					kept: kept(other),
				});
				expect({ a, b, i, length: kept(gap).length }).toEqual({
					a,
					b,
					i,
					length: lcs(
						gap.map((x) => x.t),
						other.map((x) => x.t),
					),
				});
			});
		}
	});

	it("bridges exactly the whitespace runs between two changes, nothing else (1,000 seeded pairs)", () => {
		// Owner, 2026-11-04: "Merge the spaces between two changes into one."
		// Oracle, per side: the token diff's marks (tokenMarks), plus every run
		// of unmarked tokens that are all spaces or tabs with a marked token right
		// before and right after it. So an unchanged word, digit run or
		// punctuation token is never inside a mark, and the kept words are
		// still a longest common subsequence (the test above).
		const blank = (t: string) => t === " " || t === "\t";
		const flags = (ts: string[], marks: readonly Mark[]) => {
			let at = 0;
			return ts.map((t) => {
				const marked = marks.some(([f, to]) => at >= f && at < to);
				at += t.length;
				return marked;
			});
		};
		const words = ["width", "x", "a", "42", "=", "*", "(", ")", ";", "'"];
		words.push("  ", "\t", " \t", "😀", "é", "e\u0301", "\u00a0", "\u3000");
		const random = rng(20261105);
		const line = () => {
			let s = "";
			const n = Math.floor(random() * 16);
			for (let i = 0; i < n; i++) {
				const r = random();
				s += r < 0.35 ? (r < 0.05 ? "\t" : " ") : "";
				if (r < 0.1) continue;
				s += words[Math.floor(random() * words.length)];
			}
			return random() < 0.1 ? `${s}\r` : s;
		};
		let bridged = 0;
		for (let k = 0; k < 1000; k++) {
			const a = line();
			const b = line();
			const both = a.endsWith("\r") && b.endsWith("\r");
			const raw = tokenMarks(a, b);
			const got = wordMarks(a, b);
			for (const [text, rawMarks, marks] of [
				[a, raw.old, got.old],
				[b, raw.new, got.new],
			] as const) {
				const body = both ? text.slice(0, -1) : text;
				const edges = boundaries(text);
				let last = -1;
				for (const [from, to] of marks) {
					expect(from).toBeGreaterThan(last); // sorted, apart (merged)
					expect(to).toBeGreaterThan(from);
					expect(to).toBeLessThanOrEqual(body.length);
					expect(edges.has(from) && edges.has(to)).toBe(true);
					last = to;
				}
				const ts = tokenize(body);
				const before = flags(ts, rawMarks);
				const expected = [...before];
				for (let i = 0; i < ts.length; ) {
					if (before[i] || !blank(ts[i] as string)) {
						i++;
						continue;
					}
					let e = i;
					while (e < ts.length && !before[e] && blank(ts[e] as string)) e++;
					if (i > 0 && before[i - 1] && e < ts.length && before[e]) {
						expected.fill(true, i, e);
						bridged++;
					}
					i = e;
				}
				const after = flags(ts, marks);
				expect({ text, after }).toEqual({ text, after: expected });
				ts.forEach((t, i) => {
					if (!blank(t))
						expect({ text, i, after: after[i] }).toEqual({
							text,
							i,
							after: before[i],
						});
				});
			}
		}
		// The seeds do reach the rule.
		expect(bridged).toBeGreaterThan(100);
	});

	/** Code-like 120-character lines: 400 identifiers, keywords, numbers, operators. */
	const codeLines = (seed: number) => {
		const random = rng(seed);
		const pick = <T>(xs: readonly T[]): T =>
			xs[Math.floor(random() * xs.length)] as T;
		const parts = ["get", "set", "user", "count", "total", "item", "map", "id"]
			.concat(["name", "value", "list", "index", "key", "data", "node"])
			.concat(["line", "file", "path", "diff", "row"]);
		const idents = parts.flatMap((a) =>
			parts.map((b) => `${a}${b[0]?.toUpperCase()}${b.slice(1)}`),
		);
		const words = [...idents, "const", "return", "if", "await", "42", "0"];
		const seps = [" ", ".", "(", ")", ", ", " = ", "; ", " + ", " => ", "["];
		const line = () => {
			let s = "";
			while (s.length < 120) s += pick(words) + pick(seps);
			return s.slice(0, 120);
		};
		/** The line with about 10% of its tokens changed. */
		const edit = (text: string) =>
			tokenize(text)
				.map((t) => (random() < 0.1 ? pick(words) : t))
				.join("")
				.slice(0, 120);
		return { line, edit };
	};

	/**
	 * The budget tests' wall-clock timeout: they gate CPU time, not wall
	 * time. The unrelated test spends about 2 s of CPU (six rounds of
	 * wordMarks and the yardstick, the warm-up included), and a loaded
	 * machine (load 40 on 4 cores) stretches CPU time about 10x in wall
	 * time: 20 s, so 60 s leaves room.
	 */
	const LOADED = 60_000;

	type Pairs = readonly (readonly [string, string])[];

	/** About 10% of each line's tokens changed (an equal block of edited lines). */
	const similarPairs = (): Pairs => {
		const { line, edit } = codeLines(7);
		return Array.from({ length: 2000 }, () => {
			const a = line();
			return [a, edit(a)] as const;
		});
	};

	/**
	 * The yardstick: diff-match-patch's own character diff of the similar
	 * pairs. Its cost moves with the machine (runner speed, load, a busy
	 * sibling core) the same way wordMarks' does, so the ratio of the two
	 * holds much stiller than the absolute time: 0.58–0.64 (similar) and
	 * 1.51–1.58 (unrelated) on a dev machine both idle and with a busy loop
	 * per core, 0.64–0.86 and 1.63–1.84 in three CI runs (another CPU),
	 * while CI's absolute time for the similar pairs ranged 36–100 ms
	 * (CAR-115).
	 */
	const reference = new DiffMatchPatch();
	reference.Diff_Timeout = 0;
	const referencePairs = similarPairs();

	const cpu = (run: () => void) => {
		const before = process.threadCpuUsage();
		run();
		const spent = process.threadCpuUsage(before);
		return spent.user + spent.system;
	};

	/**
	 * CPU µs of marking every pair and of the yardstick, after a warm-up:
	 * each the best of five rounds (load only adds time), the two taken in
	 * turn so they see the same load.
	 */
	const bestCpu = (pairs: Pairs) => {
		const marks = () => {
			for (const [a, b] of pairs) wordMarks(a, b);
		};
		const yardstick = () => {
			for (const [a, b] of referencePairs) reference.diff_main(a, b, false);
		};
		marks();
		yardstick();
		let best = Number.POSITIVE_INFINITY;
		let ref = Number.POSITIVE_INFINITY;
		for (let round = 0; round < 5; round++) {
			best = Math.min(best, cpu(marks));
			ref = Math.min(ref, cpu(yardstick));
		}
		return { best, ratio: best / ref };
	};

	// The ratio budgets are about twice CI's highest ratio, so a uniform
	// slowdown fails the similar test from about 3.4x on a dev machine
	// (2.1x on CI) and the unrelated one from about 2.6x (2x on CI); a 2x
	// slowdown can pass both. Diffing characters instead of tokens (1.6x
	// and 7.6x the yardstick on the dev machine) fails the unrelated test.
	// The similar ratio moves more with load (wordMarks allocates more
	// than the yardstick), hence its looser budget. The absolute ceilings
	// are only a backstop for the yardstick itself slowing down: three
	// times CI's slowest best-of-three (100 and 241 ms).
	it(
		"marks 2,000 pairs of similar 120-character lines in 1.8x the CPU of their character diff",
		() => {
			const { best, ratio } = bestCpu(similarPairs());
			console.info(
				`wordMarks: 2,000 similar pairs in ${best} µs CPU, ${ratio.toFixed(2)}x the yardstick`,
			);
			expect(ratio).toBeLessThan(1.8);
			expect(best).toBeLessThan(300_000);
		},
		LOADED,
	);

	it(
		"marks 2,000 pairs of unrelated 120-character lines in 3.7x the CPU of the similar pairs' character diff",
		() => {
			// A rewritten block: every pair two unrelated lines (GitHub marks them all).
			const { line } = codeLines(11);
			const pairs = Array.from(
				{ length: 2000 },
				() => [line(), line()] as const,
			);
			const { best, ratio } = bestCpu(pairs);
			console.info(
				`wordMarks: 2,000 unrelated pairs in ${best} µs CPU, ${ratio.toFixed(2)}x the yardstick`,
			);
			expect(ratio).toBeLessThan(3.7);
			expect(best).toBeLessThan(750_000);
		},
		LOADED,
	);

	/**
	 * Minified-code-like text: one-letter and short identifiers, keywords,
	 * numbers and punctuation with hardly a space, so a 120-character piece
	 * is about 85 tokens (the code lines above are about 40).
	 */
	const minified = (seed: number) => {
		const random = rng(seed);
		const pick = <T>(xs: readonly T[]): T =>
			xs[Math.floor(random() * xs.length)] as T;
		const letters = [..."abcdefghijklmnopqrstuvwxyz"];
		const words = letters
			.concat(
				letters.map((c) => `${c}e`),
				letters.map((c) => `_${c}`),
			)
			.concat(["Object", "length", "push", "call", "function", "return"])
			.concat(["var", "this", "0", "1", "null", "void"]);
		const seps = [..."().,=;{}?:![]+ "].concat(["&&", "||", "===", "=>"]);
		const piece = () => {
			let s = "";
			while (s.length < 120) s += pick(words) + pick(seps);
			return s.slice(0, 120);
		};
		/** The piece with one token changed (a renamed variable, a new constant). */
		const edit = (text: string) => {
			const tokens = tokenize(text);
			const at = Math.floor(random() * tokens.length);
			let other = pick(words);
			while (other === tokens[at]) other = pick(words);
			tokens[at] = other;
			return tokens.join("").slice(0, 120);
		};
		return { piece, edit };
	};

	/** Eight 120-character pieces to a long line: 960 characters, under the cut. */
	const PIECES = 8;

	/**
	 * Long pairs and the same text as short pairs: each long line is eight
	 * 120-character pieces joined, its pair the eight pieces' pairs joined,
	 * so both sides hold the same characters, tokens and changes.
	 */
	const longAndShort = (
		count: number,
		pair: () => readonly [string, string],
	) => {
		const short: [string, string][] = [];
		const long: [string, string][] = [];
		for (let i = 0; i < count; i++) {
			const pieces = Array.from({ length: PIECES }, pair);
			short.push(...pieces.map(([a, b]) => [a, b] as [string, string]));
			long.push([
				pieces.map(([a]) => a).join(""),
				pieces.map(([, b]) => b).join(""),
			]);
		}
		return { short, long };
	};

	/**
	 * CPU µs of marking `pairs` and the ratio to marking `against`, after a
	 * warm-up: each the best of five rounds, taken in turn (as `bestCpu`).
	 */
	const bestCpuAgainst = (pairs: Pairs, against: Pairs) => {
		const marks = (ps: Pairs) => () => {
			for (const [a, b] of ps) wordMarks(a, b);
		};
		const run = marks(pairs);
		const yardstick = marks(against);
		run();
		yardstick();
		let best = Number.POSITIVE_INFINITY;
		let ref = Number.POSITIVE_INFINITY;
		for (let round = 0; round < 5; round++) {
			best = Math.min(best, cpu(run));
			ref = Math.min(ref, cpu(yardstick));
		}
		return { best, ratio: best / ref };
	};

	// Long lines. Every line above is 120 characters, so a cost that grows
	// with the square of a line's length hides in them. Here the yardstick
	// is wordMarks itself on the same text cut into 120-character pairs: a
	// cost linear in a line's length marks a long line in about the time of
	// its pieces, and a uniform slowdown cancels out (the tests above catch
	// that). The cut (WORD_DIFF_MAX) bounds a marked line, so a quadratic
	// cost grows at most 8x here: 960 characters (about 700 tokens) against
	// 120. (A join can merge two pieces' edge tokens into one, so the two
	// sides' tokens differ there, by a few in 700.)
	//
	// Similar lines, one token changed per piece: the exact diff's best
	// case, linear: 0.96–1.10x, idle and with a busy loop per core. Fails
	// on a quadratic step in the per-line work: copying the token array
	// for each token (2.0–2.2x), reading each character by splitting the
	// line up to it (2.8x; the similar 120-character test passes it at
	// 1.06x), each gap's diff starting at the line's start instead of the
	// last anchor (29x). Can miss a quadratic step over the changed tokens
	// alone (few change here), or one cheap enough per token pair to stay
	// under 1.7x.
	it(
		"marks 960-character similar lines in 1.7x the CPU of the same text as 120-character lines",
		() => {
			const { piece, edit } = minified(13);
			const { short, long } = longAndShort(100, () => {
				const a = piece();
				return [a, edit(a)] as const;
			});
			const { best, ratio } = bestCpuAgainst(long, short);
			console.info(
				`wordMarks: 100 similar 960-character pairs in ${best} µs CPU, ${ratio.toFixed(2)}x their 120-character pieces`,
			);
			expect(ratio).toBeLessThan(1.7);
		},
		LOADED,
	);

	// Unrelated lines: here the exact diff (O(N·D) over the tokens, D about
	// N) is itself quadratic in a line's length: 4.0–4.2x its pieces,
	// 8 ms of CPU a pair on the dev machine (13 ms under load). No added
	// quadratic step can fail this test (none of the three above moves it
	// past 4.3x): it fails only on a cost worse than quadratic, or on about
	// 8x more quadratic work in the existing diff.
	it(
		"marks 960-character unrelated lines in 7x the CPU of the same text as 120-character lines",
		() => {
			const { piece } = minified(17);
			const { short, long } = longAndShort(
				20,
				() => [piece(), piece()] as const,
			);
			const { best, ratio } = bestCpuAgainst(long, short);
			console.info(
				`wordMarks: 20 unrelated 960-character pairs in ${best} µs CPU, ${ratio.toFixed(2)}x their 120-character pieces`,
			);
			expect(ratio).toBeLessThan(7);
		},
		LOADED,
	);

	// Past the cut (a minified bundle's line), a pair costs only the length
	// check: 0.00x a 120-character pair. Fails when the cut comes after the
	// line is tokenized (2.5x) or goes (440x: 100 ms a pair, the exact diff
	// over 2,800 tokens a side).
	it(
		"leaves a pair of 4,000-character lines plain in less CPU than a pair of 120-character lines",
		() => {
			const { piece, edit } = minified(19);
			const short: [string, string][] = [];
			const long: [string, string][] = [];
			for (let i = 0; i < 200; i++) {
				const pieces = Array.from({ length: 34 }, () => {
					const a = piece();
					return [a, i % 2 ? piece() : edit(a)] as const;
				});
				short.push([...(pieces[0] as readonly [string, string])]);
				long.push([
					pieces.map(([a]) => a).join(""),
					pieces.map(([, b]) => b).join(""),
				]);
			}
			const { best, ratio } = bestCpuAgainst(long, short);
			console.info(
				`wordMarks: 200 4,080-character pairs in ${best} µs CPU, ${ratio.toFixed(2)}x 200 120-character pairs`,
			);
			expect(ratio).toBeLessThan(1);
		},
		LOADED,
	);
});
