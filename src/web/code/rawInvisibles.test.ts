import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { escapeLabel, INVISIBLE } from "./invisibles";

/**
 * Sources spell invisible characters as `\u` escapes. A formatter (Biome's
 * `pnpm fix`) may turn an escape into the raw character, which then hides in
 * the code it is meant to expose: this fails on any raw one.
 */
const ROOT = join(import.meta.dirname, "../../..");
const DIRS = ["src", "test", "e2e", "docs", "scripts", ".github"].filter(
	(dir) => existsSync(join(ROOT, dir)),
);
const TEXT = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".md",
	".css",
	".html",
	".svg",
	".yml",
	".yaml",
	".txt",
	".toml",
	"",
]);
/** Whitespace a source file legitimately holds. */
const ORDINARY = new Set([" ", "\t", "\n", "\r"]);
/** A line of printable ASCII and ORDINARY whitespace: nothing to look at. */
const PLAIN = /^[\t\r\x20-\x7e]*$/;
/** Code files, where a raw combining mark must sit on a letter. */
const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const NONSPACING = /^[\p{Mn}\p{Me}]$/u;
const LETTER = /^\p{L}$/u;

/**
 * Raw nonspacing marks in `line` not sitting on a non-ASCII letter (after
 * other marks): one on a quote or an ASCII letter hides in the code.
 */
function orphanMarks(line: string): string[] {
	const chars = Array.from(line);
	const found: string[] = [];
	chars.forEach((ch, i) => {
		if (!NONSPACING.test(ch)) return;
		let j = i - 1;
		while (j >= 0 && NONSPACING.test(chars[j] as string)) j--;
		const base = chars[j];
		const onLetter =
			base !== undefined &&
			LETTER.test(base) &&
			(base.codePointAt(0) as number) > 0x7f;
		if (!onLetter) found.push(ch);
	});
	return found;
}

/**
 * "path:line": raw characters allowed there: the gallery's hidden-unicode
 * case (inline-diff #64), byte for byte as on GitHub.
 */
const ALLOWED = new Set<string>([
	"test/fixtures/inline-diff/case/inline/64-hidden-unicode.ts:4",
	"test/fixtures/inline-diff/case/inline/64-hidden-unicode.ts:8",
]);

function* files(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* files(path);
		else if (TEXT.has(extname(entry.name))) yield path;
	}
}

describe("sources", () => {
	it("hold no raw invisible, bidi, tag or variation-selector characters", () => {
		const found: string[] = [];
		let checked = 0;
		const rootFiles = readdirSync(ROOT, { withFileTypes: true })
			.filter((e) => e.isFile() && TEXT.has(extname(e.name)))
			.map((e) => join(ROOT, e.name));
		const all = [
			...rootFiles,
			...DIRS.flatMap((dir) => [...files(join(ROOT, dir))]),
		];
		for (const path of all) {
			checked++;
			const lines = readFileSync(path, "utf8").split("\n");
			const file = relative(ROOT, path);
			lines.forEach((line, i) => {
				if (PLAIN.test(line)) return;
				const where = `${file}:${i + 1}`;
				if (ALLOWED.has(where)) return;
				for (const ch of line) {
					if (ORDINARY.has(ch) || !INVISIBLE.test(ch)) continue;
					found.push(`${where} ${escapeLabel(ch.codePointAt(0) ?? 0)}`);
				}
				if (!CODE.has(extname(path))) return;
				for (const ch of orphanMarks(line)) {
					found.push(
						`${where} ${escapeLabel(ch.codePointAt(0) ?? 0)} (orphan mark)`,
					);
				}
			});
		}
		expect(checked).toBeGreaterThan(50);
		// The root's own files are covered (CLAUDE.md, package.json...).
		expect(rootFiles.map((p) => relative(ROOT, p))).toEqual(
			expect.arrayContaining(["CLAUDE.md", "package.json", "vitest.config.ts"]),
		);
		expect(found).toEqual([]);
	});

	it("flags a raw mark that sits on no letter", () => {
		expect(orphanMarks('"\u0301"')).toEqual(["\u0301"]);
		expect(orphanMarks("e\u0301")).toEqual(["\u0301"]);
		expect(orphanMarks("\u0301")).toEqual(["\u0301"]);
		// On a non-ASCII letter, after other marks too, it is just text.
		expect(orphanMarks("क\u094D\u0901")).toEqual([]);
		expect(orphanMarks("é")).toEqual([]);
	});

	it("would catch one", () => {
		for (const cp of [0x200b, 0x202e, 0xfe0f, 0xe0041, 0x00a0, 0x2066]) {
			expect(INVISIBLE.test(String.fromCodePoint(cp))).toBe(true);
		}
	});
});
