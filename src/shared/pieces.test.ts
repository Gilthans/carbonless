import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { blockOfLine, markdownBlocks } from "./markdownBlocks";
import type { SincePiece } from "./pieces";
import {
	changeFor,
	clusterAt,
	crossOffChange,
	cutRunsAtBlocks,
	fitRanges,
	lineIndex,
	lineRuns,
	partlyMarked,
	pieceRanges,
	pieceState,
	reviewedCount,
	sinceFileChange,
	sinceMarkKey,
	sinceOnlyPieces,
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

	it("gives a removed line to the piece that shows it, by its place in the base (the since view numbers it in the compared head)", () => {
		const ranges = pieceRanges(
			cluster,
			[[add(22)], [del(57, "old b"), add(27)]],
			{ ...vouched, baseNo: (l) => (l.oldNo === 57 ? 11 : undefined) },
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

	it("a removed line the engine can't place in the base (the compared patch set added it) is never one of the cluster's", () => {
		expect(
			pieceRanges(cluster, [[del(57, "old b")]], { baseNo: () => undefined }),
		).toEqual([null]);
	});

	it("without the engine's placement, a shown removed line is none of the cluster's (never read in the full diff's numbering)", () => {
		// del(10, "old a") would be index 0 in the full diff's numbering.
		expect(pieceRanges(cluster, [[del(10, "old a")]])).toEqual([null]);
	});

	it("never by text: a shown blank line owns its own place, not an unshown twin (principle 2)", () => {
		const twins: Cluster = {
			...cluster,
			oldStart: 10,
			oldCount: 4,
			newCount: 1,
			removed: ["x", "", "y", ""],
			added: ["n0"],
			lines: 5,
		};
		// Base line 11 (index 1), numbered 13 in the compared head (two lines added above).
		const shown = [del(13, "")];
		expect(
			pieceRanges(twins, [shown], {
				baseNo: (l) => (l.oldNo === 13 ? 11 : undefined),
			}),
		).toEqual([[[1, 2]]]);
		// Unmapped: nothing, never the twin at index 3.
		expect(pieceRanges(twins, [shown], { baseNo: () => undefined })).toEqual([
			null,
		]);
		// A place whose text differs owns nothing either.
		expect(pieceRanges(twins, [shown], { baseNo: () => 10 })).toEqual([null]);
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

	it("whole-file marks move only the given pieces of the file's own mark (CAR-155)", () => {
		type R = [number, number][];
		const a = { old: [[1, 3]] as R, new: [] as R };
		const b = { old: [] as R, new: [[5, 6]] as R };
		const c = { old: [[9, 10]] as R, new: [] as R };
		// b already crossed off; another file's mark and another
		// comparison's must stay as they are.
		const other: SinceMark = {
			since: 1,
			path: "b.ts",
			reviewed: { old: [[1, 3]], new: [] },
			crossed: { old: [], new: [] },
		};
		const older: SinceMark = { ...other, since: 2, path: "a.ts" };
		const marks: SinceMark[] = [
			other,
			older,
			{
				since: 1,
				path: "a.ts",
				reviewed: { old: [], new: [] },
				crossed: { old: [], new: [[5, 6]] },
			},
		];
		const tick = sinceFileChange(marks, 1, "a.ts", [a, b, c], "reviewed");
		expect(tick).toEqual({
			key: sinceMarkKey(1, "a.ts"),
			state: "reviewed",
			sinceMark: {
				since: 1,
				path: "a.ts",
				reviewed: {
					old: [
						[1, 3],
						[9, 10],
					],
					new: [],
				},
				crossed: { old: [], new: [[5, 6]] },
			},
		});
		const after = [other, older, tick?.sinceMark as SinceMark];
		for (const p of [a, c])
			expect(sinceOnlyState(after, 1, "a.ts", p)).toBe("reviewed");
		expect(sinceOnlyState(after, 1, "a.ts", b)).toBe("crossed-off");
		// Nothing left to mark: no change.
		expect(sinceFileChange(after, 1, "a.ts", [a, b, c], "reviewed")).toBe(null);
		expect(sinceFileChange(after, 1, "a.ts", [a, b, c], "crossed-off")).toBe(
			null,
		);
		// Resets take back only their kind.
		const unReview = sinceFileChange(
			after,
			1,
			"a.ts",
			[a, b, c],
			"reset-reviewed",
		);
		expect(unReview?.state).toBe("unreviewed");
		expect(unReview?.sinceMark).toEqual({
			since: 1,
			path: "a.ts",
			reviewed: { old: [], new: [] },
			crossed: { old: [], new: [[5, 6]] },
		});
		const unCross = sinceFileChange(
			after,
			1,
			"a.ts",
			[a, b, c],
			"reset-crossed-off",
		);
		expect(unCross?.sinceMark?.crossed).toEqual({ old: [], new: [] });
		expect(unCross?.sinceMark?.reviewed).toEqual(tick?.sinceMark?.reviewed);
		// Crossing off marks every unreviewed piece crossed, none reviewed.
		const cross = sinceFileChange(undefined, 1, "a.ts", [a, c], "crossed-off");
		expect(cross?.sinceMark).toEqual({
			since: 1,
			path: "a.ts",
			reviewed: { old: [], new: [] },
			crossed: {
				old: [
					[1, 3],
					[9, 10],
				],
				new: [],
			},
		});
	});

	it("since-only pieces: those owning no line of a viewed cluster", () => {
		const own = {
			hunk: 0,
			line: 0,
			key: "k1",
			owns: [[0, 1]] as [number, number][],
			old: [],
			new: [],
		};
		const goneKey = { ...own, key: "g1", owns: null };
		const notInView = { ...own, key: "k2" };
		const reverted = { hunk: 0, line: 3, owns: null, old: [], new: [] };
		expect(
			sinceOnlyPieces([own, goneKey, notInView, reverted], new Set(["k1"])),
		).toEqual([goneKey, notInView, reverted]);
		expect(sinceOnlyPieces([own], new Set())).toEqual([own]);
	});
});

describe("the since view's pieces of a Markdown file, cut at its blocks (CAR-167)", () => {
	const line = (
		kind: DiffLine["kind"],
		oldNo: number | undefined,
		newNo: number | undefined,
		text: string,
		clusterKey?: string,
	): DiffLine => ({
		kind,
		...(oldNo === undefined ? {} : { oldNo }),
		...(newNo === undefined ? {} : { newNo }),
		text,
		...(clusterKey === undefined ? {} : { clusterKey }),
	});
	const sides = (oldLines: string[], newLines: string[]) => ({
		old: markdownBlocks(oldLines),
		new: markdownBlocks(newLines),
	});
	/** A piece's lines in its hunk: its run (lineRuns) from its first line. */
	const textOf = (
		hunks: readonly { lines: readonly DiffLine[] }[],
		p: { hunk: number; line: number },
	) => {
		const lines = hunks[p.hunk]?.lines ?? [];
		const run = lineRuns(lines.slice(p.line))[0];
		return run?.lines.map((l) => `${l.kind === "add" ? "+" : "-"}${l.text}`);
	};

	// The viewed snapshot's one cluster: two list items edited (old 3–4 → new 3–4).
	const oldLines = ["# Title", "", "- one", "- two", ""];
	const newLines = ["# Title", "", "- one!", "- two!", ""];
	const list: Cluster = {
		key: "l".repeat(64),
		kind: "lines",
		oldStart: 3,
		oldCount: 2,
		newStart: 3,
		newCount: 2,
		removed: ["- one", "- two"],
		added: ["- one!", "- two!"],
		lines: 4,
	};
	const k = list.key;
	const listHunk = {
		newStart: 1,
		lines: [
			line("context", 1, 1, "# Title"),
			line("context", 2, 2, ""),
			line("del", 3, undefined, "- one", k),
			line("del", 4, undefined, "- two", k),
			line("add", undefined, 3, "- one!", k),
			line("add", undefined, 4, "- two!", k),
			line("context", 5, 5, ""),
		],
	};
	const facts = () => ({ baseNo: (l: DiffLine) => l.oldNo });

	it("a run across two list items of one cluster is two pieces, each owning only its item's lines", () => {
		const whole = sincePieces([listHunk], [list], facts);
		expect(whole.map((p) => p.owns)).toEqual([[[0, 4]]]);
		const hunks = cutRunsAtBlocks([listHunk], sides(oldLines, newLines));
		const pieces = sincePieces(hunks, [list], facts);
		expect(pieces.map((p) => textOf(hunks, p))).toEqual([
			["-- one", "+- one!"],
			["-- two", "+- two!"],
		]);
		expect(pieces).toEqual([
			{
				hunk: 0,
				line: 2,
				key: k,
				owns: [
					[0, 1],
					[2, 3],
				],
				old: [[3, 4]],
				new: [[3, 4]],
			},
			{
				hunk: 0,
				line: 4,
				key: k,
				owns: [
					[1, 2],
					[3, 4],
				],
				old: [[4, 5]],
				new: [[4, 5]],
			},
		]);
		// The context stays where it was; only the run's lines are regrouped.
		expect(hunks[0]?.lines.filter((l) => l.kind === "context")).toEqual(
			listHunk.lines.filter((l) => l.kind === "context"),
		);
	});

	it("a run marked before the cut reads the same per line: every block piece of it is marked", () => {
		const [whole] = sincePieces([listHunk], [list], facts);
		const cut = sincePieces(
			cutRunsAtBlocks([listHunk], sides(oldLines, newLines)),
			[list],
			facts,
		);
		const marked = toggleChange(
			{ ...list, state: "unreviewed" },
			whole?.owns ?? undefined,
		);
		const after: ClusterView = {
			...list,
			state: marked.state,
			...(marked.reviewedLines ? { reviewedLines: marked.reviewedLines } : {}),
		};
		expect(cut).toHaveLength(2);
		for (const p of cut) {
			expect(pieceState(after, p.owns ?? [])).toBe("reviewed");
		}
		// A piece of its own (lines the compared patch set had, gone): its
		// file mark holds each block piece's lines too.
		const goneHunk = {
			newStart: 1,
			lines: [
				line("context", 1, 1, "# Title"),
				line("context", 2, 2, ""),
				line("del", 3, undefined, "- one"),
				line("del", 4, undefined, "- two"),
				line("context", 5, 3, ""),
			],
		};
		const [gone] = sincePieces([goneHunk], []);
		const tick = sinceToggleChange(undefined, 1, "a.md", gone as SincePiece);
		const marks = [tick.sinceMark as SinceMark];
		const goneCut = sincePieces(
			cutRunsAtBlocks([goneHunk], sides(oldLines, ["# Title", "", ""])),
			[],
		);
		expect(goneCut.map((p) => p.old)).toEqual([[[3, 4]], [[4, 5]]]);
		for (const p of goneCut) {
			expect(sinceOnlyState(marks, 1, "a.md", p)).toBe("reviewed");
		}
	});

	it("a whitespace-only change inside a paragraph keeps one piece per cluster, as without the cut", () => {
		const para: Cluster = {
			key: "p".repeat(64),
			kind: "lines",
			oldStart: 1,
			oldCount: 1,
			newStart: 1,
			newCount: 1,
			removed: ["Some text here."],
			added: ["Some  text here."],
			lines: 2,
			whitespaceOnly: true,
		};
		const hunk = {
			newStart: 1,
			lines: [
				line("del", 1, undefined, "Some text here.", para.key),
				line("add", undefined, 1, "Some  text here.", para.key),
				line("context", 2, 2, "more words."),
			],
		};
		const hunks = cutRunsAtBlocks(
			[hunk],
			sides(
				["Some text here.", "more words."],
				["Some  text here.", "more words."],
			),
		);
		expect(hunks[0]).toBe(hunk);
		expect(sincePieces(hunks, [para], facts)).toEqual(
			sincePieces([hunk], [para], facts),
		);
	});

	it("a run whose removals don't all come before its additions isn't cut", () => {
		const hunk = {
			newStart: 1,
			lines: [
				line("add", undefined, 3, "- one!", k),
				line("del", 3, undefined, "- one", k),
				line("del", 4, undefined, "- two", k),
				line("add", undefined, 4, "- two!", k),
			],
		};
		expect(cutRunsAtBlocks([hunk], sides(oldLines, newLines))[0]).toBe(hunk);
	});

	/** A line diff of two texts (LCS), each run of changes its removals first. */
	const diffLines = (a: string[], b: string[]): DiffLine[] => {
		const n = a.length;
		const m = b.length;
		const table = new Array<number>((n + 1) * (m + 1)).fill(0);
		const lcs = (i: number, j: number) => table[i * (m + 1) + j] as number;
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				table[i * (m + 1) + j] =
					a[i] === b[j]
						? lcs(i + 1, j + 1) + 1
						: Math.max(lcs(i + 1, j), lcs(i, j + 1));
			}
		}
		const out: DiffLine[] = [];
		let dels: DiffLine[] = [];
		let adds: DiffLine[] = [];
		const flush = () => {
			out.push(...dels, ...adds);
			dels = [];
			adds = [];
		};
		let i = 0;
		let j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && a[i] === b[j]) {
				flush();
				out.push(line("context", i + 1, j + 1, a[i] as string));
				i++;
				j++;
			} else if (j >= m || (i < n && lcs(i + 1, j) >= lcs(i, j + 1))) {
				dels.push(line("del", i + 1, undefined, a[i] as string));
				i++;
			} else {
				adds.push(line("add", undefined, j + 1, b[j] as string));
				j++;
			}
		}
		flush();
		return out;
	};
	const LINE = fc.constantFrom(
		"",
		"# Title",
		"## Section",
		"- item one",
		"- item two",
		"  - nested",
		"1. first",
		"> quoted",
		"```",
		"code()",
		"| a | b |",
		"| - | - |",
		"| x | y |",
		"plain text",
		"more words here",
	);
	/** An edit of `lines`: `count` lines at `at` replaced by `put`. */
	const EDIT = fc.record({
		at: fc.nat(),
		count: fc.nat({ max: 6 }),
		put: fc.array(LINE, { maxLength: 6 }),
	});
	const apply = (
		lines: string[],
		edits: { at: number; count: number; put: string[] }[],
	) => {
		const out = [...lines];
		for (const e of edits) {
			const at = e.at % (out.length + 1);
			out.splice(at, e.count, ...e.put);
		}
		return out;
	};

	it("every changed line is in exactly one piece, each piece one run (random edits on both patch sets)", () => {
		fc.assert(
			fc.property(
				fc.array(LINE, { maxLength: 25 }),
				fc.array(EDIT, { maxLength: 4 }),
				fc.array(EDIT, { maxLength: 4 }),
				fc.array(fc.constantFrom("a", "b", undefined), {
					minLength: 1,
					maxLength: 5,
				}),
				(base, edits1, edits2, keys) => {
					const ps1 = apply(base, edits1);
					const ps2 = apply(base, edits2);
					const lines = diffLines(ps1, ps2).map((l, i) => {
						const key = keys[i % keys.length];
						return l.kind === "context" || key === undefined
							? l
							: { ...l, clusterKey: key };
					});
					const hunk = { newStart: 1, lines };
					const [cut] = cutRunsAtBlocks([hunk], sides(ps1, ps2));
					const id = (l: DiffLine) => `${l.kind}:${l.oldNo}:${l.newNo}`;
					// The same lines, context in place, keys kept.
					expect(
						cut?.lines.map((l) => `${id(l)}:${l.clusterKey}`).sort(),
					).toEqual(lines.map((l) => `${id(l)}:${l.clusterKey}`).sort());
					cut?.lines.forEach((l, i) => {
						if (l.kind === "context" || lines[i]?.kind === "context") {
							expect(l).toEqual(lines[i]);
						}
					});
					const pieces = sincePieces([cut as typeof hunk], []);
					const dels = lines.flatMap((l) =>
						l.kind === "del" ? [l.oldNo as number] : [],
					);
					const adds = lines.flatMap((l) =>
						l.kind === "add" ? [l.newNo as number] : [],
					);
					const olds = pieces.flatMap((p) =>
						p.old.flatMap(([f, t]) =>
							Array.from({ length: t - f }, (_, i) => f + i),
						),
					);
					const news = pieces.flatMap((p) =>
						p.new.flatMap(([f, t]) =>
							Array.from({ length: t - f }, (_, i) => f + i),
						),
					);
					expect(olds.sort((x, y) => x - y)).toEqual(dels);
					expect(news.sort((x, y) => x - y)).toEqual(adds);
					// Each piece is a run of its own, with its first line.
					const runs = lineRuns(cut?.lines ?? []).filter((r) => r.change);
					expect(pieces).toHaveLength(runs.length);
					// A cut piece's added lines lie in one block of the new side.
					const newBlocks = markdownBlocks(ps2);
					for (const r of runs) {
						if (r.lines[0]?.blockPiece === undefined) continue;
						const blocks = new Set(
							r.lines.flatMap((l) =>
								l.newNo === undefined ? [] : [blockOfLine(newBlocks, l.newNo)],
							),
						);
						expect(blocks.size).toBeLessThanOrEqual(1);
					}
				},
			),
			{ numRuns: 300 },
		);
	});
});
