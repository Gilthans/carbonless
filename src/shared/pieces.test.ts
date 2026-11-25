import { describe, expect, it } from "vitest";
import { fromIndexes } from "./lineRanges";
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
	sinceFileChange,
	sinceMarkKey,
	sinceOnlyPieces,
	sinceOnlyState,
	sincePieces,
	sinceToggleChange,
	sinceUnits,
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
		// Lines just before the cluster are none of its lines either.
		expect(lineIndex(cluster, add(19))).toBeUndefined();
		expect(lineIndex(cluster, del(9, "x"))).toBeUndefined();
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
		// The cross-off toggle undoes a whole cross-off.
		expect(crossOffChange(view({ state: "crossed-off" }))).toEqual({
			key: k,
			state: "unreviewed",
		});
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

	it("orphan lines (CAR-216) are a piece of their own: never merged with their cluster's shown lines, owning exactly theirs, unchipped", () => {
		const orphan = (line: DiffLine): DiffLine => ({
			...line,
			clusterKey: cluster.key,
			orphan: true,
		});
		const lines = [
			ctx(1, 19),
			// Base line 10, removed: no number here, its base number instead.
			orphan({ kind: "del", text: "old a", baseNo: 10 }),
			keyed(add(20), cluster.key),
			orphan(add(21)),
			orphan(add(22)),
			keyed(add(23), cluster.key),
			ctx(2, 30),
		];
		expect(
			lineRuns(lines).map((r) => [r.change, r.orphan, r.lines.length]),
		).toEqual([
			[false, undefined, 1],
			[true, true, 1],
			[true, undefined, 1],
			[true, true, 2],
			[true, undefined, 1],
			[false, undefined, 1],
		]);
		const pieces = sincePieces([{ newStart: 19, lines }], [cluster], () => ({
			baseNo: (line) => (line.orphan ? (line.baseNo ?? undefined) : undefined),
		}));
		expect(pieces).toEqual([
			{
				hunk: 0,
				line: 1,
				key: cluster.key,
				orphan: true,
				owns: [[0, 1]],
				old: [],
				new: [],
			},
			{
				hunk: 0,
				line: 2,
				key: cluster.key,
				owns: [[2, 3]],
				old: [],
				new: [[20, 21]],
			},
			{
				hunk: 0,
				line: 3,
				key: cluster.key,
				orphan: true,
				owns: [[3, 5]],
				old: [],
				new: [[21, 23]],
			},
			{
				hunk: 0,
				line: 5,
				key: cluster.key,
				owns: [[5, 6]],
				old: [],
				new: [[23, 24]],
			},
		]);
		// The since view's units count an orphan's own lines (a removed one
		// has no number here).
		const units = sinceUnits(
			[
				{
					index: 0,
					path: "a.ts",
					clusters: [{ key: cluster.key, kind: "new" }],
					pieces,
				},
			],
			1,
			() => [view()],
			undefined,
		);
		expect(units.filter((u) => !u.rest).map((u) => u.lines)).toEqual([
			1, 1, 2, 1,
		]);
		// An orphan run with none of its cluster's lines is no piece.
		expect(
			sincePieces(
				[{ newStart: 1, lines: [ctx(1, 1), orphan(add(40))] }],
				[cluster],
			),
		).toEqual([]);
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
		// Crossing off a crossed-off piece undoes it too.
		const uncross = sinceToggleChange(
			[cross.sinceMark as SinceMark],
			1,
			"a.ts",
			piece,
			true,
		);
		expect(uncross.state).toBe("unreviewed");
		expect(uncross.sinceMark?.crossed).toEqual({ old: [], new: [] });
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

describe("the since view's pieces cut at whitespace runs (CAR-218)", () => {
	const line = (
		kind: "add" | "del" | "context",
		no: number,
		key?: string,
	): DiffLine => ({
		kind,
		text: `${kind} ${no}`,
		...(kind !== "add" ? { oldNo: no } : {}),
		...(kind !== "del" ? { newNo: no } : {}),
		...(key === undefined || kind === "context" ? {} : { clusterKey: key }),
	});

	it("a run mixing whitespace-only and changed lines is one piece per stretch; flagged only when every line is marked", () => {
		const lines = [
			line("context", 1),
			line("del", 2, "k"),
			line("del", 3, "k"),
			line("del", 4, "k"),
			line("add", 2, "k"),
			line("add", 3, "k"),
			line("add", 4, "k"),
			line("context", 5),
		];
		const [, d2, d3, , a2, , a4] = lines as DiffLine[];
		const ws = new Set([d2, d3, a2, a4] as DiffLine[]);
		const pieces = sincePieces([{ newStart: 1, lines }], [], () => ({}), {
			lines: ws,
			marked: (l) => l !== a4,
		});
		expect(
			pieces.map((p) => [p.line, p.old, p.new, p.whitespaceOnly === true]),
		).toEqual([
			[1, [[2, 4]], [], true],
			[3, [[4, 5]], [], false],
			[4, [], [[2, 3]], true],
			[5, [], [[3, 4]], false],
			// Whitespace-only on the interdiff, but its line wasn't marked then.
			[6, [], [[4, 5]], false],
		]);
		// Without `ws`: one piece per run, never flagged (as before).
		const plain = sincePieces([{ newStart: 1, lines }], []);
		expect(plain.map((p) => [p.line, p.whitespaceOnly])).toEqual([
			[1, undefined],
		]);
	});

	it("pieces split at whitespace runs: every changed line in exactly one piece, in order, each piece all whitespace-only or none (any hunks)", () => {
		let seed = 3218;
		const rand = (k: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return (seed >>> 16) % k;
		};
		for (let round = 0; round < 300; round++) {
			const hunks: { newStart: number; lines: DiffLine[] }[] = [];
			const ws = new Set<DiffLine>();
			let no = 1;
			for (let h = 0; h < 1 + rand(3); h++) {
				const lines: DiffLine[] = [];
				for (let i = 0; i < 1 + rand(14); i++) {
					const kind = (["add", "del", "context"] as const)[rand(3)];
					const key = ["a", "b", undefined][rand(3)];
					const l = line(kind ?? "context", no++, key);
					if (l.kind !== "context" && rand(2) === 0) ws.add(l);
					lines.push(l);
				}
				hunks.push({ newStart: no, lines });
			}
			const marked = new Set([...ws].filter(() => rand(3) > 0));
			const pieces = sincePieces(hunks, [], () => ({}), {
				lines: ws,
				marked: (l) => marked.has(l),
			});
			const seen: DiffLine[] = [];
			for (const p of pieces) {
				const run: DiffLine[] = [];
				for (const l of hunks[p.hunk]?.lines.slice(p.line) ?? []) {
					if (l.kind === "context") break;
					if (run.length > 0) {
						const prev = run.at(-1) as DiffLine;
						if (prev.clusterKey !== l.clusterKey) break;
						if (ws.has(prev) !== ws.has(l)) break;
					}
					run.push(l);
				}
				expect(run.length).toBeGreaterThan(0);
				const flagged = run.every((l) => ws.has(l) && marked.has(l));
				expect(p.whitespaceOnly === true).toBe(flagged);
				// Its numbers are its lines'.
				expect(p.old).toEqual(
					fromIndexes(
						run.flatMap((l) => (l.kind === "del" ? [l.oldNo as number] : [])),
					),
				);
				expect(p.new).toEqual(
					fromIndexes(
						run.flatMap((l) => (l.kind === "add" ? [l.newNo as number] : [])),
					),
				);
				seen.push(...run);
			}
			const changed = hunks.flatMap((hk) =>
				hk.lines.filter((l) => l.kind !== "context"),
			);
			expect(seen).toEqual(changed);
		}
	});

	it("a file-level cluster no piece owns is one unit, unreviewed until marked (principle 2)", () => {
		// A binary or mode change: no lines, so nothing of it is ever "rest".
		const fileLevel: Cluster = {
			key: "f".repeat(64),
			kind: "file",
			label: "Binary file changed",
			oldStart: 0,
			oldCount: 0,
			newStart: 0,
			newCount: 0,
			removed: [],
			added: [],
			lines: 0,
		};
		const units = (kind: string, state: ClusterView["state"]) =>
			sinceUnits(
				[
					{
						index: 0,
						path: "a.bin",
						clusters: [{ key: fileLevel.key, kind }],
					},
				],
				1,
				() => [{ ...fileLevel, state }],
				undefined,
			).map(({ kind, state, lines, open }) => ({ kind, state, lines, open }));
		for (const kind of ["new", "reworked"]) {
			expect(units(kind, "unreviewed")).toEqual([
				{ kind, state: "unreviewed", lines: 0, open: 0 },
			]);
			expect(units(kind, "reviewed")).toEqual([
				{ kind, state: "reviewed", lines: 0, open: 0 },
			]);
		}
	});

	it("the rest of a cluster is reviewed once its own lines are, whatever its pieces' state", () => {
		// A piece owns lines 0–1 (unmarked); lines 2–11, the rest, reviewed.
		const piece = {
			hunk: 0,
			line: 0,
			key: cluster.key,
			owns: [[0, 2]] as [number, number][],
			old: [[10, 12]] as [number, number][],
			new: [],
		};
		const units = sinceUnits(
			[
				{
					index: 0,
					path: "a.ts",
					clusters: [{ key: cluster.key, kind: "reworked" }],
					pieces: [piece],
				},
			],
			1,
			() => [view({ reviewedLines: [[2, 12]] })],
			undefined,
		);
		expect(units.map(({ rest, state }) => [rest === true, state])).toEqual([
			[false, "unreviewed"],
			[true, "reviewed"],
		]);
	});

	it("the rest of a cluster counts only its unmarked lines open", () => {
		// Lines 0–4 reviewed, 5 crossed off, 6–11 unmarked: six open.
		const units = sinceUnits(
			[
				{
					index: 0,
					path: "a.ts",
					clusters: [{ key: cluster.key, kind: "reworked" }],
				},
			],
			1,
			() => [view({ reviewedLines: [[0, 5]], crossedLines: [[5, 6]] })],
			undefined,
		);
		expect(
			units.map(({ state, lines, open }) => ({ state, lines, open })),
		).toEqual([{ state: "unreviewed", lines: 12, open: 6 }]);
		// Every line marked: no line open.
		const done = sinceUnits(
			[
				{
					index: 0,
					path: "a.ts",
					clusters: [{ key: cluster.key, kind: "reworked" }],
				},
			],
			1,
			() => [view({ state: "reviewed" })],
			undefined,
		);
		expect(done.map(({ state, open }) => ({ state, open }))).toEqual([
			{ state: "reviewed", open: 0 },
		]);
	});

	it("a piece's unit takes the piece's flag, the rest of a cluster its cluster's", () => {
		const ws: Cluster = { ...cluster, whitespaceOnly: true };
		const piece = {
			hunk: 0,
			line: 0,
			key: ws.key,
			owns: [[2, 3]] as [number, number][],
			old: [],
			new: [[22, 23]] as [number, number][],
		};
		const free = {
			hunk: 0,
			line: 4,
			owns: null,
			old: [[40, 41]] as [number, number][],
			new: [],
			kind: "reverted" as const,
		};
		const units = (pieces: object[]) =>
			sinceUnits(
				[
					{
						index: 0,
						path: "a.ts",
						clusters: [{ key: ws.key, kind: "reworked" }],
						pieces: pieces as never,
					},
				],
				1,
				() => [{ ...ws, state: "unreviewed" }],
				undefined,
			).map((u) => [u.rest === true, u.whitespaceOnly === true]);
		// A real change since, in a cluster whitespace-only against the base: counts.
		expect(units([piece, free])).toEqual([
			[false, false],
			[false, false],
			[true, true],
		]);
		expect(
			units([
				{ ...piece, whitespaceOnly: true },
				{ ...free, whitespaceOnly: true },
			]),
		).toEqual([
			[false, true],
			[false, true],
			[true, true],
		]);
	});
});
