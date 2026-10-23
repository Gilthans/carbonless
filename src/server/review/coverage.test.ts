import { describe, expect, it } from "vitest";
import type {
	Cluster,
	ClusterState,
	FileSummary,
	Snapshot,
} from "../../shared/types.js";
import { buildReviewView } from "./coverage.js";
import type { ProgressState } from "./fold.js";

const REV = "a".repeat(64);

function cluster(key: string, lines: number): Cluster {
	return {
		key,
		kind: "lines",
		oldStart: 1,
		oldCount: 0,
		newStart: 1,
		newCount: lines,
		removed: [],
		added: Array.from({ length: lines }, (_, i) => `line ${i}`),
		lines,
	};
}

function file(index: number, path: string, clusters: Cluster[]): FileSummary {
	return {
		index,
		path,
		status: "modified",
		binary: false,
		submodule: false,
		additions: clusters.reduce((n, c) => n + c.lines, 0),
		deletions: 0,
		clusters,
	};
}

function snapshot(files: FileSummary[], revision = REV): Snapshot {
	return { base: "1".repeat(40), head: "2".repeat(40), revision, files };
}

function progress(
	states: Record<string, ClusterState | [ClusterState, string]>,
	revision: string | null = REV,
): ProgressState {
	return {
		patchset: revision
			? {
					number: 1,
					revision,
					mergeBase: "1".repeat(40),
					head: "2".repeat(40),
				}
			: null,
		states: new Map(
			Object.entries(states).map(([key, s]) =>
				Array.isArray(s)
					? [key, { state: s[0], reason: s[1] }]
					: [key, { state: s }],
			),
		),
	};
}

const three = snapshot([
	file(0, "a.ts", [cluster("k1", 1), cluster("k2", 1)]),
	file(1, "b.ts", [cluster("k3", 1)]),
]);

describe("buildReviewView", () => {
	it("clusters without a stored state are unreviewed", () => {
		const view = buildReviewView(three, progress({ k2: "reviewed" }));
		expect(
			view.files.flatMap((f) => f.clusters.map((c) => [c.key, c.state])),
		).toEqual([
			["k1", "unreviewed"],
			["k2", "reviewed"],
			["k3", "unreviewed"],
		]);
		expect(view.files.map((f) => f.done)).toEqual([false, false]);
		expect(view).toMatchObject({ revision: REV, patchset: 1 });
	});

	it("a stored state for a cluster not in the snapshot is ignored", () => {
		const view = buildReviewView(
			three,
			progress({ k1: "reviewed", ghost: "reviewed", ghost2: "reviewed" }),
		);
		expect(view.progress.clusters).toEqual({
			total: 3,
			reviewed: 1,
			crossedOff: 0,
		});
		expect(JSON.stringify(view)).not.toContain("ghost");
	});

	it("progress counts lines and files", () => {
		const snap = snapshot([
			file(0, "a.ts", [cluster("k1", 10)]),
			file(1, "gen.ts", [cluster("k2", 5)]),
			file(2, "c.ts", [cluster("k3", 2), cluster("k4", 13)]),
		]);
		const view = buildReviewView(
			snap,
			progress({
				k1: "reviewed",
				k2: ["crossed-off", "generated"],
				k3: "reviewed",
			}),
		);
		expect(view.progress).toEqual({
			clusters: { total: 4, reviewed: 2, crossedOff: 1 },
			lines: { total: 30, reviewed: 12, crossedOff: 5 },
			files: { total: 3, reviewed: 1, crossedOff: 1, done: 2 },
		});
		expect(view.files.map((f) => [f.done, f.crossedOff])).toEqual([
			[true, false],
			[true, true],
			[false, false],
		]);
		expect(view.files[1]?.clusters[0]).toMatchObject({
			state: "crossed-off",
			reason: "generated",
		});
	});

	it("a file with reviewed and crossed-off clusters is done, not crossed off", () => {
		const snap = snapshot([
			file(0, "a.ts", [cluster("k1", 1), cluster("k2", 1)]),
		]);
		const view = buildReviewView(
			snap,
			progress({ k1: "reviewed", k2: ["crossed-off", "generated"] }),
		);
		expect(view.files[0]).toMatchObject({ done: true, crossedOff: false });
		expect(view.progress.files).toEqual({
			total: 1,
			reviewed: 1,
			crossedOff: 0,
			done: 1,
		});
	});

	it("a crossed-off state without a reason counts as unreviewed", () => {
		const view = buildReviewView(
			three,
			progress({ k1: "crossed-off", k2: ["crossed-off", ""] }),
		);
		expect(view.progress.clusters.crossedOff).toBe(0);
		expect(view.files[0]?.clusters.map((c) => c.state)).toEqual([
			"unreviewed",
			"unreviewed",
		]);
	});

	it("a reason on a reviewed cluster is dropped", () => {
		const view = buildReviewView(three, progress({ k1: ["reviewed", "x"] }));
		expect(view.files[0]?.clusters[0]).not.toHaveProperty("reason");
	});

	it("clusters sharing a key stay unreviewed", () => {
		const snap = snapshot([
			file(0, "a.ts", [cluster("dup", 1), cluster("k2", 1)]),
			file(1, "b.ts", [cluster("dup", 1)]),
		]);
		const view = buildReviewView(
			snap,
			progress({ dup: "reviewed", k2: "reviewed" }),
		);
		expect(view.progress.clusters).toEqual({
			total: 3,
			reviewed: 1,
			crossedOff: 0,
		});
	});

	it("states of a patch set on another revision are ignored", () => {
		const view = buildReviewView(
			three,
			progress({ k1: "reviewed" }, "c".repeat(64)),
		);
		expect(view.progress.clusters.reviewed).toBe(0);
		expect(view.patchset).toBeNull();
	});

	it("without a patch set everything is unreviewed", () => {
		const view = buildReviewView(three, progress({ k1: "reviewed" }, null));
		expect(view.progress.clusters.reviewed).toBe(0);
		expect(view.patchset).toBeNull();
	});

	it("a file without clusters is never done", () => {
		const view = buildReviewView(snapshot([file(0, "a.ts", [])]), progress({}));
		expect(view.files[0]).toMatchObject({ done: false, crossedOff: false });
		expect(view.progress.files).toEqual({
			total: 1,
			reviewed: 0,
			crossedOff: 0,
			done: 0,
		});
	});
});
