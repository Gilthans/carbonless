import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDiffFixture } from "../../../test/diff-fixture.js";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
	testGitEnv,
} from "../../../test/git-fixture.js";
import type { Snapshot } from "../../shared/types.js";
import { listChangedFiles } from "./files.js";
import {
	buildSnapshot,
	loadContext,
	loadFileHunks,
	loadHunksBatch,
} from "./snapshot.js";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

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

describe("loadHunksBatch", () => {
	const loaded = { hunks: [], newLineCount: 7 };

	it("answers each file on its own: a failed read is that file's error", async () => {
		const events: string[] = [];
		let releaseFirst: () => void = () => {};
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const load = vi.fn(
			async (_repo: string, _snapshot: Snapshot, i: number) => {
				events.push(`start ${i}`);
				if (i === 0) await first;
				if (i === 1) throw new Error("boom");
				events.push(`end ${i}`);
				return loaded;
			},
		);
		const result = loadHunksBatch(fixture.path, snapshot, [0, 1, 2], load);
		await vi.waitFor(() => expect(events).toEqual(["start 0"]));
		releaseFirst();
		expect(await result).toEqual({
			files: [
				{ index: 0, hunks: loaded },
				{ index: 1, error: "boom" },
				{ index: 2, hunks: loaded },
			],
		});
		expect(events).toEqual(["start 0", "end 0", "start 1", "start 2", "end 2"]);
	});

	it("rejects an index not in the snapshot before reading any file", async () => {
		const load = vi.fn();
		const missing = snapshot.files.length;
		await expect(
			loadHunksBatch(fixture.path, snapshot, [0, missing], load),
		).rejects.toThrow(`No file ${missing} in this snapshot`);
		expect(load).not.toHaveBeenCalled();
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

describe("distinct changes never share a key", () => {
	let fx: GitFixture;
	const bytes = (text: string) => Buffer.from(text, "latin1");
	const keyOf = (snap: Snapshot, path: string) =>
		snap.files.find((f) => f.path === path)?.clusters.map((c) => c.key);
	const addedText = async (snap: Snapshot, path: string) => {
		const index = snap.files.findIndex((f) => f.path === path);
		const { hunks } = await loadFileHunks(fx.path, snap, index);
		return hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add");
	};
	let toE8: Snapshot;
	let toEA: Snapshot;

	beforeAll(async () => {
		fx = createGitFixture([
			{
				message: "base",
				files: { "utf8.txt": "café\n", "nl.txt": "a\nb" },
				// Windows-1252 text: not valid UTF-8.
				binary: {
					"cp1252.txt": bytes("first\ncaf\xE9\nlast\n"),
					"img.bin": new Uint8Array([0, 1]),
				},
			},
			{
				message: "e8",
				files: { "utf8.txt": "cafè\n", "nl.txt": "a\nb\n" },
				binary: {
					"cp1252.txt": bytes("first\ncaf\xE8\nlast\n"),
					"img.bin": new Uint8Array([0, 2]),
				},
			},
			{
				message: "ea",
				files: { "utf8.txt": "cafè\n" },
				binary: {
					"cp1252.txt": bytes("first\ncaf\xEA\nlast\n"),
					"img.bin": new Uint8Array([0, 3]),
				},
			},
		]);
		const [base, e8, ea] = fx.shas as [string, string, string];
		toE8 = await buildSnapshot(fx.path, base, e8);
		toEA = await buildSnapshot(fx.path, base, ea);
	});
	afterAll(() => fx.cleanup());

	it("non-UTF-8 changes keep their bytes in keys and display", async () => {
		expect(keyOf(toE8, "cp1252.txt")).not.toEqual(keyOf(toEA, "cp1252.txt"));
		const e8 = await addedText(toE8, "cp1252.txt");
		const ea = await addedText(toEA, "cp1252.txt");
		expect(e8.map((l) => l.text)).toEqual(["caf\u00e8"]);
		expect(ea.map((l) => l.text)).toEqual(["caf\u00ea"]);
		const [cluster] =
			toE8.files.find((f) => f.path === "cp1252.txt")?.clusters ?? [];
		expect(cluster).toMatchObject({
			removed: ["caf\u00e9"],
			added: ["caf\u00e8"],
		});
		const index = toE8.files.findIndex((f) => f.path === "cp1252.txt");
		expect(await loadContext(fx.path, toE8, index, 1, 3)).toEqual([
			{ kind: "context", oldNo: 1, newNo: 1, text: "first" },
			{ kind: "context", oldNo: 3, newNo: 3, text: "last" },
		]);
	});

	it("UTF-8 files decode as UTF-8", async () => {
		expect(
			toE8.files.find((f) => f.path === "utf8.txt")?.clusters[0],
		).toMatchObject({ removed: ["café"], added: ["cafè"] });
		expect((await addedText(toE8, "utf8.txt")).map((l) => l.text)).toEqual([
			"cafè",
		]);
	});

	it("different binary contents get different keys", () => {
		expect(keyOf(toE8, "img.bin")).toHaveLength(1);
		expect(keyOf(toE8, "img.bin")).not.toEqual(keyOf(toEA, "img.bin"));
	});

	it("adding and removing the final newline get different keys", async () => {
		const [base, e8] = fx.shas as [string, string];
		const back = await buildSnapshot(fx.path, e8, base);
		const added = toE8.files.find((f) => f.path === "nl.txt")?.clusters[0];
		const removed = back.files.find((f) => f.path === "nl.txt")?.clusters[0];
		expect(added).toMatchObject({
			removed: ["b"],
			added: ["b"],
			noNewlineOld: true,
		});
		expect(removed).toMatchObject({
			removed: ["b"],
			added: ["b"],
			noNewlineNew: true,
		});
		expect(added?.key).not.toBe(removed?.key);
		const index = back.files.findIndex((f) => f.path === "nl.txt");
		const { hunks } = await loadFileHunks(fx.path, back, index);
		expect(hunks[0]?.lines.filter((l) => l.noNewline)).toEqual([
			{
				kind: "add",
				newNo: 2,
				text: "b",
				clusterKey: removed?.key,
				noNewline: true,
			},
		]);
	});
});

describe("cross-renames and context-dependent counts", () => {
	/**
	 * Two files move to a new directory under each other's names, both
	 * edited; another is renamed and edited; one carries a change git counts
	 * differently with and without context (synthetic text).
	 */
	const quirk = JSON.parse(
		readFileSync("test/fixtures/diff/context-quirk.json", "utf8"),
	) as { old: string; new: string };
	const body = (name: string, n: number) =>
		`${Array.from({ length: n }, (_, i) => `${name} line ${i + 1}`).join("\n")}\n`;
	let fx: GitFixture;
	let snap: Snapshot;
	const [b, h] = [() => fx.shas[0] as string, () => fx.shas[1] as string];

	beforeAll(async () => {
		fx = createGitFixture([
			{
				message: "base",
				files: {
					"pages/login_page.py": `${body("page", 20)}${quirk.old}`,
					"actions/login_actions.py": body("actions", 20),
					"util.py": body("util", 20),
				},
			},
			{
				message: "head",
				delete: ["pages/login_page.py", "actions/login_actions.py", "util.py"],
				files: {
					// Each other's content under each other's name, edited.
					"src/actions/login_actions.py": `${body("page", 20).replace("page line 3\n", "PAGE 3\n")}${quirk.new}`,
					"src/pages/login_page.py": body("actions", 20).replace(
						"actions line 7\n",
						"ACTIONS 7\nextra\n",
					),
					"src/util.py": body("util", 20).replace("util line 1\n", ""),
				},
			},
		]);
		snap = await buildSnapshot(fx.path, b(), h());
	});
	afterAll(() => fx.cleanup());

	it("pairs each rename as the listing does, and its clusters add up to its counts", async () => {
		const pairs = Object.fromEntries(
			snap.files.map((f) => [f.path, f.oldPath]),
		);
		expect(pairs).toEqual({
			"src/actions/login_actions.py": "pages/login_page.py",
			"src/pages/login_page.py": "actions/login_actions.py",
			"src/util.py": "util.py",
		});
		for (const file of snap.files) {
			const lines = file.clusters.filter((c) => c.kind === "lines");
			expect(lines.flatMap((c) => c.added)).toHaveLength(file.additions);
			expect(lines.flatMap((c) => c.removed)).toHaveLength(file.deletions);
			expect(file.additions + file.deletions).toBeGreaterThan(0);
			// Display hunks check every unchanged line against both blobs.
			const { hunks } = await loadFileHunks(fx.path, snap, file.index);
			const changed = hunks
				.flatMap((hk) => hk.lines)
				.filter((l) => l.kind !== "context");
			expect(changed).toHaveLength(file.additions + file.deletions);
		}
	});

	it("counts with zero context, like the clusters (git's default context counts differently here)", () => {
		const file = snap.files.find(
			(f) => f.path === "src/actions/login_actions.py",
		);
		const withContext = execFileSync(
			"git",
			[
				"diff",
				"--numstat",
				"-M",
				b(),
				h(),
				"--",
				"src/actions/login_actions.py",
				"pages/login_page.py",
			],
			{ cwd: fx.path, encoding: "utf8", env: testGitEnv() },
		);
		const [add, del] = withContext.split("\t").map(Number);
		expect([file?.additions, file?.deletions]).not.toEqual([add, del]);
		expect(file).toMatchObject({ additions: 8, deletions: 3 });
	});
});
