import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Windows and macOS file systems ignore case, so two tracked paths that
 * differ only by case can't both be checked out, and an import without its
 * extension may resolve to another module there: with `invisibles.ts` next
 * to `Invisibles.tsx`, `import "./Invisibles"` got `invisibles.ts` on
 * Windows and the build failed. This fails on any such pair.
 */
const ROOT = join(import.meta.dirname, "..");
/** Extensions an import may leave out (the resolver tries each in turn). */
const MODULE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Groups of the given paths that one case-insensitive name would match. */
function caseCollisions(paths: readonly string[]): string[][] {
	const byKey = new Map<string, Set<string>>();
	const add = (key: string, name: string) => {
		const lower = key.toLowerCase();
		const names = byKey.get(lower) ?? new Set<string>();
		names.add(name);
		byKey.set(lower, names);
	};
	for (const path of paths) {
		add(`file:${path}`, path);
		if (MODULE.test(path)) add(`module:${path.replace(MODULE, "")}`, path);
	}
	const groups: string[][] = [];
	for (const [key, names] of byKey) {
		const found = [...names];
		if (found.length < 2) continue;
		// foo.ts next to foo.tsx resolves the same everywhere: only case counts.
		const stems = new Set(
			found.map((p) => (key.startsWith("module:") ? p.replace(MODULE, "") : p)),
		);
		if (stems.size > 1) groups.push(found.sort());
	}
	return groups;
}

describe("caseCollisions", () => {
	it("finds paths and extensionless modules that differ only by case", () => {
		expect(
			caseCollisions([
				"src/web/code/invisibles.ts",
				"src/web/code/Invisibles.tsx",
				"docs/A.md",
				"docs/a.md",
				"src/foo.ts",
				"src/foo.tsx",
				"src/Bar.css",
				"src/bar.ts",
			]),
		).toEqual([
			["src/web/code/Invisibles.tsx", "src/web/code/invisibles.ts"],
			["docs/A.md", "docs/a.md"],
		]);
	});

	it("finds none among the repo's tracked files", () => {
		const tracked = execFileSync("git", ["ls-files", "-z"], {
			cwd: ROOT,
			encoding: "utf8",
		})
			.split("\0")
			.filter(Boolean);
		expect(tracked.length).toBeGreaterThan(0);
		expect(caseCollisions(tracked)).toEqual([]);
	});
});
