import { describe, expect, it } from "vitest";
import type { SincePiece } from "../../shared/pieces";
import type {
	ClusterState,
	FileView,
	RereviewAnswer,
	ReviewView,
	SinceMark,
} from "../../shared/types";
import { finishes } from "./fileFinish";
import {
	carriedCount,
	countedFileUnits,
	countedUnits,
	eyesOf,
	fullDiffToRead,
	goneFiles,
	liveToRead,
	nothingSince,
	shownView,
	sinceByFile,
	sinceProgress,
	toReadClusters,
	toReadCount,
	unitsFinish,
	unitsOf,
} from "./since";
import { countedFile } from "./unit";

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
			unticked: 0,
		});
		// A gone cluster counts by its pieces (none in this answer: no hunks).
		expect(since.get(1)?.counts).toEqual({
			reworked: 0,
			new: 1,
			gone: 0,
			carried: 1,
			reverted: 0,
			removed: 0,
			unticked: 0,
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
		expect(toReadCount(unitsOf(a, v), "clusters")).toBe(2);
		expect(toReadCount(unitsOf(a, v), "lines")).toBe(3);
		expect(toReadCount(unitsOf(a, v), "files")).toBe(2);
	});
	it("a cluster marked meanwhile is read; a carried one the reviewer unticked is to read again", () => {
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
		// b is carried per the engine, but the reviewer unticked it: to read
		// (principle 2), beside d, new.
		expect(toReadCount(unitsOf(a, marked), "clusters")).toBe(2);
		expect(toReadCount(unitsOf(a, marked), "files")).toBe(2);
	});
});

describe("sinceProgress", () => {
	const unit = (
		index: number,
		state: ClusterState,
		lines = 2,
	): Parameters<typeof sinceProgress>[0][number] => ({
		index,
		path: `f${index}`,
		kind: "reworked",
		lines,
		state,
		open: state === "unreviewed" ? lines : 0,
	});

	it("counts units by state, and a file done only when every unit of it is marked", () => {
		expect(
			sinceProgress([
				unit(0, "reviewed", 3),
				unit(0, "unreviewed", 1),
				unit(1, "crossed-off", 2),
				unit(1, "crossed-off", 1),
				unit(2, "reviewed", 1),
				unit(2, "crossed-off", 4),
			]),
		).toEqual({
			clusters: { total: 6, reviewed: 2, crossedOff: 3 },
			lines: { total: 12, reviewed: 4, crossedOff: 7 },
			// f0 has an unmarked unit: not done. f1 all crossed off; f2 done
			// with a reviewed unit: reviewed.
			files: { total: 3, done: 2, crossedOff: 1, reviewed: 1 },
		});
	});
});

describe("toReadClusters", () => {
	it("counts only reworked and new clusters left unmarked, in lines their unmarked lines", () => {
		const marks = view([
			file(0, "core.ts", [
				{
					...cluster("a", "unreviewed", false, 5),
					reviewedLines: [[0, 1]],
					crossedLines: [[1, 3]],
				},
				// Carried per the engine, unticked: the bar's full diff count
				// is of reworked and new clusters only.
				cluster("b", "unreviewed", false, 4),
			]),
			file(1, "util.ts", [cluster("d", "unreviewed", false, 1)]),
		]);
		expect(toReadClusters(a, marks, "lines", false)).toBe(2 + 1);
		expect(toReadClusters(a, marks, "clusters", false)).toBe(2);
		expect(toReadClusters(a, marks, "files", false)).toBe(2);
	});
});

