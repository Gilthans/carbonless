import { describe, expect, it } from "vitest";
import { proseFile } from "./proseFile";

describe("proseFile", () => {
	it("is true for Markdown and its kin, text, and extensionless files", () => {
		for (const p of [
			"README.md",
			"docs/guide.markdown",
			"docs/page.mdx",
			"a.mdown",
			"a.mkd",
			"docs/index.rst",
			"docs/manual.adoc",
			"notes.txt",
			"NOTES.TXT",
			"README",
			"pkg/LICENSE",
		]) {
			expect(proseFile(p), p).toBe(true);
		}
	});

	it("is false for code, even without a grammar, and for dotfiles", () => {
		for (const p of [
			"src/a.ts",
			"lib/a.c",
			"lib/a.cpp",
			"app/a.rb",
			"a.py",
			".gitignore",
			"conf/.bashrc",
			"docs.md/a.c",
		]) {
			expect(proseFile(p), p).toBe(false);
		}
	});
});
