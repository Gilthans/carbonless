import { describe, expect, it } from "vitest";
import { bestCpuRatio } from "../../../test/cpu";
import { pairingClusters } from "../../../test/pairing-fixtures";
import { plainWordSteps, punctuation } from "../../../test/word-steps";
import type { DiffLine } from "../../shared/types";
import { ALIGN_WORD_OPS, HUNK_ALIGN_WORD_OPS } from "./linePairing";
import type { DiffRow } from "./whitespace";
import { hunkPairs, pairWordMarks } from "./wordBlocks";
import { tokenize } from "./wordDiff";

/** Each paired line's word marks, as the view gets them. */
const marksOf = (rows: readonly DiffRow[]) => pairWordMarks(hunkPairs(rows));

const del = (text: string, clusterKey = "k"): DiffLine => ({
	kind: "del",
	text,
	clusterKey,
});
const add = (text: string, clusterKey = "k"): DiffLine => ({
	kind: "add",
	text,
	clusterKey,
});
const ctx = (text: string): DiffLine => ({ kind: "context", text });
const rows = (...lines: DiffLine[]): DiffRow[] =>
	lines.map((line) => ({ kind: "line", line }));

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

const line = (kind: DiffLine["kind"], n: number): DiffRow => ({
	kind: "line",
	line: { kind, text: `line ${n}`, clusterKey: "k" },
});

/**
 * A big hunk's rows (a rewritten file), and the same lines as small hunks.
 * The big hunk: one block of 5,000 removed lines then 5,000 added ones,
 * then 20,000 more rows of blocks of 1–40 lines a side (half of them as
 * many added as removed), context lines and whitespace-only rows between.
 * The small hunks: the big block's lines as 250 blocks of 20 a side, each
 * after a context line, then the rest; cut into hunks at a context line
 * once a hunk has 200 rows, so no other block is split and both make the
 * same pairs.
 */
function bigHunk(): { rows: DiffRow[]; pieces: DiffRow[][] } {
	const random = rng(23);
	let n = 0;
	const dels = Array.from({ length: 5000 }, () => line("del", n++));
	const adds = Array.from({ length: 5000 }, () => line("add", n++));
	const rest: DiffRow[] = [];
	while (dels.length + adds.length + rest.length < 30_000) {
		rest.push(line("context", n++));
		if (random() < 0.1) {
			const del: DiffLine = { kind: "del", text: "\tx", clusterKey: "k" };
			rest.push({ kind: "ws", del });
		}
		const d = 1 + Math.floor(random() * 40);
		const a = random() < 0.5 ? d : 1 + Math.floor(random() * 40);
		for (let i = 0; i < d; i++) rest.push(line("del", n++));
		for (let i = 0; i < a; i++) rest.push(line("add", n++));
	}
	const small: DiffRow[] = [];
	for (let i = 0; i < 5000; i += 20) {
		small.push(line("context", n++));
		small.push(...dels.slice(i, i + 20), ...adds.slice(i, i + 20));
	}
	small.push(...rest);
	const pieces: DiffRow[][] = [[]];
	for (const row of small) {
		const last = pieces[pieces.length - 1] as DiffRow[];
		const context = row.kind === "line" && row.line.kind === "context";
		if (context && last.length >= 200) pieces.push([row]);
		else last.push(row);
	}
	return { rows: [...dels, ...adds, ...rest], pieces };
}

/**
 * A hunk of 2,000 unequal clusters (3 removed lines, 2 added ones, each pair
 * of lines sharing most of its words, so alignCluster pairs them), a context
 * line between, and the same clusters as small hunks cut at a context line
 * once a hunk has 200 rows: no cluster is split, so both make the same pairs.
 */
