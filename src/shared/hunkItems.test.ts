import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bestCpuRatio } from "../../test/cpu";
import { plainWordSteps, punctuation } from "../../test/word-steps";
import {
	type DiffRow,
	hunkItems,
	hunkPairs,
	type LineGroup,
	type LinePair,
} from "./hunkPairs";
import {
	ALIGN_WORD_OPS,
	GROUP_MAX_LINES,
	HUNK_ALIGN_WORD_OPS,
	lineSimilarity,
	PAIR_MIN_SIMILARITY,
} from "./linePairing";
import { tokenize } from "./tokenize";
import type { DiffLine } from "./types";

const del = (text: string): DiffLine => ({
	kind: "del",
	text,
	clusterKey: "k",
});
const add = (text: string): DiffLine => ({
	kind: "add",
	text,
	clusterKey: "k",
});
const ctx = (text: string): DiffLine => ({ kind: "context", text });
const rows = (...lines: DiffLine[]): DiffRow[] =>
	lines.map((line) => ({ kind: "line", line }));
const texts = (pairs: readonly LinePair[]) =>
	pairs.map(([d, a]) => [d.text, a.text]);

const SPLIT = [
	"def load(",
	"    path,",
	"    retries=3,",
	"    timeout=30,",
	"):",
];
const LINE = "def load(path, retries=3, timeout=30):";

