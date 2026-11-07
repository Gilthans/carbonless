import { execFileSync } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
	testGitEnv,
} from "../../../test/git-fixture";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import type {
	CodeAnchor,
	ReviewThread,
	Snapshot,
	ThreadAnchorRef,
} from "../../shared/types";
import { buildSnapshot } from "../diff/snapshot";
import { ThreadCodeSource } from "../threadCode";
import { placeable, ThreadPlacer } from "./threads";

vi.setConfig(GIT_TEST_TIMEOUTS);

/*
 * Thread placement on throwaway repos: threads made on PS1's head `H1`
 * (base `B1`) placed into a later snapshot `(B2, H2)` whose base moved
 * and whose head was rebuilt on it, one thread per fate.
 */

const lines = (p: string, n: number) =>
	Array.from({ length: n }, (_, i) => `${p} ${i + 1}`);
const text = (l: string[]) => `${l.join("\n")}\n`;
const edit = (l: string[], at: Record<number, string | null | string[]>) =>
	text(
		l.flatMap((line, i) => {
			const e = at[i + 1];
			return e === undefined ? [line] : e === null ? [] : e;
		}),
	);

const A = lines("a", 20);
const OLD = lines("o", 10);
const MV = lines("m", 10);
const C = lines("c", 10);
const DEL = lines("d", 5);
const GONE = lines("g", 5);

let repo: GitFixture;
let B1: string;
let H1: string;
let B2: string;
let H2: string;
let target: Snapshot;

function commit(
	parent: string,
	files: Record<string, string>,
	opts: { delete?: string[]; rename?: Record<string, string> } = {},
): string {
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: repo.path,
			encoding: "utf8",
			env: testGitEnv(),
		}).trim();
	git("checkout", "--quiet", "--detach", parent);
	for (const name of opts.delete ?? []) rmSync(join(repo.path, name));
	for (const [from, to] of Object.entries(opts.rename ?? {})) {
		renameSync(join(repo.path, from), join(repo.path, to));
	}
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(repo.path, name), content);
	}
	git("add", "--all");
	git("commit", "--quiet", "--allow-empty", "-m", "step");
	return git("rev-parse", "HEAD");
}

beforeAll(async () => {
	repo = createGitFixture([
		{
			message: "base",
			files: {
				"a.ts": text(A),
				"old.ts": text(OLD),
				"mv.ts": text(MV),
				"c.ts": text(C),
				"del.ts": text(DEL),
			},
		},
	]);
	B1 = repo.shas[0] ?? "";
	H1 = commit(B1, {
		"a.ts": edit(A, {
			5: "a 5 x",
			10: "a 10 x",
			17: ["a 17", "a added"],
		}),
		"gone.ts": text(GONE),
		"old.ts": edit(OLD, { 3: "o 3 x" }),
		"mv.ts": edit(MV, { 3: "m 3 x" }),
		"c.ts": edit(C, { 4: "c 4 x" }),
		"del.ts": edit(DEL, { 2: "d 2 x" }),
	});
	// The base moves on: c.ts's line 3 changes.
	B2 = commit(B1, { "c.ts": edit(C, { 3: "c 3 base" }) });
	execFileSync("git", ["update-ref", "refs/heads/main", B2], {
		cwd: repo.path,
		env: testGitEnv(),
	});
	// The PR rebuilt on the new base: two lines on top of a.ts, line 5
	// rewritten, line 10 deleted, the added line gone again; gone.ts
	// dropped; old.ts renamed whole; mv.ts renamed without its line 3;
	// del.ts deleted.
	H2 = commit(
		B2,
		{
			"a.ts": text([
				"top 1",
				"top 2",
				...A.slice(0, 4),
				"a 5 y",
				...A.slice(5, 9),
				...A.slice(10),
			]),
			"new.ts": edit(OLD, { 3: "o 3 x" }),
			"mv2.ts": edit(MV, { 3: null }),
			"c.ts": edit(C, { 3: "c 3 base", 4: "c 4 x" }),
		},
		{ delete: ["old.ts", "mv.ts", "del.ts"] },
	);
	target = await buildSnapshot(repo.path, B2, H2);
});

afterAll(() => repo.cleanup());

let ids = 0;
function thread(
	path: string,
	anchor: Partial<CodeAnchor> | null,
	extra: Partial<ReviewThread> = {},
): ReviewThread {
	ids += 1;
	const line = anchor?.line ?? 1;
	const side = anchor?.side ?? "RIGHT";
	return {
		id: `T${ids}`,
		path,
		line: anchor ? line : null,
		currentLine: null,
		loaded: true,
		excerpt: "",
		html: "",
		body: "",
		createdAt: "2026-01-01T00:00:00Z",
		lastActivityAt: "2026-01-01T00:00:00Z",
		author: "rev",
		bot: false,
		avatarUrl: "",
		participants: [],
		commentCount: 1,
		hasReply: false,
		outdated: false,
		resolved: false,
		code: null,
		anchor: anchor && {
			path,
			commit: H1,
			side,
			line,
			startSide: side,
			startLine: line,
			at: "2099-01-01T00:00:00Z",
			...anchor,
		},
		commit: H1,
		subject: anchor ? "line" : "file",
		attention: [],
		yourTurn: false,
		viewerCan: { reply: false, resolve: false, unresolve: false },
		...extra,
	};
}

function placer() {
	const code = new ThreadCodeSource(repo.path, async () => true);
	return new ThreadPlacer(repo.path, code);
}

const base = () => ({ snapshot: B2, ref: "refs/heads/main" });

async function placeAll(
	threads: ReviewThread[],
	stored: Map<string, ThreadAnchorRef> = new Map(),
): Promise<Map<string, ThreadPlacement>> {
	const p = placer();
	const inputs = await p.inputs(target, threads, base());
	const placed = await p.place(target, inputs, stored);
	return new Map(placed.map((x) => [x.id, x.placement]));
}

