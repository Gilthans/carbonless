// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClusterState, ClusterView, FileView } from "../../shared/types";
import {
	type FormatOptions,
	fileUnitProgress,
	formatFileProgress,
	nothingLeft,
	pageCounts,
	pagePercent,
	percent,
	readUnit,
	UNIT_STORAGE_KEY,
	type Unit,
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
	reviewed: clusters.every((c) => c.state === "reviewed"),
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

describe("nothingLeft", () => {
	it("is true only when everything the unit counts is crossed off and no cluster is left", () => {
		const all = {
			clusters: { total: 2, reviewed: 0, crossedOff: 2 },
			lines: { total: 4, reviewed: 0, crossedOff: 4 },
			files: { total: 1, reviewed: 0, crossedOff: 1, done: 1 },
		};
		expect(nothingLeft(all, "lines")).toBe(true);
		expect(nothingLeft(all, "files")).toBe(true);
		const empty = {
			clusters: { total: 0, reviewed: 0, crossedOff: 0 },
			lines: { total: 0, reviewed: 0, crossedOff: 0 },
			files: { total: 0, reviewed: 0, crossedOff: 0, done: 0 },
		};
		expect(nothingLeft(empty, "lines")).toBe(false);
		const renameLeft = {
			...all,
			clusters: { total: 3, reviewed: 0, crossedOff: 2 },
		};
		expect(nothingLeft(renameLeft, "lines")).toBe(false);
	});
});

describe("fileUnitProgress", () => {
	const mixed = file([
		cluster("reviewed", 3),
		cluster("crossed-off", 2),
		cluster("unreviewed", 5),
	]);
	const text = (f: FileView, unit: Unit, opts?: FormatOptions) =>
		formatFileProgress(fileUnitProgress(f, unit), unit, opts);

	it("counts lines and clusters, leaving crossed off out of the total", () => {
		expect(fileUnitProgress(mixed, "lines")).toMatchObject({
			counts: { total: 10, reviewed: 3, crossedOff: 2 },
			percent: 37,
		});
		expect(text(mixed, "lines")).toBe("3 / 8");
		expect(text(mixed, "lines", { withUnit: true })).toBe("3 / 8 lines");
		expect(text(mixed, "clusters", { withUnit: true })).toBe("1 / 2 clusters");
	});

	it("shows a file as done or not done in the files unit", () => {
		expect(text(mixed, "files")).toBe("0 / 1");
		const reviewed = file([cluster("reviewed", 3), cluster("reviewed", 2)]);
		expect(fileUnitProgress(reviewed, "files")).toMatchObject({
			counts: { total: 1, reviewed: 1, crossedOff: 0 },
			percent: 100,
		});
		expect(text(reviewed, "files")).toBe("done");
	});

	it("counts a done file with a crossed-off cluster as crossed off, not reviewed", () => {
		const partly = file([
			cluster("reviewed", 3),
			cluster("crossed-off", 2),
			cluster("crossed-off", 1),
		]);
		expect(fileUnitProgress(partly, "files").counts).toEqual({
			total: 1,
			reviewed: 0,
			crossedOff: 1,
		});
		expect(text(partly, "files")).toBe("done · 2 crossed off");
		expect(text(partly, "files", { short: true })).toBe("done · ⊘2");
	});

	it("says done when all a file's lines left were crossed off", () => {
		const f = file([cluster("reviewed", 0, "file"), cluster("crossed-off", 4)]);
		expect(text(f, "lines", { withUnit: true })).toBe("done · 1 crossed off");
	});

	it("takes whether a file is reviewed from the server", () => {
		// The rule lives in one place (coverage.ts): a file the server doesn't
		// call reviewed never counts as reviewed here.
		const f = { ...file([cluster("reviewed", 3)]), reviewed: false };
		expect(fileUnitProgress(f, "files").counts.reviewed).toBe(0);
	});

	it("never calls a crossed-off file done or reviewed", () => {
		const crossed = file([cluster("crossed-off", 2)]);
		for (const unit of ["lines", "clusters", "files"] as const) {
			const p = fileUnitProgress(crossed, unit);
			expect(formatFileProgress(p, unit)).toBe("crossed off");
			expect(p.counts.reviewed).toBe(0);
		}
	});

	it("a renamed and edited file isn't finished in lines while the rename is unreviewed", () => {
		const renamedAndEdited = file([
			cluster("unreviewed", 0, "file"),
			cluster("reviewed", 3),
		]);
		const p = fileUnitProgress(renamedAndEdited, "lines");
		expect(p.percent).toBe(99);
		expect(p.clustersLeft).toBe(1);
		expect(text(renamedAndEdited, "lines", { withUnit: true })).toBe(
			"3 / 3 lines · 1 cluster left",
		);
		expect(text(renamedAndEdited, "lines", { short: true })).toBe(
			"3 / 3 · 1 left",
		);
	});

	it("shows a status phrase for a file without changed lines in lines", () => {
		const rename = file([cluster("unreviewed", 0, "file")]);
		expect(fileUnitProgress(rename, "lines").percent).toBe(0);
		expect(text(rename, "lines", { withUnit: true })).toBe("1 cluster left");
		expect(text(rename, "lines", { short: true })).toBe("1 cluster left");
		const reviewed = file([cluster("reviewed", 0, "file")]);
		expect(text(reviewed, "lines")).toBe("done");
		expect(fileUnitProgress(reviewed, "lines").percent).toBe(100);
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
