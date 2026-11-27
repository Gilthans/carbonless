import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bestCpuRatio, repeat } from "../../../test/cpu.js";
import { createDiffFixture } from "../../../test/diff-fixture.js";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
	testGitEnv,
} from "../../../test/git-fixture.js";
import type { Cluster, Snapshot } from "../../shared/types.js";
import { parseU0Patch, WHOLE_SALT } from "./clusters.js";
import { listChangedFiles } from "./files.js";
import { clusterKeys } from "./identity.js";
import {
	buildSnapshot,
	cutClusters,
	fitViewWhitespace,
	loadContext,
	loadFileHunks,
	loadHunksBatch,
	MARKDOWN_CUT_MAX_BYTES,
	readBlobSizes,
} from "./snapshot.js";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

// Every git call's args, to prove which reads a snapshot makes.
const gitCalls = vi.hoisted(() => [] as string[][]);
vi.mock("../git.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../git.js")>();
	return {
		...real,
		runGit: (repo: string, args: string[], opts?: object) => {
			gitCalls.push(args);
			return real.runGit(repo, args, opts);
		},
		runGitBuffer: (repo: string, args: string[], opts?: object) => {
			gitCalls.push(args);
			return real.runGitBuffer(repo, args, opts);
		},
	};
});
const SIZES_FORMAT = "--batch-check=%(objectname) %(objecttype) %(objectsize)";

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
				{ index: 1, error: "Couldn't read this file" },
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

describe("whitespace-only runs are clusters of their own (CAR-156)", () => {
	let fx: GitFixture;
	let snap: Snapshot;
	const OLD = {
		"mixed.ts": "a\nb\n  c\n  d\ne\nf\n",
		"allws.ts": "if (x) {\n  y();\n  z();\n}\n",
		"none.ts": "one\ntwo\n",
		"blank.ts": "x\n  \ny\np\nq\n",
		"crlf.ts": "a\r\nb\r\n",
		"moved.ts": "m\n  b1\n  b2\nz\n",
		"tabs.ts": "k\n\tv\nw\n",
	};
	const NEW = {
		"mixed.ts": "A\nB\nc\nd\nE\nF\n",
		"allws.ts": "if (x) {\n\ty();\n\tz();\n}\n",
		"none.ts": "uno\ndos\n",
		"blank.ts": "X\n\ny2\np\n\nq\n",
		"crlf.ts": "a\nb\n",
		"moved.ts": "b1\nb2\nm\nz\n",
		"tabs.ts": "K\n    v\nW\n",
	};
	const file = (path: string) => {
		const f = snap.files.find((x) => x.path === path);
		if (!f) throw new Error(`no ${path}`);
		return f;
	};
	const shape = (path: string) =>
		file(path).clusters.map(
			(c) =>
				`${c.whitespaceOnly ? "~" : "*"}-${c.oldStart},${c.oldCount}+${c.newStart},${c.newCount}`,
		);

	beforeAll(async () => {
		fx = createGitFixture([
			{ message: "base", files: OLD },
			{ message: "head", files: NEW },
		]);
		snap = await buildSnapshot(
			fx.path,
			fx.shas[0] as string,
			fx.shas[1] as string,
		);
	});
	afterAll(() => fx.cleanup());

	it("cuts change / whitespace-only / change in one hunk into three clusters, at git's positions", () => {
		expect(shape("mixed.ts")).toEqual(["*-1,2+1,2", "~-3,2+3,2", "*-5,2+5,2"]);
		const [first, ws, last] = file("mixed.ts").clusters;
		expect(first).toMatchObject({
			removed: ["a", "b"],
			added: ["A", "B"],
			lines: 4,
		});
		expect(ws).toMatchObject({
			removed: ["  c", "  d"],
			added: ["c", "d"],
			lines: 4,
		});
		expect(last).toMatchObject({
			removed: ["e", "f"],
			added: ["E", "F"],
			lines: 4,
		});
	});

	it("keeps an all-whitespace hunk and a hunk with no whitespace-only line whole, keys as before", () => {
		expect(shape("allws.ts")).toEqual(["~-2,2+2,2"]);
		expect(shape("none.ts")).toEqual(["*-1,2+1,2"]);
		for (const path of ["allws.ts", "none.ts"]) {
			for (const c of file(path).clusters) expect(c.split).toBeUndefined();
		}
		const { key, ...none } = file("none.ts").clusters[0] as Cluster;
		const [wholeKey] = clusterKeys(
			"none.ts",
			[none],
			NEW["none.ts"].split("\n").slice(0, -1),
		);
		expect(key).toBe(wholeKey);
	});

	it("pairs a blank line with a whitespace-only one, keeps an added blank line a change, and treats CRLF and tabs as whitespace", () => {
		expect(shape("blank.ts")).toEqual([
			"*-1,1+1,1",
			"~-2,1+2,1",
			"*-3,1+3,1",
			"*-4,0+5,1",
		]);
		expect(shape("crlf.ts")).toEqual(["~-1,2+1,2"]);
		expect(shape("tabs.ts")).toEqual(["*-1,1+1,1", "~-2,1+2,1", "*-3,1+3,1"]);
	});

	it("keeps a block re-indented and moved across a line a change: git keeps the line, the block's sides land in two hunks", () => {
		expect(shape("moved.ts")).toEqual(["*-0,0+1,2", "*-2,2+3,0"]);
	});

	it("leaves git diff -w's changed lines outside the whitespace-only clusters: exactly, within a hunk; more, never fewer, across hunks", () => {
		const numstat = execFileSync(
			"git",
			["diff", "-w", "--numstat", fx.shas[0] as string, fx.shas[1] as string],
			{ cwd: fx.path, encoding: "utf8", env: testGitEnv() },
		);
		const counted = new Map<string, number>();
		for (const line of numstat.trim().split("\n")) {
			const [added, deleted, path] = line.split("\t");
			counted.set(path as string, Number(added) + Number(deleted));
		}
		for (const f of snap.files) {
			const real = f.clusters
				.filter((c) => !c.whitespaceOnly)
				.reduce((n, c) => n + c.lines, 0);
			if (f.path === "moved.ts") {
				// -w matches the block across the moved line; per hunk, nothing pairs.
				expect(real).toBe(4);
				expect(counted.get(f.path)).toBe(2);
			} else expect(real, f.path).toBe(counted.get(f.path) ?? 0);
			// Every changed line is in exactly one cluster.
			expect(
				f.clusters.reduce((n, c) => n + c.lines, 0),
				f.path,
			).toBe(f.additions + f.deletions);
		}
	});

	it("names each piece's whole hunk by the key it had as one cluster, and where the piece sits in it", () => {
		const pieces = file("mixed.ts").clusters;
		const whole = {
			kind: "lines" as const,
			oldStart: 1,
			oldCount: 6,
			newStart: 1,
			newCount: 6,
			removed: OLD["mixed.ts"].split("\n").slice(0, -1),
			added: NEW["mixed.ts"].split("\n").slice(0, -1),
			lines: 12,
		};
		const [wholeKey] = clusterKeys("mixed.ts", [whole], whole.added);
		expect(pieces.map((c) => c.split)).toEqual([
			{ key: wholeKey, removedAt: 0, addedAt: 0, removed: 6 },
			{ key: wholeKey, removedAt: 2, addedAt: 2, removed: 6 },
			{ key: wholeKey, removedAt: 4, addedAt: 4, removed: 6 },
		]);
		const keys = pieces.map((c) => c.key);
		expect(new Set([...keys, wholeKey]).size).toBe(4);
	});

	it("shows the pieces as one display hunk, each line under its own cluster", async () => {
		const index = file("mixed.ts").index;
		const { hunks } = await loadFileHunks(fx.path, snap, index);
		expect(hunks).toHaveLength(1);
		const [first, ws, last] = file("mixed.ts").clusters.map((c) => c.key);
		expect(
			hunks[0]?.lines.map(
				(l) =>
					`${l.kind}:${l.text}:${l.clusterKey === first ? 1 : l.clusterKey === ws ? 2 : l.clusterKey === last ? 3 : 0}`,
			),
		).toEqual([
			"del:a:1",
			"del:b:1",
			"add:A:1",
			"add:B:1",
			"del:  c:2",
			"del:  d:2",
			"add:c:2",
			"add:d:2",
			"del:e:3",
			"del:f:3",
			"add:E:3",
			"add:F:3",
		]);
		const blank = await loadFileHunks(fx.path, snap, file("blank.ts").index);
		expect(blank.hunks[0]?.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
			"del:x",
			"add:X",
			"del:  ",
			"add:",
			"del:y",
			"add:y2",
			"context:p",
			"add:",
			"context:q",
		]);
	});
});

