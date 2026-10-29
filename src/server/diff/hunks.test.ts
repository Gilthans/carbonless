import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
} from "../../../test/git-fixture.js";
import type { Cluster, DisplayHunk } from "../../shared/types.js";
import { runGit } from "../git.js";
import { buildClusters } from "./clusters.js";
import { DIFF_ARGS, listChangedFiles } from "./files.js";
import { buildDisplayHunks, contextLines } from "./hunks.js";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

interface Edit {
	/** Number of old lines kept before this edit. */
	at: number;
	remove: number;
	add: string[];
}

/** Applies edits to `old`, returning the new lines and the -U0 clusters. */
function applyEdits(old: string[], edits: Edit[]) {
	const newLines: string[] = [];
	const clusters: Cluster[] = [];
	let next = 0;
	for (const [i, edit] of edits.entries()) {
		newLines.push(...old.slice(next, edit.at));
		const removed = old.slice(edit.at, edit.at + edit.remove);
		clusters.push({
			key: `k${i + 1}`,
			kind: "lines",
			oldStart: edit.remove > 0 ? edit.at + 1 : edit.at,
			oldCount: edit.remove,
			newStart: edit.add.length > 0 ? newLines.length + 1 : newLines.length,
			newCount: edit.add.length,
			removed,
			added: edit.add,
			lines: removed.length + edit.add.length,
		});
		newLines.push(...edit.add);
		next = edit.at + edit.remove;
	}
	newLines.push(...old.slice(next));
	return { newLines, clusters };
}

// The spec's Program.cs shape, with synthetic content.
const oldLines = Array.from({ length: 120 }, (_, i) => `    // line ${i + 1}`);
const { newLines, clusters } = applyEdits(oldLines, [
	{ at: 7, remove: 0, add: ["    var a = 1;"] },
	{ at: 82, remove: 1, add: ["    var b = 2;"] },
	{ at: 92, remove: 1, add: ["    var c = 3;"] },
	{ at: 116, remove: 0, add: ["    var d = 4;", "    var e = 5;"] },
	{
		at: 118,
		remove: 0,
		add: ["    f();", "    g();", "    h();", "    i();", "    j();"],
	},
]);

describe("buildDisplayHunks", () => {
	it("builds the Program.cs fixture as specified", () => {
		expect(clusters.map((c) => [c.newStart, c.newCount])).toEqual([
			[8, 1],
			[84, 1],
			[94, 1],
			[118, 2],
			[122, 5],
		]);
	});

	it("five clusters become four GitHub hunks", () => {
		const hunks = buildDisplayHunks(oldLines, newLines, clusters);
		expect(hunks).toHaveLength(4);
		expect(
			hunks[3]?.lines.filter((l) => l.clusterKey).map((l) => l.clusterKey),
		).toEqual(expect.arrayContaining([clusters[3]?.key, clusters[4]?.key]));
		expect(hunks[0]).toMatchObject({ oldStart: 5, newStart: 5 });
	});

	it("lays out context, deleted and added lines with both numbers", () => {
		const [first, second] = buildDisplayHunks(oldLines, newLines, clusters);
		expect(first).toEqual({
			oldStart: 5,
			oldCount: 6,
			newStart: 5,
			newCount: 7,
			lines: [
				{ kind: "context", oldNo: 5, newNo: 5, text: oldLines[4] },
				{ kind: "context", oldNo: 6, newNo: 6, text: oldLines[5] },
				{ kind: "context", oldNo: 7, newNo: 7, text: oldLines[6] },
				{ kind: "add", newNo: 8, text: "    var a = 1;", clusterKey: "k1" },
				{ kind: "context", oldNo: 8, newNo: 9, text: oldLines[7] },
				{ kind: "context", oldNo: 9, newNo: 10, text: oldLines[8] },
				{ kind: "context", oldNo: 10, newNo: 11, text: oldLines[9] },
			],
		});
		expect(second?.lines.filter((l) => l.kind !== "context")).toEqual([
			{ kind: "del", oldNo: 83, text: oldLines[82], clusterKey: "k2" },
			{ kind: "add", newNo: 84, text: "    var b = 2;", clusterKey: "k2" },
		]);
	});

	it("ignores file-level clusters", () => {
		const file: Cluster = {
			key: "f",
			kind: "file",
			label: "Renamed from a.cs",
			oldStart: 0,
			oldCount: 0,
			newStart: 0,
			newCount: 0,
			removed: [],
			added: [],
			lines: 0,
		};
		expect(buildDisplayHunks(oldLines, oldLines, [file])).toEqual([]);
		expect(buildDisplayHunks(oldLines, newLines, [file, ...clusters])).toEqual(
			buildDisplayHunks(oldLines, newLines, clusters),
		);
	});
	it("throws when the clusters don't match the file contents", () => {
		const drifted = oldLines.map((l, i) => (i === 5 ? `${l} edited` : l));
		expect(() => buildDisplayHunks(drifted, newLines, clusters)).toThrow(
			/differs/,
		);
		expect(() => contextLines(drifted, newLines, clusters, 1, 10)).toThrow(
			/differs/,
		);
	});
});

