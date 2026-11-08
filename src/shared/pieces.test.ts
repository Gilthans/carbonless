import { describe, expect, it } from "vitest";
import {
	changeFor,
	clusterAt,
	crossOffChange,
	fitRanges,
	lineIndex,
	lineRuns,
	partlyMarked,
	pieceRanges,
	pieceState,
	reviewedCount,
	sinceMarkKey,
	sinceOnlyState,
	sincePieces,
	sinceToggleChange,
	toggleChange,
	viewOfLines,
} from "./pieces";
import type { Cluster, ClusterView, DiffLine, SinceMark } from "./types";

/** A cluster replacing old lines 10–11 (two) with new lines 20–29 (ten). */
const cluster: Cluster = {
	key: "k".repeat(64),
	kind: "lines",
	oldStart: 10,
	oldCount: 2,
	newStart: 20,
	newCount: 10,
	removed: ["old a", "old b"],
	added: Array.from({ length: 10 }, (_, i) => `new ${i}`),
	lines: 12,
};
const view = (patch: Partial<ClusterView> = {}): ClusterView => ({
	...cluster,
	state: "unreviewed",
	...patch,
});
const add = (newNo: number): DiffLine => ({
	kind: "add",
	newNo,
	text: `new ${newNo - 20}`,
});
const del = (oldNo: number, text: string): DiffLine => ({
	kind: "del",
	oldNo,
	text,
});

