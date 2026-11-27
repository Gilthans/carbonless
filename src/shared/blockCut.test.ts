import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bestCpuRatio } from "../../test/cpu.js";
import { cutAtBlocks, groupByBlocks } from "./blockCut.js";
import { blockOfLine, markdownBlocks } from "./markdownBlocks.js";
import type { LineCluster } from "./types.js";

/**
 * The one hunk between two texts, as git -U0 numbers it: the common prefix
 * and suffix stripped (a side with no lines starts at the line it follows).
 */
function hunk(
	oldLines: readonly string[],
	newLines: readonly string[],
): LineCluster {
	let pre = 0;
	while (
		pre < oldLines.length &&
		pre < newLines.length &&
		oldLines[pre] === newLines[pre]
	)
		pre++;
	let suf = 0;
	while (
		suf < oldLines.length - pre &&
		suf < newLines.length - pre &&
		oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
	)
		suf++;
	const removed = oldLines.slice(pre, oldLines.length - suf);
	const added = newLines.slice(pre, newLines.length - suf);
	return {
		oldStart: removed.length > 0 ? pre + 1 : pre,
		oldCount: removed.length,
		newStart: added.length > 0 ? pre + 1 : pre,
		newCount: added.length,
		removed,
		added,
		lines: removed.length + added.length,
	};
}

function cut(oldText: string, newText: string) {
	const o = oldText.split("\n");
	const n = newText.split("\n");
	const c = hunk(o, n);
	return {
		c,
		parts: cutAtBlocks(c, markdownBlocks(o), markdownBlocks(n)),
	};
}

const shape = (p: ReturnType<typeof cutAtBlocks>[number]) => ({
	old: [p.cluster.oldStart, p.cluster.oldCount],
	new: [p.cluster.newStart, p.cluster.newCount],
	removed: p.cluster.removed,
	added: p.cluster.added,
	at: [p.removedAt, p.addedAt],
});

