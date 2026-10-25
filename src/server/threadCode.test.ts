import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createGitFixture, testGitEnv } from "../../test/git-fixture";
import type { CodeAnchor, CodeRow, PrOverview } from "../shared/types";
import { hunkWindowRows } from "./codeWindow";
import { runGit } from "./git.js";

// Pass-through spy, so a test can count the git calls.
vi.mock("./git.js", async (importOriginal) => {
	const git = await importOriginal<typeof import("./git.js")>();
	return { ...git, runGit: vi.fn(git.runGit) };
});

import { type DiffBase, ThreadCodeSource } from "./threadCode";

const numbered = (n: number, tag = "") =>
	`${Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join("\n")}\n`;

// base: a.txt 1..20, keep.txt, old-name.txt and the look-alike i.tsx/ab.ts;
// then the PR edits a.txt (line 10 replaced, two lines added after 15),
// adds new.txt and files whose names are pathspec magic, renames
// old-name.txt, and edits the look-alikes too.
const fx = createGitFixture([
	{
		message: "base",
		files: {
			"a.txt": numbered(20),
			"keep.txt": numbered(5),
			"old-name.txt": numbered(12, " moved"),
			"i.tsx": numbered(3, " plain i"),
			"ab.ts": numbered(3, " plain ab"),
		},
	},
	{
		message: "pr",
		rename: { "old-name.txt": "new-name.txt" },
		files: {
			"a.txt": numbered(20)
				.replace("line 10\n", "line 10 changed\n")
				.replace("line 15\n", "line 15\nadded 1\nadded 2\n"),
			"new.txt": numbered(12, " new"),
			"new-name.txt": numbered(12, " moved").replace(
				"line 3 moved",
				"line 3 moved, edited",
			),
			"[id].tsx": numbered(3, " bracket"),
			"i.tsx": numbered(3, " plain i, edited"),
			"a*.ts": numbered(3, " star"),
			"ab.ts": numbered(3, " plain ab, edited"),
			"a?.ts": numbered(3, " question"),
		},
	},
]);
afterAll(() => fx.cleanup());
const [base, head] = fx.shas as [string, string];
const git = (...args: string[]) =>
	execFileSync("git", args, {
		cwd: fx.path,
		encoding: "utf8",
		env: testGitEnv(),
	}).trim();
// A commit force-pushed away: a.txt's line 3 edited on top of base, then
// left behind (no branch has it).
const droppedA = (() => {
	const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
		cwd: fx.path,
		encoding: "utf8",
		env: testGitEnv(),
		input: numbered(20).replace("line 3\n", "line 3 then\n"),
	}).trim();
	const tree = execFileSync("git", ["mktree"], {
		cwd: fx.path,
		encoding: "utf8",
		env: testGitEnv(),
		input: `100644 blob ${blob}\ta.txt\n`,
	}).trim();
	return git("commit-tree", tree, "-p", base, "-m", "dropped a.txt");
})();

const now = () => new Date().toISOString();
const at = (partial: Partial<CodeAnchor>): CodeAnchor => ({
	path: "a.txt",
	commit: head,
	side: "RIGHT",
	line: 1,
	startSide: "RIGHT",
	startLine: 1,
	at: now(),
	...partial,
});
const BASE: DiffBase = { snapshot: base, ref: base };

/** Rows as "> old/new text", ">" when marked. */
const shown = (rows: CodeRow[] | null) =>
	rows?.map(
		(l) =>
			`${l.marked ? ">" : " "}${l.oldNo ?? "."}/${l.newNo ?? "."} ${l.text}`,
	) ?? null;

const source = () => new ThreadCodeSource(fx.path);

