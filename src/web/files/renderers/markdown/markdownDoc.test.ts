import { describe, expect, it } from "vitest";
import type { DiffLine } from "../../../../shared/types";
import { docFixture, type Edit } from "./docFixture";
import {
	blockCommentSpan,
	blocksOf,
	buildDoc,
	lineAnchor,
	orphanSource,
	rebuildSides,
} from "./markdownDoc";

function docOf(oldText: string[], newText: string[], edits: Edit[]) {
	const fx = docFixture(oldText, newText, edits);
	const sides = rebuildSides(fx.hunks, fx.context);
	if (!sides) throw new Error("no sides");
	return buildDoc({
		sides,
		oldBlocks: blocksOf(sides.old),
		newBlocks: blocksOf(sides.new),
		units: edits.map((e) => ({
			key: e.key,
			old: e.old ? [e.old] : [],
			new: e.new ? [e.new] : [],
		})),
	});
}

describe("rebuildSides", () => {
	it("needs every line of both sides", () => {
		const fx = docFixture(
			["a", "", "b"],
			["a", "", "c"],
			[{ key: "k", old: [3, 4], new: [3, 4] }],
		);
		expect(rebuildSides(fx.hunks, fx.context)).toMatchObject({
			old: ["a", "", "b"],
			new: ["a", "", "c"],
		});
		expect(rebuildSides(fx.hunks, fx.context.slice(1))).toBeNull();
	});
});