describe("cutAtBlocks (CAR-167)", () => {
	it("leaves a word change in one list item whole", () => {
		const { c, parts } = cut(
			"- one\n- two\n- three\n- four\n- five",
			"- one\n- two\n- tree\n- four\n- five",
		);
		expect(parts).toEqual([{ cluster: c, removedAt: 0, addedAt: 0 }]);
	});

	it("cuts a hunk over items 2–4 into one piece per item, each old with its new", () => {
		const { parts } = cut(
			"- one\n- two apples\n- three pears\n- four plums\n- five",
			"- one\n- two apples!\n- three pears!\n- four plums!\n- five",
		);
		expect(parts.map(shape)).toEqual([
			{
				old: [2, 1],
				new: [2, 1],
				removed: ["- two apples"],
				added: ["- two apples!"],
				at: [0, 0],
			},
			{
				old: [3, 1],
				new: [3, 1],
				removed: ["- three pears"],
				added: ["- three pears!"],
				at: [1, 1],
			},
			{
				old: [4, 1],
				new: [4, 1],
				removed: ["- four plums"],
				added: ["- four plums!"],
				at: [2, 2],
			},
		]);
	});

	it("pairs a split paragraph with the new block most of its lines pair with", () => {
		const { parts } = cut(
			"# T\n\nalpha beta gamma\ndelta epsilon zeta\neta theta iota\n\nend",
			"# T\n\nalpha beta gamma!\ndelta epsilon zeta!\n\neta theta iota!\n\nend",
		);
		expect(parts.map(shape)).toEqual([
			{
				old: [3, 3],
				new: [3, 3],
				removed: ["alpha beta gamma", "delta epsilon zeta", "eta theta iota"],
				added: ["alpha beta gamma!", "delta epsilon zeta!", ""],
				at: [0, 0],
			},
			{
				old: [5, 0],
				new: [6, 1],
				removed: [],
				added: ["eta theta iota!"],
				at: [3, 3],
			},
		]);
	});

	it("cuts a deleted section into removal-only pieces", () => {
		const { parts } = cut(
			"# A\n\ntext a\n\n# B\n\ntext b\n\n# C",
			"# A\n\ntext a\n\n# C",
		);
		expect(parts.map(shape)).toEqual([
			{
				old: [5, 2],
				new: [4, 0],
				removed: ["# B", ""],
				added: [],
				at: [0, 0],
			},
			{
				old: [7, 2],
				new: [4, 0],
				removed: ["text b", ""],
				added: [],
				at: [2, 0],
			},
		]);
	});

	it("cuts a pure addition over two blocks, numbering the old side as the line it follows", () => {
		const { parts } = cut("# A\n\nend", "# A\n\nnew one\n\nnew two\n\nend");
		expect(parts.map(shape)).toEqual([
			{
				old: [2, 0],
				new: [3, 2],
				removed: [],
				added: ["new one", ""],
				at: [0, 0],
			},
			{
				old: [2, 0],
				new: [5, 2],
				removed: [],
				added: ["new two", ""],
				at: [0, 2],
			},
		]);
	});

	it("cuts a changed table row beside an added row", () => {
		const { parts } = cut(
			"| a | b |\n| - | - |\n| one | two |\n| x | y |",
			"| a | b |\n| - | - |\n| one | three |\n| new | row |\n| x | y |",
		);
		expect(parts.map(shape)).toEqual([
			{
				old: [3, 1],
				new: [3, 1],
				removed: ["| one | two |"],
				added: ["| one | three |"],
				at: [0, 0],
			},
			{
				old: [3, 0],
				new: [4, 1],
				removed: [],
				added: ["| new | row |"],
				at: [1, 1],
			},
		]);
	});

	it("leaves a change inside a 10-line code fence whole", () => {
		const fence = (mid: string) =>
			[
				"```ts",
				"a()",
				"b()",
				"c()",
				mid,
				"e()",
				"f()",
				"g()",
				"h()",
				"```",
			].join("\n");
		const { c, parts } = cut(fence("d()"), fence("d(1)"));
		expect(parts).toEqual([{ cluster: c, removedAt: 0, addedAt: 0 }]);
	});

	it("never crosses: the later old block becomes removal-only", () => {
		// Old A, B rewritten in the order B', A': A pairs with A' (the stronger
		// match), so B can't pair with B' before it.
		const { parts } = cut(
			"x\n\nalpha beta gamma delta epsilon\n\nkappa lambda mu\n\ny",
			"x\n\nkappa lambda mu nu\n\nalpha beta gamma delta epsilon zeta\n\ny",
		);
		expect(parts.map(shape)).toEqual([
			{
				old: [2, 0],
				new: [3, 2],
				removed: [],
				added: ["kappa lambda mu nu", ""],
				at: [0, 0],
			},
			{
				old: [3, 2],
				new: [5, 1],
				removed: ["alpha beta gamma delta epsilon", ""],
				added: ["alpha beta gamma delta epsilon zeta"],
				at: [0, 2],
			},
			{
				old: [5, 1],
				new: [5, 0],
				removed: ["kappa lambda mu"],
				added: [],
				at: [2, 3],
			},
		]);
	});

	it("keeps a new block's old blocks adjacent: A→X, B unpaired, C→X makes C removal-only", () => {
		const { parts } = cut(
			"# T\n\nalpha beta gamma\n\nzzz qqq\n\ndelta epsilon zeta\n\nend",
			"# T\n\nalpha beta gamma!\ndelta epsilon zeta!\n\nend",
		);
		expect(parts.map(shape)).toEqual([
			{
				old: [3, 2],
				new: [3, 2],
				removed: ["alpha beta gamma", ""],
				added: ["alpha beta gamma!", "delta epsilon zeta!"],
				at: [0, 0],
			},
			{
				old: [5, 2],
				new: [4, 0],
				removed: ["zzz qqq", ""],
				added: [],
				at: [2, 2],
			},
			{
				old: [7, 1],
				new: [4, 0],
				removed: ["delta epsilon zeta"],
				added: [],
				at: [4, 2],
			},
		]);
	});

	it("pairs by position when nothing pairs and the counts match, else not at all", () => {
		const same = cut("# A\n\nold text\n\nz", "# B\n\nnew words\n\nz");
		expect(same.parts.map(shape)).toEqual([
			{
				old: [1, 2],
				new: [1, 2],
				removed: ["# A", ""],
				added: ["# B", ""],
				at: [0, 0],
			},
			{
				old: [3, 1],
				new: [3, 1],
				removed: ["old text"],
				added: ["new words"],
				at: [2, 2],
			},
		]);
		// The hunk is "# A", "", "old text" → "# B": two old blocks, one new.
		const differ = cut("# A\n\nold text\n\nz", "# B\n\nz");
		expect(differ.parts.map(shape)).toEqual([
			{ old: [1, 2], new: [0, 0], removed: ["# A", ""], added: [], at: [0, 0] },
			{
				old: [3, 1],
				new: [0, 0],
				removed: ["old text"],
				added: [],
				at: [2, 0],
			},
			{ old: [3, 0], new: [1, 1], removed: [], added: ["# B"], at: [3, 0] },
		]);
	});

	it("keeps the end-of-file flags on the piece holding the last line", () => {
		const c: LineCluster = {
			oldStart: 1,
			oldCount: 3,
			newStart: 1,
			newCount: 3,
			removed: ["- one apple", "- two pears", "- three"],
			added: ["- one apple!", "- two pears!", "- three!"],
			lines: 6,
			noNewlineOld: true,
			noNewlineNew: true,
		};
		const blocks = markdownBlocks(c.removed);
		const pieces = cutAtBlocks(c, blocks, markdownBlocks(c.added)).map(
			(p) => p.cluster,
		);
		expect(pieces).toHaveLength(3);
		expect(pieces.map((p) => [p.noNewlineOld, p.noNewlineNew])).toEqual([
			[undefined, undefined],
			[undefined, undefined],
			[true, true],
		]);
	});

	it("drops split on cut pieces and keeps whitespaceOnly on every piece of a whitespace-only cluster", () => {
		const c = {
			oldStart: 1,
			oldCount: 2,
			newStart: 1,
			newCount: 2,
			removed: ["-  one", "-  two"],
			added: ["- one", "- two"],
			lines: 4,
			whitespaceOnly: true as const,
			split: { key: "k", removedAt: 3, addedAt: 3, removed: 9 },
		};
		const pieces = cutAtBlocks(
			c,
			markdownBlocks(c.removed),
			markdownBlocks(c.added),
		).map((p) => p.cluster);
		expect(pieces).toHaveLength(2);
		for (const p of pieces) {
			expect(p.whitespaceOnly).toBe(true);
			expect(p.split).toBeUndefined();
		}
	});

	it("keeps whitespaceOnly on the pieces of a one-sided whitespace-only cluster (CAR-218)", () => {
		// Removed lines whose twins sit outside the cluster (another git hunk,
		// or context): every line is whitespace-only, so every part is.
		const c = {
			oldStart: 3,
			oldCount: 2,
			newStart: 2,
			newCount: 0,
			removed: ["-  one", "-  two"],
			added: [],
			lines: 2,
			whitespaceOnly: true as const,
		};
		const oldBlocks = markdownBlocks(["x", "", "-  one", "-  two"]);
		const pieces = cutAtBlocks(c, oldBlocks, markdownBlocks([])).map(
			(p) => p.cluster,
		);
		expect(pieces).toHaveLength(2);
		for (const p of pieces) expect(p.whitespaceOnly).toBe(true);
	});
});

