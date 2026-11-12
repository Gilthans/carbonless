import { describe, expect, it } from "vitest";
import type { DiffLine } from "../../shared/types";
import type { DiffRow } from "./whitespace";
import { hunkPairs, hunkWordMarks } from "./wordBlocks";

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
 * A big hunk's rows: a rewritten file. One block of 5,000 removed lines
 * then 5,000 added ones, then 20,000 more rows of blocks of 1–40 lines a
 * side (half of them as many added as removed), context lines and
 * whitespace-only rows between.
 */
function bigHunk(): DiffRow[] {
	const random = rng(23);
	const rows: DiffRow[] = [];
	let n = 0;
	for (let i = 0; i < 5000; i++) rows.push(line("del", n++));
	for (let i = 0; i < 5000; i++) rows.push(line("add", n++));
	while (rows.length < 30_000) {
		rows.push(line("context", n++));
		if (random() < 0.1) {
			const del: DiffLine = { kind: "del", text: "\tx", clusterKey: "k" };
			rows.push({ kind: "ws", del });
		}
		const dels = 1 + Math.floor(random() * 40);
		const adds = random() < 0.5 ? dels : 1 + Math.floor(random() * 40);
		for (let i = 0; i < dels; i++) rows.push(line("del", n++));
		for (let i = 0; i < adds; i++) rows.push(line("add", n++));
	}
	return rows;
}

describe("hunkWordMarks", () => {
	it("pairs an equal block's i-th removed line with its i-th added line", () => {
		const d1 = del("const a = 1;");
		const d2 = del("const b = 2;");
		const a1 = add("const a = 10;");
		const a2 = add("const bee = 2;");
		const marks = hunkWordMarks(rows(ctx("x"), d1, d2, a1, a2, ctx("y")));
		expect(marks.get(d1)).toEqual([[10, 11]]);
		expect(marks.get(a1)).toEqual([[10, 12]]);
		expect(marks.get(d2)).toEqual([[6, 7]]);
		expect(marks.get(a2)).toEqual([[6, 9]]);
		expect(marks.size).toBe(4);
	});

	it("leaves unequal blocks plain", () => {
		for (const [n, m] of [
			[1, 2],
			[3, 1],
			[2, 3],
			[1, 0],
			[0, 1],
		] as const) {
			const lines = [
				...Array.from({ length: n }, (_, i) => del(`old ${i}`)),
				...Array.from({ length: m }, (_, i) => add(`new ${i}`)),
			];
			expect(hunkWordMarks(rows(...lines)).size).toBe(0);
		}
	});

	it("never pairs across a context line", () => {
		const d = del("a = 1");
		const a = add("a = 2");
		expect(hunkWordMarks(rows(d, ctx("between"), a)).size).toBe(0);
		// Two blocks, each 1/1.
		const d1 = del("a = 1");
		const a1 = add("a = 2");
		const d2 = del("b = 1");
		const a2 = add("b = 3");
		const marks = hunkWordMarks(rows(d1, a1, ctx("between"), d2, a2));
		expect([...marks.keys()]).toEqual([d1, a1, d2, a2]);
	});

	it("ends a block at an added line followed by a removed one", () => {
		const a1 = add("x = 1");
		const d1 = del("y = 1");
		const a2 = add("y = 2");
		// 0/1, then 1/1.
		const marks = hunkWordMarks(rows(a1, d1, a2));
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
		expect(hunkWordMarks(r).size).toBe(0);
		// A one-sided `~` row ends it too.
		const r2: DiffRow[] = [
			{ kind: "line", line: d1 },
			{ kind: "ws", add: wa },
			{ kind: "line", line: a1 },
		];
		expect(hunkWordMarks(r2).size).toBe(0);
		// And the whitespace-only lines themselves are never marked.
		const r3: DiffRow[] = [{ kind: "ws", del: wd, add: wa }];
		expect(hunkWordMarks(r3).size).toBe(0);
	});

	it("pairs across clusters: the hunk's rows, not its runs", () => {
		const d1 = del("one = 1", "a");
		const d2 = del("two = 2", "a");
		const a1 = add("one = 11", "b");
		const a2 = add("two = 22", "b");
		const marks = hunkWordMarks(rows(d1, d2, a1, a2));
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
		const marks = hunkWordMarks(rows(d1, d2, a1, a2));
		expect([...marks.keys()]).toEqual([d2, a2]);
	});

	it("marks a trailing \\r only one line of a pair has (owner, 2026-11-04)", () => {
		const d = del("same\r");
		const a = add("same");
		const marks = hunkWordMarks(rows(d, a));
		expect(marks.get(d)).toEqual([[4, 5]]);
		expect(marks.has(a)).toBe(false);
	});
});

describe("hunkPairs", () => {
	const cpu = (run: () => void) => {
		const before = process.threadCpuUsage();
		run();
		const spent = process.threadCpuUsage(before);
		return spent.user + spent.system;
	};

	/**
	 * The budget test's wall-clock timeout: it gates CPU time, not wall
	 * time. It spends well under a second of CPU, which a loaded machine
	 * (load 40 on 4 cores) stretches about 10x in wall time.
	 */
	const LOADED = 60_000;

	// The yardstick is hunkPairs itself on the same rows cut into hunks of
	// 200: each piece costs the same however many there are, so a cost
	// linear in the hunk's rows pairs the big hunk in about the time of its
	// pieces (1.08–1.68x, idle and with a busy loop per core), and a uniform
	// slowdown cancels out. A cost that grows with the square of a block's
	// lines or of the hunk's pairs grows 25x more in the 5,000-line block
	// than in a 200-row piece: copying the removed lines per line (10.5x),
	// looking each one's index up again (14x), or copying the pairs per
	// pair (38x) fail. Can miss a cost quadratic only in a hunk's context
	// lines or blocks, or one that shows only past 30,000 rows.
	it(
		"pairs a 30,000-row hunk in 3x the CPU of the same rows as 200-row hunks",
		() => {
			const rows = bigHunk();
			const pieces: DiffRow[][] = [];
			for (let i = 0; i < rows.length; i += 200) {
				pieces.push(rows.slice(i, i + 200));
			}
			// Each round pairs the rows 40 times: one pass is about half a millisecond.
			const whole = () => {
				for (let r = 0; r < 40; r++) hunkPairs(rows);
			};
			const cut = () => {
				for (let r = 0; r < 40; r++) for (const p of pieces) hunkPairs(p);
			};
			// The big block pairs, and so do half the small ones.
			expect(hunkPairs(rows).length).toBeGreaterThan(5000 + 5000);
			whole();
			cut();
			let best = Number.POSITIVE_INFINITY;
			let ref = Number.POSITIVE_INFINITY;
			for (let round = 0; round < 5; round++) {
				best = Math.min(best, cpu(whole));
				ref = Math.min(ref, cpu(cut));
			}
			const ratio = best / ref;
			console.info(
				`hunkPairs: ${rows.length} rows 40 times in ${best} µs CPU, ${ratio.toFixed(2)}x as 200-row hunks`,
			);
			expect(ratio).toBeLessThan(3);
		},
		LOADED,
	);
});
