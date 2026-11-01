import { describe, expect, it } from "vitest";
import type { FileView } from "../../shared/types";
import { buildTree, byName, treeOrder } from "./fileOrder";

const at = (index: number, path: string) => ({ index, path }) as FileView;

describe("treeOrder", () => {
	it("puts folders before files at every level, each by name like a file explorer", () => {
		const paths = [
			"src/a.ts",
			"src/z/b.ts",
			"README.md",
			"lib/x.ts",
			"src/B.ts",
			"src/a10.ts",
			"src/a2.ts",
		];
		const files = paths.map((p, i) => at(i, p));
		const ordered = treeOrder(files);
		expect(ordered.map((f) => f.path)).toEqual([
			"lib/x.ts",
			"src/z/b.ts",
			"src/a.ts",
			"src/a2.ts",
			"src/a10.ts",
			"src/B.ts",
			"README.md",
		]);
		// Identity kept: the same objects, indexes untouched.
		expect(ordered.map((f) => f.index)).toEqual([3, 1, 0, 6, 5, 4, 2]);
		expect(ordered[0]).toBe(files[3]);
	});

	it("sorts a merged single-folder chain by its shown name", () => {
		const files = [at(0, "b/x.ts"), at(1, "a/z/deep/y.ts"), at(2, "a/m.ts")];
		const tree = buildTree(files);
		const names = tree.children.map((n) =>
			n.kind === "folder" ? n.folder.name : n.file.path,
		);
		expect(names).toEqual(["a", "b"]);
		expect(treeOrder(files).map((f) => f.path)).toEqual([
			"a/z/deep/y.ts",
			"a/m.ts",
			"b/x.ts",
		]);
		const chain = buildTree([at(0, "q/r/s.ts"), at(1, "p.ts")]);
		expect(chain.children[0]).toMatchObject({
			kind: "folder",
			folder: { name: "q/r", path: "q/r" },
		});
	});

	it("is the same whatever order the files come in", () => {
		const paths = ["b.ts", "A.ts", "a.ts", "x/1.ts", "X/2.ts"];
		const forward = treeOrder(paths.map((p, i) => at(i, p))).map((f) => f.path);
		const backward = treeOrder(
			[...paths].reverse().map((p, i) => at(i, p)),
		).map((f) => f.path);
		expect(forward).toEqual(backward);
		// Case-insensitive, then bytewise: "A" before "a", "X" before "x".
		expect(forward).toEqual(["X/2.ts", "x/1.ts", "A.ts", "a.ts", "b.ts"]);
	});

	it("compares names numeric-aware and case-insensitively", () => {
		expect(byName("a2", "a10")).toBeLessThan(0);
		expect(byName("B", "a")).toBeGreaterThan(0);
		expect(byName("a", "a")).toBe(0);
	});
});
