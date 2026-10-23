import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDiffFixture } from "../../../test/diff-fixture.js";
import type { GitFixture } from "../../../test/git-fixture.js";
import type { Snapshot } from "../../shared/types.js";
import { listChangedFiles } from "./files.js";
import { buildSnapshot, loadContext, loadFileHunks } from "./snapshot.js";

let fixture: GitFixture;
let snapshot: Snapshot;
const base = () => fixture.shas[0] as string;
const head = () => fixture.shas[1] as string;
const indexOf = (path: string) => {
	const file = snapshot.files.find((f) => f.path === path);
	if (!file) throw new Error(`no ${path}`);
	return file.index;
};

beforeAll(async () => {
	fixture = createDiffFixture();
	snapshot = await buildSnapshot(fixture.path, base(), head());
});

afterAll(() => fixture.cleanup());

describe("buildSnapshot", () => {
	it("returns every changed file in raw diff order", async () => {
		const changed = await listChangedFiles(fixture.path, base(), head());
		expect(snapshot.files.map((f) => f.path)).toEqual(
			changed.map((f) => f.path),
		);
		expect(snapshot.files.map((f) => f.index)).toEqual(
			changed.map((_, i) => i),
		);
		expect(snapshot).toMatchObject({ base: base(), head: head() });
		expect(snapshot.files.find((f) => f.path === "new-name.ts")).toMatchObject({
			oldPath: "old-name.ts",
			status: "renamed",
		});
		expect(JSON.stringify(snapshot)).not.toMatch(/oldOid|newOid/);
	});

	it("gives every cluster a unique key", () => {
		const keys = snapshot.files.flatMap((f) => f.clusters.map((c) => c.key));
		expect(keys.length).toBeGreaterThan(snapshot.files.length);
		for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}(:\d+)?$/);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("has a revision of 64 hex chars that is identical across calls", async () => {
		expect(snapshot.revision).toMatch(/^[0-9a-f]{64}$/);
		const again = await buildSnapshot(fixture.path, base(), head());
		expect(again).toEqual(snapshot);
	});
});

describe("loadFileHunks", () => {
	it("returns hunks whose changed lines carry the snapshot's cluster keys", async () => {
		const index = indexOf("dir/my file.ts");
		const { hunks, newLineCount } = await loadFileHunks(
			fixture.path,
			snapshot,
			index,
		);
		const [cluster] = snapshot.files[index]?.clusters ?? [];
		expect(newLineCount).toBe(2);
		expect(hunks).toEqual([
			{
				oldStart: 1,
				oldCount: 1,
				newStart: 1,
				newCount: 2,
				lines: [
					{ kind: "context", oldNo: 1, newNo: 1, text: "one" },
					{ kind: "add", newNo: 2, text: "two", clusterKey: cluster?.key },
				],
			},
		]);
	});

	it("reads the old side of a renamed file from its old path", async () => {
		const index = indexOf("new-name.ts");
		const { hunks } = await loadFileHunks(fixture.path, snapshot, index);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]).toMatchObject({ oldStart: 2, newStart: 2 });
		expect(hunks[0]?.lines.find((l) => l.kind === "del")?.text).toBe("line 5");
	});

	it("handles added, deleted, binary and submodule files", async () => {
		const added = await loadFileHunks(
			fixture.path,
			snapshot,
			indexOf("added.ts"),
		);
		expect(added.hunks[0]).toMatchObject({
			oldStart: 0,
			oldCount: 0,
			newCount: 1,
		});
		const gone = await loadFileHunks(
			fixture.path,
			snapshot,
			indexOf("gone.ts"),
		);
		expect(gone).toMatchObject({ newLineCount: 0 });
		expect(gone.hunks[0]).toMatchObject({
			oldStart: 1,
			newStart: 0,
			newCount: 0,
		});
		for (const path of ["img.bin", "vendor", "empty.txt"]) {
			expect(
				await loadFileHunks(fixture.path, snapshot, indexOf(path)),
			).toEqual({ hunks: [], newLineCount: 0 });
		}
	});

	it("reads paths with unicode and quotes", async () => {
		for (const [path, text] of [
			["docs/über.md", "zwei"],
			['q"uote.txt', "y"],
		]) {
			const { hunks } = await loadFileHunks(
				fixture.path,
				snapshot,
				indexOf(path as string),
			);
			expect(hunks[0]?.lines.find((l) => l.kind === "add")?.text).toBe(text);
		}
	});

	it("rejects an unknown file index", async () => {
		await expect(loadFileHunks(fixture.path, snapshot, 999)).rejects.toThrow();
	});
});

describe("loadContext", () => {
	it("returns context lines of the new side with old numbers", async () => {
		const index = indexOf("mod.ts");
		expect(await loadContext(fixture.path, snapshot, index, 4, 6)).toEqual([
			{ kind: "context", oldNo: 4, newNo: 4, text: "line 4" },
			{ kind: "context", oldNo: 5, newNo: 5, text: "line 5" },
			{ kind: "context", oldNo: 6, newNo: 6, text: "line 6" },
		]);
	});
});