describe("missing newline at end of file", () => {
	const change = (flags: Partial<Cluster>): Cluster => ({
		key: "k",
		kind: "lines",
		oldStart: 2,
		oldCount: 1,
		newStart: 2,
		newCount: 1,
		removed: ["b"],
		added: ["b"],
		lines: 2,
		...flags,
	});
	const marked = (hunks: DisplayHunk[]) =>
		hunks
			.flatMap((h) => h.lines)
			.filter((l) => l.noNewline)
			.map((l) => l.kind);

	it("flags the removed line when the newline was added", () => {
		const hunks = buildDisplayHunks(
			["a", "b"],
			["a", "b"],
			[change({ noNewlineOld: true })],
		);
		expect(marked(hunks)).toEqual(["del"]);
	});

	it("flags the added line when the newline was removed", () => {
		const hunks = buildDisplayHunks(
			["a", "b"],
			["a", "b"],
			[change({ noNewlineNew: true })],
		);
		expect(marked(hunks)).toEqual(["add"]);
	});

	it("flags an unchanged last line, also in loaded context", () => {
		const old = ["a", "b", "c"];
		const next = ["A", "b", "c"];
		const c: Cluster = {
			...change({}),
			oldStart: 1,
			newStart: 1,
			removed: ["a"],
			added: ["A"],
		};
		const hunks = buildDisplayHunks(old, next, [c], 3, true);
		expect(hunks[0]?.lines.at(-1)).toMatchObject({ newNo: 3, noNewline: true });
		expect(contextLines(old, next, [c], 2, 3, true)).toEqual([
			{ kind: "context", oldNo: 2, newNo: 2, text: "b" },
			{ kind: "context", oldNo: 3, newNo: 3, text: "c", noNewline: true },
		]);
	});
});

describe("contextLines", () => {
	it("context lines map old numbers through earlier clusters", () => {
		expect(contextLines(oldLines, newLines, clusters, 20, 21)).toEqual([
			{ kind: "context", oldNo: 19, newNo: 20, text: newLines[19] },
			{ kind: "context", oldNo: 20, newNo: 21, text: newLines[20] },
		]);
	});

	it("clamps to the file", () => {
		const lines = contextLines(oldLines, newLines, clusters, -5, 2);
		expect(lines.map((l) => l.newNo)).toEqual([1, 2]);
		const end = contextLines(oldLines, newLines, clusters, 127, 500);
		expect(end).toEqual([
			{ kind: "context", oldNo: 119, newNo: 127, text: oldLines[118] },
			{ kind: "context", oldNo: 120, newNo: 128, text: oldLines[119] },
		]);
	});

	it("never returns added lines as context", () => {
		const lines = contextLines(oldLines, newLines, clusters, 117, 123);
		expect(lines.map((l) => [l.oldNo, l.newNo])).toEqual([
			[116, 117],
			[117, 120],
			[118, 121],
		]);
	});
});

