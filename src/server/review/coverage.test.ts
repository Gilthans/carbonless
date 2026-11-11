import { describe, expect, it } from "vitest";
import type {
	Cluster,
	ClusterState,
	FileSummary,
	Snapshot,
} from "../../shared/types.js";
import { buildReviewView } from "./coverage.js";
import type { PatchsetRecord, ProgressState, StateEntry } from "./fold.js";

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

type Stored = ClusterState | [ClusterState, string] | StateEntry;

/** One patch set on `revision` (none when null) with these states. */
function progress(
	states: Record<string, Stored>,
	revision: string | null = REV,
): ProgressState {
	return progressOf(revision ? [[1, revision, states]] : []);
}

/** Patch sets in start order, each with its own states. */
function progressOf(
	sets: [number, string, Record<string, Stored>][],
): ProgressState {
	const patchsets: PatchsetRecord[] = sets.map(([number, revision]) => ({
		number,
		revision,
		mergeBase: "1".repeat(40),
		head: "2".repeat(40),
		startedAt: number,
		since: number > 1 ? number - 1 : null,
		shape: null,
		baseBranch: null,
		interdiff: null,
	}));
	const statesByRevision = new Map(
		sets.map(([, revision, states]) => [
			revision,
			new Map<string, StateEntry>(
				Object.entries(states).map(([key, s]) =>
					Array.isArray(s)
						? [key, { state: s[0], reason: s[1] }]
						: typeof s === "string"
							? [key, { state: s }]
							: [key, s],
				),
			),
		]),
	);
	const patchset = patchsets.at(-1) ?? null;
	return {
		patchsets,
		patchset,
		states: (patchset && statesByRevision.get(patchset.revision)) ?? new Map(),
		statesByRevision,
		sinceMarks: new Map(sets.map(([, revision]) => [revision, []])),
		placements: new Map(),
	};
}

const three = snapshot([
	file(0, "a.ts", [cluster("k1", 1), cluster("k2", 1)]),
	file(1, "b.ts", [cluster("k3", 1)]),
]);