describe("pieces of a cluster", () => {
	it("indexes the cluster's own lines: removed first, then added", () => {
		expect(lineIndex(cluster, del(10, "old a"))).toBe(0);
		expect(lineIndex(cluster, del(11, "old b"))).toBe(1);
		expect(lineIndex(cluster, add(20))).toBe(2);
		expect(lineIndex(cluster, add(29))).toBe(11);
		expect(lineIndex(cluster, add(30))).toBeUndefined();
		expect(lineIndex(cluster, del(12, "x"))).toBeUndefined();
		expect(
			lineIndex(cluster, { kind: "context", oldNo: 10, newNo: 20 }),
		).toBeUndefined();
	});

	const vouched = { vouched: () => true };

	it("splits the cluster among its pieces, every line owned once, unshown lines unchanged since a reviewed one to the piece before them", () => {
		// Three pieces: new lines 21, 25–26 and 28 changed since; the rest
		// unchanged since lines reviewed on the compared patch set.
		const ranges = pieceRanges(
			cluster,
			[[add(21)], [add(25), add(26)], [add(28)]],
			vouched,
		);
		expect(ranges).toEqual([
			[[0, 7]], // removed 0–1, added 20–24 (indexes 2–6)
			[[7, 10]], // added 25–27
			[[10, 12]], // added 28–29
		]);
	});

	it("gives a removed line to the piece that shows it, by text when its number is another side's", () => {
		const ranges = pieceRanges(
			cluster,
			[
				[add(22)],
				// The since view numbers a removed line in the compared head.
				[del(57, "old b"), add(27)],
			],
			vouched,
		);
		expect(ranges).toEqual([
			[
				[0, 1],
				[2, 9],
			],
			[
				[1, 2],
				[9, 12],
			],
		]);
	});

	it("a piece showing none of the cluster's lines owns nothing", () => {
		expect(
			pieceRanges(cluster, [[del(3, "gone line")], [add(24)]], vouched),
		).toEqual([null, [[0, 12]]]);
		expect(pieceRanges(cluster, [[del(3, "gone line")]])).toEqual([null]);
		expect(
			pieceRanges({ ...cluster, kind: "file", lines: 0 }, [[add(24)]]),
		).toEqual([null]);
	});

	it("fails closed: an unshown line not unchanged since a reviewed one joins no piece, so ticking them all leaves it unreviewed", () => {
		// New lines 23 and 24 (indexes 5, 6) match no reviewed line then.
		const ranges = pieceRanges(
			cluster,
			[[add(21)], [add(25), add(26)], [add(28)]],
			{ vouched: (i) => i !== 5 && i !== 6 },
		);
		expect(ranges).toEqual([[[0, 5]], [[7, 10]], [[10, 12]]]);
		// With nothing vouched, each piece owns what it shows, nothing more.
		expect(
			pieceRanges(cluster, [[add(21)], [add(25), add(26)], [add(28)]]),
		).toEqual([[[3, 4]], [[7, 9]], [[10, 11]]]);
	});

	it("a removed line the compared patch set added is never one of the cluster's", () => {
		expect(
			pieceRanges(cluster, [[del(57, "old b")]], { baseLine: () => false }),
		).toEqual([null]);
	});

	it("a piece is reviewed when its cluster is, or every line it owns is", () => {
		const piece: [number, number][] = [[7, 10]];
		expect(pieceState(view({ state: "reviewed" }), piece)).toBe("reviewed");
		expect(pieceState(view({ state: "crossed-off" }), piece)).toBe(
			"crossed-off",
		);
		expect(pieceState(view(), piece)).toBe("unreviewed");
		expect(pieceState(view({ reviewedLines: [[6, 10]] }), piece)).toBe(
			"reviewed",
		);
		expect(pieceState(view({ reviewedLines: [[8, 12]] }), piece)).toBe(
			"unreviewed",
		);
	});

	it("ticking a piece adds its lines only; ticking the last makes the cluster reviewed; unticking one takes its lines away", () => {
		const a: [number, number][] = [[0, 7]];
		const b: [number, number][] = [[7, 10]];
		const c: [number, number][] = [[10, 12]];
		const k = cluster.key;
		expect(toggleChange(view(), b)).toEqual({
			key: k,
			state: "unreviewed",
			reviewedLines: b,
		});
		expect(toggleChange(view({ reviewedLines: [[7, 12]] }), a)).toEqual({
			key: k,
			state: "reviewed",
		});
		expect(toggleChange(view({ state: "reviewed" }), b)).toEqual({
			key: k,
			state: "unreviewed",
			reviewedLines: [
				[0, 7],
				[10, 12],
			],
		});
		expect(toggleChange(view({ reviewedLines: c }), c)).toEqual({
			key: k,
			state: "unreviewed",
		});
		// A carried mark is the cluster's: unticking a piece keeps the rest.
		expect(
			toggleChange(
				view({ state: "reviewed", carried: { from: 1, rule: "exact" } }),
				c,
			),
		).toEqual({ key: k, state: "unreviewed", reviewedLines: [[0, 10]] });
	});

	it("without a piece the checkbox is the whole cluster's: mixed and unreviewed to reviewed, reviewed to unreviewed, crossed off undone", () => {
		const k = cluster.key;
		expect(toggleChange(view({ reviewedLines: [[0, 3]] }))).toEqual({
			key: k,
			state: "reviewed",
		});
		expect(toggleChange(view())).toEqual({ key: k, state: "reviewed" });
		expect(toggleChange(view({ state: "reviewed" }))).toEqual({
			key: k,
			state: "unreviewed",
		});
		expect(toggleChange(view({ state: "crossed-off" }))).toEqual({
			key: k,
			state: "unreviewed",
		});
	});

	it("a piece's box undoes its own cross-off only; its cross-off toggle crosses off its lines only", () => {
		const k = cluster.key;
		expect(toggleChange(view({ state: "crossed-off" }), [[0, 3]])).toEqual({
			key: k,
			state: "unreviewed",
			crossedLines: [[3, 12]],
		});
		expect(
			crossOffChange(view({ reviewedLines: [[0, 7]] }), [[7, 10]]),
		).toEqual({
			key: k,
			state: "unreviewed",
			reviewedLines: [[0, 7]],
			crossedLines: [[7, 10]],
		});
		expect(
			crossOffChange(view({ crossedLines: [[7, 10]] }), [[7, 10]]),
		).toEqual({ key: k, state: "unreviewed" });
		expect(
			crossOffChange(view({ crossedLines: [[0, 10]] }), [[10, 12]]),
		).toEqual({ key: k, state: "crossed-off" });
		expect(crossOffChange(view())).toEqual({ key: k, state: "crossed-off" });
		expect(pieceState(view({ crossedLines: [[7, 10]] }), [[7, 10]])).toBe(
			"crossed-off",
		);
		expect(partlyMarked(view({ crossedLines: [[7, 10]] }))).toBe(true);
		expect(
			partlyMarked(view({ state: "reviewed", crossedLines: [[7, 10]] })),
		).toBe(false);
	});

	it("lays lines out as the views show them: done mixed counts reviewed with its crossed lines", () => {
		expect(viewOfLines(cluster, [[0, 10]], [[10, 12]])).toMatchObject({
			state: "reviewed",
			crossedLines: [[10, 12]],
		});
		expect(viewOfLines(cluster, [], [[0, 12]])?.state).toBe("crossed-off");
		expect(viewOfLines(cluster, [[0, 3]], [])).toMatchObject({
			state: "unreviewed",
			reviewedLines: [[0, 3]],
		});
		expect(viewOfLines(cluster, [[0, 13]], [])).toBeNull();
	});

	it("changeFor names the whole cluster when its lines are all or none", () => {
		expect(changeFor(cluster, [[0, 12]])).toEqual({
			key: cluster.key,
			state: "reviewed",
		});
		expect(changeFor(cluster, [])).toEqual({
			key: cluster.key,
			state: "unreviewed",
		});
	});

	it("counts reviewed lines, and fits only ranges within the cluster", () => {
		expect(reviewedCount(view({ state: "reviewed" }))).toBe(12);
		expect(reviewedCount(view({ reviewedLines: [[2, 5]] }))).toBe(3);
		expect(reviewedCount(view({ state: "crossed-off" }))).toBe(0);
		expect(fitRanges(cluster, [[0, 12]])).toEqual([[0, 12]]);
		expect(fitRanges(cluster, [[10, 13]])).toBeNull();
		expect(fitRanges({ kind: "file", lines: 0 }, [[0, 1]])).toBeNull();
	});
});