describe("hunkItems", () => {
	it("a split is a group of its lines", () => {
		const one = del(LINE);
		const run = SPLIT.map(add);
		const items = hunkItems([rows(one, ...run)]);
		expect(items.pairs).toEqual([]);
		expect(items.groups).toHaveLength(1);
		expect(items.groups[0]?.one).toBe(one);
		expect(items.groups[0]?.run).toEqual(run);
	});
	it("equal stretches keep i-th with i-th", () => {
		// 2 removed, 2 added, one of them a split: GitHub's pairs, no group.
		const hunk = rows(
			del(LINE),
			del("x = 1"),
			add("def load("),
			add("    path, retries=3, timeout=30):"),
		);
		const items = hunkItems([hunk]);
		expect(items.groups).toEqual([]);
		expect(items.pairs).toEqual(hunkPairs(hunk));
		expect(texts(items.pairs)).toEqual([
			[LINE, "def load("],
			["x = 1", "    path, retries=3, timeout=30):"],
		]);
	});
	it("a group stays in its view run; pairs still cross runs", () => {
		const one = del(LINE);
		const run = SPLIT.map(add);
		// The removed line and the first three added lines in one run.
		const items = hunkItems([
			rows(one, ...run.slice(0, 3)),
			rows(...run.slice(3)),
		]);
		expect(items.groups).toEqual([{ one, run: run.slice(0, 3) }]);
		// A pair across two runs, as hunkPairs makes it.
		const a = del("const timeout = 30;");
		const b = add("const timeout = 60;");
		const c = add("// unrelated");
		const across = hunkItems([rows(a), rows(b, c)]);
		expect(across.pairs).toEqual([[a, b]]);
		expect(across.groups).toEqual([]);
	});
	it("context and whitespace-only rows end a stretch, as for pairs", () => {
		const one = del(LINE);
		const run = SPLIT.map(add);
		const cut: DiffRow[] = [
			...rows(one, ...run.slice(0, 2)),
			{ kind: "ws", add: add("  ") },
			...rows(...run.slice(2)),
		];
		// The whitespace-only row ends the stretch: the group is the first
		// two added lines (they still score), the rest stay plain.
		expect(
			lineSimilarity(LINE, SPLIT.slice(0, 2).join("\n")),
		).toBeGreaterThanOrEqual(PAIR_MIN_SIMILARITY);
		expect(hunkItems([cut]).groups).toEqual([{ one, run: run.slice(0, 2) }]);
	});
	it("a split next to a pair in one stretch: both", () => {
		const one = del(LINE);
		const ret = del("    return open(path)");
		const run = SPLIT.map(add);
		const ret2 = add("    return open(path, 'r')");
		const items = hunkItems([rows(one, ret, ...run, ret2)]);
		expect(items.pairs).toEqual([[ret, ret2]]);
		expect(items.groups).toEqual([{ one, run }]);
	});

	/** alignCluster's estimate (Σ ⌈|old|/32⌉ × Σ |new|, in tokens). */
	const tokens = (t: string) =>
		tokenize(t).filter((x) => !/^\s+$/u.test(x)).length;
	it("groups take what the pairs leave of the hunk's budget, never the pairs' share", () => {
		// A stretch that pairs (2 removed, 1 added), then the split.
		const pairDels = ["a b c", "zzz"];
		const pairAdd = "a b c";
		const hunk = [
			...rows(...pairDels.map(del), add(pairAdd), ctx("--")),
			...rows(del(LINE), ...SPLIT.map(add)),
		];
		const pairOps =
			pairDels.reduce((s, t) => s + Math.ceil(tokens(t) / 32), 0) *
				tokens(pairAdd) +
			Math.ceil(tokens(LINE) / 32) * SPLIT.reduce((s, t) => s + tokens(t), 0);
		expect(pairOps).toBe(2 * 3 + 15);
		// The split's group estimate: its windows from added lines 0-3.
		const groupOps = 15 + 12 + 10 + 6;
		for (const budget of [pairOps - 1, pairOps, pairOps + groupOps - 1]) {
			const items = hunkItems([hunk], budget);
			// The pairs use the budget's last word steps: none left for groups.
			expect(items.pairs).toEqual(hunkPairs(hunk, budget));
			expect(items.groups).toEqual([]);
		}
		const items = hunkItems([hunk], pairOps + groupOps);
		expect(items.pairs).toEqual(hunkPairs(hunk, pairOps + groupOps));
		expect(items.groups).toHaveLength(1);
		expect(texts(items.pairs)).toEqual([["a b c", "a b c"]]);
	});

	// Random hunks: rows of a small vocabulary, context and whitespace-only
	// rows between, cut into view runs at random.
	const vocab = fc.constantFrom("a", "b", "c", "(", ")", ",", " ");
	const text = fc
		.array(vocab, { minLength: 0, maxLength: 6 })
		.map((t) => t.join(""));
	const row: fc.Arbitrary<DiffRow> = fc.oneof(
		{
			arbitrary: text.map((t) => ({ kind: "line", line: del(t) }) as DiffRow),
			weight: 4,
		},
		{
			arbitrary: text.map((t) => ({ kind: "line", line: add(t) }) as DiffRow),
			weight: 6,
		},
		{
			arbitrary: text.map((t) => ({ kind: "line", line: ctx(t) }) as DiffRow),
			weight: 1,
		},
		{
			arbitrary: fc.constant({ kind: "ws", add: add(" ") } as DiffRow),
			weight: 1,
		},
	);
	const hunk = fc.array(row, { maxLength: 40 }).chain((all) =>
		fc
			.array(fc.boolean(), { minLength: all.length, maxLength: all.length })
			.map((cuts) => {
				const runs: DiffRow[][] = [[]];
				all.forEach((r, i) => {
					if (i > 0 && cuts[i]) runs.push([]);
					(runs[runs.length - 1] as DiffRow[]).push(r);
				});
				return runs;
			}),
	);
	const budget = fc.oneof(
		fc.constant(HUNK_ALIGN_WORD_OPS),
		fc.integer({ min: 0, max: 200 }),
	);
	it("property: the pairs are hunkPairs' but those a group took; groups well formed", () => {
		fc.assert(
			fc.property(hunk, budget, (runs, b) => {
				const flat = runs.flat();
				const items = hunkItems(runs, b);
				const runOf = new Map<DiffLine, number>();
				runs.forEach((r, k) => {
					for (const x of r) if (x.kind === "line") runOf.set(x.line, k);
				});
				const grouped = new Set<DiffLine>();
				for (const g of items.groups as LineGroup[]) {
					for (const l of [g.one, ...g.run]) {
						expect(grouped.has(l)).toBe(false); // each line in one item
						grouped.add(l);
						expect(runOf.get(l)).toBe(runOf.get(g.one)); // one view run
					}
					expect(g.run.length).toBeGreaterThanOrEqual(2);
					expect(g.run.length).toBeLessThanOrEqual(GROUP_MAX_LINES);
					// The run is adjacent rows, all on the other side.
					const at = flat.findIndex(
						(r) => r.kind === "line" && r.line === g.run[0],
					);
					g.run.forEach((l, k) => {
						const r = flat[at + k];
						expect(r?.kind === "line" && r.line).toBe(l);
						expect(l.kind).toBe(g.one.kind === "del" ? "add" : "del");
					});
					// Every run line shares a token with the one line.
					const own = new Set(tokenize(g.one.text));
					for (const l of g.run)
						expect(tokenize(l.text).some((t) => t.trim() && own.has(t))).toBe(
							true,
						);
				}
				const want = hunkPairs(flat, b).filter(
					([d, a]) => !grouped.has(d) && !grouped.has(a),
				);
				expect(items.pairs).toEqual(want);
				for (const [d, a] of items.pairs) {
					expect(grouped.has(d) || grouped.has(a)).toBe(false);
				}
			}),
			{ numRuns: 500 },
		);
	});

	// CPU: a hunk of 40 of the costliest stretches the group guard lets
	// through (linePairing.test.ts's `worst`: 2 removed lines of 1,000
	// punctuation tokens, 56 added lines cycling their 50-token pieces).
	const LOADED = 60_000;
	it(
		"a hunk of 40 costliest group stretches costs about the budget's, against plain word steps",
		() => {
			const stretch = (seed: number) => {
				const line = punctuation(1, 1000, seed)[0] as string;
				const pieces = Array.from({ length: 20 }, (_, k) =>
					line.slice(50 * k, 50 * k + 50),
				);
				return {
					dels: [line, line],
					adds: Array.from({ length: 56 }, (_, k) => pieces[k % 20] as string),
				};
			};
			const stretches = Array.from({ length: 40 }, (_, k) => stretch(k + 3));
			const hunk: DiffRow[] = stretches.flatMap((s, k) => [
				...(k > 0 ? rows(ctx(`between ${k}`)) : []),
				...rows(...s.dels.map(del), ...s.adds.map(add)),
			]);
			// Each stretch's pairs cost 2 × 32 × 56 × 50 = 179,200 word steps
			// of estimate (no pair passes score()'s bound, so no LCS runs);
			// its groups 2,972,800 (as linePairing.test.ts's worstOps(56)).
			const pairOps = 2 * 32 * 56 * 50;
			const groupOps = 2 * 32 * (37 * 20 + 189) * 50;
			expect(groupOps).toBeLessThanOrEqual(ALIGN_WORD_OPS);
			const left = HUNK_ALIGN_WORD_OPS - 40 * pairOps;
			const grouped = Math.floor(left / groupOps);
			expect(grouped).toBe(1);
			const items = hunkItems([hunk]);
			expect(items.groups.length).toBeGreaterThan(0);
			expect(new Set(items.groups.map((g) => g.one.text)).size).toBe(grouped);
			const lines = hunk.flatMap((r) =>
				r.kind === "line" ? [r.line.text] : [],
			);
			// The yardstick shares no code with the LCS: every line tokenized
			// (the pairs read them all) plus the grouped stretches' word steps
			// in a plain loop. Without the budget all 40 stretches group: 40
			// times the word steps.
			const { best, ref, ratio } = bestCpuRatio(
				() => hunkItems([hunk]),
				() => {
					for (const l of lines) tokenize(l);
					plainWordSteps(grouped * groupOps);
				},
			);
			console.info(
				`hunkItems 40 costliest group stretches: ${best} µs, ${ratio.toFixed(2)}x tokenizing and ${grouped} stretches' word steps (${ref} µs)`,
			);
			expect(ratio).toBeLessThan(12);
		},
		LOADED,
	);
});