describe("the cut is part of cluster identity (CAR-156)", () => {
	it("pins the pieces' keys, flags and whole-hunk keys of fixed hunks: changing the cut changes keys", () => {
		// Change / whitespace only / change; and a deletion, a re-indent, an addition.
		const patch =
			"@@ -2,6 +2,6 @@\n-a\n-b\n-  c\n-  d\n-e\n-f\n+A\n+B\n+c\n+d\n+E\n+F\n@@ -10,3 +10,3 @@\n-gone\n-  b1\n-  b2\n+b1\n+b2\n+new\n";
		const newLines = [
			"x",
			"A",
			"B",
			"c",
			"d",
			"E",
			"F",
			"y",
			"z",
			"b1",
			"b2",
			"new",
			"w",
		];
		const hunks = parseU0Patch(patch).map((c) => ({
			...c,
			kind: "lines" as const,
		}));
		const oldLines = [
			"x",
			"a",
			"b",
			"  c",
			"  d",
			"e",
			"f",
			"y",
			"z",
			"gone",
			"  b1",
			"  b2",
			"w",
		];
		const pieces = cutClusters(
			hunks,
			(cs) => clusterKeys("pin.ts", cs, newLines),
			{ oldLines, newLines, noNewlineAtEnd: false },
		);
		const H1 =
			"35dd0fb1a6d7c6027046a57f11edac073159a6af469e26d654a851c390431c67";
		const H2 =
			"cb73730b567b19658bc8c50a13b5bcb7f0ab1236d08fa5f454cca383ce98cffe";
		expect(
			pieces.map((c) => [c.key, c.whitespaceOnly ?? false, c.split?.key]),
		).toEqual([
			[
				"90fb21e0cd88e607b32a1774e9640366d23424fa7ad79d52e3dc15ed65cbb4a7",
				false,
				H1,
			],
			[
				"bd127ad9d802f80bffc09937d7680c472e6fa200733f90ebd34c1b871b222651",
				true,
				H1,
			],
			[
				"980fbb79e35b46f1c46f400491ad19b4e63b05cca63ec9a0cf07221df47eab16",
				false,
				H1,
			],
			[
				"dad65bfd0e1a5cd2b813d6f367001d8fd1f1ee070700140eee0b3aafd736fc0d",
				false,
				H2,
			],
			[
				"fa83eec9c99b688351ae1f9fd74395ed5a2a610d8c5b2ad431b810ed503d367b",
				true,
				H2,
			],
			[
				"0ad01c5dd0362b3ca8210dbb060b877159303fab4c2b2b26bed305d316d0eaf8",
				false,
				H2,
			],
		]);
		// The whole hunks' keys are what they were as one cluster each.
		expect(clusterKeys("pin.ts", hunks, newLines)).toEqual([H1, H2]);
	});
});