function unequalHunk(): { rows: DiffRow[]; pieces: DiffRow[][] } {
	const out: DiffRow[] = [];
	let n = 0;
	const text = (k: number, tail: string) =>
		`const total = compute(a, b, c, ${k}, ${tail});`;
	const row = (kind: "del" | "add", t: string): DiffRow => ({
		kind: "line",
		line: { kind, text: t, clusterKey: "k" },
	});
	for (let c = 0; c < 2000; c++) {
		out.push(line("context", n++));
		for (let i = 0; i < 3; i++) out.push(row("del", text(n++, "old")));
		for (let i = 0; i < 2; i++) out.push(row("add", text(n++, "new")));
	}
	const pieces: DiffRow[][] = [[]];
	for (const row of out) {
		const last = pieces[pieces.length - 1] as DiffRow[];
		const context = row.kind === "line" && row.line.kind === "context";
		if (context && last.length >= 200) pieces.push([row]);
		else last.push(row);
	}
	return { rows: out, pieces };
}

describe("pairWordMarks of hunkPairs", () => {
	it("pairs an equal block's i-th removed line with its i-th added line", () => {
		const d1 = del("const a = 1;");
		const d2 = del("const b = 2;");
		const a1 = add("const a = 10;");
		const a2 = add("const bee = 2;");
		const marks = marksOf(rows(ctx("x"), d1, d2, a1, a2, ctx("y")));
		expect(marks.get(d1)).toEqual([[10, 11]]);
		expect(marks.get(a1)).toEqual([[10, 12]]);
		expect(marks.get(d2)).toEqual([[6, 7]]);
		expect(marks.get(a2)).toEqual([[6, 9]]);
		expect(marks.size).toBe(4);
	});

	it("pairs a 1/2 cluster by similarity: the comment stays unmarked (case 2)", () => {
		const d = del("const timeout = 30;");
		const c = add("// seconds");
		const a = add("const timeout = 60;");
		const marks = marksOf(rows(d, c, a));
		expect(marks.get(d)).toEqual([[16, 18]]);
		expect(marks.get(a)).toEqual([[16, 18]]);
		expect(marks.has(c)).toBe(false);
	});

	it("pairs a 3/2 cluster by similarity: the dropped line stays unmarked (case 3)", () => {
		const d1 = del("retry(getUser, 3)");
		const dl = del("log('retrying')");
		const d2 = del("retry(getOrders, 3)");
		const a1 = add("retry(getUser, 5)");
		const a2 = add("retry(getOrders, 5)");
		const marks = marksOf(rows(d1, dl, d2, a1, a2));
		expect(marks.get(d1)).toEqual([[15, 16]]);
		expect(marks.get(a1)).toEqual([[15, 16]]);
		expect(marks.get(d2)).toEqual([[17, 18]]);
		expect(marks.get(a2)).toEqual([[17, 18]]);
		expect(marks.has(dl)).toBe(false);
		expect(marks.size).toBe(4);
	});

	it("leaves a 1/2 cluster of unrelated lines plain (case 4)", () => {
		const r = rows(
			del("sendEmail(user);"),
			add("queue.push(job);"),
			add("metrics.inc('jobs');"),
		);
		expect(marksOf(r).size).toBe(0);
	});

	it("leaves blocks with a missing side plain", () => {
		for (const [n, m] of [
			[1, 0],
			[0, 1],
		] as const) {
			const lines = [
				...Array.from({ length: n }, (_, i) => del(`old ${i}`)),
				...Array.from({ length: m }, (_, i) => add(`new ${i}`)),
			];
			expect(marksOf(rows(...lines)).size).toBe(0);
		}
	});

	it("never pairs an unequal cluster across a whitespace-only row", () => {
		const d = del("const timeout = 30;");
		const wd = del("  b");
		const wa = add("b");
		const c = add("// seconds");
		const a = add("const timeout = 60;");
		const r: DiffRow[] = [
			{ kind: "line", line: d },
			{ kind: "ws", del: wd, add: wa },
			{ kind: "line", line: c },
			{ kind: "line", line: a },
		];
		expect(marksOf(r).size).toBe(0);
	});

	it("never pairs across a context line", () => {
		const d = del("a = 1");
		const a = add("a = 2");
		expect(marksOf(rows(d, ctx("between"), a)).size).toBe(0);
		// Two blocks, each 1/1.
		const d1 = del("a = 1");
		const a1 = add("a = 2");
		const d2 = del("b = 1");
		const a2 = add("b = 3");
		const marks = marksOf(rows(d1, a1, ctx("between"), d2, a2));
		expect([...marks.keys()]).toEqual([d1, a1, d2, a2]);
	});

	it("ends a block at an added line followed by a removed one", () => {
		const a1 = add("x = 1");
		const d1 = del("y = 1");
		const a2 = add("y = 2");
		// 0/1, then 1/1.
		const marks = marksOf(rows(a1, d1, a2));
		expect([...marks.keys()]).toEqual([d1, a2]);
	});

	it("ends a block at a whitespace-only row (Ignore whitespace)", () => {
		const d1 = del("a = 1");
		const wd = del("  b");
		const wa = add("b");
		const a1 = add("a = 2");
		const r: DiffRow[] = [
			{ kind: "line", line: d1 },
			{ kind: "ws", del: wd, add: wa },
			{ kind: "line", line: a1 },
		];
		expect(marksOf(r).size).toBe(0);
		// A one-sided `~` row ends it too.
		const r2: DiffRow[] = [
			{ kind: "line", line: d1 },
			{ kind: "ws", add: wa },
			{ kind: "line", line: a1 },
		];
		expect(marksOf(r2).size).toBe(0);
		// And the whitespace-only lines themselves are never marked.
		const r3: DiffRow[] = [{ kind: "ws", del: wd, add: wa }];
		expect(marksOf(r3).size).toBe(0);
	});

	it("pairs across clusters: the hunk's rows, not its runs", () => {
		const d1 = del("one = 1", "a");
		const d2 = del("two = 2", "a");
		const a1 = add("one = 11", "b");
		const a2 = add("two = 22", "b");
		const marks = marksOf(rows(d1, d2, a1, a2));
		expect(marks.get(d1)).toEqual([[6, 7]]);
		expect(marks.get(a1)).toEqual([[6, 8]]);
		expect(marks.get(d2)).toEqual([[6, 7]]);
		expect(marks.get(a2)).toEqual([[6, 8]]);
	});

	it("keeps the other pairs' marks when one pair is too long", () => {
		const d1 = del("a".repeat(1024));
		const d2 = del("x = 1");
		const a1 = add("b");
		const a2 = add("x = 2");
		const marks = marksOf(rows(d1, d2, a1, a2));
		expect([...marks.keys()]).toEqual([d2, a2]);
	});

	it("marks a trailing \\r only one line of a pair has (owner, 2026-11-04)", () => {
		const d = del("same\r");
		const a = add("same");
		const marks = marksOf(rows(d, a));
		expect(marks.get(d)).toEqual([[4, 5]]);
		expect(marks.has(a)).toBe(false);
	});
});

