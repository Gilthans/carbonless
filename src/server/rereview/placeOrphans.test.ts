import { describe, expect, it } from "vitest";
import { bestCpuRatio, repeat } from "../../../test/cpu.js";
import type { DiffLine, DisplayHunk } from "../../shared/types.js";
import { type Orphan, placeOrphans } from "./engine.js";

/** One hunk of `n` unchanged lines, old and new numbered alike. */
const contextHunk = (n: number): DisplayHunk => ({
	oldStart: 1,
	oldCount: n,
	newStart: 1,
	newCount: n,
	lines: Array.from(
		{ length: n },
		(_, i): DiffLine => ({
			kind: "context",
			oldNo: i + 1,
			newNo: i + 1,
			text: `l${i + 1}`,
		}),
	),
});

/** Every other line an added orphan; a removed one after each of the rest. */
const orphansOf = (n: number): Orphan[] => {
	const out: Orphan[] = [];
	for (let line = 1; line <= n; line++) {
		if (line % 2 === 0) {
			out.push({
				place: line - 1,
				line: {
					kind: "add",
					newNo: line,
					text: `l${line}`,
					clusterKey: "k",
					orphan: true,
				},
			});
		} else {
			out.push({
				place: line,
				line: {
					kind: "del",
					text: `gone ${line}`,
					clusterKey: "k",
					baseNo: line,
					orphan: true,
				},
			});
		}
	}
	// In file order, a place's removed lines first (orphanLines' order).
	return out.sort(
		(a, b) =>
			a.place - b.place ||
			(a.line.kind === b.line.kind ? 0 : a.line.kind === "del" ? -1 : 1),
	);
};

describe("placing orphans (CAR-216)", () => {
	it("an added one stands for its context row, a removed one goes before the row below its place; the spans stay", () => {
		const hunks = [contextHunk(4)];
		placeOrphans(hunks, orphansOf(4));
		expect(
			hunks[0]?.lines.map(
				(l) => `${l.kind} ${l.oldNo ?? "-"}/${l.newNo ?? "-"} ${l.text}`,
			),
		).toEqual([
			"context 1/1 l1",
			"del -/- gone 1",
			"add -/2 l2",
			"context 3/3 l3",
			"del -/- gone 3",
			"add -/4 l4",
		]);
		// The header's spans are the interdiff's: an added orphan's old line
		// is still in the old span (not shown), a removed one is in neither.
		expect(hunks[0]).toMatchObject({
			oldStart: 1,
			oldCount: 4,
			newStart: 1,
			newCount: 4,
		});
	});

	it("at the top (after line 0) and at a hunk's end, past its last row", () => {
		const hunks = [contextHunk(2)];
		const del = (place: number, text: string): Orphan => ({
			place,
			line: { kind: "del", text, clusterKey: "k", baseNo: 1, orphan: true },
		});
		placeOrphans(hunks, [del(0, "top"), del(2, "end")]);
		expect(hunks[0]?.lines.map((l) => l.text)).toEqual([
			"top",
			"l1",
			"l2",
			"end",
		]);
	});

	it("fails closed: no row for an added one's line, or none at a removed one's place, throws", () => {
		expect(() =>
			placeOrphans(
				[contextHunk(2)],
				[
					{
						place: 4,
						line: { kind: "add", newNo: 5, text: "x", orphan: true },
					},
				],
			),
		).toThrow();
		expect(() =>
			placeOrphans(
				[contextHunk(2)],
				[{ place: 7, line: { kind: "del", text: "x", orphan: true } }],
			),
		).toThrow();
	});

	it("scales linearly: 8x the orphans cost about 8 runs of an eighth (no scan per orphan)", () => {
		const n = 2000;
		const place = (size: number) => () =>
			placeOrphans([contextHunk(size)], orphansOf(size));
		const { ratio } = bestCpuRatio(place(8 * n), repeat(8, place(n)));
		console.info(
			`placeOrphans: 8x the orphans in ${ratio.toFixed(2)}x the CPU`,
		);
		// 8x, not test/cpu.ts's 4x: linear isn't 1x here (more rows cost
		// more each, in memory), so 4x left too little room. At 4x, 4000
		// read 1.1-1.4x on the dev machine and 2.14x on CI (CAR-300),
		// against 3.6x for a scan of the rows per orphan, under a limit of
		// 2. At 8x the same 16,000 rows read 1.05-1.44x on the dev machine
		// and 1.16x on CI (a runner that read 2.14x at 4x may read 2.1-2.5x
		// here), the scan 5.8-6.6x: a limit of 3.5 sits about midway, with
		// room on both sides.
		expect(ratio).toBeLessThan(3.5);
	});
});
