import { describe, expect, it } from "vitest";
import {
	sinceFileChange,
	sinceMarkKey,
	sinceToggleChange,
} from "../../shared/pieces";
import type { ClusterState, SinceMark } from "../../shared/types";
import {
	fileLeft,
	finishes,
	nextFile,
	resetChanges,
	type SinceOnly,
} from "./fileFinish";

const c = (key: string, state: ClusterState) => ({ key, state });
type Cluster = { key: string; state: ClusterState };

describe("finishes", () => {
	it("is true when the last unreviewed cluster gets marked", () => {
		const clusters = [c("a", "reviewed"), c("b", "unreviewed")];
		expect(finishes(clusters, [{ key: "b", state: "reviewed" }])).toBe(true);
		expect(finishes(clusters, [{ key: "b", state: "crossed-off" }])).toBe(true);
	});

	it("is false while something stays unreviewed", () => {
		const clusters = [c("a", "unreviewed"), c("b", "unreviewed")];
		expect(finishes(clusters, [{ key: "a", state: "reviewed" }])).toBe(false);
	});

	it("is false for a file finished already, or for unmarking", () => {
		const done = [c("a", "reviewed"), c("b", "crossed-off")];
		expect(finishes(done, [{ key: "b", state: "reviewed" }])).toBe(false);
		expect(finishes(done, [{ key: "a", state: "unreviewed" }])).toBe(false);
		expect(finishes([], [])).toBe(false);
	});

	it("a piece's mark finishes only when it leaves no line unmarked; a since-only mark never", () => {
		const clusters = [c("a", "reviewed"), c("b", "unreviewed")];
		// Part of b's lines: the change keeps b unreviewed (pieces.ts changeFor).
		expect(
			finishes(clusters, [
				{ key: "b", state: "unreviewed", reviewedLines: [[0, 5]] },
			]),
		).toBe(false);
		expect(
			finishes(clusters, [
				{ key: "b", state: "unreviewed", crossedLines: [[0, 5]] },
			]),
		).toBe(false);
		// The last piece: changeFor makes the whole cluster's state.
		expect(finishes(clusters, [{ key: "b", state: "reviewed" }])).toBe(true);
		// A since-only piece's mark has its own key, never a cluster's.
		expect(
			finishes(clusters, [
				{ key: sinceMarkKey(1, "src/a.ts"), state: "reviewed" },
			]),
		).toBe(false);
	});

	it("ignores a change for a key the file doesn't have", () => {
		const clusters = [c("a", "unreviewed")];
		expect(finishes(clusters, [{ key: "x", state: "reviewed" }])).toBe(false);
	});
});

describe("finishes, the file's since mark as the changes leave it", () => {
	const a = { old: [[1, 2]] as [number, number][], new: [] };
	const b = { old: [[5, 6]] as [number, number][], new: [] };
	const mark = (reviewed: [number, number][]): SinceMark => ({
		since: 1,
		path: "src/a.ts",
		reviewed: { old: reviewed, new: [] },
		crossed: { old: [], new: [] },
	});
	const only: SinceOnly = {
		marks: [mark([[1, 2]])],
		since: 1,
		path: "src/a.ts",
		pieces: [a, b],
	};
	const both = mark([
		[1, 2],
		[5, 6],
	]);
	const tick = {
		key: sinceMarkKey(1, "src/a.ts"),
		state: "reviewed" as const,
		sinceMark: both,
	};

	it("the new mark replaces the file's old one: ticking the last piece finishes it", () => {
		expect(finishes([c("k", "reviewed")], [tick], only)).toBe(true);
	});

	it("reads the file's own mark among the changes, not the last change's", () => {
		expect(
			finishes(
				[c("k", "reviewed")],
				[tick, { key: "k", state: "reviewed" }],
				only,
			),
		).toBe(true);
	});
});