describe("liveToRead", () => {
	it("counts the unmarked units, the gone ones among them, and every conflicted file", () => {
		const base = { path: "f", lines: 1, open: 1 };
		const since = new Map([
			[7, { conflict: true } as never],
			[0, { conflict: false } as never],
		]);
		expect(
			liveToRead(since, [
				{ ...base, index: 0, kind: "gone", state: "unreviewed" },
				{ ...base, index: 0, kind: "gone", state: "reviewed", open: 0 },
				{ ...base, index: 1, kind: "new", state: "unreviewed" },
			]),
		).toEqual({ files: 3, clusters: 2, gone: 1 });
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
		expect(toReadCount(unitsOf(a, partly), "clusters")).toBe(2);
		expect(toReadCount(unitsOf(a, partly), "lines")).toBe(2);
		expect(toReadCount(unitsOf(a, partly), "files")).toBe(2);
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
		expect(toReadCount(unitsOf(withRevert, plain), "clusters")).toBe(3);
		expect(toReadCount(unitsOf(withRevert, plain), "lines")).toBe(6 + 3 + 3);
		expect(toReadCount(unitsOf(withRevert, plain), "files")).toBe(2);
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
		expect(toReadCount(unitsOf(withRevert, marked), "clusters")).toBe(1);
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
		expect(toReadCount(unitsOf(ans, one), "clusters")).toBe(
			toReadCount(unitsOf(ans, at()), "clusters") - 1,
		);
		expect(after.get(0)?.counts.reworked).toBe(
			(before.get(0)?.counts.reworked ?? 0) - 1,
		);
		expect(liveToRead(after, unitsOf(ans, one)).clusters).toBe(
			liveToRead(before, unitsOf(ans, at())).clusters - 1,
		);
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
		expect(liveToRead(r, unitsOf(ans, reverted)).clusters).toBe(
			liveToRead(before, unitsOf(ans, at())).clusters - 1,
		);
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
		expect(toReadClusters(ans, at(), "clusters", false)).toBe(2);
		expect(
			toReadClusters(
				ans,
				at(ten({ reviewedLines: [[0, 5]] })),
				"clusters",
				false,
			),
		).toBe(2);
		expect(
			toReadClusters(ans, at(ten({ state: "reviewed" })), "clusters", false),
		).toBe(1);
	});
});

describe('the full diff\'s "to read" with "Ignore whitespace" (CAR-243)', () => {
	const wsAnswer = answer(
		[
			{
				index: 0,
				path: "core.ts",
				conflict: false,
				clusters: [
					{ key: "a", kind: "reworked" },
					{ key: "w", kind: "reworked" },
				],
			},
			{
				index: 1,
				path: "util.ts",
				conflict: false,
				clusters: [{ key: "u", kind: "new" }],
			},
		],
		{ files: 2, clusters: 3 },
	);
	const wsView = view([
		file(0, "core.ts", [
			cluster("a", "unreviewed"),
			{ ...cluster("w", "unreviewed"), whitespaceOnly: true as const },
		]),
		file(1, "util.ts", [
			{ ...cluster("u", "unreviewed"), whitespaceOnly: true as const },
		]),
	]);

	// Two whitespace-only clusters, two lines each (the `cluster` helper's default).
	const WS_CLUSTERS = 2;
	const LINES_PER_CLUSTER = 2;

	it("counts whitespace-only clusters with the switch off, not with it on", () => {
		expect(toReadClusters(wsAnswer, wsView, "clusters", false)).toBe(3);
		expect(toReadClusters(wsAnswer, wsView, "clusters", false)).toBe(3);
		expect(toReadClusters(wsAnswer, wsView, "clusters", true)).toBe(1);
		expect(toReadClusters(wsAnswer, wsView, "files", false)).toBe(2);
		// util.ts is nothing else: it counts nowhere, as on the bar.
		expect(toReadClusters(wsAnswer, wsView, "files", true)).toBe(1);
		expect(toReadClusters(wsAnswer, wsView, "lines", true)).toBe(
			toReadClusters(wsAnswer, wsView, "lines", false) -
				WS_CLUSTERS * LINES_PER_CLUSTER,
		);
	});
});