describe("buildReviewView", () => {
	it("a partly reviewed cluster is unreviewed with its reviewed lines; its lines count, the cluster doesn't", () => {
		const snap = snapshot([
			file(0, "a.ts", [cluster("k1", 10), cluster("k2", 4)]),
		]);
		const view = buildReviewView(
			snap,
			progress({
				k1: { state: "unreviewed", lines: [[2, 5]] },
				k2: { state: "unreviewed", lines: [[0, 4]] },
			}),
		);
		const [k1, k2] = view.files[0]?.clusters ?? [];
		expect(k1).toMatchObject({ state: "unreviewed", reviewedLines: [[2, 5]] });
		// Every line marked one piece at a time: the cluster is reviewed.
		expect(k2?.state).toBe("reviewed");
		expect(k2?.reviewedLines).toBeUndefined();
		expect(view.files[0]?.done).toBe(false);
		expect(view.progress.clusters).toEqual({
			total: 2,
			reviewed: 1,
			crossedOff: 0,
		});
		expect(view.progress.lines).toEqual({
			total: 14,
			reviewed: 7,
			crossedOff: 0,
		});
	});

	it("lines crossed off one piece at a time: partly marked, done (reviewed with its crossed lines), or all crossed off", () => {
		const snap = snapshot([
			file(0, "a.ts", [cluster("k1", 10), cluster("k2", 4), cluster("k3", 4)]),
		]);
		const view = buildReviewView(
			snap,
			progress({
				k1: { state: "unreviewed", lines: [[0, 2]], crossed: [[5, 6]] },
				k2: { state: "unreviewed", lines: [[0, 3]], crossed: [[3, 4]] },
				k3: { state: "unreviewed", crossed: [[0, 4]] },
			}),
		);
		const [k1, k2, k3] = view.files[0]?.clusters ?? [];
		expect(k1).toMatchObject({
			state: "unreviewed",
			reviewedLines: [[0, 2]],
			crossedLines: [[5, 6]],
		});
		expect(k2).toMatchObject({ state: "reviewed", crossedLines: [[3, 4]] });
		expect(k3?.state).toBe("crossed-off");
		expect(view.progress.lines).toEqual({
			total: 18,
			reviewed: 2 + 3,
			crossedOff: 1 + 1 + 4,
		});
		expect(view.progress.clusters).toEqual({
			total: 3,
			reviewed: 1,
			crossedOff: 1,
		});
	});

	it("shows the patch set's since marks, never in its progress", () => {
		const base = progress({});
		const mark = {
			since: 1,
			path: "a.ts",
			reviewed: { old: [[3, 5]] as [number, number][], new: [] },
			crossed: { old: [], new: [] },
		};
		base.sinceMarks.set(REV, [mark]);
		const view = buildReviewView(three, base);
		expect(view.sinceMarks).toEqual([mark]);
		expect(view.progress.lines.reviewed).toBe(0);
		expect(buildReviewView(three, progress({})).sinceMarks).toBeUndefined();
	});

	it("a partial mark past the cluster's lines, or on a file-level cluster, covers nothing (fail closed)", () => {
		const fileLevel: Cluster = {
			...cluster("k3", 0),
			kind: "file",
			newCount: 0,
			added: [],
		};
		const snap = snapshot([
			file(0, "a.ts", [cluster("k1", 4), cluster("k2", 4), fileLevel]),
		]);
		const view = buildReviewView(
			snap,
			progress({
				k1: { state: "unreviewed", lines: [[0, 5]] },
				k2: {
					state: "unreviewed",
					lines: [
						[0, 1],
						[3, 9],
					],
				},
				k3: { state: "unreviewed", lines: [[0, 1]] },
			}),
		);
		for (const c of view.files[0]?.clusters ?? []) {
			expect(c.state).toBe("unreviewed");
			expect(c.reviewedLines).toBeUndefined();
		}
		expect(view.progress.lines.reviewed).toBe(0);
	});

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
		expect(view.files.map((f) => [f.done, f.reviewed, f.crossedOff])).toEqual([
			[true, true, false],
			[true, false, true],
			[false, false, false],
		]);
		expect(view.files[1]?.clusters[0]).toMatchObject({
			state: "crossed-off",
			reason: "generated",
		});
	});

	it("a file with reviewed and crossed-off clusters is done, and counts as reviewed", () => {
		const snap = snapshot([
			file(0, "a.ts", [cluster("k1", 1), cluster("k2", 1)]),
		]);
		const view = buildReviewView(
			snap,
			progress({ k1: "reviewed", k2: ["crossed-off", "generated"] }),
		);
		expect(view.files[0]).toMatchObject({
			done: true,
			reviewed: true,
			crossedOff: false,
		});
		// Owner: crossed off "only if all clusters are crossed off".
		expect(view.progress.files).toEqual({
			total: 1,
			reviewed: 1,
			crossedOff: 0,
			done: 1,
		});
	});

	it("a file counts crossed off only when all of it is, and neither while any cluster is unreviewed", () => {
		const snap = snapshot([
			file(0, "a.ts", [cluster("k1", 1), cluster("k2", 1), cluster("k3", 1)]),
			file(1, "b.ts", [cluster("k4", 1), cluster("k5", 1)]),
			file(2, "c.ts", [cluster("k6", 1), cluster("k7", 1)]),
		]);
		const view = buildReviewView(
			snap,
			progress({
				k1: "reviewed",
				k2: "crossed-off",
				k3: "crossed-off",
				k4: "crossed-off",
				k5: "crossed-off",
				k6: "reviewed",
				k7: "unreviewed",
			}),
		);
		expect(
			view.files.map((f) => [f.path, f.done, f.reviewed, f.crossedOff]),
		).toEqual([
			["a.ts", true, true, false],
			["b.ts", true, false, true],
			["c.ts", false, false, false],
		]);
		expect(view.progress.files).toEqual({
			total: 3,
			reviewed: 1,
			crossedOff: 1,
			done: 2,
		});
	});

	it("a crossed-off state without a reason counts as crossed off, never reviewed", () => {
		const view = buildReviewView(
			three,
			progress({ k1: "crossed-off", k2: ["crossed-off", "  "] }),
		);
		expect(view.progress.clusters).toEqual({
			total: 3,
			reviewed: 0,
			crossedOff: 2,
		});
		expect(view.files[0]?.clusters.map((c) => c.state)).toEqual([
			"crossed-off",
			"crossed-off",
		]);
		// No reason, and a blank one, show as no reason at all.
		for (const c of view.files[0]?.clusters ?? []) {
			expect(c).not.toHaveProperty("reason");
		}
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

	it("applies each patch set's own states to its own snapshot", () => {
		const OTHER = "d".repeat(64);
		const both = progressOf([
			[1, REV, { k1: "reviewed", k2: "reviewed" }],
			[2, OTHER, { k3: "crossed-off" }],
		]);
		const ps1 = buildReviewView(three, both);
		expect(ps1.patchset).toBe(1);
		expect(ps1.files.flatMap((f) => f.clusters.map((c) => c.state))).toEqual([
			"reviewed",
			"reviewed",
			"unreviewed",
		]);
		const ps2 = buildReviewView(
			snapshot([three.files[0], three.files[1]] as FileSummary[], OTHER),
			both,
		);
		expect(ps2.patchset).toBe(2);
		expect(ps2.files.flatMap((f) => f.clusters.map((c) => c.state))).toEqual([
			"unreviewed",
			"unreviewed",
			"crossed-off",
		]);
	});

	it("shows a carried state with where it came from", () => {
		const view = buildReviewView(
			three,
			progress({
				k1: { state: "reviewed", carried: { from: 1, rule: "exact" } },
				k2: {
					state: "crossed-off",
					reason: "generated",
					carried: { from: 1, rule: "rename" },
				},
				k3: "reviewed",
			}),
		);
		const [k1, k2] = view.files[0]?.clusters ?? [];
		expect(k1).toMatchObject({
			state: "reviewed",
			carried: { from: 1, rule: "exact" },
		});
		expect(k2).toMatchObject({
			state: "crossed-off",
			reason: "generated",
			carried: { from: 1, rule: "rename" },
		});
		expect(view.files[1]?.clusters[0]).not.toHaveProperty("carried");
		expect(view.progress.clusters).toEqual({
			total: 3,
			reviewed: 2,
			crossedOff: 1,
		});
	});

	it("never shows a carried mark on an unreviewed cluster", () => {
		const view = buildReviewView(
			three,
			progress({
				k1: { state: "unreviewed", carried: { from: 1, rule: "exact" } },
			}),
		);
		expect(view.files[0]?.clusters[0]).toEqual(
			expect.objectContaining({ state: "unreviewed" }),
		);
		expect(view.files[0]?.clusters[0]).not.toHaveProperty("carried");
	});
});
