import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createGitFixture,
	type GitFixture,
} from "../../../test/git-fixture.js";
import {
	compileGlob,
	parseEditorConfig,
	readTabWidths,
	tabWidthFor,
} from "./editorconfig.js";
import { buildSnapshot } from "./snapshot.js";

describe("compileGlob", () => {
	const matches = (glob: string, path: string) => compileGlob(glob).test(path);

	it("matches a name without a slash in any directory", () => {
		expect(matches("*", "a.go")).toBe(true);
		expect(matches("*.go", "pkg/x/a.go")).toBe(true);
		expect(matches("Makefile", "sub/Makefile")).toBe(true);
		expect(matches("*.go", "a.got")).toBe(false);
	});

	it("anchors a glob with a slash to the config's directory", () => {
		expect(matches("lib/*.js", "lib/a.js")).toBe(true);
		expect(matches("lib/*.js", "x/lib/a.js")).toBe(false);
		expect(matches("lib/*.js", "lib/sub/a.js")).toBe(false);
		expect(matches("lib/**.js", "lib/sub/a.js")).toBe(true);
		expect(matches("/top.txt", "top.txt")).toBe(true);
		expect(matches("src/**/*.ts", "src/a.ts")).toBe(true);
	});

	it("supports ?, sets, alternatives and number ranges", () => {
		expect(matches("?.c", "a.c")).toBe(true);
		expect(matches("[ab].c", "b.c")).toBe(true);
		expect(matches("[!ab].c", "b.c")).toBe(false);
		expect(matches("*.{js,ts}", "a.ts")).toBe(true);
		expect(matches("*.{js,ts}", "a.py")).toBe(false);
		expect(matches("file{1..3}.txt", "file2.txt")).toBe(true);
		expect(matches("file{1..3}.txt", "file4.txt")).toBe(false);
		expect(matches("a.{x}", "a.{x}")).toBe(true);
		expect(matches("f{-3..3}.txt", "f-2.txt")).toBe(true);
		expect(matches("f{-3..3}.txt", "f4.txt")).toBe(false);
		expect(matches("{a,{b,c}d}.go", "cd.go")).toBe(true);
		expect(matches("{a,{b,c}d}.go", "c.go")).toBe(false);
	});

	it("collapses runs of stars", () => {
		expect(matches("***.js", "a/b/c.js")).toBe(true);
		expect(matches("lib/***/x", "lib/x")).toBe(true);
		expect(matches("lib/*/x", "lib/x")).toBe(false);
	});

	it("matches pathological headers in linear time", () => {
		const path = `${"a/".repeat(100)}${"a".repeat(500)}${"1".repeat(400)}`;
		for (const glob of [
			"*".repeat(30),
			`${"*".repeat(30)}x`,
			`${"*a".repeat(60)}x`,
			`${"**a".repeat(40)}x`,
			`*{1..9999}*{1..9999}*{1..9999}*{1..9999}x`,
			`${"{a,*}".repeat(30)}x`,
		]) {
			const glob_ = compileGlob(glob);
			const start = performance.now();
			glob_.test(path);
			expect(performance.now() - start, glob).toBeLessThan(1000);
		}
	});

	it("refuses headers too large to match safely", () => {
		expect(() => compileGlob("{1..2}".repeat(17))).toThrow();
		expect(() => compileGlob("{a,b}".repeat(5000))).toThrow();
		// The section is ignored: the default width stays.
		const config = parseEditorConfig(
			`[*]\ntab_width = 2\n[${"{1..2}".repeat(17)}]\ntab_width = 8\n`,
		);
		expect(config.sections).toHaveLength(1);
	});
});