describe("the cut over display hunks (CAR-218)", () => {
	// A page's markup wrapped one level deeper in a new <Provider>: the inner
	// `<div>` and `</div>` at the old depth equal the outer ones at the new
	// depth, so git cuts the block into three hunks around them.
	const oldText = [
		"export function Page() {",
		"  return (",
		"    <div>",
		"      <Header />",
		"      <div>",
		"        <Title />",
		"      </div>",
		"      <Footer />",
		"    </div>",
		"  );",
		"}",
	];
	const newText = [
		"export function Page() {",
		"  return (",
		"    <Provider>",
		"      <div>",
		"        <Header />",
		"        <div>",
		"          <Title />",
		"        </div>",
		"        <Footer />",
		"      </div>",
		"    </Provider>",
		"  );",
		"}",
	];
	const patch =
		"@@ -3,2 +3 @@\n-    <div>\n-      <Header />\n+    <Provider>\n@@ -6 +5,5 @@\n-        <Title />\n+        <Header />\n+        <div>\n+          <Title />\n+        </div>\n+        <Footer />\n@@ -8,2 +11 @@\n-      <Footer />\n-    </div>\n+    </Provider>\n";
	const hunks = parseU0Patch(patch).map((c) => ({
		...c,
		kind: "lines" as const,
	}));
	const keysOf = (cs: Omit<Cluster, "key">[]) =>
		clusterKeys("page.tsx", cs, newText);

	it("re-indent across an accidental unchanged line: only the wrapper's lines are changes", () => {
		const pieces = cutClusters(hunks, keysOf, {
			oldLines: oldText,
			newLines: newText,
			noNewlineAtEnd: false,
		});
		expect(
			pieces.map(
				(c) =>
					`${c.whitespaceOnly ? "~" : "*"}${c.oldStart},${c.oldCount} ${c.newStart},${c.newCount}`,
			),
		).toEqual(["~3,2 2,0", "*4,0 3,1", "~6,1 5,5", "~8,2 10,0", "*9,0 11,1"]);
		const changes = pieces.filter((c) => !c.whitespaceOnly);
		expect(changes.flatMap((c) => [...c.removed, ...c.added])).toEqual([
			"    <Provider>",
			"    </Provider>",
		]);
	});

	it("pins the new keys of a hunk that spans an accidental unchanged line", () => {
		const pieces = cutClusters(hunks, keysOf, {
			oldLines: oldText,
			newLines: newText,
			noNewlineAtEnd: false,
		});
		const H1 =
			"126047072c2c74b1b572adc747f99175a6211ac8359d49468fa90a6b578d43c8";
		const H2 =
			"492161214fe8f491f0ce9766365d9121b07ad27e6cc811d0d8aea59f91edf510";
		const H3 =
			"1bb11a33c795bb5783bee2c701b5c960b74f59aabd53a6df9480b51160c59bd2";
		// Hunk 1 and 3 split into removed-only whitespace and an added-only
		// change; hunk 2, all whitespace, is one cluster with the whole
		// hunk's key.
		expect(
			pieces.map((c) => [c.key, c.whitespaceOnly ?? false, c.split?.key]),
		).toEqual([
			[
				"2044005d8a46e7d0c0dc245ef5308da6be3308c0698e214f1217c5283b8e825a",
				true,
				H1,
			],
			[
				"426bd982b901c18f93092c3bd89663b5988429eaca01278a92e025e69b9531cd",
				false,
				H1,
			],
			[H2, true, undefined],
			[
				"7c9094044ca843d6a27075db5e5a9a08f25195dc11eb9fcf719f1dbf79eef459",
				true,
				H3,
			],
			[
				"4669e698766b2d3a1bb0eeafd293c8aa7324d0a27026dfb575e935e7d394e97d",
				false,
				H3,
			],
		]);
		// The whole hunks' keys are what they were as one cluster each.
		expect(keysOf(hunks)).toEqual([H1, H2, H3]);
	});

	it("falls back to each hunk on its own when the hunks don't fit the text", () => {
		const own = cutClusters(hunks, keysOf, {
			oldLines: [],
			newLines: [],
			noNewlineAtEnd: false,
		});
		// As splitHunk cut them before CAR-218: only <Title /> pairs.
		expect(own.map((c) => `${c.whitespaceOnly ? "~" : "*"}${c.lines}`)).toEqual(
			["*3", "*2", "~2", "*2", "*3"],
		);
	});
});