describe("hunkPairs on the gallery's cases 5 and 6", () => {
	// test/fixtures/pairing: git's clusters of each case, a context line
	// between them. An equal cluster pairs i-th with i-th (step 1), an unequal
	// one by similarity (step 2).
	const pairsOf = (file: string) => {
		const clusters = pairingClusters(file);
		const hunk = clusters.flatMap((c, i) => [
			...(i > 0 ? [ctx("between")] : []),
			...c.dels.map((t) => del(t)),
			...c.adds.map((t) => add(t)),
		]);
		return hunkPairs(rows(...hunk)).map(([d, a]) => [d.text, a.text]);
	};
	it("case 5: the signature pairs with its rename, the helper stays alone", () => {
		const pairs = pairsOf("05-helper-above.go");
		expect(pairs).toHaveLength(3);
		expect(pairs[0]?.[0]).toMatch(/^\/\/ IsCacheSkippedForDomain /);
		expect(pairs[0]?.[1]).toMatch(/^\/\/ SkipsCacheFor /);
	});
	// Provisional: these exact pairs are pinned as a regression detector
	// until the owner's pass over the real-PR comparison; a different
	// answer from the owner changes them.
	it("case 6: Clear's old signature pairs with the new Touch's", () => {
		const pairs = pairsOf("06-clear-touch.go");
		expect(pairs).toHaveLength(4);
		expect(pairs[0]?.[0]).toMatch(/\) Clear\(/);
		expect(pairs[0]?.[1]).toMatch(/\) Touch\(/);
	});
});