describe("tabWidthFor", () => {
	const configs = (entries: Record<string, string>) =>
		new Map(
			Object.entries(entries).map(([dir, text]) => [
				dir,
				parseEditorConfig(text),
			]),
		);

	it("takes tab_width, else a numeric indent_size", () => {
		const c = configs({
			"": "root = true\n[*]\nindent_size = 2\n[*.go]\nindent_size = tab\ntab_width = 8\n[*.py]\nindent_size = tab\n",
		});
		expect(tabWidthFor("a.ts", c)).toBe(2);
		expect(tabWidthFor("x/a.go", c)).toBe(8);
		// "tab" with no width says nothing about the width.
		expect(tabWidthFor("a.py", c)).toBeUndefined();
		expect(tabWidthFor("a.md", new Map())).toBeUndefined();
	});

	it("lets later sections and closer files win, and stops at root", () => {
		const c = configs({
			"": "[*]\ntab_width = 3\n",
			"sub/": "root = true\n[*]\ntab_width = 5\n[*.c]\nTAB_WIDTH = 6\n",
			"sub/deep/": "[*.c]\ntab_width = 7\n",
		});
		expect(tabWidthFor("a.c", c)).toBe(3);
		expect(tabWidthFor("sub/a.h", c)).toBe(5);
		expect(tabWidthFor("sub/a.c", c)).toBe(6);
		expect(tabWidthFor("sub/deep/a.c", c)).toBe(7);
		const above = configs({
			"": "[*.c]\ntab_width = 2\n",
			"sub/": "[*.h]\ntab_width = 5\n",
		});
		// Not root: the top file still applies where the closer one is silent.
		expect(tabWidthFor("sub/a.c", above)).toBe(2);
	});

	it("ignores comments, junk and bad numbers", () => {
		const c = configs({
			"": "# comment\n; also\nnonsense\n[*]\ntab_width = 0\nindent_size = 4\n",
		});
		expect(tabWidthFor("a", c)).toBe(4);
	});
});

describe("readTabWidths", () => {
	let fixture: GitFixture;
	beforeAll(() => {
		fixture = createGitFixture([
			{ message: "base", files: { "a.go": "x\n", "b/c.ts": "y\n" } },
			{
				message: "head",
				files: {
					".editorconfig": "root = true\n[*.go]\ntab_width = 8\n",
					"b/.editorconfig": "[*.ts]\nindent_size = 2\n",
					"a.go": "x\n\tz\n",
					"b/c.ts": "y\n\tz\n",
					"d.md": "md\n",
					// Over 64 KB: ignored, so its width never applies.
					"big/.editorconfig": `[*]\ntab_width = 3\n${"# padding\n".repeat(7000)}`,
					"big/x.ts": "z\n",
					"small/.editorconfig": `[*]\ntab_width = 3\n${"#\n".repeat(100)}`,
					"small/x.ts": "z\n",
				},
			},
		]);
	});
	afterAll(() => fixture.cleanup());

	it("reads the head's configs for each path", async () => {
		const head = fixture.shas[1] as string;
		expect(
			await readTabWidths(fixture.path, head, ["a.go", "b/c.ts", "d.md"]),
		).toEqual([8, 2, undefined]);
		// The base has no config at all.
		expect(
			await readTabWidths(fixture.path, fixture.shas[0] as string, ["a.go"]),
		).toEqual([undefined]);
	});

	it("ignores a config over 64 KB", async () => {
		const head = fixture.shas[1] as string;
		expect(
			await readTabWidths(fixture.path, head, ["big/x.ts", "small/x.ts"]),
		).toEqual([undefined, 3]);
	});

	it("puts them on the snapshot's files", async () => {
		const snapshot = await buildSnapshot(
			fixture.path,
			fixture.shas[0] as string,
			fixture.shas[1] as string,
		);
		const byPath = Object.fromEntries(
			snapshot.files.map((f) => [f.path, f.tabWidth]),
		);
		expect(byPath).toMatchObject({ "a.go": 8, "b/c.ts": 2 });
		expect(snapshot.files.find((f) => f.path === "d.md")).not.toHaveProperty(
			"tabWidth",
		);
	});
});
