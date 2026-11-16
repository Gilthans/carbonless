import { describe, expect, it } from "vitest";
import type { LineCluster } from "./clusters.js";
import {
	fileLevelCluster,
	parseU0Patch,
	splitCluster,
	splitPatch,
} from "./clusters.js";
import type { ChangedFile } from "./files.js";

function file(partial: Partial<ChangedFile>): ChangedFile {
	return {
		path: "a.ts",
		status: "modified",
		oldMode: "100644",
		newMode: "100644",
		binary: false,
		submodule: false,
		additions: 1,
		deletions: 1,
		oldOid: "1".repeat(40),
		newOid: "2".repeat(40),
		...partial,
	};
}

describe("parseU0Patch", () => {
	it("splits changes separated by one unchanged line into two clusters", () => {
		const patch = "@@ -3 +3 @@\n-a\n+A\n@@ -5,0 +6,2 @@\n+x\n+y\n";
		expect(parseU0Patch(patch)).toEqual([
			{
				oldStart: 3,
				oldCount: 1,
				newStart: 3,
				newCount: 1,
				removed: ["a"],
				added: ["A"],
				lines: 2,
			},
			{
				oldStart: 5,
				oldCount: 0,
				newStart: 6,
				newCount: 2,
				removed: [],
				added: ["x", "y"],
				lines: 2,
			},
		]);
	});

	it("records missing trailing newline", () => {
		const [c] = parseU0Patch(
			"@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n",
		);
		expect(c).toMatchObject({
			noNewlineOld: true,
			removed: ["a"],
			added: ["a"],
		});
		expect(c?.noNewlineNew).toBeUndefined();
	});

	it("returns no clusters for an empty patch", () => {
		expect(parseU0Patch("")).toEqual([]);
	});
});

describe("fileLevelCluster", () => {
	it.each([
		[
			{ status: "renamed", oldPath: "a.ts", path: "b.ts" },
			false,
			"Renamed from a.ts",
		],
		[
			{ status: "modified", oldMode: "100644", newMode: "100755" },
			false,
			"Mode changed 100644 → 100755",
		],
		[{ status: "modified", binary: true }, false, "Binary file changed"],
		[
			{ status: "added", binary: false, additions: 0, deletions: 0 },
			false,
			"Empty file added",
		],
		[
			{ status: "deleted", binary: false, additions: 0, deletions: 0 },
			false,
			"Empty file deleted",
		],
		[
			{
				status: "modified",
				submodule: true,
				oldOid: "a".repeat(40),
				newOid: "b".repeat(40),
			},
			false,
			"Submodule moved aaaaaaa → bbbbbbb",
		],
	] as [Partial<ChangedFile>, boolean, string][])(
		"file-level cluster %#",
		(partial, hasLines, label) => {
			const cluster = fileLevelCluster(file(partial), hasLines);
			expect(cluster?.label).toBe(label);
			expect(cluster).toMatchObject({ kind: "file", lines: 0, newCount: 0 });
		},
	);

	it("a rename with edits keeps the rename cluster", () => {
		const renamed = file({ status: "renamed", oldPath: "a.ts", path: "b.ts" });
		expect(fileLevelCluster(renamed, true)?.label).toBe("Renamed from a.ts");
	});

	it("a mode change with edits keeps the mode cluster", () => {
		const chmod = file({ newMode: "100755" });
		expect(fileLevelCluster(chmod, true)?.label).toBe(
			"Mode changed 100644 → 100755",
		);
	});

	it("a plain edit has no file-level cluster", () => {
		expect(fileLevelCluster(file({}), true)).toBeNull();
	});

	it("an empty added file with line clusters is not 'empty'", () => {
		expect(
			fileLevelCluster(file({ status: "added", additions: 0 }), true),
		).toBeNull();
	});
});

describe("splitPatch", () => {
	const patch = Buffer.from(
		[
			"diff --git a/x.ts b/x.ts",
			"index 1..2 100644",
			"@@ -1 +1 @@",
			"-a",
			"+b",
			"diff --git a/old.ts b/new.ts",
			"similarity index 90%",
			"diff --git a/link b/link",
			"deleted file mode 100644",
			"diff --git a/link b/link",
			"new file mode 120000",
			"",
		].join("\n"),
	);

	it("splits by header and keeps a type change's two halves together", () => {
		const sections = splitPatch(patch);
		expect([...sections.keys()]).toEqual([
			"diff --git a/x.ts b/x.ts",
			"diff --git a/old.ts b/new.ts",
			"diff --git a/link b/link",
		]);
		expect(sections.get("diff --git a/link b/link")?.toString()).toBe(
			"diff --git a/link b/link\ndeleted file mode 100644\ndiff --git a/link b/link\nnew file mode 120000",
		);
		const x = sections.get("diff --git a/x.ts b/x.ts");
		expect(parseU0Patch(x?.toString() ?? "")).toHaveLength(1);
	});

	it("refuses text before the first file", () => {
		expect(() => splitPatch(Buffer.from("junk\ndiff --git a/x b/x\n"))).toThrow(
			/before its first file/,
		);
	});
});

describe("splitCluster (CAR-156)", () => {
	const shape = (c: ReturnType<typeof splitCluster>[number]) => ({
		ws: c.cluster.whitespaceOnly === true,
		old: [c.cluster.oldStart, c.cluster.oldCount],
		new: [c.cluster.newStart, c.cluster.newCount],
		at: [c.removedAt, c.addedAt],
	});

	it("numbers each piece as git numbers a hunk: a side with no lines starts at the line it follows", () => {
		const [hunk] = parseU0Patch(
			"@@ -10,3 +10,3 @@\n-gone\n-  b1\n-  b2\n+b1\n+b2\n+new\n",
		);
		expect(splitCluster(hunk as LineCluster).map(shape)).toEqual([
			{ ws: false, old: [10, 1], new: [9, 0], at: [0, 0] },
			{ ws: true, old: [11, 2], new: [10, 2], at: [1, 0] },
			{ ws: false, old: [12, 0], new: [12, 1], at: [3, 2] },
		]);
	});

	it("keeps the end-of-file flags on the piece holding the last line", () => {
		const [hunk] = parseU0Patch(
			"@@ -1,2 +1,2 @@\n- a\n-b\n\\ No newline at end of file\n+a\n+B\n\\ No newline at end of file\n",
		);
		const pieces = splitCluster(hunk as LineCluster).map((p) => p.cluster);
		expect(pieces).toMatchObject([
			{ whitespaceOnly: true, removed: [" a"], added: ["a"] },
			{ removed: ["b"], added: ["B"], noNewlineOld: true, noNewlineNew: true },
		]);
		expect(pieces[0]?.noNewlineOld).toBeUndefined();
		expect(pieces[0]?.noNewlineNew).toBeUndefined();
	});

	it("leaves a hunk that doesn't split as it is, flagged when all whitespace", () => {
		const [plain] = parseU0Patch("@@ -1 +1 @@\n-a\n+b\n");
		expect(splitCluster(plain as LineCluster)).toEqual([
			{ cluster: plain, removedAt: 0, addedAt: 0 },
		]);
		const [ws] = parseU0Patch("@@ -1 +1 @@\n-a\n+ a\n");
		expect(splitCluster(ws as LineCluster)[0]?.cluster).toEqual({
			...ws,
			whitespaceOnly: true,
		});
	});
});
