import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createGitFixture, testGitEnv } from "../../test/git-fixture";
import type { CodeAnchor, CodeRow, CodeWindow } from "../shared/types";
import { runGit } from "./git.js";

// Pass-through spy, so a test can count the git calls.
vi.mock("./git.js", async (importOriginal) => {
	const git = await importOriginal<typeof import("./git.js")>();
	return { ...git, runGit: vi.fn(git.runGit) };
});

import { type DiffBase, Memo, ThreadCodeSource } from "./threadCode";

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
			"as-is.txt": numbered(6, " as is"),
			"crlf.txt": "one\r\ntwo\r\nthree\r\n",
			"eof.txt": "a\nb",
			"i.tsx": numbered(3, " plain i"),
			"ab.ts": numbered(3, " plain ab"),
		},
	},
	{
		message: "pr",
		// One rename with an edit, one with none.
		rename: { "old-name.txt": "new-name.txt", "as-is.txt": "moved-as-is.txt" },
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
			"crlf.txt": "one\r\nTWO\r\nthree\r\n",
			"eof.txt": "a\nB",
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

	it("diffs a renamed file against its old path, as the whole diff pairs them", async () => {
		const s = source();
		const edited = [
			" 1/1 line 1 moved",
			" 2/2 line 2 moved",
			" 3/. line 3 moved",
			">./3 line 3 moved, edited",
			" 4/4 line 4 moved",
			" 5/5 line 5 moved",
			" 6/6 line 6 moved",
		];
		expect(
			shown(
				await s.window(
					at({ path: "new-name.txt", line: 3, startLine: 3 }),
					BASE,
				),
			),
		).toEqual(edited);
		// The old side of the renamed file, by the new path (as GitHub names it).
		expect(
			shown(
				await s.window(
					at({
						path: "new-name.txt",
						side: "LEFT",
						startSide: "LEFT",
						line: 3,
						startLine: 3,
					}),
					BASE,
				),
			)?.find((r) => r.startsWith(">")),
		).toBe(">3/. line 3 moved");
		// Renamed with no change: the file as context.
		expect(
			shown(
				await s.window(
					at({ path: "moved-as-is.txt", line: 2, startLine: 2 }),
					BASE,
				),
			),
		).toEqual([
			" 1/1 line 1 as is",
			">2/2 line 2 as is",
			" 3/3 line 3 as is",
			" 4/4 line 4 as is",
			" 5/5 line 5 as is",
		]);
		// The old path alone isn't in the PR's new side: no code.
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

describe("ThreadCodeSource.code", () => {
	/** A comment: its anchor and GitHub's own hunk ("" for none). */
	const comment = (anchor: CodeAnchor, hunk = "") => ({ anchor, hunk });
	/** Every comment's code, as a read builds them. */
	const fill = (
		s: ThreadCodeSource,
		comments: ReturnType<typeof comment>[],
	): Promise<(CodeWindow | null)[]> =>
		Promise.all(
			comments.map((c) => s.code(c.anchor, BASE, async () => c.hunk)),
		);

	it("builds every comment's code from the clone, GitHub's hunk or not, checking it against the hunk", async () => {
		const hostHunk = vi.fn(
			async () => "@@ -0,0 +1,2 @@\n+line 1 new\n+line 2 new",
		);
		const s = source();
		const a = await s.code(
			at({ path: "new.txt", line: 2, startLine: 2 }),
			BASE,
			hostHunk,
		);
		expect(a?.source).toBe("clone");
		expect(shown(a?.rows ?? null)).toEqual([
			" ./1 line 1 new",
			">./2 line 2 new",
			" ./3 line 3 new",
			" ./4 line 4 new",
			" ./5 line 5 new",
		]);
		// The hunk is a run of the PR's diff, ending on the line.
		expect(hostHunk).toHaveBeenCalledOnce();
		expect(a?.snapshot).toEqual({ same: true });
		const [b] = await fill(s, [
			comment(at({ path: "new.txt", line: 5, startLine: 5 })),
		]);
		expect(b?.source).toBe("clone");
		// Nothing to check it against.
		expect(b?.snapshot).toEqual({ same: false, reason: "no-host-diff" });
	});

	it("flags code that isn't the diff the comment was made on", async () => {
		const line10 = at({ line: 10, startLine: 10 });
		const [same, sinceReview, otherNumbers, unchanged, broken] = await fill(
			source(),
			[
				// The PR's own diff: three rows of context, the edit.
				comment(
					line10,
					"@@ -7,7 +7,7 @@\n line 7\n line 8\n line 9\n-line 10\n+line 10 changed",
				),
				// "Changes since your last review": another old side, where
				// line 10 had been edited once already.
				comment(
					line10,
					"@@ -7,7 +7,7 @@\n line 7\n line 8\n line 9\n-line 10 first try\n+line 10 changed",
				),
				// The same lines, numbered as in another diff.
				comment(
					line10,
					"@@ -8,7 +8,7 @@\n line 7\n line 8\n line 9\n-line 10\n+line 10 changed",
				),
				// A view where the line's neighbour is new too.
				comment(
					line10,
					"@@ -7,6 +7,7 @@\n line 7\n line 8\n+line 9\n-line 10\n+line 10 changed",
				),
				// A hunk that doesn't hold the commented line.
				comment(line10, "@@ -7,3 +7,3 @@\n line 7\n line 8\n line 9"),
			],
		);
		expect(same?.snapshot).toEqual({ same: true });
		for (const c of [sinceReview, otherNumbers, unchanged, broken]) {
			expect(c?.source).toBe("clone");
			expect(c?.snapshot).toEqual({ same: false, reason: "diff-differs" });
		}
		// An unchanged file shown whole as context, commented as added.
		const [cr] = await fill(source(), [
			comment(
				at({ path: "keep.txt", line: 2, startLine: 2 }),
				"@@ -0,0 +1,2 @@\n+line 1\n+line 2",
			),
		]);
		expect(cr?.rows.every((r) => r.kind === "context")).toBe(true);
		expect(cr?.snapshot).toEqual({ same: false, reason: "diff-differs" });
	});

	it("checks CRLF lines and a last line without a newline as GitHub keeps them", async () => {
		const [crlf, eof] = await fill(source(), [
			// GitHub keeps each line's CR, as git does.
			comment(
				at({ path: "crlf.txt", line: 2, startLine: 2 }),
				"@@ -1,3 +1,3 @@\n one\r\n-two\r\n+TWO\r",
			),
			// Its hunk stops at the commented line, before the marker.
			comment(
				at({ path: "eof.txt", line: 2, startLine: 2 }),
				"@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B",
			),
		]);
		expect(crlf?.rows.find((r) => r.marked)?.text).toBe("TWO\r");
		expect(crlf?.snapshot).toEqual({ same: true });
		expect(eof?.rows.at(-1)).toMatchObject({ text: "B", noNewline: true });
		expect(eof?.snapshot).toEqual({ same: true });
	});

	it("counts a hunk that can't be read as none", async () => {
		const c = await source().code(
			at({ line: 10, startLine: 10 }),
			BASE,
			async () => {
				throw new Error("gone");
			},
		);
		expect(c?.source).toBe("clone");
		expect(c?.snapshot).toEqual({ same: false, reason: "no-host-diff" });
	});

	it("takes GitHub's hunk, marked as GitHub's, when the clone can't give the code", async () => {
		// A path that isn't at the comment's commit (GitHub names today's).
		const anchor = at({ path: "elsewhere.txt", line: 3, startLine: 3 });
		const [hosted, neither] = await fill(source(), [
			comment(anchor, "@@ -0,0 +1,3 @@\n+line 1\n+line 2\n+line 3"),
			// Neither: no hunk, and the clone can't.
			comment(anchor),
		]);
		expect(hosted?.source).toBe("github");
		// The host's hunk is the commenter's own view.
		expect(hosted?.snapshot).toEqual({ same: true });
		expect(shown(hosted?.rows ?? null)).toEqual([
			" ./1 line 1",
			" ./2 line 2",
			">./3 line 3",
		]);
		expect(neither).toBeNull();
	});

	it("falls back to a hunkless new-side range's own commit when the base then is unknown", async () => {
		const [right, left] = await fill(source(), [
			comment(at({ path: "new.txt", line: 2, startLine: 2, at: "" })),
			comment(
				at({
					side: "LEFT",
					startSide: "LEFT",
					line: 10,
					startLine: 10,
					at: "",
				}),
			),
		]);
		expect(right?.source).toBe("clone");
		// Nothing vouches for it.
		expect(right?.snapshot).toEqual({ same: false, reason: "no-host-diff" });
		expect(left).toBeNull();
	});

	it("asks for a commit it can't get once, until its failures are forgotten (a Refresh)", async () => {
		const fetchCommit = vi.fn(async () => false);
		const s = new ThreadCodeSource(fx.path, fetchCommit);
		const lost = "d".repeat(40);
		const comments = Array.from({ length: 9 }, (_, i) =>
			comment(
				at({ path: `f${i}.txt`, commit: lost, line: i + 1, startLine: i + 1 }),
			),
		);
		expect((await fill(s, comments)).every((c) => c === null)).toBe(true);
		await fill(s, comments);
		expect(fetchCommit).toHaveBeenCalledTimes(1);
		s.forgetFailures();
		await fill(s, comments);
		expect(fetchCommit).toHaveBeenCalledTimes(2);
	});

	it("reads git once for the same code: a second build is served from the cache", async () => {
		const fetchCommit = vi.fn(async () => true);
		const s = new ThreadCodeSource(fx.path, fetchCommit);
		const comments = [
			comment(at({ line: 10, startLine: 10 })),
			comment(at({ line: 18, startLine: 16 })),
		];
		const first = await fill(s, comments);
		expect(first.every((c) => c?.source === "clone")).toBe(true);
		vi.mocked(runGit).mockClear();
		const again = await fill(s, comments);
		expect(again.map((c) => c?.rows)).toEqual(first.map((c) => c?.rows));
		expect(runGit).not.toHaveBeenCalled();
		expect(fetchCommit).toHaveBeenCalledTimes(1);
		// Forgetting failures keeps what succeeded.
		s.forgetFailures();
		await fill(s, comments);
		expect(fetchCommit).toHaveBeenCalledTimes(1);
	});
});

describe("Memo", () => {
	it("makes each answer once, and keeps at most max, dropping the least recently used", async () => {
		const memo = new Memo<string>(() => false, 2);
		const make = vi.fn(async () => "x");
		await memo.get("a", make);
		await memo.get("b", make);
		// a is now the most recent.
		await memo.get("a", make);
		expect(make).toHaveBeenCalledTimes(2);
		// Drops b.
		await memo.get("c", make);
		expect(memo.size).toBe(2);
		await memo.get("a", make);
		expect(make).toHaveBeenCalledTimes(3);
		await memo.get("b", make);
		expect(make).toHaveBeenCalledTimes(4);
	});

	it("keeps a failure until its failures are forgotten", async () => {
		const memo = new Memo<string | null>((v) => v === null, 10);
		const make = vi.fn(async () => null);
		await memo.get("a", make);
		await memo.get("a", make);
		expect(make).toHaveBeenCalledTimes(1);
		memo.forgetFailures();
		await memo.get("a", make);
		expect(make).toHaveBeenCalledTimes(2);
	});
});
