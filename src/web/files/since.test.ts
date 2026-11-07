import { describe, expect, it } from "vitest";
import type {
	ClusterState,
	FileView,
	RereviewAnswer,
	ReviewView,
} from "../../shared/types";
import {
	carriedCount,
	eyesOf,
	goneFiles,
	nothingSince,
	shownView,
	sinceByFile,
	toReadCount,
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
		});
		expect(since.get(1)?.counts).toEqual({
			reworked: 0,
			new: 1,
			gone: 1,
			carried: 1,
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

describe("eyesOf", () => {
	it("read for anything to look at, carried when every mark carried, null without an answer", () => {
		const since = sinceByFile(a, v);
		expect(eyesOf(v.files[0] as FileView, since.get(0))).toBe("read");
		const carried = file(0, "core.ts", [cluster("b", "reviewed", true)]);
		expect(
			eyesOf(carried, {
				kinds: new Map(),
				conflict: false,
				counts: { reworked: 0, new: 0, gone: 0, carried: 1 },
			}),
		).toBe("carried");
		// A carried file whose mark the reviewer unticked needs eyes again.
		expect(
			eyesOf(file(0, "core.ts", [cluster("b", "unreviewed")]), {
				kinds: new Map(),
				conflict: false,
				counts: { reworked: 0, new: 0, gone: 0, carried: 0 },
			}),
		).toBe("read");
		expect(
			eyesOf(carried, {
				kinds: new Map(),
				conflict: true,
				counts: { reworked: 0, new: 0, gone: 0, carried: 1 },
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