describe("hunkPairs", () => {
	/**
	 * The budget test's wall-clock timeout: it gates CPU time, not wall
	 * time. One pass of each hunk is tens of milliseconds of CPU, which a
	 * loaded machine (load 40 on 4 cores) stretches about 10x in wall time.
	 */
	const LOADED = 60_000;

	// The yardstick is hunkPairs on the same lines as small hunks of about
	// 200 rows, making the same pairs: each small hunk costs the same
	// however many there are, so a cost linear in the hunk's rows pairs the
	// big hunk in about the time of the small ones, and a uniform slowdown
	// cancels out. A cost that grows with the square of a block's lines, of
	// the hunk's pairs or of its clusters grows far more in the big hunk
	// than in small ones: copying the removed lines per line (14x), looking
	// each one's index up again (8.8-9.7x) or copying the pairs per pair
	// (21x) fail. Can miss a cost quadratic only in a hunk's context lines
	// or blocks, or one that shows only past 30,000 rows.
	//
	// Since step 2 the unequal clusters pair by similarity (alignCluster,
	// O(n*m) inside its cap by design), so a pass is tens of milliseconds
	// instead of half of one. The cut hunks keep every cluster whole (they
	// are cut at context lines), so each cluster's alignCluster cost is in
	// both sides and cancels; only a cost that depends on the hunk around a
	// cluster shows. "Same pairs" still holds, and is asserted. The second
	// hunk is all unequal clusters, 2,000 of them (the first has them in
	// half of its small blocks, and one 5,000-line equal block).
	const cases: [string, () => { rows: DiffRow[]; pieces: DiffRow[][] }][] = [
		["a 30,000-row hunk (one 5,000-line block, blocks of 1-40 lines)", bigHunk],
		["a hunk of 2,000 unequal 3/2 clusters", unequalHunk],
	];
	it.each(cases)(
		"pairs %s in 2x the CPU of the same lines as 200-row hunks",
		(_name, build) => {
			const { rows, pieces } = build();
			const pairs = hunkPairs(rows).length;
			expect(pieces.reduce((sum, p) => sum + hunkPairs(p).length, 0)).toBe(
				pairs,
			);
			expect(pairs).toBeGreaterThanOrEqual(4000);
			expect(pieces.length).toBeGreaterThan(10);
			const { best, ref, ratio } = bestCpuRatio(
				() => hunkPairs(rows),
				() => {
					for (const p of pieces) hunkPairs(p);
				},
			);
			console.info(
				`hunkPairs: ${rows.length} rows in ${best} µs CPU, ${ratio.toFixed(2)}x as 200-row hunks (${ref} µs)`,
			);
			expect(ratio).toBeLessThan(2);
		},
		LOADED,
	);
});

