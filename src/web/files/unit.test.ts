// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClusterState, ClusterView, FileView } from "../../shared/types";
import {
	fileUnitProgress,
	pageCounts,
	pagePercent,
	percent,
	readUnit,
	UNIT_STORAGE_KEY,
	writeUnit,
} from "./unit";

const cluster = (
	state: ClusterState,
	lines: number,
	kind: "lines" | "file" = "lines",
): ClusterView => ({
	key: `${state}${lines}${Math.random()}`,
	kind,
	oldStart: 1,
	oldCount: 1,
	newStart: 1,
	newCount: 1,
	removed: [],
	added: [],
	lines,
	state,
});

const file = (clusters: ClusterView[]): FileView => ({
	index: 0,
	path: "a.ts",
	status: "modified",
	binary: false,
	submodule: false,
	additions: 0,
	deletions: 0,
	clusters,
	done: clusters.every((c) => c.state !== "unreviewed"),
	crossedOff: clusters.every((c) => c.state === "crossed-off"),
});

describe("percent", () => {
	it("is reviewed out of what isn't crossed off, floored; 0/0 is 100", () => {
		expect(percent({ total: 39, reviewed: 18, crossedOff: 4 })).toBe(51);
		expect(percent({ total: 2, reviewed: 0, crossedOff: 2 })).toBe(100);
		expect(percent({ total: 0, reviewed: 0, crossedOff: 0 })).toBe(100);
	});
});

describe("pageCounts and pagePercent", () => {
	const progress = {
		clusters: { total: 4, reviewed: 1, crossedOff: 1 },
		lines: { total: 40, reviewed: 10, crossedOff: 5 },
		files: { total: 3, reviewed: 1, crossedOff: 1, done: 2 },
	};

	it("picks the selected unit's counts", () => {
		expect(pageCounts(progress, "lines")).toEqual(progress.lines);
		expect(pageCounts(progress, "clusters")).toEqual(progress.clusters);
		expect(pageCounts(progress, "files")).toEqual({
			total: 3,
			reviewed: 1,
			crossedOff: 1,
		});
		expect(pagePercent(progress, "lines")).toBe(28);
	});

	it("never shows 100% while a cluster is unreviewed", () => {
		// Only a rename is left: no changed lines, but a cluster to review.
		const renameLeft = {
			clusters: { total: 2, reviewed: 1, crossedOff: 0 },
			lines: { total: 4, reviewed: 4, crossedOff: 0 },
			files: { total: 2, reviewed: 1, crossedOff: 0, done: 1 },
		};
		expect(pagePercent(renameLeft, "lines")).toBe(99);
		const onlyRenames = {
			clusters: { total: 1, reviewed: 0, crossedOff: 0 },
			lines: { total: 0, reviewed: 0, crossedOff: 0 },
			files: { total: 1, reviewed: 0, crossedOff: 0, done: 0 },
		};
		expect(pagePercent(onlyRenames, "lines")).toBe(0);
	});
});

describe("fileUnitProgress", () => {
	const mixed = file([
		cluster("reviewed", 3),
		cluster("crossed-off", 2),
		cluster("unreviewed", 5),
	]);

	it("counts lines and clusters, leaving crossed off out of the total", () => {
		expect(fileUnitProgress(mixed, "lines")).toMatchObject({
			unit: "lines",
			counts: { total: 10, reviewed: 3, crossedOff: 2 },
			text: "3 / 8",
		});
		expect(fileUnitProgress(mixed, "clusters")).toMatchObject({
			unit: "clusters",
			text: "1 / 2",
		});
	});

	it("shows a file as done or not done in the files unit", () => {
		expect(fileUnitProgress(mixed, "files").text).toBe("0 / 1");
		const done = file([cluster("reviewed", 3), cluster("crossed-off", 2)]);
		expect(fileUnitProgress(done, "files")).toMatchObject({
			text: "done",
			counts: { total: 1, reviewed: 1, crossedOff: 0 },
		});
	});

	it("never calls a crossed-off file done or reviewed", () => {
		const crossed = file([cluster("crossed-off", 2)]);
		for (const unit of ["lines", "clusters", "files"] as const) {
			const p = fileUnitProgress(crossed, unit);
			expect(p.text).toBe("crossed off");
			expect(p.counts.reviewed).toBe(0);
		}
	});

	it("falls back to clusters when a file has no changed lines", () => {
		const rename = file([cluster("unreviewed", 0, "file")]);
		expect(fileUnitProgress(rename, "lines")).toMatchObject({
			unit: "clusters",
			text: "0 / 1",
		});
	});
});

describe("the remembered unit", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
	});

	it("defaults to lines and remembers a choice", () => {
		expect(readUnit()).toBe("lines");
		writeUnit("files");
		expect(localStorage.getItem(UNIT_STORAGE_KEY)).toBe("files");
		expect(readUnit()).toBe("files");
	});

	it("ignores unknown stored values", () => {
		localStorage.setItem(UNIT_STORAGE_KEY, "bananas");
		expect(readUnit()).toBe("lines");
	});

	it("works without storage", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("denied");
		});
		expect(readUnit()).toBe("lines");
		expect(() => writeUnit("clusters")).not.toThrow();
	});
});