describe("the since view's pieces", () => {
	const ctx = (oldNo: number, newNo: number): DiffLine => ({
		kind: "context",
		oldNo,
		newNo,
		text: `c${newNo}`,
	});
	const keyed = (line: DiffLine, key?: string): DiffLine =>
		key === undefined ? line : { ...line, clusterKey: key };

	it("runs: an unkeyed removal is a run of its own, never part of the context", () => {
		const lines = [ctx(1, 1), del(2, "x"), ctx(3, 2), keyed(add(3), "k")];
		expect(
			lineRuns(lines).map((r) => [r.change, r.key, r.lines.length]),
		).toEqual([
			[false, undefined, 1],
			[true, undefined, 1],
			[false, undefined, 1],
			[true, "k", 1],
		]);
	});

	it("finds the cluster at a removal's place", () => {
		expect(clusterAt([cluster], 19)?.key).toBe(cluster.key); // before line 20
		expect(clusterAt([cluster], 29)?.key).toBe(cluster.key);
		expect(clusterAt([cluster], 30)).toBeUndefined();
		expect(clusterAt([cluster], 5)).toBeUndefined();
	});

	it("every run of changed lines is a piece: a cluster's own, or one on its own lines, reverted or removed", () => {
		const pieces = sincePieces(
			[
				{
					newStart: 1,
					lines: [
						ctx(1, 1),
						// Lines the compared head had, gone, far from any cluster: reverted.
						del(2, "a"),
						del(3, "b"),
						ctx(4, 2),
						ctx(20, 19),
						keyed(add(21), cluster.key),
						ctx(21, 22),
						// Next to the cluster, owning none of its lines: removed.
						keyed(del(22, "not in it"), cluster.key),
						ctx(23, 23),
					],
				},
			],
			[cluster],
			() => ({ vouched: () => true }),
		);
		expect(pieces).toEqual([
			{
				hunk: 0,
				line: 1,
				owns: null,
				old: [[2, 4]],
				new: [],
				kind: "reverted",
			},
			{
				hunk: 0,
				line: 5,
				key: cluster.key,
				owns: [[0, 12]],
				old: [],
				new: [[21, 22]],
			},
			{
				hunk: 0,
				line: 7,
				key: cluster.key,
				owns: null,
				old: [[22, 23]],
				new: [],
				kind: "removed",
			},
		]);
	});

	it("marks a piece on its own lines: the comparison's whole set, ticked, crossed off, undone", () => {
		const piece = { old: [[2, 4]] as [number, number][], new: [] };
		const tick = sinceToggleChange(undefined, 1, "a.ts", piece);
		expect(tick).toEqual({
			key: sinceMarkKey(1, "a.ts"),
			state: "reviewed",
			sinceMark: {
				since: 1,
				path: "a.ts",
				reviewed: { old: [[2, 4]], new: [] },
				crossed: { old: [], new: [] },
			},
		});
		const marks = [tick.sinceMark as SinceMark];
		expect(sinceOnlyState(marks, 1, "a.ts", piece)).toBe("reviewed");
		expect(sinceOnlyState(marks, 2, "a.ts", piece)).toBe("unreviewed");
		expect(sinceOnlyState(marks, 1, "b.ts", piece)).toBe("unreviewed");
		const cross = sinceToggleChange(marks, 1, "a.ts", piece, true);
		expect(cross.sinceMark).toEqual({
			since: 1,
			path: "a.ts",
			reviewed: { old: [], new: [] },
			crossed: { old: [[2, 4]], new: [] },
		});
		const undo = sinceToggleChange(
			[cross.sinceMark as SinceMark],
			1,
			"a.ts",
			piece,
		);
		expect(undo.state).toBe("unreviewed");
		expect(undo.sinceMark?.crossed).toEqual({ old: [], new: [] });
	});
});