/** Parses `git diff -U3` output into display hunks (no cluster keys). */
function parseU3(patch: string): DisplayHunk[] {
	const hunks: DisplayHunk[] = [];
	let oldNo = 0;
	let newNo = 0;
	for (const line of patch.split("\n")) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		const hunk = hunks[hunks.length - 1];
		if (header) {
			const h = {
				oldStart: Number(header[1]),
				oldCount: header[2] === undefined ? 1 : Number(header[2]),
				newStart: Number(header[3]),
				newCount: header[4] === undefined ? 1 : Number(header[4]),
				lines: [],
			};
			hunks.push(h);
			oldNo = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart;
			newNo = h.newCount === 0 ? h.newStart + 1 : h.newStart;
		} else if (!hunk) {
		} else if (line.startsWith(" ")) {
			hunk.lines.push({
				kind: "context",
				oldNo: oldNo++,
				newNo: newNo++,
				text: line.slice(1),
			});
		} else if (line.startsWith("-")) {
			hunk.lines.push({ kind: "del", oldNo: oldNo++, text: line.slice(1) });
		} else if (line.startsWith("+")) {
			hunk.lines.push({ kind: "add", newNo: newNo++, text: line.slice(1) });
		} else if (line.startsWith("\\")) {
			const previous = hunk.lines[hunk.lines.length - 1];
			if (previous) previous.noNewline = true;
		}
	}
	return hunks;
}

const toLines = (text: string) => {
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
};

describe("buildDisplayHunks matches git diff -U3", () => {
	const numbered = (n: number, prefix = "line") =>
		Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
	const text = (lines: string[], newline = true) =>
		lines.join("\n") + (newline && lines.length > 0 ? "\n" : "");
	const gap = numbered(40);
	const before: Record<string, string> = {
		"Program.cs": text(oldLines),
		"edges.txt": text(numbered(12)),
		"deleted.txt": text(numbered(4, "doomed")),
		"nonl.txt": text(["a", "b"], false),
		"gaps.txt": text(gap),
		"whole.txt": text(["x", "y"]),
		"tail-nonl.txt": text(numbered(8), false),
	};
	const after: Record<string, string> = {
		"Program.cs": text(newLines),
		"edges.txt": text(["new top", ...numbered(12).slice(2), "tail"], false),
		"added.txt": text(numbered(5, "fresh")),
		"nonl.txt": text(["a", "b", "c"]),
		// Changes 6 unchanged lines apart share a hunk, 7 apart don't.
		"gaps.txt": text(
			gap.map((l, i) => ([9, 16, 29, 37].includes(i) ? `${l} changed` : l)),
		),
		"whole.txt": text(["p", "q", "r"]),
		// The unchanged last line has no newline on either side.
		"tail-nonl.txt": text(["changed", ...numbered(8).slice(1)], false),
	};
	let fx: GitFixture;

	beforeAll(() => {
		fx = createGitFixture([
			{ message: "base", files: before },
			{ message: "head", files: after, delete: ["deleted.txt"] },
		]);
	});
	afterAll(() => fx.cleanup());

	it.each([
		"Program.cs",
		"edges.txt",
		"added.txt",
		"deleted.txt",
		"nonl.txt",
		"gaps.txt",
		"whole.txt",
		"tail-nonl.txt",
	])("%s", async (path) => {
		const [base, head] = fx.shas as [string, string];
		const file = (await listChangedFiles(fx.path, base, head)).find(
			(f) => f.path === path,
		);
		if (!file) throw new Error(`no ${path}`);
		const unkeyed = await buildClusters(fx.path, base, head, file);
		const keyed = unkeyed.map((c, i) => ({ ...c, key: `k${i}` }));
		const patch = await runGit(fx.path, [
			...DIFF_ARGS,
			"-U3",
			base,
			head,
			"--",
			path,
		]);
		const expected = parseU3(patch);
		expect(expected.length).toBeGreaterThan(0);
		const newText = after[path] ?? "";
		const hunks = buildDisplayHunks(
			toLines(before[path] ?? ""),
			toLines(newText),
			keyed,
			3,
			newText !== "" && !newText.endsWith("\n"),
		);
		const changed = hunks
			.flatMap((h) => h.lines)
			.filter((l) => l.kind !== "context");
		expect(changed.every((l) => l.clusterKey !== undefined)).toBe(true);
		const actual = hunks.map((h) => ({
			...h,
			lines: h.lines.map(({ clusterKey, ...l }) => l),
		}));
		expect(actual).toEqual(expected);
	});
});
