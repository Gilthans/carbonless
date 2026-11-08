import { describe, expect, it } from "vitest";
import type { ClusterState } from "../../shared/types";
import { finishes, nextFile, resetChanges } from "./fileFinish";

const c = (key: string, state: ClusterState) => ({ key, state });

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
	const files = [{ index: 2 }, { index: 0 }, { index: 1 }];
	it("follows the given order, not the index", () => {
		expect(nextFile(files, 2)).toEqual({ index: 0 });
		expect(nextFile(files, 0)).toEqual({ index: 1 });
	});
	it("has none after the last file, or for an unknown one", () => {
		expect(nextFile(files, 1)).toBeUndefined();
		expect(nextFile(files, 7)).toBeUndefined();
	});
});
