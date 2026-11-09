import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDiffFixture } from "../../../test/diff-fixture.js";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
	testGitEnv,
} from "../../../test/git-fixture.js";
import type { DisplayHunk, Snapshot } from "../../shared/types.js";
import {
	buildAllHeadings,
	decodeHeading,
	type GitHunkHeading,
	parseHeadings,
	withHeadings,
} from "./headings.js";
import { buildSnapshot, loadFileHunks } from "./snapshot.js";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const lines = (n: number, prefix: string) =>
	Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const text = (...parts: (string | string[])[]) =>
	`${parts.flat().join("\n")}\n`;

// Each file: a definition, a body long enough for a hunk well inside it.
const python = (body: string) =>
	text(
		"import os",
		"",
		"class Greeter:",
		"    def __init__(self):",
		"        self.name = 'x'",
		"",
		"    def greet(self, who):",
		lines(10, "        step_"),
		`        ${body}`,
		lines(10, "        after_"),
	);
const js = (body: string) =>
	text(
		"const a = 1;",
		"",
		"function bar(x) {",
		lines(10, "  // step "),
		`  ${body}`,
		lines(10, "  // after "),
		"}",
	);
const ts = (body: string) =>
	text(
		"export class Box {",
		"  open(): void {",
		lines(10, "    // step "),
		`    ${body}`,
		lines(10, "    // after "),
		"  }",
		"}",
	);
const go = (body: string) =>
	text(
		"package main",
		"",
		"func (s *Server) Handle(w Writer) error {",
		lines(10, "\t// step "),
		`\t${body}`,
		lines(10, "\t// after "),
		"}",
	);
// Nothing git's default rule matches: every line starts with a space.
const plain = (body: string) =>
	text(lines(15, " - item "), ` ${body}`, lines(5, " - more "));
// A change on line 2: its hunk starts at the top, nothing above it.
const top = (body: string) => text("first", body, lines(10, "rest "));
// A custom attribute: `.txt` files as Python by the repo's .gitattributes.
const custom = (body: string) =>
	text("def by_attribute():", lines(10, "    x"), `    ${body}`, "    end");
// Whitespace-only change inside a function.
const ws = (indent: string) =>
	text("def spaced():", lines(10, "    s"), `${indent}value = 1`, "    end");
// Two hunks in one file, under two functions.
const two = (a: string, b: string) =>
	text(
		"def first():",
		lines(8, "    a"),
		`    ${a}`,
		lines(8, "    b"),
		"def second():",
		lines(8, "    c"),
		`    ${b}`,
		lines(4, "    d"),
	);
// Markdown: GitHub keeps git's default rule (no markdown driver).
const md = (body: string) =>
	text("# Title", "", "Intro text here.", "", "- a", "- b", "- c", "- d", body);
// Two-byte characters cut at git's 80 bytes.
const longName = `def a${"é".repeat(50)}():`;
const wide = (body: string) =>
	text(longName, lines(10, "    w"), `    ${body}`, "    end");

let fixture: GitFixture;
let bare: string;
let snapshot: Snapshot;

beforeAll(async () => {
	fixture = createGitFixture([
		{
			message: "base",
			files: {
				".gitattributes": "*.txt diff=python\n",
				"app.py": python("old()"),
				"app.js": js("old();"),
				"box.ts": ts("old();"),
				"main.go": go("old()"),
				"list.md.txt.none": plain("old"),
				"top.py": top("old"),
				"custom.txt": custom("old"),
				"ws.py": ws("    "),
				"two.py": two("old_a", "old_b"),
				"wide.py": wide("old"),
				"README.md": md("- old"),
			},
		},
		{
			message: "head",
			files: {
				"app.py": python("new()"),
				"app.js": js("new();"),
				"box.ts": ts("new();"),
				"main.go": go("new()"),
				"list.md.txt.none": plain("new"),
				"top.py": top("new"),
				"custom.txt": custom("new"),
				"ws.py": ws("\t"),
				"two.py": two("new_a", "new_b"),
				"wide.py": wide("new"),
				"README.md": md("- new"),
			},
		},
	]);
	// Like carbonless's own clone: bare, attributes only from commits.
	bare = join(mkdtempSync(join(tmpdir(), "carbonless-headings-")), "r.git");
	execFileSync("git", ["clone", "--quiet", "--bare", fixture.path, bare], {
		env: testGitEnv(),
	});
	snapshot = await buildSnapshot(
		bare,
		fixture.shas[0] as string,
		fixture.shas[1] as string,
	);
});

afterAll(() => {
	fixture.cleanup();
	rmSync(join(bare, ".."), { recursive: true, force: true });
});

const headingsOf = async (path: string) => {
	const file = snapshot.files.find((f) => f.path === path);
	if (!file) throw new Error(`no ${path}`);
	const { hunks } = await loadFileHunks(bare, snapshot, file.index);
	return hunks.map((h) => h.heading);
};

