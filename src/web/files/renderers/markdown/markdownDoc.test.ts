import { describe, expect, it } from "vitest";
import { docFixture, type Edit } from "./docFixture";
import { blocksOf, buildDoc, rebuildSides } from "./markdownDoc";

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
