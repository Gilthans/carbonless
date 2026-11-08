import { describe, expect, it } from "vitest";
import type { SincePiece } from "../../shared/pieces";
import type {
	ClusterState,
	FileView,
	RereviewAnswer,
	ReviewView,
	SinceMark,
} from "../../shared/types";
import {
	carriedCount,
	eyesOf,
	goneFiles,
	liveToRead,
	nothingSince,
	shownView,
	sinceByFile,
	sinceProgress,
	toReadClusters,
	toReadCount,
	unitsOf,
} from "./since";

const cluster = (
	key: string,
	state: ClusterState,
	carried = false,
	lines = 2,
): FileView["clusters"][number] => ({
	key,
	kind: "lines",
	oldStart: 1,
	oldCount: 1,
	newStart: 1,
	newCount: 1,
	removed: ["a"],
	added: ["b"],
	lines,
	state,
	...(carried ? { carried: { from: 1, rule: "exact" as const } } : {}),
});

const file = (
	index: number,
	path: string,
	clusters: FileView["clusters"],
): FileView => ({
	index,
	path,
	status: "modified",
	binary: false,
	submodule: false,
	additions: 1,
	deletions: 1,
	clusters,
	done: clusters.every((c) => c.state !== "unreviewed"),
	reviewed: clusters.every((c) => c.state === "reviewed"),
	crossedOff: false,
});

const counts = { total: 0, reviewed: 0, crossedOff: 0 };
const view = (files: FileView[]): ReviewView => ({
	revision: "r2",
	patchset: 2,
	files,
	progress: { clusters: counts, lines: counts, files: { ...counts, done: 0 } },
});

const answer = (
	files: RereviewAnswer["files"],
	toRead = { files: 1, clusters: 2 },
): RereviewAnswer => ({
	from: 1,
	toHead: "h",
	toRevision: "r2",
	shape: {
		code: "S1",
		commits: 1,
		identical: false,
		conflicts: [],
		virtualRebase: "ok",
		virtualHead: null,
	},
	interdiff: "available",
	files,
	toRead,
	threads: [],
});

const v = view([
	file(0, "core.ts", [
		cluster("a", "unreviewed", false, 2),
		cluster("b", "reviewed", true, 2),
	]),
	file(1, "util.ts", [
		cluster("c", "reviewed", true, 3),
		cluster("d", "unreviewed", false, 1),
	]),
]);
const a = answer([
	{
		index: 0,
		path: "core.ts",
		conflict: false,
		clusters: [
			{ key: "a", kind: "reworked" },
			{ key: "b", kind: "carried", from: 1, state: "reviewed", rule: "exact" },
		],
	},
	{
		index: 1,
		path: "util.ts",
		conflict: false,
		clusters: [
			{ key: "c", kind: "carried", from: 1, state: "reviewed", rule: "exact" },
			{ key: "d", kind: "new" },
			{ key: "old", kind: "gone", from: 1 },
		],
	},
	{
		index: 2,
		path: "removed.ts",
		conflict: false,
		clusters: [{ key: "z", kind: "gone", from: 1 }],
	},
]);

describe("sinceByFile", () => {
	it("counts each file's kinds, carried from the view's marks", () => {
		const since = sinceByFile(a, v);
		expect(since.get(0)?.counts).toEqual({
			reworked: 1,
			new: 0,
			gone: 0,
			carried: 1,
			reverted: 0,
			removed: 0,
		});
		// A gone cluster counts by its pieces (none in this answer: no hunks).
		expect(since.get(1)?.counts).toEqual({
			reworked: 0,
			new: 1,
			gone: 0,
			carried: 1,
			reverted: 0,
			removed: 0,
		});
		expect(since.get(1)?.kinds.get("old")).toEqual({
			key: "old",
			kind: "gone",
			from: 1,
		});
		// A file only the interdiff has: no view clusters, nothing carried.
		expect(since.get(2)?.counts.carried).toBe(0);
	});
	it("a carried entry the view does not show as carried is not counted", () => {
		// The reviewer unticked it: the mark is a human unreviewed now.
		const unticked = view([file(0, "core.ts", [cluster("b", "unreviewed")])]);
		expect(sinceByFile(a, unticked).get(0)?.counts.carried).toBe(0);
	});
});

describe("goneFiles", () => {
	it("lists the answer's files past the view's that have gone clusters", () => {
		expect(goneFiles(a, v).map((f) => f.path)).toEqual(["removed.ts"]);
	});
});