describe("finishes, in the since view (CAR-159)", () => {
	// One removed piece no cluster owns: old lines 10 and 11 ([10, 12) is half-open).
	const removed = { old: [[10, 12]] as [number, number][], new: [] };
	const only = (marks?: SinceMark[]): SinceOnly => ({
		marks,
		since: 1,
		path: "src/a.ts",
		pieces: [removed],
	});
	const marked = (kind: "reviewed" | "crossed"): SinceMark => ({
		since: 1,
		path: "src/a.ts",
		reviewed: { old: kind === "reviewed" ? [[10, 12]] : [], new: [] },
		crossed: { old: kind === "crossed" ? [[10, 12]] : [], new: [] },
	});

	it("marking the last cluster doesn't finish while a removed piece is left", () => {
		const clusters = [c("a", "unreviewed")];
		expect(finishes(clusters, [{ key: "a", state: "reviewed" }], only())).toBe(
			false,
		);
		expect(
			finishes(clusters, [{ key: "a", state: "crossed-off" }], only()),
		).toBe(false);
		// Once the piece is marked, the cluster does.
		expect(
			finishes(
				clusters,
				[{ key: "a", state: "reviewed" }],
				only([marked("reviewed")]),
			),
		).toBe(true);
	});

	it("marking the last removed piece, clusters done, finishes the file", () => {
		const clusters = [c("a", "reviewed")];
		for (const cross of [false, true]) {
			const change = sinceToggleChange(
				undefined,
				1,
				"src/a.ts",
				removed,
				cross,
			);
			expect(finishes(clusters, [change], only())).toBe(true);
		}
		// The header's ✓ on the pieces left (CAR-155's open note).
		const all = sinceFileChange(
			undefined,
			1,
			"src/a.ts",
			[removed],
			"reviewed",
		);
		expect(all).not.toBeNull();
		expect(finishes(clusters, all ? [all] : [], only())).toBe(true);
		// A file without clusters (all its pieces since-only).
		const tick = sinceToggleChange(undefined, 1, "src/a.ts", removed);
		expect(finishes([], [tick], only())).toBe(true);
	});

	it("marking a piece while a cluster is left doesn't finish", () => {
		const change = sinceToggleChange(undefined, 1, "src/a.ts", removed);
		expect(finishes([c("a", "unreviewed")], [change], only())).toBe(false);
	});

	it("unmarking a piece, or a mark for another file or patch set, never finishes", () => {
		const clusters = [c("a", "reviewed")];
		const done = only([marked("reviewed")]);
		const undo = sinceToggleChange(
			[marked("reviewed")],
			1,
			"src/a.ts",
			removed,
		);
		expect(undo.state).toBe("unreviewed");
		expect(finishes(clusters, [undo], done)).toBe(false);
		const other = sinceToggleChange(undefined, 1, "src/b.ts", removed);
		expect(finishes(clusters, [other], only())).toBe(false);
		const older = sinceToggleChange(undefined, 2, "src/a.ts", removed);
		expect(finishes(clusters, [older], only())).toBe(false);
	});

	it("fileLeft counts a cluster or an unmarked piece", () => {
		expect(fileLeft([c("a", "reviewed")], only())).toBe(true);
		expect(fileLeft([c("a", "reviewed")], only([marked("crossed")]))).toBe(
			false,
		);
		expect(fileLeft([c("a", "unreviewed")], only([marked("reviewed")]))).toBe(
			true,
		);
		expect(fileLeft([c("a", "reviewed")])).toBe(false);
	});
});

describe("resetChanges", () => {
	const mixed = [c("a", "reviewed"), c("b", "crossed-off"), c("d", "reviewed")];

	it("sets only its own kind back to unreviewed", () => {
		expect(resetChanges(mixed, "reviewed")).toEqual([
			{ key: "a", state: "unreviewed" },
			{ key: "d", state: "unreviewed" },
		]);
		expect(resetChanges(mixed, "crossed-off")).toEqual([
			{ key: "b", state: "unreviewed" },
		]);
	});

	it("is empty while anything is unreviewed, or with none of its kind", () => {
		expect(resetChanges([...mixed, c("e", "unreviewed")], "reviewed")).toEqual(
			[],
		);
		expect(resetChanges([c("a", "reviewed")], "crossed-off")).toEqual([]);
	});

	it("never marks anything", () => {
		for (const kind of ["reviewed", "crossed-off"] as const) {
			for (const change of resetChanges(mixed, kind)) {
				expect(change.state).toBe("unreviewed");
			}
		}
	});
});

