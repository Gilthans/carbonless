import { describe, expect, it } from "vitest";
import type { Mark } from "../code/Invisibles";
import { tokenize, WORD_DIFF_MAX, wordMarks } from "./wordDiff";

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

	it("folds nothing: each changed word its own mark, the spaces between plain", () => {
		expect(wordMarks("a b c d", "w x y z")).toEqual({
			old: [
				[0, 1],
				[2, 3],
				[4, 5],
				[6, 7],
			],
			new: [
				[0, 1],
				[2, 3],
				[4, 5],
				[6, 7],
			],
		});
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

	it("is exactly a token diff, for any pair (500 seeded pairs)", () => {
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
			const { old, new: young } = wordMarks(a, b);
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

	it("never marks a token the diff keeps: shared words first, then spaces (1,000 seeded pairs)", () => {
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
			const { old, new: young } = wordMarks(a, b);
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
	 * The budget tests' wall-clock timeout: they gate CPU time, and four
	 * rounds of 2,000 pairs on a loaded machine (load 40 on 4 cores) take
	 * 5–8 s of wall time for under 1 s of CPU.
	 */
	const LOADED = 30_000;

	/** CPU µs of marking every pair, after a warm-up: the best of three (load only adds time). */
	const bestCpu = (pairs: readonly (readonly [string, string])[]) => {
		for (const [a, b] of pairs) wordMarks(a, b);
		let best = Number.POSITIVE_INFINITY;
		for (let run = 0; run < 3; run++) {
			const before = process.threadCpuUsage();
			for (const [a, b] of pairs) wordMarks(a, b);
			const spent = process.threadCpuUsage(before);
			best = Math.min(best, spent.user + spent.system);
		}
		return best;
	};

	it(
		"marks 2,000 pairs of similar 120-character lines in under 100 ms of CPU",
		() => {
			// An equal block of edited lines: about 10% of each line's tokens changed.
			const { line, edit } = codeLines(7);
			const pairs = Array.from({ length: 2000 }, () => {
				const a = line();
				return [a, edit(a)] as const;
			});
			const best = bestCpu(pairs);
			console.info(`wordMarks: 2,000 similar pairs in ${best} µs CPU`);
			expect(best).toBeLessThan(100_000);
		},
		LOADED,
	);

	it(
		"marks 2,000 pairs of unrelated 120-character lines in under 400 ms of CPU",
		() => {
			// A rewritten block: every pair two unrelated lines (GitHub marks them all).
			const { line } = codeLines(11);
			const pairs = Array.from(
				{ length: 2000 },
				() => [line(), line()] as const,
			);
			const best = bestCpu(pairs);
			console.info(`wordMarks: 2,000 unrelated pairs in ${best} µs CPU`);
			expect(best).toBeLessThan(400_000);
		},
		LOADED,
	);
});