describe("ThreadPlacer", () => {
	it("places threads made on H1 into (B2, H2): every fate", async () => {
		const ts = {
			placed: thread("a.ts", { line: 15 }),
			changed: thread("a.ts", { line: 5 }),
			deleted: thread("a.ts", { line: 10 }),
			reverted: thread("a.ts", { line: 18 }),
			gone: thread("gone.ts", { line: 2 }),
			fileGone: thread("del.ts", { line: 2 }),
			renamed: thread("old.ts", { line: 3 }),
			moved: thread("mv.ts", { line: 3 }),
			base: thread("c.ts", { line: 3, side: "LEFT", startSide: "LEFT" }),
			pastEnd: thread("a.ts", { line: 500 }),
			file: thread("old.ts", null),
		};
		const got = await placeAll(Object.values(ts));
		const of = (t: ReviewThread) => got.get(t.id);
		expect(of(ts.placed)).toEqual({
			kind: "placed",
			anchor: {
				path: "a.ts",
				startSide: "RIGHT",
				startLine: 16,
				side: "RIGHT",
				line: 16,
			},
			changed: false,
		});
		expect(of(ts.changed)).toEqual({
			kind: "changed",
			anchor: {
				path: "a.ts",
				startSide: "RIGHT",
				startLine: 7,
				side: "RIGHT",
				line: 7,
			},
			old: { side: "RIGHT", startLine: 5, line: 5, text: ["a 5 x"] },
		});
		expect(of(ts.deleted)).toEqual({
			kind: "unplaced",
			fate: "deleted",
			path: "a.ts",
			nearest: { side: "RIGHT", line: 11 },
		});
		expect(of(ts.reverted)).toMatchObject({
			kind: "unplaced",
			fate: "reverted",
			path: "a.ts",
		});
		expect(of(ts.gone)).toEqual({
			kind: "outside",
			path: "gone.ts",
			fate: "file-gone",
		});
		expect(of(ts.fileGone)).toEqual({
			kind: "unplaced",
			fate: "file-gone",
			path: "del.ts",
			nearest: null,
		});
		expect(of(ts.renamed)).toMatchObject({
			kind: "placed",
			anchor: { path: "new.ts", line: 3 },
		});
		expect(of(ts.moved)).toMatchObject({
			kind: "unplaced",
			fate: "moved",
			path: "mv2.ts",
			movedTo: "mv2.ts",
		});
		expect(of(ts.base)).toMatchObject({
			kind: "unplaced",
			fate: "base-changed",
			path: "c.ts",
		});
		expect(of(ts.pastEnd)).toMatchObject({
			kind: "unplaced",
			fate: "rewritten",
		});
		expect(of(ts.file)).toEqual({ kind: "file", path: "new.ts" });
	});

	it("skips resolved threads, deleted ones and those without an id", async () => {
		const open = thread("a.ts", { line: 15 });
		const resolved = thread("a.ts", { line: 15 }, { resolved: true });
		const deleted = thread("a.ts", { line: 15 }, { unavailable: "deleted" });
		const noId = thread("a.ts", { line: 15 }, { id: "" });
		expect(placeable([open, resolved, deleted, noId])).toEqual([open]);
		const got = await placeAll([open, resolved]);
		expect([...got.keys()]).toEqual([open.id]);
	});

	it("a thread on the target's own head and base is placed where it is", async () => {
		const own = thread("a.ts", { line: 7, commit: H2 }, { commit: H2 });
		const got = await placeAll([own]);
		expect(got.get(own.id)).toMatchObject({
			kind: "placed",
			anchor: { path: "a.ts", line: 7 },
		});
	});

	it("a thread on a commit git can't give is never placed", async () => {
		const lost = thread(
			"a.ts",
			{ line: 7, commit: "f".repeat(40) },
			{ commit: "f".repeat(40) },
		);
		const p = new ThreadPlacer(
			repo.path,
			new ThreadCodeSource(repo.path, async () => false),
		);
		const [placed] = await p.place(
			target,
			await p.inputs(target, [lost], base()),
			new Map(),
		);
		expect(placed?.placement).toMatchObject({
			kind: "unplaced",
			fate: "rewritten",
		});
	});

	it("a stored placement wins when it fits the snapshot; a stale one is ignored", async () => {
		const t = thread("a.ts", { line: 10 });
		const fits: ThreadAnchorRef = {
			path: "c.ts",
			startSide: "RIGHT",
			startLine: 4,
			side: "RIGHT",
			line: 4,
		};
		expect((await placeAll([t], new Map([[t.id, fits]]))).get(t.id)).toEqual({
			kind: "placed",
			anchor: fits,
			changed: false,
		});
		for (const stale of [
			{ ...fits, line: 11, startLine: 11 },
			{ ...fits, path: "nowhere.ts" },
			{ ...fits, path: "gone.ts" },
		]) {
			expect(
				(await placeAll([t], new Map([[t.id, stale]]))).get(t.id),
				stale.path,
			).toMatchObject({ kind: "unplaced", fate: "deleted" });
		}
	});

	it("line counts: a file's head lines on the right, its base's on the left, none for a path that is no file", async () => {
		const p = placer();
		expect(await p.lineCount(target, "a.ts", "RIGHT")).toBe(21);
		expect(await p.lineCount(target, "a.ts", "LEFT")).toBe(20);
		expect(await p.lineCount(target, "new.ts", "LEFT")).toBe(10);
		expect(await p.lineCount(target, "del.ts", "RIGHT")).toBeNull();
		expect(await p.lineCount(target, "nowhere.ts", "RIGHT")).toBeNull();
	});
});