describe("toReadCount", () => {
	it("counts unreviewed reworked and new clusters, in each unit", () => {
		const since = sinceByFile(a, v);
		expect(toReadCount(since, v, "clusters")).toBe(2);
		expect(toReadCount(since, v, "lines")).toBe(3);
		expect(toReadCount(since, v, "files")).toBe(2);
	});
	it("a cluster marked meanwhile is read; a carried one unticked is to read only if the engine lists it", () => {
		const marked = view([
			file(0, "core.ts", [
				cluster("a", "reviewed"),
				cluster("b", "unreviewed"),
			]),
			file(1, "util.ts", [
				cluster("c", "reviewed", true),
				cluster("d", "unreviewed"),
			]),
		]);
		const since = sinceByFile(a, marked);
		// b is carried per the engine, not reworked or new: unticking it
		// leaves it unreviewed (the bar counts that), not "to read".
		expect(toReadCount(since, marked, "clusters")).toBe(1);
		expect(toReadCount(since, marked, "files")).toBe(1);
	});
});

describe("toReadCount, a partly reviewed cluster", () => {
	it("is still to read: in lines, only its unreviewed lines", () => {
		const partly = view([
			file(0, "core.ts", [
				{ ...cluster("a", "unreviewed", false, 2), reviewedLines: [[0, 1]] },
			]),
			file(1, "util.ts", [cluster("d", "unreviewed", false, 1)]),
		]);
		const since = sinceByFile(a, partly);
		expect(toReadCount(since, partly, "clusters")).toBe(2);
		expect(toReadCount(since, partly, "lines")).toBe(2);
		expect(toReadCount(since, partly, "files")).toBe(2);
		expect(eyesOf(partly.files[0] as FileView, since.get(0))).toBe("read");
	});
});

describe("since-only pieces", () => {
	const only = (
		line: number,
		old: [number, number][],
		fresh: [number, number][],
		kind: "reverted" | "removed",
	): SincePiece => ({ hunk: 0, line, owns: null, old, new: fresh, kind });
	const withRevert = answer(
		[
			{
				index: 0,
				path: "core.ts",
				conflict: false,
				clusters: [{ key: "a", kind: "reworked" }],
				pieces: [
					only(0, [[10, 16]], [], "removed"),
					only(9, [[30, 31]], [[40, 42]], "reverted"),
				],
			},
			{
				index: 3,
				path: "reverted.ts",
				conflict: false,
				clusters: [],
				pieces: [only(0, [[1, 4]], [], "reverted")],
			},
		],
		{ files: 2, clusters: 4 },
	);
	const plain = view([
		file(0, "core.ts", [cluster("a", "reviewed", false, 2)]),
	]);

	it("count in to-read until marked, in each unit; a file only they hold is listed as gone", () => {
		const since = sinceByFile(withRevert, plain);
		expect(toReadCount(since, plain, "clusters")).toBe(3);
		expect(toReadCount(since, plain, "lines")).toBe(6 + 3 + 3);
		expect(toReadCount(since, plain, "files")).toBe(2);
		expect(since.get(0)?.counts).toMatchObject({ removed: 1, reverted: 1 });
		expect(goneFiles(withRevert, plain).map((f) => f.path)).toEqual([
			"reverted.ts",
		]);
		const marked: ReviewView = {
			...plain,
			sinceMarks: [
				{
					since: 1,
					path: "core.ts",
					reviewed: { old: [[10, 16]], new: [] },
					crossed: { old: [[30, 31]], new: [[40, 42]] },
				},
			],
		};
		const after = sinceByFile(withRevert, marked);
		expect(toReadCount(after, marked, "clusters")).toBe(1);
		expect(after.get(0)?.left).toEqual({ units: 0, lines: 0 });
		expect(after.get(0)?.counts).toMatchObject({ removed: 0, reverted: 0 });
		// A mark that holds part of a piece's lines leaves it to read.
		const part: ReviewView = {
			...plain,
			sinceMarks: [
				{
					since: 1,
					path: "core.ts",
					reviewed: { old: [[10, 12]], new: [] },
					crossed: { old: [], new: [] },
				},
			],
		};
		expect(sinceByFile(withRevert, part).get(0)?.left.units).toBe(2);
		// Another comparison's mark is not this one's.
		const other: ReviewView = {
			...plain,
			sinceMarks: [{ ...(marked.sinceMarks?.[0] as SinceMark), since: 2 }],
		};
		expect(sinceByFile(withRevert, other).get(0)?.left.units).toBe(2);
	});
});