describe("file sizes and the LFS flag", () => {
	let fx: GitFixture;
	let snap: Snapshot;
	const LFS = "version https://git-lfs.github.com/spec/v1";
	const pointer = `${LFS}\noid sha256:${"ab".repeat(32)}\nsize 12345\n`;
	const long = `${LFS}\n${"x".repeat(300 - LFS.length - 2)}\n`;
	const plain300 = `${"y".repeat(299)}\n`;
	const png = (n: number) =>
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, n]);
	// Large enough, and alike enough, for git to pair the rename.
	const bigPng = (last: number, extra = 0) =>
		new Uint8Array([
			...png(0),
			...Array.from({ length: 2000 + extra }, (_, i) => (i * 7) % 251),
			last,
		]);
	const fileOf = (path: string) => {
		const file = snap.files.find((f) => f.path === path);
		if (!file) throw new Error(`no ${path}`);
		return file;
	};

	beforeAll(async () => {
		fx = createGitFixture([
			{
				message: "base",
				files: {
					"pointer.png": `${LFS}\noid sha256:${"cd".repeat(32)}\nsize 1\n`,
					"long.png": `${long}old\n`,
					"flip.png": plain300,
				},
				binary: {
					"logo.png": png(1),
					"before.png": bigPng(1),
					// Only moved: the same blob on both sides.
					"mark.png": bigPng(9, 40),
					// Unlike added.png, so git doesn't pair them as a rename.
					"gone.png": new Uint8Array(64).fill(0xaa),
				},
				submodule: { lib: "1".repeat(40) },
			},
			{
				message: "head",
				delete: ["gone.png"],
				rename: { "before.png": "after.png", "mark.png": "brand/mark.png" },
				files: {
					"pointer.png": pointer,
					"notes.txt": pointer,
					"long.png": long,
					"flip.png": pointer,
				},
				binary: {
					"logo.png": new Uint8Array([...png(2), 7, 7, 7]),
					"added.png": png(3),
					"after.png": bigPng(2, 5),
				},
				submodule: { lib: "2".repeat(40) },
			},
		]);
		const [base, head] = fx.shas as [string, string];
		snap = await buildSnapshot(fx.path, base, head);
	});
	afterAll(() => fx.cleanup());

	it("gives each side's byte size", () => {
		expect(fileOf("logo.png")).toMatchObject({ oldSize: 10, newSize: 13 });
		const added = fileOf("added.png");
		expect(added.newSize).toBe(10);
		expect(added).not.toHaveProperty("oldSize");
		const gone = fileOf("gone.png");
		expect(gone).toMatchObject({ status: "deleted", oldSize: 64 });
		expect(gone).not.toHaveProperty("newSize");
		expect(fileOf("after.png")).toMatchObject({
			status: "renamed",
			oldPath: "before.png",
			oldSize: bigPng(1).length,
			newSize: bigPng(2, 5).length,
		});
		expect(fileOf("notes.txt")).not.toHaveProperty("oldSize");
		expect(fileOf("notes.txt").newSize).toBe(pointer.length);
		expect(fileOf("flip.png")).toMatchObject({
			oldSize: 300,
			newSize: pointer.length,
		});
	});

	it("flags a file whose two sides are the same blob", () => {
		expect(fileOf("brand/mark.png")).toMatchObject({
			status: "renamed",
			oldPath: "mark.png",
			sameBlob: true,
		});
		for (const path of ["after.png", "logo.png", "added.png", "gone.png"])
			expect(fileOf(path)).not.toHaveProperty("sameBlob");
	});

	it("gives a submodule no size", () => {
		const lib = fileOf("lib");
		expect(lib.submodule).toBe(true);
		expect(lib).not.toHaveProperty("oldSize");
		expect(lib).not.toHaveProperty("newSize");
	});

	it("sizes only blobs", async () => {
		const [base] = fx.shas as [string];
		const blob = execFileSync("git", ["rev-parse", `${base}:logo.png`], {
			cwd: fx.path,
			encoding: "utf8",
			env: testGitEnv(),
		}).trim();
		const sizes = await readBlobSizes(fx.path, [base, blob, "1".repeat(40)]);
		expect([...sizes]).toEqual([[blob, 10]]);
	});

	it("flags an LFS pointer with an image path only", () => {
		expect(fileOf("pointer.png").lfs).toBe(true);
		expect(fileOf("notes.txt")).not.toHaveProperty("lfs");
		expect(long.length).toBe(300);
		expect(fileOf("long.png")).not.toHaveProperty("lfs");
		expect(fileOf("logo.png")).not.toHaveProperty("lfs");
	});

	it("flags a file when either side is a pointer", () => {
		expect(plain300.length).toBe(300);
		expect(fileOf("flip.png").lfs).toBe(true);
	});

	it("reads no sizes from git for a review without binary files", async () => {
		const textOnly = createGitFixture([
			{ message: "base", files: { "a.txt": "one\n" } },
			{ message: "head", files: { "a.txt": "two\n", "b.png": pointer } },
		]);
		try {
			const [base, head] = textOnly.shas as [string, string];
			gitCalls.length = 0;
			const text = await buildSnapshot(textOnly.path, base, head);
			expect(text.files.map((f) => [f.path, f.oldSize, f.newSize])).toEqual([
				["a.txt", 4, 4],
				["b.png", undefined, pointer.length],
			]);
			expect(gitCalls.some((args) => args.includes(SIZES_FORMAT))).toBe(false);
			// The same check sees the read where there is a binary file.
			gitCalls.length = 0;
			await buildSnapshot(fx.path, fx.shas[0] as string, fx.shas[1] as string);
			expect(gitCalls.some((args) => args.includes(SIZES_FORMAT))).toBe(true);
		} finally {
			textOnly.cleanup();
		}
	});
});

