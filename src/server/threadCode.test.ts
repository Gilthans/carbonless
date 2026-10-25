import { afterAll, describe, expect, it } from "vitest";
import { createGitFixture } from "../../test/git-fixture";
import { parseDiffHunk } from "../shared/diffHunk";
import type { PrOverview } from "../shared/types";
import { codeExcerpt } from "../web/overview/diffHunk";
import { cutHunk, fillThreadCode, rebuildHunk } from "./threadCode";

type Code = NonNullable<PrOverview["threads"][number]["code"]>;

const numbered = (n: number, tag = "") =>
	`${Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join("\n")}\n`;

// base: a.txt 1..20, keep.txt; then the PR edits a.txt (line 10 replaced,
// two lines added after 15) and adds new.txt.
const fx = createGitFixture([
	{
		message: "base",
		files: { "a.txt": numbered(20), "keep.txt": numbered(5) },
	},
	{
		message: "pr",
		files: {
			"a.txt": numbered(20)
				.replace("line 10\n", "line 10 changed\n")
				.replace("line 15\n", "line 15\nadded 1\nadded 2\n"),
			"new.txt": numbered(12, " new"),
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

describe("rebuildHunk", () => {
	it("rebuilds an added file's hunk ending at the commented line, like GitHub's", async () => {
		const c = code({ startLine: 9, endLine: 10 });
		const hunk = await rebuildHunk(fx.path, base, c, "new.txt");
		expect(hunk?.split("\n")[0]).toBe("@@ -0,0 +3,8 @@");
		expect(hunk?.split("\n").at(-1)).toBe("+line 10 new");
		expect(marked(c, hunk ?? "")).toEqual(["line 9 new", "line 10 new"]);
	});

	it("marks the right side of a changed line, and the left side by old numbers", async () => {
		const right = code({ startLine: 10, endLine: 10 });
		const r = await rebuildHunk(fx.path, base, right, "a.txt");
		expect(marked(right, r ?? "")).toEqual(["line 10 changed"]);
		const left = code({
			side: "LEFT",
			startSide: "LEFT",
			startLine: 10,
			endLine: 10,
		});
		const l = await rebuildHunk(fx.path, base, left, "a.txt");
		expect(marked(left, l ?? "")).toEqual(["line 10"]);
		// Numbers past an addition differ per side; each side keeps its own.
		const after = code({ endLine: 18, startLine: 18 });
		expect(
			marked(after, (await rebuildHunk(fx.path, base, after, "a.txt")) ?? ""),
		).toEqual(["line 16"]);
	});

	it("numbers a cut hunk so parsing it gives the file's own line numbers", async () => {
		const c = code({ startLine: 16, endLine: 17 });
		const hunk = (await rebuildHunk(fx.path, base, c, "a.txt")) ?? "";
		for (const line of parseDiffHunk(hunk)) {
			if (line.newNo !== null && line.kind !== "add") {
				expect(line.text).toMatch(new RegExp(`^line ${line.oldNo}( |$)`));
			}
		}
		expect(marked(c, hunk)).toEqual(["added 1", "added 2"]);
	});

	it("shows an unchanged file's lines as context", async () => {
		const c = code({ startLine: 3, endLine: 3 });
		const hunk = await rebuildHunk(fx.path, base, c, "keep.txt");
		expect(hunk?.split("\n")[0]).toBe("@@ -1,3 +1,3 @@");
		expect(marked(c, hunk ?? "")).toEqual(["line 3"]);
	});

	it("gives up on a line, file or commit that isn't there", async () => {
		expect(
			await rebuildHunk(fx.path, base, code({ endLine: 99 }), "a.txt"),
		).toBeNull();
		expect(await rebuildHunk(fx.path, base, code({}), "gone.txt")).toBeNull();
		expect(
			await rebuildHunk(
				fx.path,
				base,
				code({ commit: "f".repeat(40) }),
				"a.txt",
			),
		).toBeNull();
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
});

describe("fillThreadCode", () => {
	const thread = (
		path: string,
		c: Code | null,
	): PrOverview["threads"][number] => ({
		path,
		line: c?.endLine ?? null,
		currentLine: null,
		excerpt: "",
		html: "",
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
		const filled = await fillThreadCode(fx.path, base, overview);
		expect(filled.threads[0]?.code?.diffHunk).toContain("+line 2 new");
		expect(filled.threads[1]?.code).toBe(kept);
		expect(filled.threads[2]?.code).toBeNull();
		expect(filled.threads[3]?.code).toBeNull();
	});
});