describe("counts follow the since view (its pieces)", () => {
	// Cluster k (10 lines) in three pieces; a reverted piece; cluster n,
	// new, with lines no piece owns (only the full diff shows them).
	const ten = (over: Partial<FileView["clusters"][number]> = {}) => ({
		...cluster("k", "unreviewed", false, 10),
		oldCount: 0,
		newCount: 10,
		removed: [],
		added: Array.from({ length: 10 }, (_, i) => `l${i}`),
		...over,
	});
	const piece = (
		line: number,
		owns: [number, number][] | null,
		fresh: [number, number][],
		extra: Partial<SincePiece> = {},
	): SincePiece => ({
		hunk: 0,
		line,
		owns,
		old: [],
		new: fresh,
		...(owns ? { key: "k" } : {}),
		...extra,
	});
	const pieces = [
		piece(0, [[0, 5]], [[3, 4]]),
		piece(4, [[5, 8]], [[7, 9]]),
		piece(9, [[8, 10]], [[10, 11]]),
		piece(12, null, [], { old: [[20, 23]], kind: "reverted" }),
	];
	const ans = answer(
		[
			{
				index: 0,
				path: "core.ts",
				conflict: false,
				clusters: [
					{ key: "k", kind: "reworked" },
					{ key: "n", kind: "new" },
				],
				pieces: [...pieces, piece(20, [[0, 1]], [[30, 31]], { key: "n" })],
			},
		],
		{ files: 1, clusters: 6 },
	);
	const at = (k = ten(), marks?: SinceMark[]) =>
		({
			...view([
				file(0, "core.ts", [
					k,
					{ ...cluster("n", "unreviewed", false, 3), newCount: 3 },
				]),
			]),
			...(marks ? { sinceMarks: marks } : {}),
		}) as ReviewView;

	it("progress counts units: pieces, and the rest only the full diff shows", () => {
		const fresh = sinceProgress(unitsOf(ans, at()));
		// 4 pieces of the file + n's piece + n's rest (2 lines no piece owns).
		expect(fresh.clusters).toEqual({ total: 6, reviewed: 0, crossedOff: 0 });
		expect(fresh.lines.total).toBe(1 + 2 + 1 + 3 + 1 + 2);
		expect(fresh.files).toEqual({
			total: 1,
			reviewed: 0,
			crossedOff: 0,
			done: 0,
		});
	});

	it("marking a piece moves progress, to read, the chips and the connector by one piece", () => {
		const before = sinceByFile(ans, at());
		const one = at(ten({ reviewedLines: [[5, 8]] }));
		const after = sinceByFile(ans, one);
		expect(sinceProgress(unitsOf(ans, one)).clusters.reviewed).toBe(1);
		expect(toReadCount(after, one, "clusters")).toBe(
			toReadCount(before, at(), "clusters") - 1,
		);
		expect(after.get(0)?.counts.reworked).toBe(
			(before.get(0)?.counts.reworked ?? 0) - 1,
		);
		expect(liveToRead(after).clusters).toBe(liveToRead(before).clusters - 1);
		// The reverted piece: by its mark, the same.
		const reverted = at(ten(), [
			{
				since: 1,
				path: "core.ts",
				reviewed: { old: [[20, 23]], new: [] },
				crossed: { old: [], new: [] },
			},
		]);
		const r = sinceByFile(ans, reverted);
		expect(r.get(0)?.counts.reverted).toBe(0);
		expect(liveToRead(r).clusters).toBe(liveToRead(before).clusters - 1);
		expect(sinceProgress(unitsOf(ans, reverted)).clusters.reviewed).toBe(1);
	});

	it("the rest of a cluster no piece owns stays to read until the full diff marks it", () => {
		const nPiece = at(ten(), undefined);
		nPiece.files[0]?.clusters.splice(1, 1, {
			...cluster("n", "unreviewed", false, 3),
			newCount: 3,
			reviewedLines: [[0, 1]],
		});
		const after = sinceProgress(unitsOf(ans, nPiece));
		expect(after.clusters.reviewed).toBe(1);
		const all = at(ten(), undefined);
		all.files[0]?.clusters.splice(1, 1, {
			...cluster("n", "reviewed", false, 3),
			newCount: 3,
		});
		expect(sinceProgress(unitsOf(ans, all)).clusters.reviewed).toBe(2);
	});

	it("the full diff's to-read counts the snapshot's clusters", () => {
		expect(toReadClusters(ans, at(), "clusters")).toBe(2);
		expect(
			toReadClusters(ans, at(ten({ reviewedLines: [[0, 5]] })), "clusters"),
		).toBe(2);
		expect(
			toReadClusters(ans, at(ten({ state: "reviewed" })), "clusters"),
		).toBe(1);
	});
});