describe("hunkPairs' per-hunk budget (HUNK_ALIGN_WORD_OPS)", () => {
	const LOADED = 60_000;
	/** The removed and added texts of a hunk's pairs. */
	const texts = (pairs: ReturnType<typeof hunkPairs>) =>
		pairs.map(([d, a]) => [d.text, a.text]);
	// Each unequal stretch's word-op estimate (alignCluster's: Σ ⌈|old|/32⌉
	// × Σ |new|, in tokens): "a b c" and "zzz" against "a b c" is (1 + 1)
	// × 3 = 6; "q" and "zz" against "q" is (1 + 1) × 1 = 2.
	const stretches = () => {
		const s1 = [del("a b c"), del("zzz"), add("a b c")];
		const s2 = [del("a b c"), del("zzz"), add("a b c")];
		const s3 = [del("q"), del("zz"), add("q")];
		const equal = [del("p 1"), add("p 2")];
		return rows(...s1, ctx("1"), ...s2, ctx("2"), ...s3, ctx("3"), ...equal);
	};
	it("is four clusters at ALIGN_WORD_OPS", () => {
		expect(HUNK_ALIGN_WORD_OPS).toBe(4 * ALIGN_WORD_OPS);
	});
	it("a stretch just inside pairs; just over, it and every later unequal stretch get none, earlier ones keep theirs", () => {
		// 6 + 6 + 2 = 14: all three fit.
		expect(texts(hunkPairs(stretches(), 14))).toEqual([
			["a b c", "a b c"],
			["a b c", "a b c"],
			["q", "q"],
			["p 1", "p 2"],
		]);
		// 6 + 6 = 12: the second stretch just fits, the third (12 + 2) doesn't.
		expect(texts(hunkPairs(stretches(), 12))).toEqual([
			["a b c", "a b c"],
			["a b c", "a b c"],
			["p 1", "p 2"],
		]);
		// 11: the second stretch is just over; the third would fit what is
		// left (6 + 2) but comes after it, so it gets none either. The equal
		// stretch pairs by position, at no cost.
		expect(texts(hunkPairs(stretches(), 11))).toEqual([
			["a b c", "a b c"],
			["p 1", "p 2"],
		]);
		expect(texts(hunkPairs(stretches(), 5))).toEqual([["p 1", "p 2"]]);
	});
	it("a stretch over a cluster's own guards costs nothing from the hunk's", () => {
		// 51 x 50 lines: over ALIGN_CAP, so alignCluster scores nothing.
		const over = [
			...Array.from({ length: 51 }, () => del("a b c")),
			...Array.from({ length: 50 }, () => add("a b c")),
		];
		expect(
			texts(hunkPairs([...rows(...over, ctx("x")), ...stretches()], 14)),
		).toHaveLength(4);
	});

	// The most expensive unequal cluster the per-cluster guards let through:
	// 50 removed and 49 added lines of 192 punctuation tokens, every pair
	// past score()'s bound (as in linePairing.test.ts's 50 x 50), 50·6 ×
	// 49·192 = 2,822,400 word steps. An added line is a removed one with its
	// first token changed, so each cluster pairs (the LCS costs the same
	// alike or not). Four fit the hunk's 12,000,000; the fifth doesn't.
	const WORST = 50 * 6 * 49 * 192;
	const worstHunk = (clusters: number) =>
		Array.from({ length: clusters }, (_, k) => {
			const old = punctuation(50, 192, k + 7);
			return [
				...(k > 0 ? rows(ctx(`between ${k}`)) : []),
				...rows(
					...old.map((t) => del(t)),
					...old.slice(1).map((t) => add(`#${t.slice(1)}`)),
				),
			];
		}).flat();
	it(
		"a hunk of 40 worst-case clusters costs about 4 of them, against plain word steps",
		() => {
			expect(4 * WORST).toBeLessThanOrEqual(HUNK_ALIGN_WORD_OPS);
			expect(5 * WORST).toBeGreaterThan(HUNK_ALIGN_WORD_OPS);
			const hunk = worstHunk(40);
			// The first four clusters pair, 49 lines each; the rest none.
			const dels = hunk.flatMap((r) =>
				r.kind === "line" && r.line.kind === "del" ? [r.line] : [],
			);
			expect(hunkPairs(hunk).map(([d]) => dels.indexOf(d))).toEqual(
				Array.from({ length: 4 }, (_, k) =>
					Array.from({ length: 49 }, (_, i) => 50 * k + i + 1),
				).flat(),
			);
			const first4 = hunk
				.slice(0, 4 * 100)
				.flatMap((r) => (r.kind === "line" ? [r.line.text] : []));
			// The yardstick shares no code with the LCS: the four clusters'
			// lines tokenized plus their word steps in a plain loop, as the
			// 50 x 50 test in linePairing.test.ts. Measured 2.5x, limit 12 as
			// there (the yardstick may drift 2-2.5x between machines). Without
			// the budget all 40 clusters align, ten times the work: 20 of them
			// read 12.0x, so 40 leave the mutant well clear of the limit.
			const { best, ref, ratio } = bestCpuRatio(
				() => hunkPairs(hunk),
				() => {
					for (const l of first4) tokenize(l);
					plainWordSteps(4 * WORST);
				},
			);
			console.info(
				`hunkPairs 40 worst clusters: ${best} µs, ${ratio.toFixed(2)}x tokenizing 4 clusters and their word steps (${ref} µs)`,
			);
			expect(ratio).toBeLessThan(12);
		},
		LOADED,
	);
});