describe("the connector of the comparison open in the full diff counts as its bar (CAR-266)", () => {
	// The engine's count is its since units (four: a re-indent of a
	// changed line is two); the full diff's bar counts the clusters.
	const wsAnswer = answer(
		[
			{
				index: 0,
				path: "core.ts",
				conflict: false,
				clusters: [
					{ key: "a", kind: "reworked" },
					{ key: "w", kind: "reworked" },
				],
			},
			{
				index: 1,
				path: "util.ts",
				conflict: false,
				clusters: [
					{ key: "u", kind: "new" },
					{ key: "g", kind: "gone", from: 1 },
				],
			},
		],
		{ files: 2, clusters: 4 },
	);
	const wsView = view([
		file(0, "core.ts", [
			cluster("a", "unreviewed"),
			{ ...cluster("w", "unreviewed"), whitespaceOnly: true as const },
		]),
		file(1, "util.ts", [
			{ ...cluster("u", "unreviewed"), whitespaceOnly: true as const },
		]),
	]);

	it("is the bar's to-read, switch off and on, not the engine's units", () => {
		for (const ws of [false, true]) {
			const live = fullDiffToRead(
				wsAnswer,
				wsView,
				sinceByFile(wsAnswer, wsView, ws),
				ws,
			);
			expect(live.clusters).toBe(
				toReadClusters(wsAnswer, wsView, "clusters", ws),
			);
			expect(live.files).toBe(toReadClusters(wsAnswer, wsView, "files", ws));
			expect(live.gone).toBe(1);
		}
		expect(
			fullDiffToRead(wsAnswer, wsView, sinceByFile(wsAnswer, wsView), false),
		).toEqual({ files: 2, clusters: 3, gone: 1 });
	});

	it("follows the reviewer's marks, and a conflicted file always counts", () => {
		const marked = view([
			file(0, "core.ts", [
				cluster("a", "reviewed"),
				{ ...cluster("w", "unreviewed"), whitespaceOnly: true as const },
			]),
			file(1, "util.ts", [cluster("u", "reviewed")]),
		]);
		expect(
			fullDiffToRead(wsAnswer, marked, sinceByFile(wsAnswer, marked), true),
		).toEqual({ files: 0, clusters: 0, gone: 1 });
		const conflicted = {
			...wsAnswer,
			files: wsAnswer.files.map((f) =>
				f.index === 1 ? { ...f, conflict: true } : f,
			),
		};
		expect(
			fullDiffToRead(conflicted, marked, sinceByFile(conflicted, marked), true)
				.files,
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
					unticked: 0,
				},
				left: { units: 0, lines: 0 },
			}),
		).toBe("carried");
		// A carried file whose mark the reviewer unticked needs eyes again
		// (its unit is left: sinceUnits).
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
					unticked: 1,
				},
				left: { units: 1, lines: 2 },
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
					unticked: 0,
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
					unticked: 0,
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

	it("anything to read, in either count, or gone in any file is not nothing (principle 2)", () => {
		const quietFiles: RereviewAnswer["files"] = [
			{ index: 0, path: "core.ts", conflict: false, clusters: [] },
		];
		for (const toRead of [
			{ files: 0, clusters: 1 },
			{ files: 1, clusters: 0 },
		]) {
			const some = answer(quietFiles, toRead);
			expect(nothingSince(some, sinceByFile(some, v))).toBe(false);
		}
		// Gone only in the second file.
		const goneLater = answer(
			[
				...quietFiles,
				{
					index: 1,
					path: "util.ts",
					conflict: false,
					clusters: [{ key: "x", kind: "gone", from: 1 }],
				},
			],
			{ files: 0, clusters: 0 },
		);
		expect(nothingSince(goneLater, sinceByFile(goneLater, v))).toBe(false);
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

describe("an unticked carried cluster in the since view (principle 2)", () => {
	const carriedAnswer = answer(
		[
			{
				index: 0,
				path: "core.ts",
				conflict: false,
				clusters: [
					{
						key: "c",
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

	it("a carried mark is not counted; once the reviewer unticks it, it is to read, and its file needs eyes", () => {
		const carried = view([
			file(0, "core.ts", [cluster("c", "reviewed", true, 4)]),
		]);
		const before = sinceByFile(carriedAnswer, carried);
		expect(toReadCount(unitsOf(carriedAnswer, carried), "clusters")).toBe(0);
		expect(sinceProgress(unitsOf(carriedAnswer, carried)).clusters.total).toBe(
			0,
		);
		expect(eyesOf(carried.files[0] as FileView, before.get(0))).toBe("carried");

		const unticked = view([
			file(0, "core.ts", [cluster("c", "unreviewed", false, 4)]),
		]);
		const after = sinceByFile(carriedAnswer, unticked);
		expect(toReadCount(unitsOf(carriedAnswer, unticked), "clusters")).toBe(1);
		expect(toReadCount(unitsOf(carriedAnswer, unticked), "lines")).toBe(4);
		expect(sinceProgress(unitsOf(carriedAnswer, unticked)).clusters).toEqual({
			total: 1,
			reviewed: 0,
			crossedOff: 0,
		});
		expect(eyesOf(unticked.files[0] as FileView, after.get(0))).toBe("read");
		expect(liveToRead(after, unitsOf(carriedAnswer, unticked)).clusters).toBe(
			1,
		);
		// Ticked again by the reviewer: counted, and reviewed.
		const again = view([
			file(0, "core.ts", [cluster("c", "reviewed", false, 4)]),
		]);
		expect(sinceProgress(unitsOf(carriedAnswer, again)).clusters).toEqual({
			total: 1,
			reviewed: 1,
			crossedOff: 0,
		});
	});
});

describe('"Ignore whitespace" in the since view (CAR-184)', () => {
	const ws = (c: FileView["clusters"][number]) => ({
		...c,
		whitespaceOnly: true as const,
	});
	// core.ts: a reworked change and a reworked whitespace-only cluster;
	// util.ts: only a new whitespace-only cluster.
	const wv = view([
		file(0, "core.ts", [
			cluster("a", "reviewed"),
			ws(cluster("w", "unreviewed")),
		]),
		file(1, "util.ts", [ws(cluster("u", "unreviewed"))]),
	]);
	const wa = answer(
		[
			{
				index: 0,
				path: "core.ts",
				conflict: false,
				clusters: [
					{ key: "a", kind: "reworked" },
					{ key: "w", kind: "reworked" },
				],
			},
			{
				index: 1,
				path: "util.ts",
				conflict: false,
				clusters: [{ key: "u", kind: "new" }],
			},
		],
		{ files: 2, clusters: 3 },
	);

	it("a unit of a whitespace-only cluster says so; switch off, nothing is left out", () => {
		const units = unitsOf(wa, wv);
		expect(units.map((u) => u.whitespaceOnly === true)).toEqual([
			false,
			true,
			true,
		]);
		const off = countedUnits(units, false);
		expect(off).toEqual({ units, leftOut: 0 });
		expect(sinceProgress(off.units).clusters).toEqual({
			total: 3,
			reviewed: 1,
			crossedOff: 0,
		});
	});

	it("switch on, the bar leaves them all out: done, with how many", () => {
		const on = countedUnits(unitsOf(wa, wv), true);
		expect(on.leftOut).toBe(2);
		expect(sinceProgress(on.units).clusters).toEqual({
			total: 1,
			reviewed: 1,
			crossedOff: 0,
		});
		expect(sinceProgress(on.units).files.done).toBe(1);
	});

	it("switch on, the bar's to-read reads the bar's own units: a file of nothing else counts nowhere on it, though its row keeps its count", () => {
		const on = countedUnits(unitsOf(wa, wv), true);
		const bar = sinceProgress(on.units);
		// The bar: core.ts's change, reviewed; util.ts (nothing else) is out.
		expect(bar.clusters.total - bar.clusters.reviewed).toBe(0);
		expect(toReadCount(on.units, "clusters")).toBe(0);
		expect(toReadCount(on.units, "lines")).toBe(0);
		expect(toReadCount(on.units, "files")).toBe(0);
		// util.ts's row still counts its unit.
		const rows = sinceByFile(wa, wv, true);
		expect(rows.get(1)?.left.units).toBe(1);
		// The connector's live count agrees with the bar.
		expect(liveToRead(rows, on.units)).toEqual({
			files: 0,
			clusters: 0,
			gone: 0,
		});
		// Off: both whitespace-only units are to read, in two files.
		const off = countedUnits(unitsOf(wa, wv), false);
		expect(toReadCount(off.units, "clusters")).toBe(2);
		expect(toReadCount(off.units, "lines")).toBe(4);
		expect(toReadCount(off.units, "files")).toBe(2);
		expect(liveToRead(sinceByFile(wa, wv), off.units)).toEqual({
			files: 2,
			clusters: 2,
			gone: 0,
		});
	});

	it("a file's header leaves them out, but a file of nothing else keeps its own", () => {
		const units = unitsOf(wa, wv);
		const coreUnits = countedFileUnits(
			units.filter((u) => u.index === 0),
			true,
		);
		expect(coreUnits.units).toHaveLength(1);
		expect(coreUnits.leftOut).toBe(1);
		const utilUnits = countedFileUnits(
			units.filter((u) => u.index === 1),
			true,
		);
		expect(utilUnits.units).toHaveLength(1);
		expect(utilUnits.leftOut).toBe(0);
		// Off: as they are.
		expect(
			countedFileUnits(
				units.filter((u) => u.index === 0),
				false,
			).leftOut,
		).toBe(0);
	});

	it("a file whose only since unit is whitespace-only, beside a carried change, with no other since unit, is nothing else: it counts the unit, its own marks shown (CAR-218)", () => {
		// PS1: a change and a re-indent, both reviewed; PS2 changes only the
		// indent amount: the change is carried, the re-indent reworked.
		const cv = view([
			file(0, "core.ts", [
				cluster("a", "reviewed", true),
				ws(cluster("w", "unreviewed")),
			]),
		]);
		const only = answer(
			[
				{
					index: 0,
					path: "core.ts",
					conflict: false,
					clusters: [
						{
							key: "a",
							kind: "carried",
							from: 1,
							state: "reviewed",
							rule: "exact",
						},
						{ key: "w", kind: "reworked" },
					],
				},
			],
			{ files: 1, clusters: 1 },
		);
		const units = unitsOf(only, cv);
		expect(units).toHaveLength(1);
		// Decided by the since units (the carried change is none): the file
		// is nothing but whitespace-only units, so they all count.
		expect(countedFileUnits(units, true)).toEqual({ units, leftOut: 0 });
		expect(sinceByFile(only, cv, true).get(0)?.left.units).toBe(1);
	});

	// A file whose snapshot clusters are changes, its pieces a re-indent.
	const reindented = (earlierMarked: boolean) => {
		const pieces: SincePiece[] = [
			{
				hunk: 0,
				line: 0,
				key: "c",
				owns: [[0, 1]],
				old: [[0, 1]],
				new: [],
				...(earlierMarked ? { whitespaceOnly: true as const } : {}),
			},
			{
				hunk: 0,
				line: 1,
				key: "c",
				owns: [[1, 2]],
				old: [],
				new: [[0, 1]],
				...(earlierMarked ? { whitespaceOnly: true as const } : {}),
			},
		];
		return {
			cv: view([file(0, "core.ts", [cluster("c", "unreviewed")])]),
			ans: answer(
				[
					{
						index: 0,
						path: "core.ts",
						conflict: false,
						clusters: [{ key: "c", kind: "reworked" }],
						pieces,
					},
				],
				{ files: 1, clusters: 1 },
			),
		};
	};

	it("a file whose snapshot clusters are changes but whose since units are all whitespace-only, marked at the earlier patch set, reads nothing else (Review Focus 5)", () => {
		const { cv, ans } = reindented(true);
		const units = unitsOf(ans, cv);
		expect(units.every((u) => u.whitespaceOnly)).toBe(true);
		// The snapshot's cluster is a change, and still the file counts them.
		expect((cv.files[0] as FileView).clusters[0]?.whitespaceOnly).toBe(
			undefined,
		);
		expect(countedFileUnits(units, true)).toEqual({ units, leftOut: 0 });
		expect(sinceByFile(ans, cv, true).get(0)?.left.units).toBe(2);
	});

	it("units the earlier patch set never marked are not whitespace-only: they count and leave nothing out (principle 2)", () => {
		const { cv, ans } = reindented(false);
		const units = unitsOf(ans, cv);
		expect(units.some((u) => u.whitespaceOnly)).toBe(false);
		expect(countedFileUnits(units, true)).toEqual({ units, leftOut: 0 });
		expect(countedUnits(units, true).leftOut).toBe(0);
	});

	it("units without a cluster each count once in the `~`", () => {
		const two = answer(
			[
				{
					index: 0,
					path: "core.ts",
					conflict: false,
					clusters: [{ key: "a", kind: "reworked" }],
					pieces: [
						{
							hunk: 0,
							line: 0,
							owns: [],
							old: [[0, 1]],
							new: [],
							whitespaceOnly: true,
						},
						{
							hunk: 1,
							line: 0,
							owns: [],
							old: [[0, 1]],
							new: [],
							whitespaceOnly: true,
						},
					] as SincePiece[],
				},
			],
			{ files: 1, clusters: 3 },
		);
		const cv = view([file(0, "core.ts", [cluster("a", "unreviewed")])]);
		const units = unitsOf(two, cv).filter((u) => u.whitespaceOnly);
		expect(units).toHaveLength(2);
		expect(units.every((u) => u.cluster === undefined)).toBe(true);
		expect(countedUnits(units, true).leftOut).toBe(2);
	});

	it("the `~` counts clusters, not pieces: a cluster's old and new pieces are one", () => {
		const pieced = answer(
			[
				{
					index: 0,
					path: "core.ts",
					conflict: false,
					clusters: [
						{ key: "a", kind: "reworked" },
						{ key: "w", kind: "reworked" },
					],
					pieces: [
						{
							hunk: 0,
							line: 0,
							key: "w",
							owns: [[0, 1]],
							old: [[1, 2]],
							new: [],
							// Judged on the interdiff (CAR-218): the engine's flag.
							whitespaceOnly: true,
						},
						{
							hunk: 0,
							line: 1,
							key: "w",
							owns: [[1, 2]],
							old: [],
							new: [[1, 2]],
							whitespaceOnly: true,
						},
					] satisfies SincePiece[],
				},
			],
			{ files: 1, clusters: 3 },
		);
		const wide = view([
			file(0, "core.ts", [
				cluster("a", "unreviewed"),
				ws(cluster("w", "unreviewed")),
			]),
		]);
		const units = unitsOf(pieced, wide);
		expect(units.filter((u) => u.whitespaceOnly)).toHaveLength(2);
		expect(countedUnits(units, true).leftOut).toBe(1);
		expect(countedFileUnits(units, true).leftOut).toBe(1);
	});

	it("each file's counts and dot follow the switch, never hiding a file of nothing else", () => {
		const off = sinceByFile(wa, wv);
		expect(off.get(0)?.left.units).toBe(1);
		expect(eyesOf(wv.files[0] as FileView, off.get(0))).toBe("read");
		const on = sinceByFile(wa, wv, true);
		expect(on.get(0)?.left.units).toBe(0);
		expect(on.get(0)?.counts.reworked).toBe(0);
		expect(eyesOf(wv.files[0] as FileView, on.get(0))).toBe("carried");
		// util.ts has only whitespace-only units: still read.
		expect(on.get(1)?.left.units).toBe(1);
		expect(eyesOf(wv.files[1] as FileView, on.get(1))).toBe("read");
	});

	it("nothing to read since: the counted units decide, a change unit always counts", () => {
		// core.ts alone: its change carried, its whitespace-only cluster reworked.
		const cv = view([
			file(0, "core.ts", [
				cluster("a", "reviewed", true),
				ws(cluster("w", "unreviewed")),
			]),
		]);
		const only = answer(
			[
				{
					index: 0,
					path: "core.ts",
					conflict: false,
					clusters: [
						{
							key: "a",
							kind: "carried",
							from: 1,
							state: "reviewed",
							rule: "exact",
						},
						{ key: "w", kind: "reworked" },
					],
				},
			],
			{ files: 1, clusters: 1 },
		);
		const units = unitsOf(only, cv);
		const byFile = sinceByFile(only, cv, true);
		// Off: the engine's to read.
		expect(nothingSince(only, byFile)).toBe(false);
		// On: only a whitespace-only unit, left out.
		const on = countedUnits(units, true);
		expect(on.leftOut).toBe(1);
		expect(nothingSince(only, byFile, on.units)).toBe(true);
		// A change unit, even reviewed, is something that changed.
		const both = countedUnits(unitsOf(wa, wv), true);
		expect(nothingSince(wa, sinceByFile(wa, wv, true), both.units)).toBe(false);
	});
});

describe("unitsFinish: a mark finishes a since view's file by its units (CAR-218)", () => {
	// core.ts: a new change `a`, and `w`, whitespace-only against the base
	// but a real edit since the earlier patch set (its piece isn't
	// whitespace-only).
	const fv = view([
		file(0, "core.ts", [
			cluster("a", "unreviewed"),
			{ ...cluster("w", "unreviewed"), whitespaceOnly: true },
		]),
	]);
	const fa = answer(
		[
			{
				index: 0,
				path: "core.ts",
				conflict: false,
				clusters: [
					{ key: "a", kind: "new" },
					{ key: "w", kind: "reworked" },
				],
				pieces: [
					{
						hunk: 0,
						line: 0,
						key: "w",
						owns: [[0, 2]],
						old: [[0, 1]],
						new: [[0, 1]],
					},
				],
			},
		],
		{ files: 1, clusters: 2 },
	);
	const tick = (key: string) => ({ key, state: "reviewed" as const });

	it("never while a counted unit is unmarked, the switch on or off", () => {
		// The snapshot's clusters, the switch on, would say `a` finishes it.
		expect(
			finishes(countedFile(fv.files[0] as FileView, true).clusters, [
				tick("a"),
			]),
		).toBe(true);
		for (const on of [true, false]) {
			expect(unitsFinish(fa, fv, 0, "core.ts", [tick("a")], on)).toBe(false);
			expect(
				unitsFinish(fa, fv, 0, "core.ts", [tick("a"), tick("w")], on),
			).toBe(true);
		}
	});

	it("a file the engine didn't answer is left to its clusters; one with nothing left can't finish again", () => {
		expect(unitsFinish(fa, fv, 9, "other.ts", [tick("a")], true)).toBe(
			undefined,
		);
		const done = view([
			file(0, "core.ts", [
				cluster("a", "reviewed"),
				{ ...cluster("w", "reviewed"), whitespaceOnly: true },
			]),
		]);
		expect(unitsFinish(fa, done, 0, "core.ts", [tick("a")], true)).toBe(false);
	});
});