describe("groupByBlocks", () => {
	it("is one group when each side has at most one block", () => {
		expect(
			groupByBlocks(
				["a"],
				["b", "c"],
				() => 0,
				() => 3,
			),
		).toEqual([{ removed: [0, 1], added: [0, 2] }]);
		expect(
			groupByBlocks(
				["a", "b"],
				[],
				() => -1,
				() => -1,
			),
		).toEqual([{ removed: [0, 2], added: [0, 0] }]);
	});
});

const LINE = fc.oneof(
	fc.constantFrom(
		"",
		"",
		"# Title",
		"## Section two",
		"- item one",
		"- item two words",
		"  - nested item",
		"1. first",
		"> quoted text",
		">",
		"```",
		"code line()",
		"| a | b |",
		"| - | - |",
		"| x | y |",
		"---",
		"plain paragraph text",
		"more paragraph words here",
		"<div>",
		"[ref]: http://x",
	),
	fc.stringMatching(/^[a-z #|>*-]{0,12}$/),
);

describe("cutAtBlocks properties", () => {
	it("covers every line once, in order, each piece within one block per side", () => {
		fc.assert(
			fc.property(
				fc.array(LINE, { maxLength: 30 }),
				fc.nat(),
				fc.nat(),
				fc.array(LINE, { maxLength: 12 }),
				(oldLines, s, k, inserted) => {
					const start = s % (oldLines.length + 1);
					const count = k % (oldLines.length - start + 1);
					const newLines = [
						...oldLines.slice(0, start),
						...inserted,
						...oldLines.slice(start + count),
					];
					const c = hunk(oldLines, newLines);
					if (c.lines === 0) return;
					const oldBlocks = markdownBlocks(oldLines);
					const newBlocks = markdownBlocks(newLines);
					const parts = cutAtBlocks(c, oldBlocks, newBlocks);
					expect(parts.flatMap((p) => p.cluster.removed)).toEqual(c.removed);
					expect(parts.flatMap((p) => p.cluster.added)).toEqual(c.added);
					let r = 0;
					let a = 0;
					// No block is cut across two pieces.
					const oldSeen = new Set<number>();
					const newSeen = new Set<number>();
					for (const { cluster: p, removedAt, addedAt } of parts) {
						expect(p.lines).toBeGreaterThan(0);
						expect([removedAt, addedAt]).toEqual([r, a]);
						r += p.removed.length;
						a += p.added.length;
						expect(p.oldCount).toBe(p.removed.length);
						expect(p.newCount).toBe(p.added.length);
						const oldBase = c.oldCount > 0 ? c.oldStart : c.oldStart + 1;
						const newBase = c.newCount > 0 ? c.newStart : c.newStart + 1;
						expect(p.oldStart).toBe(
							oldBase + removedAt - (p.oldCount === 0 ? 1 : 0),
						);
						expect(p.newStart).toBe(
							newBase + addedAt - (p.newCount === 0 ? 1 : 0),
						);
						p.removed.forEach((line, i) => {
							expect(line).toBe(oldLines[p.oldStart - 1 + i]);
						});
						p.added.forEach((line, i) => {
							expect(line).toBe(newLines[p.newStart - 1 + i]);
						});
						if (parts.length > 1) {
							// A piece's new side is one block; its old side is the old
							// blocks paired with it (adjacent), one block if removal-only.
							const ob = new Set(
								p.removed.map((_, i) => blockOfLine(oldBlocks, p.oldStart + i)),
							);
							const nb = new Set(
								p.added.map((_, i) => blockOfLine(newBlocks, p.newStart + i)),
							);
							expect(nb.size).toBeLessThanOrEqual(1);
							if (p.added.length === 0) expect(ob.size).toBe(1);
							for (const b of ob) {
								expect(oldSeen.has(b)).toBe(false);
								oldSeen.add(b);
							}
							for (const b of nb) {
								expect(newSeen.has(b)).toBe(false);
								newSeen.add(b);
							}
						}
					}
				},
			),
			{ numRuns: 500 },
		);
	});
});

describe("cutAtBlocks cost", () => {
	it("grows linearly with a cluster's lines and blocks", () => {
		// A new file of list items: one block per line, every line changed. The
		// 4x file against four runs of the quarter does the same work, so a
		// linear cut reads about 1x and a per-line scan of the blocks 4x (it
		// read 203 ms for 16,754 items before blockOfLine was a binary search;
		// with the scan put back this test read 3.22x, with the search 0.78-1.22x).
		const file = (n: number) => {
			const lines = Array.from({ length: n }, (_, i) => `- item ${i}`);
			const c: LineCluster = {
				oldStart: 0,
				oldCount: 0,
				newStart: 1,
				newCount: n,
				removed: [],
				added: lines,
				lines: n,
			};
			return { c, blocks: markdownBlocks(lines) };
		};
		const big = file(16_000);
		const quarter = file(4_000);
		expect(cutAtBlocks(big.c, [], big.blocks)).toHaveLength(16_000);
		const { best, ref, ratio } = bestCpuRatio(
			() => cutAtBlocks(big.c, [], big.blocks),
			() => {
				for (let i = 0; i < 4; i++) cutAtBlocks(quarter.c, [], quarter.blocks);
			},
		);
		console.info(
			`cutAtBlocks 16,000 items: ${best} µs, ${ratio.toFixed(2)}x four runs of 4,000 (${ref} µs)`,
		);
		expect(ratio).toBeLessThan(2);
	});
});
