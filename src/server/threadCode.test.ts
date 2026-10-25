import { afterAll, describe, expect, it, vi } from "vitest";
import { createGitFixture } from "../../test/git-fixture";
import { parseDiffHunk } from "../shared/diffHunk";
import type { PrOverview } from "../shared/types";
import { codeExcerpt } from "../web/overview/diffHunk";
import { cutHunk, ThreadCodeSource } from "./threadCode";

type Code = NonNullable<PrOverview["threads"][number]["code"]>;

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

const code = (partial: Partial<Code>): Code => ({
	diffHunk: "",
	commit: head,
	side: "RIGHT",
	startSide: "RIGHT",
	startLine: 1,
	endLine: 1,
	...partial,
});

/** The marked lines' text, as the code pane shows them. */
const marked = (c: Code, hunk: string) =>
	codeExcerpt({ ...c, diffHunk: hunk })
		.lines.filter((l) => l.marked)
		.map((l) => l.text);

const source = () => new ThreadCodeSource(fx.path);

describe("ThreadCodeSource.rebuild", () => {
	it("rebuilds an added file's hunk ending at the commented line, like GitHub's", async () => {
		const c = code({ startLine: 9, endLine: 10 });
		const hunk = await source().rebuild(base, c, "new.txt");
		expect(hunk?.split("\n")[0]).toBe("@@ -0,0 +3,8 @@");
		expect(hunk?.split("\n").at(-1)).toBe("+line 10 new");
		expect(marked(c, hunk ?? "")).toEqual(["line 9 new", "line 10 new"]);
	});

	it("marks the right side of a changed line, and the left side by old numbers", async () => {
		const s = source();
		const right = code({ startLine: 10, endLine: 10 });
		expect(
			marked(right, (await s.rebuild(base, right, "a.txt")) ?? ""),
		).toEqual(["line 10 changed"]);
		const left = code({
			side: "LEFT",
			startSide: "LEFT",
			startLine: 10,
			endLine: 10,
		});
		expect(marked(left, (await s.rebuild(base, left, "a.txt")) ?? "")).toEqual([
			"line 10",
		]);
		// Numbers past an addition differ per side; each side keeps its own.
		const after = code({ endLine: 18, startLine: 18 });
		expect(
			marked(after, (await s.rebuild(base, after, "a.txt")) ?? ""),
		).toEqual(["line 16"]);
	});

	it("numbers a cut hunk so parsing it gives the file's own line numbers", async () => {
		const c = code({ startLine: 16, endLine: 17 });
		const hunk = (await source().rebuild(base, c, "a.txt")) ?? "";
		for (const line of parseDiffHunk(hunk)) {
			if (line.newNo !== null && line.kind !== "add") {
				expect(line.text).toMatch(new RegExp(`^line ${line.oldNo}( |$)`));
			}
		}
		expect(marked(c, hunk)).toEqual(["added 1", "added 2"]);
	});

	it("shows an unchanged file's lines as context", async () => {
		const c = code({ startLine: 3, endLine: 3 });
		const hunk = await source().rebuild(base, c, "keep.txt");
		expect(hunk?.split("\n")[0]).toBe("@@ -1,3 +1,3 @@");
		expect(marked(c, hunk ?? "")).toEqual(["line 3"]);
	});

	it("takes paths literally: brackets, * and ? never match another file", async () => {
		const s = source();
		const c = code({ startLine: 2, endLine: 2 });
		for (const [path, tag] of [
			["[id].tsx", " bracket"],
			["i.tsx", " plain i"],
			["a*.ts", " star"],
			["a?.ts", " question"],
			["ab.ts", " plain ab"],
		] as const) {
			const hunk = (await s.rebuild(base, c, path)) ?? "";
			expect(marked(c, hunk).join(), path).toContain(`line 2${tag}`);
			// Only this file's lines: a pattern would have pulled in others.
			for (const line of parseDiffHunk(hunk)) {
				expect(line.text, path).toContain(tag);
			}
		}
	});

	it("gives up on a renamed file rather than show it all added", async () => {
		expect(
			await source().rebuild(
				base,
				code({ startLine: 3, endLine: 3 }),
				"new-name.txt",
			),
		).toBeNull();
		expect(
			await source().rebuild(
				base,
				code({ side: "LEFT", startSide: "LEFT", startLine: 3, endLine: 3 }),
				"old-name.txt",
			),
		).toBeNull();
	});

	it("gives up when either end of the range, the file, the commit or the merge base is missing", async () => {
		const s = source();
		expect(await s.rebuild(base, code({ endLine: 99 }), "a.txt")).toBeNull();
		// The end is there but not the start: never a shrunken range.
		expect(
			await s.rebuild(
				base,
				code({ startLine: 99, endLine: 10, startSide: "LEFT" }),
				"a.txt",
			),
		).toBeNull();
		expect(await s.rebuild(base, code({}), "gone.txt")).toBeNull();
		expect(
			await s.rebuild(base, code({ commit: "f".repeat(40) }), "a.txt"),
		).toBeNull();
		// No merge base with an unknown base: no code, not a guess.
		expect(await s.rebuild("e".repeat(40), code({}), "a.txt")).toBeNull();
	});
});

