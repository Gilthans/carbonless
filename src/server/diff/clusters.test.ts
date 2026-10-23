import { describe, expect, it } from "vitest";
import { fileLevelCluster, parseU0Patch } from "./clusters.js";
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
