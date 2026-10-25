import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { escapeLabel, INVISIBLE } from "./invisibles";

/**
 * Sources spell invisible characters as `\u` escapes. A formatter (Biome's
 * `pnpm fix`) may turn an escape into the raw character, which then hides in
 * the code it is meant to expose: this fails on any raw one.
 */
const ROOT = join(import.meta.dirname, "../../..");
const DIRS = ["src", "test", "e2e", "docs"];
const TEXT = new Set([
	".ts",
	".tsx",
	".js",
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
	"",
]);
/** Whitespace a source file legitimately holds. */
const ORDINARY = new Set([" ", "\t", "\n", "\r"]);
/** "path:line": raw characters allowed there (none so far). */
const ALLOWED = new Set<string>();

function* files(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* files(path);
		else if (TEXT.has(extname(entry.name))) yield path;
	}
}

describe("sources", () => {
	it("hold no raw invisible, bidi, tag or variation-selector characters", () => {
		const found: string[] = [];
		let checked = 0;
		for (const dir of DIRS) {
			for (const path of files(join(ROOT, dir))) {
				checked++;
				const lines = readFileSync(path, "utf8").split("\n");
				lines.forEach((line, i) => {
					for (const ch of line) {
						if (ORDINARY.has(ch) || !INVISIBLE.test(ch)) continue;
						const where = `${relative(ROOT, path)}:${i + 1}`;
						if (ALLOWED.has(where)) continue;
						found.push(`${where} ${escapeLabel(ch.codePointAt(0) ?? 0)}`);
					}
				});
			}
		}
		expect(checked).toBeGreaterThan(50);
		expect(found).toEqual([]);
	});

	it("would catch one", () => {
		for (const cp of [0x200b, 0x202e, 0xfe0f, 0xe0041, 0x00a0, 0x2066]) {
			expect(INVISIBLE.test(String.fromCodePoint(cp))).toBe(true);
		}
	});
});