describe("Markdown files are cut at their blocks (CAR-167)", () => {
	let fx: GitFixture;
	let snap: Snapshot;
	let again: Snapshot;
	// One hunk (banana, cherry) across two list items.
	const LIST = "# Fruit\n\nSome text.\n\n- apple\n- banana\n- cherry\n\nEnd.\n";
	const LIST2 = LIST.replace("- banana\n- cherry", "- Banana!\n- Cherry!");
	const filler = Array.from(
		{ length: 30 },
		(_, i) => `Line ${i} of a paragraph long enough to keep the rename.`,
	).join("\n");
	const NOTES = `${LIST}\n${filler}\n`;
	const NOTES2 = `${LIST2}\n${filler}\n`;
	const lfsPointer = (oid: string) =>
		`version https://git-lfs.github.com/spec/v1\noid sha256:${oid.repeat(32)}\nsize 12345\n`;
	// Over the cap by a paragraph, the same edit at its top.
	const para = `${"x".repeat(99)}\n\n`;
	const pad = para.repeat(Math.ceil(MARKDOWN_CUT_MAX_BYTES / para.length));
	const fileOf = (s: Snapshot, path: string) => {
		const f = s.files.find((x) => x.path === path);
		if (!f) throw new Error(`no ${path}`);
		return f;
	};
	const shape = (s: Snapshot, path: string) =>
		fileOf(s, path).clusters.map(
			(c) => `-${c.oldStart},${c.oldCount}+${c.newStart},${c.newCount}`,
		);

	beforeAll(async () => {
		fx = createGitFixture([
			{
				message: "base",
				files: {
					"list.md": LIST,
					"list.txt": LIST,
					"notes.txt": NOTES,
					"gone.md": LIST,
					"big.md": `${LIST}\n${pad}`,
					"other.ts": "a\n",
					"pointer.md": lfsPointer("aa"),
					"readme.md": NOTES,
				},
			},
			{
				message: "head",
				rename: { "notes.txt": "notes.md", "readme.md": "readme.txt" },
				delete: ["gone.md"],
				files: {
					"list.md": LIST2,
					"list.txt": LIST2,
					"notes.md": NOTES2,
					"big.md": `${LIST2}\n${pad}`,
					"other.ts": "b\n",
					"pointer.md": lfsPointer("bb"),
					"readme.txt": NOTES2,
				},
			},
			// Only another file moves on.
			{ message: "later", files: { "other.ts": "c\n" } },
		]);
		const [b, h, later] = fx.shas as [string, string, string];
		[snap, again] = await Promise.all([
			buildSnapshot(fx.path, b, h),
			buildSnapshot(fx.path, b, later),
		]);
	});
	afterAll(() => fx.cleanup());

	it("cuts a .md hunk across two list items into two clusters, and flags the file", () => {
		expect(shape(snap, "list.md")).toEqual(["-6,1+6,1", "-7,1+7,1"]);
		expect(fileOf(snap, "list.md").markdownBlocks).toBe(true);
		const [banana, cherry] = fileOf(snap, "list.md").clusters as [
			Cluster,
			Cluster,
		];
		expect([banana.removed, banana.added]).toEqual([
			["- banana"],
			["- Banana!"],
		]);
		// Both point at the git hunk, with their places in it.
		expect(banana.split?.key).toBe(cherry.split?.key);
		expect(banana.split).toMatchObject({
			removedAt: 0,
			addedAt: 0,
			removed: 2,
		});
		expect(cherry.split).toMatchObject({
			removedAt: 1,
			addedAt: 1,
			removed: 2,
		});
	});

	it("leaves the same content in a .txt one cluster, unflagged", () => {
		expect(shape(snap, "list.txt")).toEqual(["-6,2+6,2"]);
		expect(fileOf(snap, "list.txt")).not.toHaveProperty("markdownBlocks");
		expect(fileOf(snap, "list.txt").clusters[0]).not.toHaveProperty("split");
	});

	it("cuts a file renamed to .md, and a deleted .md at its old blocks", () => {
		expect(fileOf(snap, "notes.md")).toMatchObject({
			status: "renamed",
			oldPath: "notes.txt",
			markdownBlocks: true,
		});
		// The rename's own cluster, then the two items.
		expect(shape(snap, "notes.md")).toEqual([
			"-0,0+0,0",
			"-6,1+6,1",
			"-7,1+7,1",
		]);
		const gone = fileOf(snap, "gone.md");
		expect(gone.status).toBe("deleted");
		expect(gone.markdownBlocks).toBe(true);
		// Heading, paragraph, three items, paragraph: one cluster each.
		expect(gone.clusters.map((c) => c.removed)).toEqual([
			["# Fruit", ""],
			["Some text.", ""],
			["- apple"],
			["- banana"],
			["- cherry", ""],
			["End."],
		]);
	});

	it("doesn't cut a file renamed from .md to another extension", () => {
		expect(fileOf(snap, "readme.txt")).toMatchObject({
			status: "renamed",
			oldPath: "readme.md",
		});
		expect(fileOf(snap, "readme.txt")).not.toHaveProperty("markdownBlocks");
		expect(shape(snap, "readme.txt")).toEqual(["-0,0+0,0", "-6,2+6,2"]);
	});

	it("doesn't cut or flag an LFS pointer named .md", () => {
		expect(fileOf(snap, "pointer.md")).not.toHaveProperty("markdownBlocks");
	});

	it("doesn't cut or flag a symlink named .md", async () => {
		const links = createGitFixture([
			{ message: "base", files: { "keep.txt": "k\n" } },
		]);
		try {
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: links.path,
					encoding: "utf8",
					env: testGitEnv(),
				}).trim();
			// A symlink whose target text is Markdown blocks: two list items.
			const link = (target: string) => {
				const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
					cwd: links.path,
					encoding: "utf8",
					env: testGitEnv(),
					input: target,
				}).trim();
				git("update-index", "--add", "--cacheinfo", `120000,${blob},link.md`);
				git("commit", "-q", "-m", target);
				return git("rev-parse", "HEAD");
			};
			const from = link("- a\n- b");
			const to = link("- A\n- B");
			const s = await buildSnapshot(links.path, from, to);
			const f = fileOf(s, "link.md");
			expect(f.newMode).toBe("120000");
			expect(f).not.toHaveProperty("markdownBlocks");
			expect(f.clusters.filter((c) => c.kind === "lines")).toHaveLength(1);
		} finally {
			links.cleanup();
		}
	});

	it("doesn't cut or flag a .md over MARKDOWN_CUT_MAX_BYTES", () => {
		expect(MARKDOWN_CUT_MAX_BYTES).toBeGreaterThanOrEqual(300 * 1024);
		const big = fileOf(snap, "big.md");
		expect(big.newSize).toBeGreaterThan(MARKDOWN_CUT_MAX_BYTES);
		expect(shape(snap, "big.md")).toEqual(["-6,2+6,2"]);
		expect(big).not.toHaveProperty("markdownBlocks");
	});

	it("keeps every key of a .md unchanged elsewhere, across snapshots", () => {
		for (const path of ["list.md", "notes.md", "gone.md", "readme.txt"]) {
			expect(fileOf(again, path).clusters).toEqual(fileOf(snap, path).clusters);
		}
		expect(fileOf(again, "other.ts").clusters[0]?.key).not.toBe(
			fileOf(snap, "other.ts").clusters[0]?.key,
		);
	});
});

