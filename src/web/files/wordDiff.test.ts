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
	it("marks a renamed identifier as one token", () => {
		expect(wordMarks("const userCount = 1;", "const memberCount = 1;")).toEqual(
			{ old: [[6, 15]], new: [[6, 17]] },
		);
	});

	it("leaves equal lines and a trailing \\r alone", () => {
		expect(wordMarks("abc", "abc")).toEqual({ old: [], new: [] });
		expect(wordMarks("a\r", "a")).toEqual({ old: [], new: [] });
		expect(wordMarks("a", "a\r")).toEqual({ old: [], new: [] });
		const { old, new: young } = wordMarks("a b\r", "a c\r");
		expect(old).toEqual([[2, 3]]);
		expect(young).toEqual([[2, 3]]);
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
			for (const [text, marks] of [
				[a, old],
				[b, young],
			] as const) {
				const edges = boundaries(text);
				let last = -1;
				for (const [from, to] of marks) {
					expect(from).toBeGreaterThan(last); // sorted, apart (merged)
					expect(to).toBeGreaterThan(from);
					expect(to).toBeLessThanOrEqual(text.replace(/\r$/, "").length);
					expect(edges.has(from) && edges.has(to)).toBe(true);
					last = to;
				}
			}
			const strip = (s: string) => s.replace(/\r$/, "");
			expect(unmarked(strip(a), old)).toBe(unmarked(strip(b), young));
			if (strip(a) === strip(b))
				expect({ old, young }).toEqual({ old: [], young: [] });
		}
	});

	it("marks 2,000 pairs of 120-character lines in under 100 ms of CPU", () => {
		// Code-like lines: 400 identifiers, keywords, numbers, operators and
		// punctuation; about 10% of each line's tokens changed.
		const random = rng(7);
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
		const lineOf = () => {
			let s = "";
			while (s.length < 120) s += pick(words) + pick(seps);
			return s.slice(0, 120);
		};
		const pairs: [string, string][] = [];
		for (let i = 0; i < 2000; i++) {
			const a = lineOf();
			const changed = tokenize(a)
				.map((t) => (random() < 0.1 ? pick(words) : t))
				.join("");
			pairs.push([a, changed.slice(0, 120)]);
		}
		for (const [a, b] of pairs) wordMarks(a, b); // warm up
		// The best of three: other suites on the machine only ever add time.
		let best = Number.POSITIVE_INFINITY;
		for (let run = 0; run < 3; run++) {
			const before = process.threadCpuUsage();
			for (const [a, b] of pairs) wordMarks(a, b);
			const spent = process.threadCpuUsage(before);
			best = Math.min(best, spent.user + spent.system);
		}
		console.info(`wordMarks: 2,000 pairs in ${best} µs CPU`);
		expect(best).toBeLessThan(100_000);
	});
});