describe("hunk headings from git", () => {
	it("a Python method inside a class: its def, not the class (git's python driver)", async () => {
		expect(await headingsOf("app.py")).toEqual(["def greet(self, who):"]);
	});

	it("a JS function: git's default rule, as GitHub", async () => {
		expect(await headingsOf("app.js")).toEqual(["function bar(x) {"]);
	});

	it("a TS method: the default rule only sees unindented lines", async () => {
		expect(await headingsOf("box.ts")).toEqual(["export class Box {"]);
	});

	it("a Go method: its func (git's golang driver)", async () => {
		expect(await headingsOf("main.go")).toEqual([
			"func (s *Server) Handle(w Writer) error {",
		]);
	});

	it("no line matches: no heading", async () => {
		expect(await headingsOf("list.md.txt.none")).toEqual([undefined]);
	});

	it("a hunk at the top of the file: nothing above it, no heading", async () => {
		expect(await headingsOf("top.py")).toEqual([undefined]);
	});

	it("Markdown: the default rule, as GitHub (not git's markdown driver)", async () => {
		expect(await headingsOf("README.md")).toEqual(["Intro text here."]);
	});

	it("follows the repo's own .gitattributes in a bare clone", async () => {
		expect(await headingsOf("custom.txt")).toEqual(["def by_attribute():"]);
	});

	it("a whitespace-only change (Ignore whitespace is the web's): its heading", async () => {
		expect(await headingsOf("ws.py")).toEqual(["def spaced():"]);
	});

	it("each hunk its own function", async () => {
		expect(await headingsOf("two.py")).toEqual([
			"def first():",
			"def second():",
		]);
	});

	it("git's cut at 80 bytes drops a split character", async () => {
		const [heading] = await headingsOf("wide.py");
		expect(heading).toBe(longName.slice(0, 5 + 37));
		expect(heading).not.toContain("�");
	});
});

describe("display hunks and git's -U3 hunks", () => {
	it("start on the same old lines in every file of the diff fixture and this one", async () => {
		const other = createDiffFixture();
		try {
			for (const [repo, base, head] of [
				[other.path, other.shas[0], other.shas[1]],
				[bare, fixture.shas[0], fixture.shas[1]],
			] as [string, string, string][]) {
				const snap = await buildSnapshot(repo, base, head);
				const git = await buildAllHeadings(repo, base, head, snap.files);
				for (const file of snap.files) {
					const { hunks } = await loadFileHunks(repo, snap, file.index);
					const starts = hunks
						.filter((h) => h.oldCount > 0)
						.map((h) => h.oldStart);
					const gitStarts = (git[file.index] ?? [])
						.filter((g) => g.oldCount > 0)
						.map((g) => g.oldStart);
					expect(gitStarts, file.path).toEqual(starts);
				}
			}
		} finally {
			other.cleanup();
		}
	});
});

describe("parseHeadings", () => {
	it("reads headers and skips hunk lines by count, even ones that look like headers", () => {
		const section = [
			"diff --git a/x b/x",
			"--- a/x",
			"+++ b/x",
			"@@ -1,2 +1,2 @@ def a():",
			"-@@ -9,9 +9,9 @@ fake",
			"+x",
			" y",
			"@@ -20 +20 @@",
			"-z",
			"+w",
		].join("\n");
		expect(parseHeadings(section)).toEqual([
			{ oldStart: 1, oldCount: 2, heading: "def a():" },
			{ oldStart: 20, oldCount: 1, heading: "" },
		]);
	});
});

describe("withHeadings", () => {
	const hunk = (oldStart: number, oldCount = 4): DisplayHunk => ({
		oldStart,
		oldCount,
		newStart: oldStart,
		newCount: oldCount,
		lines: [],
	});
	const git: GitHunkHeading[] = [
		{ oldStart: 5, oldCount: 7, heading: "def five():" },
		{ oldStart: 30, oldCount: 7, heading: "" },
	];

	it("takes the heading of the git hunk starting on the same old line", () => {
		expect(withHeadings([hunk(5)], git, "utf8")[0]?.heading).toBe(
			"def five():",
		);
	});

	it("a display hunk no git hunk starts with gets none (the fallback)", () => {
		// git aligned the file otherwise: a heading could be another line's.
		expect(withHeadings([hunk(6)], git, "utf8")[0]).not.toHaveProperty(
			"heading",
		);
		expect(withHeadings([hunk(30)], git, "utf8")[0]).not.toHaveProperty(
			"heading",
		);
	});

	it("an empty old side (an added file) has none", () => {
		expect(
			withHeadings(
				[hunk(0, 0)],
				[{ ...git[0], oldStart: 0 } as GitHunkHeading],
				"utf8",
			)[0],
		).not.toHaveProperty("heading");
	});

	it("keeps markup as text", () => {
		const evil = "<img src=x onerror=alert(1)>";
		expect(
			withHeadings(
				[hunk(5)],
				[{ oldStart: 5, oldCount: 7, heading: evil }],
				"utf8",
			)[0]?.heading,
		).toBe(evil);
	});
});

describe("decodeHeading", () => {
	it("decodes UTF-8 bytes", () => {
		expect(
			decodeHeading(Buffer.from("é", "utf8").toString("latin1"), "utf8"),
		).toBe("é");
	});
	it("keeps latin1 files byte for byte", () => {
		expect(decodeHeading("\xe9t\xe9", "latin1")).toBe("\xe9t\xe9");
	});
});