describe("the block cut and cluster identity (CAR-167)", () => {
	const keyed = (newLines: string[]) => (cs: Omit<Cluster, "key">[]) =>
		clusterKeys("doc.md", cs, newLines);
	const hunksOf = (patch: string) =>
		parseU0Patch(patch).map((c) => ({ ...c, kind: "lines" as const }));

	it("cuts an added Markdown file at its blocks and then at blank lines (CAR-235)", () => {
		// A fence holding a blank line: the block cut keeps it one piece,
		// the blank-line cut ends a piece after that blank line too.
		const newLines = ["# T", "", "```", "a", "", "b", "```", "", "- x"];
		const hunks = hunksOf(
			`@@ -0,0 +1,9 @@\n${newLines.map((l) => `+${l}`).join("\n")}\n`,
		);
		const text = { oldLines: [], newLines, noNewlineAtEnd: false };
		const md = cutClusters(hunks, keyed(newLines), text, { markdown: true });
		const both = cutClusters(hunks, keyed(newLines), text, {
			markdown: true,
			blankLines: true,
		});
		expect(md.map((c) => c.added)).toEqual([
			["# T", ""],
			["```", "a", "", "b", "```", ""],
			["- x"],
		]);
		expect(both.map((c) => c.added)).toEqual([
			["# T", ""],
			["```", "a", ""],
			["b", "```", ""],
			["- x"],
		]);
		// Every piece is the git hunk's, at its place in it (the split carry).
		const [whole] = keyed(newLines)(hunks);
		expect(both.map((c) => [c.split?.key, c.split?.addedAt])).toEqual([
			[whole, 0],
			[whole, 2],
			[whole, 5],
			[whole, 8],
		]);
	});

	it("keeps the key a hunk the block cut leaves whole had before it", () => {
		// A two-line paragraph edited, and a list item: one block each.
		const oldLines = ["Para one", "goes on.", "", "- item"];
		const newLines = ["Para ONE", "goes on!", "", "- ITEM"];
		const hunks = hunksOf(
			"@@ -1,2 +1,2 @@\n-Para one\n-goes on.\n+Para ONE\n+goes on!\n@@ -4 +4 @@\n-- item\n+- ITEM\n",
		);
		const before = cutClusters(hunks, keyed(newLines), {
			oldLines,
			newLines,
			noNewlineAtEnd: false,
		});
		const after = cutClusters(
			hunks,
			keyed(newLines),
			{ oldLines, newLines, noNewlineAtEnd: false },
			{ markdown: true },
		);
		expect(after).toEqual(before);
		expect(after.map((c) => c.key)).toEqual(
			clusterKeys("doc.md", hunks, newLines),
		);
		expect(after.map((c) => c.key)).toEqual([
			"6180e909fbac8030f23648bbe526a445f6acf176be1b628d6e7ab3be513d2294",
			"fc011e0e0cd91f4e10b6498528ba6e9a1127dc55a5d789ec32fadfff419b35b1",
		]);
		for (const c of after) expect(c).not.toHaveProperty("split");
	});

	it("points a CAR-156 piece's block pieces at the git hunk, with their places in it, naming that piece", () => {
		// change / whitespace only across two items / change, in one hunk.
		const oldLines = ["- x", "- a ", "- b ", "- y"];
		const newLines = ["- X", "- a", "- b", "- Y"];
		const hunks = hunksOf(
			"@@ -1,4 +1,4 @@\n-- x\n-- a \n-- b \n-- y\n+- X\n+- a\n+- b\n+- Y\n",
		);
		const ws = cutClusters(hunks, keyed(newLines), {
			oldLines,
			newLines,
			noNewlineAtEnd: false,
		});
		const md = cutClusters(
			hunks,
			keyed(newLines),
			{ oldLines, newLines, noNewlineAtEnd: false },
			{ markdown: true },
		);
		expect(ws.map((c) => c.whitespaceOnly ?? false)).toEqual([
			false,
			true,
			false,
		]);
		expect(
			md.map((c) => [c.removed, c.added, c.whitespaceOnly ?? false]),
		).toEqual([
			[["- x"], ["- X"], false],
			[["- a "], ["- a"], true],
			[["- b "], ["- b"], true],
			[["- y"], ["- Y"], false],
		]);
		const hunk = hunks[0] as (typeof hunks)[number];
		const [hunkKey] = clusterKeys("doc.md", hunks, newLines);
		for (const c of md) {
			const split = c.split as NonNullable<Cluster["split"]>;
			expect(split.key).toBe(hunkKey);
			expect(split.removed).toBe(4);
			expect(
				hunk.removed.slice(split.removedAt, split.removedAt + c.removed.length),
			).toEqual(c.removed);
			expect(
				hunk.added.slice(split.addedAt, split.addedAt + c.added.length),
			).toEqual(c.added);
		}
		// The CAR-156 pieces the block cut leaves whole keep their keys; the
		// one it cuts again gets new ones, and its pieces name it.
		expect([md[0]?.key, md[3]?.key]).toEqual([ws[0]?.key, ws[2]?.key]);
		expect(md.map((c) => c.key)).not.toContain(ws[1]?.key);
		expect(md.map((c) => c.split?.piece)).toEqual([
			undefined,
			ws[1]?.key,
			ws[1]?.key,
			undefined,
		]);
	});

	it("costs linear CPU in the file's size: 300 KiB against four cuts of its quarter", () => {
		// A README of sections, each one hunk across three list items and a
		// table row. The 4x file against four runs of the quarter does the
		// same work: linear reads about 1x, quadratic 4x.
		const readme = (bytes: number) => {
			const oldLines: string[] = [];
			const newLines: string[] = [];
			let patch = "";
			let size = 0;
			for (let s = 0; size < bytes; s++) {
				const head = [`## Section ${s}`, "", `Some words about part ${s}.`, ""];
				const body = (v: string) => [
					`- item one of ${s}${v}`,
					`- item two of ${s}${v}`,
					`  - nested ${s}${v}`,
					`| ${s} | cell${v} |`,
				];
				const at = oldLines.length + head.length + 1;
				oldLines.push(...head, ...body(""), "");
				newLines.push(...head, ...body(" (edited)"), "");
				patch += `@@ -${at},4 +${at},4 @@\n${body("")
					.map((l) => `-${l}\n`)
					.join("")}${body(" (edited)")
					.map((l) => `+${l}\n`)
					.join("")}`;
				for (const l of oldLines.slice(-9)) size += l.length + 1;
			}
			const hunks = hunksOf(patch);
			const keysOf = keyed(newLines);
			return () =>
				cutClusters(
					hunks,
					keysOf,
					{ oldLines, newLines, noNewlineAtEnd: false },
					{ markdown: true },
				);
		};
		const big = readme(300 * 1024);
		const quarter = readme(75 * 1024);
		const { best, ref, ratio } = bestCpuRatio(big, () => {
			for (let i = 0; i < 4; i++) quarter();
		});
		console.info(
			`cutClusters of a 300 KiB README: ${best} µs, ${ratio.toFixed(2)}x four cuts of its quarter (${ref} µs)`,
		);
		expect(ratio).toBeLessThan(2);
	});
});