describe("eyesOf", () => {
	it("read for anything to look at, carried when every mark carried, null without an answer", () => {
		const since = sinceByFile(a, v);
		expect(eyesOf(v.files[0] as FileView, since.get(0))).toBe("read");
		const carried = file(0, "core.ts", [cluster("b", "reviewed", true)]);
		expect(
			eyesOf(carried, {
				kinds: new Map(),
				conflict: false,
				counts: {
					reworked: 0,
					new: 0,
					gone: 0,
					carried: 1,
					reverted: 0,
					removed: 0,
				},
				left: { units: 0, lines: 0 },
			}),
		).toBe("carried");
		// A carried file whose mark the reviewer unticked needs eyes again.
		expect(
			eyesOf(file(0, "core.ts", [cluster("b", "unreviewed")]), {
				kinds: new Map(),
				conflict: false,
				counts: {
					reworked: 0,
					new: 0,
					gone: 0,
					carried: 0,
					reverted: 0,
					removed: 0,
				},
				left: { units: 0, lines: 0 },
			}),
		).toBe("read");
		// A piece owning no line of the snapshot, not marked: to read.
		expect(
			eyesOf(carried, {
				kinds: new Map(),
				conflict: false,
				counts: {
					reworked: 0,
					new: 0,
					gone: 0,
					carried: 1,
					reverted: 0,
					removed: 0,
				},
				left: { units: 1, lines: 6 },
			}),
		).toBe("read");
		expect(
			eyesOf(carried, {
				kinds: new Map(),
				conflict: true,
				counts: {
					reworked: 0,
					new: 0,
					gone: 0,
					carried: 1,
					reverted: 0,
					removed: 0,
				},
				left: { units: 0, lines: 0 },
			}),
		).toBe("read");
		expect(eyesOf(carried, undefined)).toBeNull();
	});
});

describe("nothingSince", () => {
	it("only when nothing is to read, nothing is gone and nothing conflicts", () => {
		expect(nothingSince(a, sinceByFile(a, v))).toBe(false);
		const quiet = answer(
			[
				{
					index: 0,
					path: "core.ts",
					conflict: false,
					clusters: [
						{
							key: "b",
							kind: "carried",
							from: 1,
							state: "reviewed",
							rule: "exact",
						},
					],
				},
			],
			{ files: 0, clusters: 0 },
		);
		expect(nothingSince(quiet, sinceByFile(quiet, v))).toBe(true);
		const gone = answer(
			[
				{
					index: 0,
					path: "core.ts",
					conflict: false,
					clusters: [{ key: "x", kind: "gone", from: 1 }],
				},
			],
			{ files: 0, clusters: 0 },
		);
		expect(nothingSince(gone, sinceByFile(gone, v))).toBe(false);
	});
});

describe("carriedCount", () => {
	it("counts the view's carried clusters", () => {
		expect(carriedCount(v)).toBe(2);
	});
});

describe("shownView", () => {
	const raw = view([
		file(0, "core.ts", [
			cluster("a", "unreviewed"),
			cluster("b", "unreviewed"),
		]),
	]);
	const carries = answer([
		{
			index: 0,
			path: "core.ts",
			conflict: false,
			clusters: [
				{ key: "a", kind: "reworked" },
				{
					key: "b",
					kind: "carried",
					from: 1,
					state: "reviewed",
					rule: "exact",
				},
			],
		},
	]);
	const pending = (key: string, state: ClusterState) =>
		new Map([
			[
				key,
				{
					change: { key, state },
					revision: "r2",
					path: "core.ts",
					version: 1,
					since: 0,
				},
			],
		]);
	it("lays the engine's carries over a viewed head that is no patch set yet", () => {
		const out = shownView({ ...raw, patchset: null }, carries, new Map());
		expect(out.files[0]?.clusters[1]).toMatchObject({
			state: "reviewed",
			carried: { from: 1, rule: "exact" },
		});
	});
	it("a started patch set gets no overlay: its marks are the fold's", () => {
		const started = { ...raw, patchset: 2 };
		expect(shownView(started, carries, new Map())).toBe(started);
	});
	it("a pending untick beats a provisional carry (the human's mark wins)", () => {
		const out = shownView(
			{ ...raw, patchset: null },
			carries,
			pending("b", "unreviewed"),
		);
		expect(out.files[0]?.clusters[1]?.state).toBe("unreviewed");
		expect(out.files[0]?.clusters[1]?.carried).toBeUndefined();
		expect(out.progress.clusters.reviewed).toBe(0);
	});
	it("a pending mark applies without an answer too", () => {
		const out = shownView(
			{ ...raw, patchset: null },
			null,
			pending("a", "reviewed"),
		);
		expect(out.files[0]?.clusters[0]?.state).toBe("reviewed");
	});
});