describe("ThreadCodeSource.window", () => {
	it("shows a changed line with three rows of the PR's diff before and after", async () => {
		expect(
			shown(await source().window(at({ startLine: 10, line: 10 }), BASE)),
		).toEqual([
			" 8/8 line 8",
			" 9/9 line 9",
			" 10/. line 10",
			">./10 line 10 changed",
			" 11/11 line 11",
			" 12/12 line 12",
			" 13/13 line 13",
		]);
	});

	it("clips the context at the file's first and last lines", async () => {
		const s = source();
		expect(
			shown(
				await s.window(at({ path: "new.txt", line: 1, startLine: 1 }), BASE),
			),
		).toEqual([
			">./1 line 1 new",
			" ./2 line 2 new",
			" ./3 line 3 new",
			" ./4 line 4 new",
		]);
		expect(
			shown(
				await s.window(at({ path: "new.txt", line: 12, startLine: 11 }), BASE),
			),
		).toEqual([
			" ./8 line 8 new",
			" ./9 line 9 new",
			" ./10 line 10 new",
			">./11 line 11 new",
			">./12 line 12 new",
		]);
	});

	it("marks a multi-line range whole, numbered as in the file on each side", async () => {
		const rows = await source().window(at({ startLine: 16, line: 18 }), BASE);
		expect(shown(rows)).toEqual([
			" 13/13 line 13",
			" 14/14 line 14",
			" 15/15 line 15",
			">./16 added 1",
			">./17 added 2",
			">16/18 line 16",
			" 17/19 line 17",
			" 18/20 line 18",
			" 19/21 line 19",
		]);
	});

	it("finds a deleted-side line by its old number when the base then was the same", async () => {
		const left = at({
			side: "LEFT",
			startSide: "LEFT",
			line: 10,
			startLine: 10,
		});
		expect(shown(await source().window(left, BASE))).toEqual([
			" 7/7 line 7",
			" 8/8 line 8",
			" 9/9 line 9",
			">10/. line 10",
			" ./10 line 10 changed",
			" 11/11 line 11",
			" 12/12 line 12",
		]);
	});

	it("shows the old side only when the base branch as it stood then gives the same one", async () => {
		const s = source();
		const left = at({
			side: "LEFT",
			startSide: "LEFT",
			line: 10,
			startLine: 10,
		});
		// No base commit by then, or no time: no code.
		expect(
			await s.window({ ...left, at: "2000-01-01T00:00:00Z" }, BASE),
		).toBeNull();
		expect(await s.window({ ...left, at: "" }, BASE)).toBeNull();
		// A range only starting on the old side counts too.
		expect(
			await s.window(
				at({ startSide: "LEFT", startLine: 10, line: 10, at: "" }),
				BASE,
			),
		).toBeNull();
		// Lenient takes a range wholly on the new side anyway; never the old.
		expect(
			shown(
				await s.window(at({ line: 10, startLine: 10, at: "" }), BASE, true),
			)?.find((r) => r.startsWith(">")),
		).toBe(">./10 line 10 changed");
		expect(await s.window({ ...left, at: "" }, BASE, true)).toBeNull();
	});

	it("shows a comment on a commit no longer in the PR as it was there", async () => {
		const rows = await source().window(
			at({ commit: droppedA, line: 3, startLine: 3 }),
			BASE,
		);
		expect(shown(rows)).toEqual([
			" 1/1 line 1",
			" 2/2 line 2",
			" 3/. line 3",
			">./3 line 3 then",
			" 4/4 line 4",
			" 5/5 line 5",
			" 6/6 line 6",
		]);
		// Not in the clone and not to be had: no code.
		const fetchCommit = vi.fn(async () => false);
		const s = new ThreadCodeSource(fx.path, fetchCommit);
		expect(await s.window(at({ commit: "d".repeat(40) }), BASE)).toBeNull();
		expect(fetchCommit).toHaveBeenCalledTimes(1);
	});

	it("shows an unchanged file's lines as context", async () => {
		expect(
			shown(
				await source().window(
					at({ path: "keep.txt", line: 3, startLine: 3 }),
					BASE,
				),
			),
		).toEqual([
			" 1/1 line 1",
			" 2/2 line 2",
			">3/3 line 3",
			" 4/4 line 4",
			" 5/5 line 5",
		]);
	});

	it("takes paths literally: brackets, * and ? never match another file", async () => {
		const s = source();
		for (const [path, tag] of [
			["[id].tsx", " bracket"],
			["i.tsx", " plain i"],
			["a*.ts", " star"],
			["a?.ts", " question"],
			["ab.ts", " plain ab"],
		] as const) {
			const rows =
				(await s.window(at({ path, line: 2, startLine: 2 }), BASE)) ?? [];
			expect(
				rows
					.filter((r) => r.marked)
					.map((r) => r.text)
					.join(),
				path,
			).toContain(`line 2${tag}`);
			// Only this file's lines: a pattern would have pulled in others.
			for (const row of rows) expect(row.text, path).toContain(tag);
		}
	});

	it("gives up on a renamed file rather than show it all added", async () => {
		const s = source();
		expect(
			await s.window(at({ path: "new-name.txt", line: 3, startLine: 3 }), BASE),
		).toBeNull();
		expect(
			await s.window(
				at({
					path: "old-name.txt",
					side: "LEFT",
					startSide: "LEFT",
					line: 3,
					startLine: 3,
				}),
				BASE,
			),
		).toBeNull();
	});

	it("gives up when either end of the range, the file, the commit or the merge base is missing", async () => {
		const s = source();
		expect(await s.window(at({ line: 99, startLine: 99 }), BASE)).toBeNull();
		// The end is there but not the start: never a shrunken range.
		expect(await s.window(at({ startLine: 12, line: 10 }), BASE)).toBeNull();
		expect(await s.window(at({ path: "gone.txt" }), BASE)).toBeNull();
		expect(await s.window(at({ commit: "" }), BASE)).toBeNull();
		// No merge base with an unknown base: no code, not a guess.
		expect(
			await s.window(at({}), { snapshot: "e".repeat(40), ref: base }),
		).toBeNull();
	});
});

