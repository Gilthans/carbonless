import { describe, expect, it } from "vitest";
import {
	countedProgress,
	fileFlags,
	reviewProgress,
	withoutWhitespaceOnly,
} from "./progress.js";
import type { ClusterState, ClusterView, FileView } from "./types.js";

const cluster = (
	key: string,
	state: ClusterState,
	ws = false,
	lines = 4,
): ClusterView => ({
	key,
	kind: "lines",
	oldStart: 1,
	oldCount: 2,
	newStart: 1,
	newCount: 2,
	removed: [],
	added: [],
	lines,
	state,
	...(ws ? { whitespaceOnly: true as const } : {}),
});

const file = (index: number, clusters: ClusterView[]): FileView => ({
	index,
	path: `f${index}.ts`,
	status: "modified",
	binary: false,
	submodule: false,
	additions: 1,
	deletions: 1,
	clusters,
	...fileFlags(clusters),
});

describe("progress with Ignore whitespace on (CAR-156)", () => {
	// change / whitespace-only / change, the changes reviewed.
	const mixed = file(0, [
		cluster("a", "reviewed"),
		cluster("w", "unreviewed", true),
		cluster("b", "reviewed"),
	]);
	const allWs = file(1, [cluster("x", "unreviewed", true)]);
	const plain = file(2, [cluster("p", "crossed-off")]);

	it("leaves whitespace-only clusters out: 100% once the rest is reviewed, the file done", () => {
		const counted = withoutWhitespaceOnly(mixed);
		expect(counted.clusters.map((c) => c.key)).toEqual(["a", "b"]);
		expect(counted).toMatchObject({ done: true, reviewed: true });
		const { progress, leftOut } = countedProgress([mixed, allWs, plain]);
		expect(leftOut).toBe(2);
		expect(progress.clusters).toEqual({ total: 3, reviewed: 2, crossedOff: 1 });
		expect(progress.lines).toEqual({ total: 12, reviewed: 8, crossedOff: 4 });
		// The all-whitespace file has nothing to count: out of the files too.
		expect(progress.files).toEqual({
			total: 2,
			reviewed: 1,
			crossedOff: 1,
			done: 2,
		});
	});

	it("ignores a whitespace-only cluster's own mark", () => {
		const ticked = file(0, [
			cluster("a", "unreviewed"),
			cluster("w", "reviewed", true),
		]);
		const { progress } = countedProgress([ticked]);
		expect(progress.clusters).toEqual({ total: 1, reviewed: 0, crossedOff: 0 });
		expect(withoutWhitespaceOnly(ticked).done).toBe(false);
	});

	it("is the same file, and the same counts, when nothing is whitespace-only", () => {
		expect(withoutWhitespaceOnly(plain)).toBe(plain);
		expect(countedProgress([plain])).toEqual({
			progress: reviewProgress([plain]),
			leftOut: 0,
		});
	});

	it("counts every cluster as before with the switch off: the unreviewed whitespace-only one shows", () => {
		const off = reviewProgress([mixed, allWs]);
		expect(off.clusters).toEqual({ total: 4, reviewed: 2, crossedOff: 0 });
		expect(off.files.done).toBe(0);
	});
});
