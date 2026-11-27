import { describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
} from "../../../test/git-fixture.js";
import { hunkCut } from "../../shared/whitespace.js";
import type { LineCluster } from "./clusters.js";
import {
	addedCut,
	buildAllClusters,
	cutsAtBlankLines,
	fileLevelCluster,
	headersFor,
	parseU0Patch,
	splitAtBlankLines,
	splitCluster,
	splitPatch,
} from "./clusters.js";
import { type ChangedFile, listChangedFiles } from "./files.js";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

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

	it("a binary renamed with the same blob reads as a rename, never 'changed'", () => {
		const same = "3".repeat(40);
		const moved = file({
			status: "renamed",
			oldPath: "assets/mark.png",
			path: "assets/brand/mark.png",
			binary: true,
			additions: 0,
			deletions: 0,
			oldOid: same,
			newOid: same,
		});
		// Still a unit of its own (principle 2): only its text says less.
		expect(fileLevelCluster(moved, false)).toMatchObject({
			kind: "file",
			label: "Renamed from assets/mark.png",
		});
		// Renamed and edited: both said.
		expect(
			fileLevelCluster({ ...moved, newOid: "4".repeat(40) }, false)?.label,
		).toBe("Renamed from assets/mark.png, binary file changed");
		// Added or deleted binaries still say changed.
		expect(
			fileLevelCluster(
				file({ status: "added", binary: true, oldOid: "0".repeat(40) }),
				false,
			)?.label,
		).toBe("Binary file changed");
	});

	it("a binary with the same blob and only its mode changed says the mode, not 'binary file changed'", () => {
		const same = "5".repeat(40);
		expect(
			fileLevelCluster(
				file({
					binary: true,
					additions: 0,
					deletions: 0,
					newMode: "100755",
					oldOid: same,
					newOid: same,
				}),
				false,
			)?.label,
		).toBe("Mode changed 100644 → 100755");
	});

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

/** A hunk's cut matched on its own (hunkCut). */
const own = (c: LineCluster) =>
	hunkCut(c.removed, c.added, c.noNewlineOld === true, c.noNewlineNew === true);

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
		expect(
			splitCluster(hunk as LineCluster, own(hunk as LineCluster)).map(shape),
		).toEqual([
			{ ws: false, old: [10, 1], new: [9, 0], at: [0, 0] },
			{ ws: true, old: [11, 2], new: [10, 2], at: [1, 0] },
			{ ws: false, old: [12, 0], new: [12, 1], at: [3, 2] },
		]);
	});

	it("keeps the end-of-file flags on the piece holding the last line", () => {
		const [hunk] = parseU0Patch(
			"@@ -1,2 +1,2 @@\n- a\n-b\n\\ No newline at end of file\n+a\n+B\n\\ No newline at end of file\n",
		);
		const pieces = splitCluster(
			hunk as LineCluster,
			own(hunk as LineCluster),
		).map((p) => p.cluster);
		expect(pieces).toMatchObject([
			{ whitespaceOnly: true, removed: [" a"], added: ["a"] },
			{ removed: ["b"], added: ["B"], noNewlineOld: true, noNewlineNew: true },
		]);
		expect(pieces[0]?.noNewlineOld).toBeUndefined();
		expect(pieces[0]?.noNewlineNew).toBeUndefined();
	});

	it("cuts by the display hunk's flags: one-sided pieces of a pure deletion or addition numbered as git numbers them (CAR-218)", () => {
		const [gone] = parseU0Patch("@@ -5,3 +4,0 @@\n-  a\n-b\n-  c\n");
		expect(
			splitCluster(gone as LineCluster, {
				removedWs: [true, false, true],
				addedWs: [],
				pairs: [],
			}).map(shape),
		).toEqual([
			{ ws: true, old: [5, 1], new: [4, 0], at: [0, 0] },
			{ ws: false, old: [6, 1], new: [4, 0], at: [1, 0] },
			{ ws: true, old: [7, 1], new: [4, 0], at: [2, 0] },
		]);
		const [added] = parseU0Patch("@@ -4,0 +5,2 @@\n+x\n+  y\n");
		expect(
			splitCluster(added as LineCluster, {
				removedWs: [],
				addedWs: [false, true],
				pairs: [],
			}).map(shape),
		).toEqual([
			{ ws: false, old: [4, 0], new: [5, 1], at: [0, 0] },
			{ ws: true, old: [4, 0], new: [6, 1], at: [0, 1] },
		]);
		// Removed lines whose twins are elsewhere, then a real addition.
		const [hunk] = parseU0Patch(
			"@@ -3,2 +3 @@\n-    <div>\n-      <Header />\n+    <Provider>\n",
		);
		expect(
			splitCluster(hunk as LineCluster, {
				removedWs: [true, true],
				addedWs: [false],
				pairs: [],
			}).map(shape),
		).toEqual([
			{ ws: true, old: [3, 2], new: [2, 0], at: [0, 0] },
			{ ws: false, old: [4, 0], new: [3, 1], at: [2, 0] },
		]);
	});

	it("counts nothing as whitespace when the cut doesn't fit the hunk", () => {
		const [hunk] = parseU0Patch("@@ -1,2 +1,2 @@\n- a\n-b\n+a\n+B\n");
		expect(
			splitCluster(hunk as LineCluster, {
				removedWs: [true],
				addedWs: [true, false],
				pairs: [[0, 0]],
			}),
		).toEqual([{ cluster: hunk, removedAt: 0, addedAt: 0 }]);
	});

	it("counts nothing as whitespace when only the added side's cut doesn't fit", () => {
		const [hunk] = parseU0Patch("@@ -1,2 +1,2 @@\n- a\n-b\n+a\n+B\n");
		expect(
			splitCluster(hunk as LineCluster, {
				removedWs: [true, false],
				addedWs: [true],
				pairs: [[0, 0]],
			}),
		).toEqual([{ cluster: hunk, removedAt: 0, addedAt: 0 }]);
	});

	it("leaves a hunk that doesn't split as it is, flagged when all whitespace", () => {
		const [plain] = parseU0Patch("@@ -1 +1 @@\n-a\n+b\n");
		expect(
			splitCluster(plain as LineCluster, own(plain as LineCluster)),
		).toEqual([{ cluster: plain, removedAt: 0, addedAt: 0 }]);
		const [ws] = parseU0Patch("@@ -1 +1 @@\n-a\n+ a\n");
		expect(
			splitCluster(ws as LineCluster, own(ws as LineCluster))[0]?.cluster,
		).toEqual({
			...ws,
			whitespaceOnly: true,
		});
	});
});

