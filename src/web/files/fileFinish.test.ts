import { describe, expect, it } from "vitest";
import type { ClusterState } from "../../shared/types";
import { finishes, nextFile, resetChanges } from "./fileFinish";

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

	it("ignores a change for a key the file doesn't have", () => {
		const clusters = [c("a", "unreviewed")];
		expect(finishes(clusters, [{ key: "x", state: "reviewed" }])).toBe(false);
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
	it("has none when no other file has anything left, or for an unknown one", () => {
		const files = [f(0, done), f(1, left), f(2, done)];
		// The finished file itself never counts, whatever it still shows.
		expect(nextFile(files, 1)).toBeUndefined();
		expect(nextFile([f(0, left)], 0)).toBeUndefined();
		expect(nextFile(files, 7)).toBeUndefined();
	});
});