describe("cutHunk", () => {
	it("keeps a range that starts on the other side", () => {
		const lines = parseDiffHunk("@@ -1,2 +1,2 @@\n-old\n+new\n same");
		const c = code({
			startSide: "LEFT",
			startLine: 1,
			side: "RIGHT",
			endLine: 1,
		});
		expect(cutHunk(lines, c)).toBe("@@ -1,1 +1,1 @@\n-old\n+new");
	});

	it("refuses a range whose start isn't there", () => {
		const lines = parseDiffHunk("@@ -1,2 +1,2 @@\n a\n b");
		expect(cutHunk(lines, code({ startLine: 7, endLine: 2 }))).toBeNull();
	});
});

describe("ThreadCodeSource.fill", () => {
	const thread = (
		path: string,
		c: Code | null,
	): PrOverview["threads"][number] => ({
		path,
		line: c?.endLine ?? null,
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
		code: c,
	});

	it("fills hunkless threads, leaves GitHub's hunks alone, and drops code it can't rebuild", async () => {
		const kept = code({ diffHunk: "@@ -1,1 +1,1 @@\n x", endLine: 1 });
		const overview = {
			threads: [
				thread("new.txt", code({ endLine: 2, startLine: 2 })),
				thread("a.txt", kept),
				thread("a.txt", code({ endLine: 99, startLine: 99 })),
				thread("a.txt", null),
			],
		} as PrOverview;
		const filled = await source().fill(base, overview);
		expect(filled.threads[0]?.code?.diffHunk).toContain("+line 2 new");
		expect(filled.threads[1]?.code).toBe(kept);
		expect(filled.threads[2]?.code).toBeNull();
		expect(filled.threads[3]?.code).toBeNull();
	});

	it("asks for a commit it can't get once per session, however many threads need it", async () => {
		const fetchCommit = vi.fn(async () => false);
		const s = new ThreadCodeSource(fx.path, fetchCommit);
		const lost = "d".repeat(40);
		const overview = {
			threads: Array.from({ length: 9 }, (_, i) =>
				thread(
					`f${i}.txt`,
					code({ commit: lost, startLine: i + 1, endLine: i + 1 }),
				),
			),
		} as PrOverview;
		const filled = await s.fill(base, overview);
		expect(filled.threads.every((t) => t.code === null)).toBe(true);
		await s.fill(base, overview);
		expect(fetchCommit).toHaveBeenCalledTimes(1);
		// A new session (a Refresh) may try again.
		await new ThreadCodeSource(fx.path, fetchCommit).fill(base, overview);
		expect(fetchCommit).toHaveBeenCalledTimes(2);
	});

	it("rebuilds the same thread code once", async () => {
		const fetchCommit = vi.fn(async () => true);
		const s = new ThreadCodeSource(fx.path, fetchCommit);
		const c = code({ startLine: 2, endLine: 2 });
		const [a, b] = await Promise.all([
			s.rebuild(base, c, "new.txt"),
			s.rebuild(base, { ...c }, "new.txt"),
		]);
		expect(a).toBe(b);
		expect(fetchCommit).toHaveBeenCalledTimes(1);
	});
});