describe("buildDoc", () => {
	it("lines taken out of a paragraph that stays: the paragraph changed, not a removal row", () => {
		const doc = docOf(
			["one", "two", "three"],
			["one", "three"],
			[{ key: "k", old: [2, 3] }],
		);
		expect(doc.rows).toEqual([
			{
				kind: "change",
				tone: "changed",
				oldBlocks: [0],
				newBlocks: [0],
				units: ["k"],
			},
		]);
	});

	it("a blank line taken out after a block that stays: that block changed, never struck as gone", () => {
		const doc = docOf(
			["A", "", "", "B"],
			["A", "", "B"],
			[{ key: "k", old: [3, 4] }],
		);
		expect(doc.rows[0]).toEqual({
			kind: "change",
			tone: "changed",
			oldBlocks: [0],
			newBlocks: [0],
			units: ["k"],
		});
	});

	it.each([
		[
			"a line added to a paragraph",
			["one", "three"],
			["one", "two", "three"],
			[2, 3],
		],
		[
			"a line added inside a fence",
			["```", "a", "c", "```"],
			["```", "a", "b", "c", "```"],
			[3, 4],
		],
		[
			"a blank line added after a block",
			["A", "", "B"],
			["A", "", "", "B"],
			[3, 4],
		],
	] as const)(
		"%s: that block changed, never wholly new",
		(_, old, nu, added) => {
			const doc = docOf(
				[...old],
				[...nu],
				[{ key: "k", new: [...added] as [number, number] }],
			);
			const row = doc.rows.find((r) => r.kind === "change");
			expect(row).toMatchObject({
				tone: "changed",
				oldBlocks: [0],
				newBlocks: [0],
				units: ["k"],
			});
		},
	);

	it("a block added between blocks stays added", () => {
		const doc = docOf(
			["A", "", "C"],
			["A", "", "B", "", "C"],
			[{ key: "k", new: [3, 5] }],
		);
		expect(doc.rows.find((r) => r.kind === "change")).toMatchObject({
			tone: "added",
			oldBlocks: [],
		});
	});

	it("a removed block sits before the block that follows it; at the end, last", () => {
		const doc = docOf(
			["A", "", "B", "", "C", "", "D"],
			["A", "", "C"],
			[
				{ key: "b", old: [3, 5] },
				{ key: "d", old: [6, 8] },
			],
		);
		expect(
			doc.rows.map((r) => (r.kind === "change" ? r.units.join() : r.kind)),
		).toEqual(["same", "b", "same", "d"]);
	});

	it("a removed item after a changed one sits after it, where it was (gallery #61 lists.md)", () => {
		const doc = docOf(
			[
				"## Before the first shift",
				"",
				"- Sign the safety briefing form",
				"- Set up a Tidewater account with the crew role", // 4
				"- Read the lifejacket drill card", // 5
				"- Find your locker on the car deck",
			],
			[
				"## Before the first shift",
				"",
				"- Sign the safety briefing form",
				"- Set up a Tidewater account with the deckhand or purser role", // 4
				"- Find your locker on the car deck",
			],
			[
				{ key: "set", old: [4, 5], new: [4, 5] },
				{ key: "read", old: [5, 6] },
			],
		);
		expect(
			doc.rows.map((r) =>
				r.kind === "change" ? `${r.tone}:${r.units.join()}` : r.kind,
			),
		).toEqual(["same", "same", "changed:set", "removed:read", "same"]);
	});

	it("a removed block before a changed one stays before it", () => {
		const doc = docOf(
			["A", "", "B", "", "C x", "", "D"],
			["A", "", "C y", "", "D"],
			[
				{ key: "b", old: [3, 5] },
				{ key: "c", old: [5, 6], new: [3, 4] },
			],
		);
		expect(
			doc.rows.map((r) => (r.kind === "change" ? r.units.join() : r.kind)),
		).toEqual(["same", "b", "c", "same"]);
	});

	it("every unit is on exactly one row (the coverage rule), however the edits fall", () => {
		const old = Array.from({ length: 40 }, (_, i) =>
			i % 3 === 2 ? "" : `line ${i}`,
		);
		for (let seed = 1; seed < 60; seed++) {
			let x = seed;
			const rnd = (n: number) => {
				x = (x * 1103515245 + 12345) % 2147483648;
				return x % n;
			};
			const nu: string[] = [];
			const edits: Edit[] = [];
			let o = 1;
			while (o <= old.length) {
				if (rnd(5) === 0) {
					const del = rnd(3);
					const add = rnd(3);
					if (del + add > 0) {
						const from = nu.length + 1;
						for (let k = 0; k < add; k++) nu.push(`new ${seed} ${o} ${k}`);
						edits.push({
							key: `e${edits.length}`,
							...(del
								? {
										old: [o, Math.min(o + del, old.length + 1)] as [
											number,
											number,
										],
									}
								: {}),
							...(add ? { new: [from, from + add] as [number, number] } : {}),
						});
						o += del;
						continue;
					}
				}
				nu.push(old[o - 1] as string);
				o++;
			}
			const doc = docOf(old, nu, edits);
			expect(doc.unplaced).toEqual([]);
			const placed = doc.rows.flatMap((r) =>
				r.kind === "change" ? r.units : [],
			);
			expect(placed.sort()).toEqual(edits.map((e) => e.key).sort());
			for (const r of doc.rows) {
				if (r.kind === "fold") expect(r.blocks.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("blockCommentSpan", () => {
	it("a block with one cluster of added lines 12-14: those lines, on the new side", () => {
		expect(blockCommentSpan([{ old: [], new: [[12, 15]] }])).toEqual({
			startSide: "RIGHT",
			startLine: 12,
			side: "RIGHT",
			line: 14,
		});
	});

	it("a changed cluster: its new lines", () => {
		expect(blockCommentSpan([{ old: [[3, 5]], new: [[3, 4]] }])).toEqual({
			startSide: "RIGHT",
			startLine: 3,
			side: "RIGHT",
			line: 3,
		});
	});

	it("two clusters: the last one's lines", () => {
		expect(
			blockCommentSpan([
				{ old: [[24, 25]], new: [[23, 24]] },
				{ old: [[26, 27]], new: [[25, 26]] },
			]),
		).toMatchObject({ startLine: 25, line: 25 });
	});

	it("a cluster then a whitespace-only one: the first; whitespace-only alone: that one", () => {
		expect(
			blockCommentSpan([
				{ old: [], new: [[12, 15]] },
				{ old: [[20, 21]], new: [[16, 17]], ws: true },
			]),
		).toMatchObject({ startLine: 12, line: 14, side: "RIGHT" });
		expect(
			blockCommentSpan([{ old: [[20, 21]], new: [[16, 17]], ws: true }]),
		).toMatchObject({ startLine: 16, line: 16 });
	});

	it("a removal-only block on old 30-31: the old side", () => {
		expect(blockCommentSpan([{ old: [[30, 32]], new: [] }])).toEqual({
			startSide: "LEFT",
			startLine: 30,
			side: "LEFT",
			line: 31,
		});
	});

	it("an unchanged block (no unit): none", () => {
		expect(blockCommentSpan([])).toBeNull();
	});
});

describe("lineAnchor", () => {
	const OLD = ["# T", "", "old p", "", "gone", "", "kept", "", "tail"];
	const NEW = ["# T", "", "new p", "", "kept", "", "tail"];
	const setup = () => {
		const edits: Edit[] = [
			{ key: "a", old: [3, 4], new: [3, 4] },
			{ key: "b", old: [5, 7] },
		];
		const fx = docFixture(OLD, NEW, edits);
		const sides = rebuildSides(fx.hunks, fx.context);
		if (!sides) throw new Error("no sides");
		const oldBlocks = blocksOf(sides.old);
		const newBlocks = blocksOf(sides.new);
		const doc = buildDoc({
			sides,
			oldBlocks,
			newBlocks,
			units: edits.map((e) => ({
				key: e.key,
				old: e.old ? [e.old] : [],
				new: e.new ? [e.new] : [],
			})),
		});
		return (side: "LEFT" | "RIGHT", n: number) =>
			lineAnchor(doc, sides, oldBlocks, newBlocks, side, n);
	};

	it("a new line: its block; a blank line: the block before it", () => {
		const at = setup();
		expect(at("RIGHT", 3)).toEqual({ block: 1 });
		expect(at("RIGHT", 4)).toEqual({ block: 1 });
		expect(at("RIGHT", 7)).toEqual({ block: 3 });
	});

	it("an unchanged old line: the new line it is; a removed one: its change row", () => {
		const at = setup();
		expect(at("LEFT", 7)).toEqual({ block: 2 });
		// Rows: title, intro (changed), the removal before "kept", ...
		expect(at("LEFT", 5)).toEqual({ row: 2 });
		expect(at("LEFT", 3)).toEqual({ row: 1 });
	});

	it("a line past either end still lands on a block, never nowhere", () => {
		const at = setup();
		expect(at("RIGHT", 99)).toEqual({ block: 3 });
		expect(at("LEFT", 99)).not.toBeNull();
	});
});

describe("orphanSource (CAR-328)", () => {
	const del = (text: string, key = "o"): DiffLine => ({
		kind: "del",
		text,
		clusterKey: key,
		baseNo: 1,
		orphan: true,
	});
	const ctx = (n: number): DiffLine => ({
		kind: "context",
		oldNo: n,
		newNo: n,
		text: `l${n}`,
	});
	it("an orphan pair's lines, no place (its added line places it)", () => {
		const add: DiffLine = {
			kind: "add",
			newNo: 2,
			text: "new",
			clusterKey: "o",
			orphan: true,
		};
		const hunks = [{ newStart: 1, lines: [ctx(1), del("old"), add, ctx(3)] }];
		expect(orphanSource(hunks, { hunk: 0, line: 1, key: "o" })).toEqual({
			del: ["old"],
			add: ["new"],
		});
	});
	it("replaced lines sit by their cluster's first added line", () => {
		const lines = [ctx(4), del("a"), ctx(5)];
		expect(
			orphanSource(
				[{ newStart: 4, lines }],
				{ hunk: 0, line: 1, key: "o" },
				{
					newStart: 9,
					newCount: 2,
				},
			),
		).toEqual({ del: ["a"], add: [], place: 9 });
	});
	it("a removal: the line of text above in its hunk, else the line above the hunk, else below; its run ends at another", () => {
		const blank = (n: number): DiffLine => ({ ...ctx(n), text: "" });
		const removal = { newStart: 0, newCount: 0 };
		const of = (newStart: number, lines: DiffLine[], line: number) =>
			orphanSource([{ newStart, lines }], { hunk: 0, line, key: "o" }, removal);
		expect(
			of(4, [ctx(4), blank(5), del("a"), del("b"), del("c", "p"), ctx(6)], 2),
		).toEqual({
			del: ["a", "b"],
			add: [],
			place: 4,
		});
		expect(of(5, [blank(5), del("a"), ctx(6)], 1)).toEqual({
			del: ["a"],
			add: [],
			place: 4,
		});
		expect(of(1, [del("a"), blank(1), ctx(2)], 0)).toEqual({
			del: ["a"],
			add: [],
			place: 2,
		});
	});
	it("null when its row isn't an orphan's (the view shows Text)", () => {
		expect(orphanSource([], { hunk: 0, line: 0, key: "o" })).toBeNull();
		expect(
			orphanSource([{ newStart: 1, lines: [ctx(1)] }], {
				hunk: 0,
				line: 0,
				key: "o",
			}),
		).toBeNull();
	});
});