describe("splitAtBlankLines (CAR-235)", () => {
	/** An added file's one hunk, from its lines (`\\` ending: no newline at end). */
	const addedFile = (lines: string[], noNewline = false): LineCluster =>
		parseU0Patch(
			`@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}\n`).join("")}${noNewline ? "\\ No newline at end of file\n" : ""}`,
		)[0] as LineCluster;
	const shape = (p: ReturnType<typeof splitAtBlankLines>[number]) => ({
		added: p.cluster.added,
		new: [p.cluster.newStart, p.cluster.newCount],
		old: [p.cluster.oldStart, p.cluster.oldCount],
		at: p.addedAt,
	});

	it("ends a cluster at each blank line, the blank line staying with the cluster before it", () => {
		const hunk = addedFile(["a", "b", "", "c", "", "d"]);
		expect(splitAtBlankLines(hunk).map(shape)).toEqual([
			{ added: ["a", "b", ""], new: [1, 3], old: [0, 0], at: 0 },
			{ added: ["c", ""], new: [4, 2], old: [0, 0], at: 3 },
			{ added: ["d"], new: [6, 1], old: [0, 0], at: 5 },
		]);
	});

	it("joins leading blank lines to the first cluster, and keeps a run of blanks with the cluster before it", () => {
		const hunk = addedFile(["", "  ", "a", "", "", "\t", "b", "", ""]);
		expect(splitAtBlankLines(hunk).map((p) => p.cluster.added)).toEqual([
			["", "  ", "a", "", "", "\t"],
			["b", "", ""],
		]);
	});

	it("counts CRLF, tab-only and space-only lines as blank", () => {
		const hunk = addedFile(["a\r", "\r", "b\r", "\t\t", "c", " \t \r", "d"]);
		expect(splitAtBlankLines(hunk).map((p) => p.cluster.added)).toEqual([
			["a\r", "\r"],
			["b\r", "\t\t"],
			["c", " \t \r"],
			["d"],
		]);
	});

	it("leaves a file with no blank line, a single line or only blank lines whole", () => {
		for (const lines of [["a", "b"], ["a"], [""], ["", " ", "\t"], ["a", ""]]) {
			const hunk = addedFile(lines);
			expect(splitAtBlankLines(hunk)).toEqual([
				{ cluster: hunk, removedAt: 0, addedAt: 0 },
			]);
		}
	});

	it("keeps no-newline-at-end on the last piece only", () => {
		const pieces = splitAtBlankLines(addedFile(["a", "", "b"], true)).map(
			(p) => p.cluster,
		);
		expect(pieces.map((c) => c.noNewlineNew)).toEqual([undefined, true]);
	});

	it("leaves a cluster with removed lines alone", () => {
		const [hunk] = parseU0Patch("@@ -1 +1,3 @@\n-x\n+a\n+\n+b\n");
		expect(splitAtBlankLines(hunk as LineCluster)).toEqual([
			{ cluster: hunk, removedAt: 0, addedAt: 0 },
		]);
	});

	it("puts every line in exactly one piece, in order (principle 2)", () => {
		const lines = ["", "a", "", " ", "b", "c", "", "d", "\t", ""];
		const hunk = addedFile(lines);
		const pieces = splitAtBlankLines(hunk);
		expect(pieces.flatMap((p) => p.cluster.added)).toEqual(lines);
		expect(pieces.reduce((n, p) => n + p.cluster.lines, 0)).toBe(lines.length);
		for (const p of pieces) {
			expect(p.cluster.lines).toBe(p.cluster.added.length);
			expect(lines.slice(p.addedAt, p.addedAt + p.cluster.lines)).toEqual(
				p.cluster.added,
			);
		}
	});
});

describe("cutsAtBlankLines: lock files stay whole (CAR-235, owner 2026-11-24)", () => {
	it("refuses known lock files by name, in any folder", () => {
		for (const path of [
			"pnpm-lock.yaml",
			"web/package-lock.json",
			"yarn.lock",
			"crates/x/Cargo.lock",
			"go.sum",
			"poetry.lock",
			"Gemfile.lock",
			"composer.lock",
			"Pipfile.lock",
			"uv.lock",
		]) {
			expect(cutsAtBlankLines(path), path).toBe(false);
		}
	});

	it("cuts every other file, names that only look alike included", () => {
		for (const path of [
			"src/a.ts",
			"README.md",
			"docs/pnpm-lock.yaml.md",
			"my-yarn.lock",
			"lock/index.ts",
		]) {
			expect(cutsAtBlankLines(path), path).toBe(true);
		}
	});
});

describe("addedCut: machine-made files stay whole too, by name (CAR-322, owner 2026-11-27)", () => {
	it("keeps machine-made files whole, in any folder", () => {
		for (const path of [
			"dist/app.min.js",
			"static/site.min.css",
			"dist/app.js.map",
			"src/__snapshots__/a.test.ts.snap",
			"assets/logo.svg",
			"api/v1/user.pb.go",
			"proto/user_pb2.py",
			"lib/model.g.dart",
			"Forms/Main.designer.cs",
			"src/api.generated.ts",
		]) {
			expect(addedCut(path), path).toBe("machine");
			expect(cutsAtBlankLines(path), path).toBe(false);
		}
	});

	it("keeps lock files as they were, and cuts the rest: case-sensitive, never Markdown", () => {
		expect(addedCut("pnpm-lock.yaml")).toBe("lock");
		for (const path of [
			"src/a.ts",
			"app.MIN.JS",
			"Forms/Main.Designer.cs",
			"logo.SVG",
			"docs/api.generated.md",
			"notes.generated.MD",
			"min.js",
			"map/index.ts",
			"generated/a.ts",
		]) {
			expect(addedCut(path), path).toBe("blocks");
		}
	});
});

describe("headersFor", () => {
	it("names a plain path as is, and a path git quotes as git quotes it", () => {
		expect(headersFor({ path: "a.ts" })).toContain("diff --git a/a.ts b/a.ts");
		// A quote, a backslash, a tab and a newline in the name.
		expect(headersFor({ path: 'q"\\\tn\n.ts' })[1]).toBe(
			String.raw`diff --git "a/q\"\\\tn\n.ts" "b/q\"\\\tn\n.ts"`,
		);
		// A control character alone is enough to quote.
		expect(headersFor({ path: "c\u0001.ts" })[1]).toBe(
			'diff --git "a/c\u0001.ts" "b/c\u0001.ts"',
		);
		// A space is not.
		expect(headersFor({ path: "s p.ts" })[1]).toBe(
			"diff --git a/s p.ts b/s p.ts",
		);
	});
});

describe("buildAllClusters: a change can never go missing (principle 2)", () => {
	it("throws when the parsed lines don't add up to the listing's counts, or a listed file has no section", async () => {
		const fx = createGitFixture([
			{ message: "base", files: { "a.txt": "one\ntwo\n" } },
			{ message: "head", files: { "a.txt": "one\nTWO\n" } },
		]);
		try {
			const [base, head] = fx.shas as [string, string];
			const listed = await listChangedFiles(fx.path, base, head);
			expect(await buildAllClusters(fx.path, base, head, listed)).toHaveLength(
				1,
			);
			const [a] = listed as [ChangedFile];
			for (const wrong of [
				{ ...a, deletions: a.deletions + 1 },
				{ ...a, additions: a.additions + 1 },
			]) {
				await expect(
					buildAllClusters(fx.path, base, head, [wrong]),
				).rejects.toThrow(/Could not extract line clusters/);
			}
			await expect(
				buildAllClusters(fx.path, base, head, [a, { ...a, path: "b.txt" }]),
			).rejects.toThrow(/no section for b\.txt/);
		} finally {
			fx.cleanup();
		}
	});
});