describe("added files cut at blank lines (CAR-235)", () => {
	const added =
		"import x\n\nfunction a() {\n  return 1;\n}\n\n\nfunction b() {}\n";
	const edited = "one\n";
	let repo: GitFixture;
	let snap: Snapshot;
	beforeAll(async () => {
		repo = createGitFixture([
			{ message: "base", files: { "edit.ts": edited } },
			{
				message: "head",
				files: {
					"edit.ts": `${edited}\nmore\n\nand more\n`,
					"new.ts": added,
					"blank.txt": "\n \n",
					"deps/pnpm-lock.yaml": "a:\n  b: 1\n\nc:\n  d: 2\n",
					// CAR-322: machine-made by name.
					"dist/app.min.js": added,
					"src/__snapshots__/a.test.ts.snap": added,
					"docs/api.generated.md": "# A\n\ntext\n\n# B\n",
				},
			},
		]);
		snap = await buildSnapshot(
			repo.path,
			repo.shas[0] as string,
			repo.shas[1] as string,
		);
	});
	afterAll(() => repo.cleanup());
	const fileOf = (path: string) => {
		const f = snap.files.find((x) => x.path === path);
		if (!f) throw new Error(`no ${path}`);
		return f;
	};

	it("gives an added file one cluster per blank-line-ended block, every line once", () => {
		const f = fileOf("new.ts");
		expect(f.clusters.map((c) => c.added)).toEqual([
			["import x", ""],
			["function a() {", "  return 1;", "}", "", ""],
			["function b() {}"],
		]);
		expect(f.clusters.map((c) => [c.newStart, c.newCount])).toEqual([
			[1, 2],
			[3, 5],
			[8, 1],
		]);
		// Totals unchanged (principle 2): every added line in one cluster.
		expect(f.clusters.reduce((n, c) => n + c.lines, 0)).toBe(f.additions);
		expect(f.clusters.flatMap((c) => c.added).join("\n")).toBe(
			added.slice(0, -1),
		);
		expect(new Set(f.clusters.map((c) => c.key)).size).toBe(3);
	});

	it("remembers the whole hunk's key on each piece, so marks on it carry", () => {
		const f = fileOf("new.ts");
		const whole = clusterKeys(
			"new.ts",
			[
				{
					...(parseU0Patch(
						`@@ -0,0 +1,8 @@\n${added
							.split("\n")
							.slice(0, -1)
							.map((l) => `+${l}`)
							.join("\n")}\n`,
					)[0] as Omit<Cluster, "key" | "kind">),
					kind: "lines",
				},
			],
			added.split("\n").slice(0, -1),
		)[0];
		expect(f.clusters.map((c) => c.split)).toEqual([
			{ key: whole, removedAt: 0, addedAt: 0, removed: 0 },
			{ key: whole, removedAt: 0, addedAt: 2, removed: 0 },
			{ key: whole, removedAt: 0, addedAt: 7, removed: 0 },
		]);
	});

	it("leaves an added lock file whole, as before (owner 2026-11-24)", () => {
		const lock = fileOf("deps/pnpm-lock.yaml");
		expect(lock.clusters).toHaveLength(1);
		expect(lock.clusters[0]?.split).toBeUndefined();
		expect(lock.clusters[0]?.lines).toBe(5);
	});

	it("leaves an added machine-made file whole, under a new (salted) key (CAR-322)", () => {
		const lines = added.split("\n").slice(0, -1);
		for (const path of [
			"dist/app.min.js",
			"src/__snapshots__/a.test.ts.snap",
		]) {
			const f = fileOf(path);
			expect(f.clusters).toHaveLength(1);
			const [whole] = f.clusters as [Cluster];
			expect(whole.split).toBeUndefined();
			expect(whole.lines).toBe(8);
			expect(whole.added.join("\n")).toBe(added.slice(0, -1));
			const { key: _, ...hunk } = whole;
			// Not the key the whole file had before CAR-235, which its pieces'
			// marks came from: nothing marked before carries.
			const unsalted = clusterKeys(path, [hunk], lines)[0];
			expect(whole.key).not.toBe(unsalted);
			expect(whole.key).toBe(
				clusterKeys(path, [hunk], lines, { salt: WHOLE_SALT })[0],
			);
		}
	});

	it("still cuts a Markdown file whatever its name, and keeps a lock file's key as it was", () => {
		expect(fileOf("docs/api.generated.md").clusters.length).toBeGreaterThan(1);
		const [lock] = fileOf("deps/pnpm-lock.yaml").clusters as [Cluster];
		const { key: _, ...hunk } = lock;
		expect(lock.key).toBe(
			clusterKeys(
				"deps/pnpm-lock.yaml",
				[hunk],
				["a:", "  b: 1", "", "c:", "  d: 2"],
			)[0],
		);
	});

	it("leaves an added file of only blank lines whole, and an edited file's hunks as git cuts them", () => {
		expect(fileOf("blank.txt").clusters).toHaveLength(1);
		expect(fileOf("blank.txt").clusters[0]?.split).toBeUndefined();
		const e = fileOf("edit.ts");
		expect(e.clusters).toHaveLength(1);
		expect(e.clusters[0]?.added).toEqual(["", "more", "", "and more"]);
	});
});