describe("nextFile", () => {
	const left = [c("a", "reviewed"), c("b", "unreviewed")];
	const done = [c("a", "reviewed"), c("b", "crossed-off")];
	const f = (index: number, clusters: Cluster[]) => ({ index, clusters });
	it("follows the given order, not the index", () => {
		const files = [f(2, left), f(0, left), f(1, left)];
		expect(nextFile(files, 2)?.index).toBe(0);
		expect(nextFile(files, 0)?.index).toBe(1);
	});
	it("skips files with nothing unreviewed, and files without clusters", () => {
		const files = [f(0, left), f(1, done), f(2, []), f(3, left)];
		expect(nextFile(files, 0)?.index).toBe(3);
	});
	it("wraps past the end to the files before", () => {
		const files = [f(0, done), f(1, left), f(2, done), f(3, left)];
		expect(nextFile(files, 3)?.index).toBe(1);
		expect(nextFile(files, 1)?.index).toBe(3);
	});
	it("takes what counts as left (the since view's pieces too)", () => {
		const files = [f(0, left), f(1, done), f(2, left)];
		const piecesIn = new Set([1]);
		expect(
			nextFile(files, 0, (x) => fileLeft(x.clusters) || piecesIn.has(x.index))
				?.index,
		).toBe(1);
	});
	it("in the since view, a file with only a since-only piece left is next, even the only one left (CAR-159)", () => {
		const removed = { old: [[10, 12]] as [number, number][], new: [] };
		// B's clusters are done; its removed piece is unmarked. D is a gone
		// file: no clusters, every piece its own.
		const files = [
			{ index: 0, path: "a.ts", clusters: left },
			{ index: 1, path: "b.ts", clusters: done },
			{ index: 2, path: "c.ts", clusters: left },
			{ index: 3, path: "d.ts", clusters: [] },
		];
		const sinceLeft =
			(marks: SinceMark[]) => (x: { path: string; clusters: Cluster[] }) =>
				fileLeft(x.clusters, {
					marks,
					since: 1,
					path: x.path,
					pieces: [removed],
				});
		const markedOn = (path: string): SinceMark => ({
			since: 1,
			path,
			reviewed: { old: [[10, 12]], new: [] },
			crossed: { old: [], new: [] },
		});
		// Every file has its piece left: B, not C.
		expect(nextFile(files, 0, sinceLeft([]))?.index).toBe(1);
		// The clusters-only default skips B.
		expect(nextFile(files, 0)?.index).toBe(2);
		// B the only file left (C's and D's pieces marked, C's clusters too).
		const onlyB = files.map((f) =>
			f.index === 2 ? { ...f, clusters: done } : f,
		);
		const marks = [markedOn("a.ts"), markedOn("c.ts"), markedOn("d.ts")];
		expect(nextFile(onlyB, 0, sinceLeft(marks))?.index).toBe(1);
		expect(nextFile(onlyB, 0)).toBeUndefined();
		// The gone file, the only one left, is next too.
		expect(
			nextFile(
				onlyB,
				0,
				sinceLeft([markedOn("a.ts"), markedOn("b.ts"), markedOn("c.ts")]),
			)?.index,
		).toBe(3);
	});
	it("has none when no other file has anything left, or for an unknown one", () => {
		const files = [f(0, done), f(1, left), f(2, done)];
		// The finished file itself never counts, whatever it still shows.
		expect(nextFile(files, 1)).toBeUndefined();
		expect(nextFile([f(0, left)], 0)).toBeUndefined();
		expect(nextFile(files, 7)).toBeUndefined();
	});
});
