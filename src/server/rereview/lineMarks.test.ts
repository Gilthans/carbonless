import { describe, expect, it } from "vitest";
import type { Cluster } from "../../shared/types";
import { sinceLineSources } from "./engine";

/** An earlier cluster adding `added` (and removing `removed`). */
const then = (
	key: string,
	added: string[],
	removed: string[] = [],
): [string, { cluster: Cluster }] => [
	key,
	{
		cluster: {
			key,
			kind: "lines",
			oldStart: 1,
			oldCount: removed.length,
			newStart: 1,
			newCount: added.length,
			removed,
			added,
			lines: removed.length + added.length,
		} as Cluster,
	},
];
const keyed = (key: string, from: number, to: number) =>
	Object.fromEntries(
		Array.from({ length: to - from }, (_, i) => [from + i, key]),
	);

describe("sinceLineSources (CAR-195)", () => {
	// The old side: a const, a blank, then K's run (comment, set, blank), then code.
	const old = ["const", "", "// c", "set", "", "code"];
	const K = ["// c", "set", ""];

	it("a line K added stands for that line of K, by rank", () => {
		const lines = sinceLineSources(
			new Map([then("K", K)]),
			keyed("K", 3, 6),
			{},
			old,
		);
		expect([3, 4, 5].map(lines.added)).toEqual([
			{ key: "K", index: 0 },
			{ key: "K", index: 1 },
			{ key: "K", index: 2 },
		]);
	});

	it("a slider twin above the run stands for the run's last line; nothing slides past a different line", () => {
		const lines = () =>
			sinceLineSources(new Map([then("K", K)]), keyed("K", 3, 6), {}, old);
		// Line 2 (the blank above) is the twin of line 5 (K's blank).
		expect(lines().added(2)).toEqual({ key: "K", index: 2 });
		// The const reads unlike "set"; below the run "code" unlike "// c".
		expect(lines().added(1)).toBeNull();
		expect(lines().added(6)).toBeNull();
	});

	it("slides down and on: each line further stands for the line its twin did", () => {
		const lines = () =>
			sinceLineSources(new Map([then("K", ["x"])]), keyed("K", 1, 2), {}, [
				"x",
				"x",
				"x",
				"y",
			]);
		expect([2, 3, 4].map((l) => lines().added(l))).toEqual([
			{ key: "K", index: 0 },
			{ key: "K", index: 0 },
			null,
		]);
	});

	it("slides up over two lines: each twin stands for the right line", () => {
		// K adds "a", "b" at 4-5; above them "a", "b" again.
		const lines = () =>
			sinceLineSources(new Map([then("K", ["a", "b"])]), keyed("K", 4, 6), {}, [
				"q",
				"a",
				"b",
				"a",
				"b",
			]);
		expect(lines().added(3)).toEqual({ key: "K", index: 1 });
		expect(lines().added(2)).toEqual({ key: "K", index: 0 });
		expect(lines().added(1)).toBeNull();
	});

	it("never by text alone: the same text one line away from the run stands for nothing", () => {
		const lines = sinceLineSources(
			new Map([then("K", K)]),
			keyed("K", 3, 6),
			{},
			["", "z", "// c", "set", ""],
		);
		expect(lines.added(1)).toBeNull();
	});

	it("a line two runs claim stands for neither", () => {
		// A ("x") at 1, an unchanged "x" at 2, B ("x") at 3.
		const lines = sinceLineSources(
			new Map([then("A", ["x"]), then("B", ["x"])]),
			{ ...keyed("A", 1, 2), ...keyed("B", 3, 4) },
			{},
			["x", "x", "x"],
		);
		expect(lines.added(2)).toBeNull();
	});

	it("one to one: an earlier line stands for one line only, the first asked", () => {
		// K adds one blank at 6, under four unchanged blanks: each is its twin.
		const old6 = ["a", "", "", "", "", "", "b"];
		const lines = sinceLineSources(
			new Map([then("K", [""])]),
			keyed("K", 6, 7),
			{},
			old6,
		);
		expect([2, 3, 4, 5, 6].map(lines.added)).toEqual([
			{ key: "K", index: 0 },
			null,
			null,
			null,
			null,
		]);
		const direct = sinceLineSources(
			new Map([then("K", [""])]),
			keyed("K", 6, 7),
			{},
			old6,
		);
		expect([6, 5].map(direct.added)).toEqual([{ key: "K", index: 0 }, null]);
		const removed = sinceLineSources(
			new Map([then("R", [], ["gone"])]),
			{},
			keyed("R", 10, 11),
			[],
		);
		expect([10, 10].map(removed.removed)).toEqual([
			{ key: "R", index: 0 },
			null,
		]);
	});

	it("fails closed: a cluster whose lines don't all map stands for nothing", () => {
		const lines = sinceLineSources(
			new Map([then("K", K)]),
			keyed("K", 3, 5),
			{},
			old,
		);
		expect(lines.added(3)).toBeNull();
	});

	it("a removed base line stands for that removed line of the cluster", () => {
		const lines = sinceLineSources(
			new Map([then("R", ["new"], ["one", "two"])]),
			{},
			keyed("R", 10, 12),
			[],
		);
		expect([10, 11, 12].map(lines.removed)).toEqual([
			{ key: "R", index: 0 },
			{ key: "R", index: 1 },
			null,
		]);
	});

	it("an unknown cluster stands for nothing", () => {
		const lines = sinceLineSources(new Map(), keyed("K", 3, 6), {}, old);
		expect([2, 3].map(lines.added)).toEqual([null, null]);
	});
});