describe("ThreadCodeSource.fill", () => {
	const thread = (
		path: string,
		code: PrOverview["threads"][number]["code"],
	): PrOverview["threads"][number] => ({
		path,
		line: code?.anchor.line ?? null,
		currentLine: null,
		excerpt: "",
		html: "",
		body: "",
		createdAt: "",
		lastActivityAt: "",
		author: "rev1",
		bot: false,
		commentCount: 1,
		hasReply: false,
		outdated: false,
		resolved: false,
		code,
	});
	/** As GitHub's adapter makes it: the anchor and GitHub's own hunk. */
	const hosted = (anchor: CodeAnchor, hunk = "") => ({
		anchor,
		rows: hunkWindowRows(hunk, anchor),
		source: "github" as const,
	});
	const overview = (threads: PrOverview["threads"]) =>
		({ threads }) as PrOverview;

	it("builds every thread's code from the clone, GitHub's hunk or not", async () => {
		const withHunk = hosted(
			at({ path: "new.txt", line: 2, startLine: 2 }),
			"@@ -0,0 +1,2 @@\n+line 1 new\n+line 2 new",
		);
		const filled = await source().fill(
			overview([
				thread("new.txt", withHunk),
				thread(
					"new.txt",
					hosted(at({ path: "new.txt", line: 5, startLine: 5 })),
				),
				thread("a.txt", null),
			]),
			BASE,
		);
		const [a, b, c] = filled.threads;
		expect(a?.code?.source).toBe("clone");
		expect(shown(a?.code?.rows ?? null)).toEqual([
			" ./1 line 1 new",
			">./2 line 2 new",
			" ./3 line 3 new",
			" ./4 line 4 new",
			" ./5 line 5 new",
		]);
		expect(b?.code?.source).toBe("clone");
		expect(c?.code).toBeNull();
	});

	it("keeps GitHub's hunk, marked as GitHub's, when the clone can't give the code", async () => {
		const renamed = hosted(
			at({ path: "new-name.txt", line: 3, startLine: 3 }),
			"@@ -0,0 +1,3 @@\n+line 1 moved\n+line 2 moved\n+line 3 moved, edited",
		);
		const filled = await source().fill(
			overview([
				thread("new-name.txt", renamed),
				// Neither: no hunk, and the clone can't (a rename).
				thread(
					"new-name.txt",
					hosted(at({ path: "new-name.txt", line: 3, startLine: 3 })),
				),
			]),
			BASE,
		);
		expect(filled.threads[0]?.code).toBe(renamed);
		expect(filled.threads[0]?.code?.source).toBe("github");
		expect(filled.threads[1]?.code).toBeNull();
	});

	it("falls back to a hunkless new-side range's own commit when the base then is unknown", async () => {
		const filled = await source().fill(
			overview([
				thread(
					"new.txt",
					hosted(at({ path: "new.txt", line: 2, startLine: 2, at: "" })),
				),
				thread(
					"a.txt",
					hosted(
						at({
							side: "LEFT",
							startSide: "LEFT",
							line: 10,
							startLine: 10,
							at: "",
						}),
					),
				),
			]),
			BASE,
		);
		expect(filled.threads[0]?.code?.source).toBe("clone");
		expect(filled.threads[1]?.code).toBeNull();
	});

	it("asks for a commit it can't get once, until its failures are forgotten (a Refresh)", async () => {
		const fetchCommit = vi.fn(async () => false);
		const s = new ThreadCodeSource(fx.path, fetchCommit);
		const lost = "d".repeat(40);
		const ov = overview(
			Array.from({ length: 9 }, (_, i) =>
				thread(
					`f${i}.txt`,
					hosted(at({ commit: lost, line: i + 1, startLine: i + 1 })),
				),
			),
		);
		const filled = await s.fill(ov, BASE);
		expect(filled.threads.every((t) => t.code === null)).toBe(true);
		await s.fill(ov, BASE);
		expect(fetchCommit).toHaveBeenCalledTimes(1);
		s.forgetFailures();
		await s.fill(ov, BASE);
		expect(fetchCommit).toHaveBeenCalledTimes(2);
	});

	it("reads git once for the same code: a second fill is served from the cache", async () => {
		const fetchCommit = vi.fn(async () => true);
		const s = new ThreadCodeSource(fx.path, fetchCommit);
		const ov = overview([
			thread("a.txt", hosted(at({ line: 10, startLine: 10 }))),
			thread("a.txt", hosted(at({ line: 18, startLine: 16 }))),
		]);
		const first = await s.fill(ov, BASE);
		expect(first.threads.every((t) => t.code?.source === "clone")).toBe(true);
		vi.mocked(runGit).mockClear();
		const again = await s.fill(ov, BASE);
		expect(again.threads.map((t) => t.code?.rows)).toEqual(
			first.threads.map((t) => t.code?.rows),
		);
		expect(runGit).not.toHaveBeenCalled();
		expect(fetchCommit).toHaveBeenCalledTimes(1);
		// Forgetting failures keeps what succeeded.
		s.forgetFailures();
		await s.fill(ov, BASE);
		expect(fetchCommit).toHaveBeenCalledTimes(1);
	});
});