describe("the blank-line cut of a big added file scales linearly (CAR-235)", () => {
	/** An added file of `blocks` five-line blocks, each ended by a blank line. */
	const addedFile = (blocks: number) => {
		const lines = Array.from({ length: blocks }, (_, b) => [
			`export function f${b}(x: number) {`,
			`\tconst y = x * ${b};`,
			"\treturn y + 1;",
			"}",
			"",
		]).flat();
		const hunk: Omit<Cluster, "key"> = {
			kind: "lines",
			oldStart: 0,
			oldCount: 0,
			newStart: 1,
			newCount: lines.length,
			removed: [],
			added: lines,
			lines: lines.length,
		};
		return () =>
			cutClusters(
				[hunk],
				(cs) => clusterKeys("big.ts", cs, lines),
				{ oldLines: [], newLines: lines, noNewlineAtEnd: false },
				{ blankLines: true },
			);
	};

	it("cuts and keys a 4x larger file in about 4x the CPU, not 16x", () => {
		const large = addedFile(1600);
		const small = addedFile(400);
		expect(large()).toHaveLength(1600);
		expect(small()).toHaveLength(400);
		// The whole snapshot's cost of the cut: the pieces' keys (each hashed
		// with its context) and the whole hunk's key for the split carry.
		// Linear is about 1x; a per-piece pass over the file would be 4x:
		// measured 1.00-1.14x on the dev machine, and 3.56x with such a pass
		// put in splitAtBlankLines as a probe.
		const { best, ratio } = bestCpuRatio(large, repeat(4, small));
		console.info(
			`blank-line cut of an 8,000-line added file: ${(best / 1000).toFixed(1)} ms CPU, ${ratio.toFixed(2)}x four 2,000-line ones`,
		);
		expect(ratio).toBeLessThan(2);
	});
});

describe("fitViewWhitespace (CAR-167)", () => {
	it("counts a rechecked piece the view draws no lines for: unknown is never whitespace", () => {
		// A piece flagged whitespace-only that no display hunk holds a line
		// of: the view can't say it is `~`, so it counts (principle 2).
		const clusters: Omit<Cluster, "key">[] = [
			{
				kind: "file",
				label: "x",
				oldStart: 0,
				oldCount: 0,
				newStart: 0,
				newCount: 0,
				removed: [],
				added: [],
				lines: 0,
				whitespaceOnly: true,
			},
		];
		const parts = [{ hunk: -1, removedAt: 0, addedAt: 0, piece: -1 }];
		fitViewWhitespace(clusters, parts, new Set([0]), {
			oldLines: ["a"],
			newLines: ["a"],
			noNewlineAtEnd: false,
		});
		expect(clusters).toHaveLength(1);
		expect(clusters[0]?.whitespaceOnly).toBeUndefined();
	});
});
