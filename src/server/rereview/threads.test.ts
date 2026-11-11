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
import type { AgentAnchor } from "../../shared/agent";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import type {
	CodeAnchor,
	ReviewThread,
	Snapshot,
	ThreadAnchorRef,
} from "../../shared/types";
import { buildSnapshot } from "../diff/snapshot";
import { ThreadCodeSource } from "../threadCode";
import { placeAgentThreads, placeable, ThreadPlacer } from "./threads";

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
			now: ["a 5 y"],
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

	it("an old-side thread dated before the base branch's history still traces from its merge base", async () => {
		// The code pane can't vouch for its old side (no base commit by
		// then); placement takes the merge base and follows the base's changes.
		const early = thread("c.ts", {
			line: 3,
			side: "LEFT",
			startSide: "LEFT",
			at: "2000-01-01T00:00:00Z",
		});
		const got = await placeAll([early]);
		expect(got.get(early.id)).toMatchObject({
			kind: "unplaced",
			fate: "base-changed",
		});
	});

	it("places resolved threads too; skips deleted ones and those without an id", async () => {
		const open = thread("a.ts", { line: 15 });
		const resolved = thread("a.ts", { line: 15 }, { id: "R", resolved: true });
		const deleted = thread("a.ts", { line: 15 }, { unavailable: "deleted" });
		const noId = thread("a.ts", { line: 15 }, { id: "" });
		expect(placeable([open, resolved, deleted, noId])).toEqual([
			open,
			resolved,
		]);
		const got = await placeAll([open, resolved]);
		expect([...got.keys()].sort()).toEqual([open.id, "R"].sort());
		expect(got.get("R")?.kind).toBe(got.get(open.id)?.kind);
	});

	it("a thread on the target's own head and base is placed where it is", async () => {
		const own = thread("a.ts", { line: 7, commit: H2 }, { commit: H2 });
		const got = await placeAll([own]);
		expect(got.get(own.id)).toMatchObject({
			kind: "placed",
			anchor: { path: "a.ts", line: 7 },
		});
	});

	it("a thread on a commit git can't give, with no line from GitHub, is never placed", async () => {
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
		expect(placed?.placement).toEqual({
			kind: "unplaced",
			fate: "untraced",
			path: "a.ts",
			nearest: null,
		});
	});

	describe("nothing of its own to trace from: GitHub's line (CAR-116)", () => {
		/** A thread on `commit` that GitHub puts on `currentLine` of the PR's head. */
		const untraceable = (
			commit: string,
			currentLine: number | null,
			extra: Partial<ReviewThread> = {},
		) => thread("a.ts", { line: 3, commit }, { commit, currentLine, ...extra });

		async function placeFrom(
			threads: ReviewThread[],
			githubHead: string | undefined,
			/** The commits the clone can't have. */
			lost: string[] = [],
		) {
			const p = new ThreadPlacer(
				repo.path,
				new ThreadCodeSource(repo.path, async (_r, oid) => !lost.includes(oid)),
			);
			// The head comes with the threads' lines, in the same answer.
			const read = threads.map((t) =>
				githubHead ? { ...t, currentHead: githubHead } : t,
			);
			const inputs = await p.inputs(target, read, base());
			const placed = await p.place(target, inputs, new Map());
			return new Map(placed.map((x) => [x.id, x.placement]));
		}

		const onLine = (line: number, path = "a.ts") => ({
			kind: "placed",
			anchor: {
				path,
				startSide: "RIGHT",
				startLine: line,
				side: "RIGHT",
				line,
			},
			changed: false,
			source: "github",
		});

		it("no commit (GitHub gave no originalCommit): on GitHub's line", async () => {
			const t = untraceable("", 9);
			expect((await placeFrom([t], H2)).get(t.id)).toEqual(onLine(9));
		});

		it("a commit git can't fetch (force-pushed away): on GitHub's line", async () => {
			const t = untraceable("f".repeat(40), 9);
			expect((await placeFrom([t], H2, ["f".repeat(40)])).get(t.id)).toEqual(
				onLine(9),
			);
		});

		it("a commit with no merge base with the base (unrelated history): on GitHub's line", async () => {
			const git = (...args: string[]) =>
				execFileSync("git", args, {
					cwd: repo.path,
					encoding: "utf8",
					env: testGitEnv(),
				}).trim();
			const orphan = git("commit-tree", `${H1}^{tree}`, "-m", "orphan");
			const t = untraceable(orphan, 9);
			expect((await placeFrom([t], H2)).get(t.id)).toEqual(onLine(9));
		});

		it("GitHub's head is another snapshot: traced from there; only the same text places", async () => {
			// On H1, a.ts line 15 is H2's 16; line 5 was rewritten.
			const same = untraceable("", 15);
			const rewritten = untraceable("", 5);
			const got = await placeFrom([same, rewritten], H1);
			expect(got.get(same.id)).toEqual(onLine(16));
			expect(got.get(rewritten.id)).toMatchObject({
				kind: "unplaced",
				fate: "untraced",
				path: "a.ts",
			});
		});

		it("a file comment with no commit follows its file from GitHub's head", async () => {
			const t = thread("old.ts", null, { commit: "" });
			expect((await placeFrom([t], H1)).get(t.id)).toEqual({
				kind: "file",
				path: "new.ts",
			});
		});

		it("GitHub gives no line: outdated when it says so, else untraced; under the file either way", async () => {
			const outdated = untraceable("", null, { outdated: true });
			const asOf = untraceable("", null);
			const noHead = untraceable("", 9);
			const lostHead = untraceable("", 9);
			const got = await placeFrom([outdated, asOf], H2);
			expect(got.get(outdated.id)).toEqual({
				kind: "unplaced",
				fate: "outdated",
				path: "a.ts",
				nearest: null,
			});
			expect(got.get(asOf.id)).toMatchObject({
				kind: "unplaced",
				fate: "untraced",
			});
			// No head from GitHub, or one git can't give.
			expect(
				(await placeFrom([noHead], undefined)).get(noHead.id),
			).toMatchObject({ kind: "unplaced", fate: "untraced" });
			expect(
				(await placeFrom([lostHead], H2, [H2])).get(lostHead.id),
			).toMatchObject({ kind: "unplaced", fate: "untraced" });
		});

		it("an old-side line from GitHub is never taken (its merge base may not be ours): untraced", async () => {
			const t = thread(
				"c.ts",
				{ line: 3, side: "LEFT", startSide: "LEFT", commit: "" },
				{ commit: "", currentLine: 3 },
			);
			expect((await placeFrom([t], H2)).get(t.id)).toEqual({
				kind: "unplaced",
				fate: "untraced",
				path: "c.ts",
				nearest: null,
			});
		});

		it("a thread its own commit traces is never moved to GitHub's line", async () => {
			const t = thread("a.ts", { line: 15 }, { currentLine: 2 });
			expect((await placeFrom([t], H2)).get(t.id)).toEqual({
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

describe("placeAgentThreads", () => {
	const asked = (
		id: string,
		anchor: Partial<AgentAnchor> & { path: string },
	) => ({
		id,
		at: "2026-01-01T00:00:00Z",
		anchor: {
			subject: "line",
			commit: H1,
			side: "RIGHT",
			line: 1,
			startSide: "RIGHT",
			startLine: 1,
			...anchor,
		} as AgentAnchor,
	});

	it("traces an agent thread asked on PS1 onto PS2's moved line, like a comment", async () => {
		const got = await placeAgentThreads(
			placer(),
			target,
			[asked("A1", { path: "a.ts", line: 15, startLine: 15 })],
			base(),
		);
		expect(got).toEqual([
			{
				id: "A1",
				placement: {
					kind: "placed",
					anchor: {
						path: "a.ts",
						startSide: "RIGHT",
						startLine: 16,
						side: "RIGHT",
						line: 16,
					},
					changed: false,
				},
			},
		]);
	});

	it("one whose line was deleted is unplaced with its fate; a file question follows its file", async () => {
		const got = await placeAgentThreads(
			placer(),
			target,
			[
				asked("A2", { path: "a.ts", line: 10, startLine: 10 }),
				{
					id: "A3",
					at: "2026-01-01T00:00:00Z",
					anchor: { subject: "file", path: "old.ts", commit: H1 },
				},
			],
			base(),
		);
		expect(new Map(got.map((p) => [p.id, p.placement]))).toEqual(
			new Map<string, ThreadPlacement>([
				[
					"A2",
					{
						kind: "unplaced",
						fate: "deleted",
						path: "a.ts",
						nearest: { side: "RIGHT", line: 11 },
					},
				],
				["A3", { kind: "file", path: "new.ts" }],
			]),
		);
	});

	it("a thread whose tracing fails is left out (the page keeps it where it was asked), the others placed", async () => {
		const code = new ThreadCodeSource(repo.path, async () => true);
		const broken = "e".repeat(40);
		const endpoints = code.endpoints.bind(code);
		vi.spyOn(code, "endpoints").mockImplementation((anchor, b) =>
			anchor.commit === broken
				? Promise.reject(new Error("git broke"))
				: endpoints(anchor, b),
		);
		const got = await placeAgentThreads(
			new ThreadPlacer(repo.path, code),
			target,
			[
				asked("BAD", { path: "a.ts", line: 15, startLine: 15, commit: broken }),
				asked("OK", { path: "a.ts", line: 15, startLine: 15 }),
			],
			base(),
		);
		expect(got.map((p) => p.id)).toEqual(["OK"]);
	});
});
