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
const MODULE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/;

/**
 * Groups of names that differ only by case: paths (files and their
 * directories, which must check out side by side) and the names an
 * extensionless import reaches a module by (`a/b` for `a/b.ts`, and `a` for
 * `a/index.ts`).
 */
function caseCollisions(paths: readonly string[]): string[][] {
	const byLower = new Map<string, Set<string>>();
	const add = (kind: "path" | "module", name: string) => {
		const key = `${kind}:${name.toLowerCase()}`;
		const names = byLower.get(key) ?? new Set<string>();
		names.add(name);
		byLower.set(key, names);
	};
	for (const path of paths) {
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			add("path", parts.slice(0, i).join("/"));
		}
		if (!MODULE.test(path)) continue;
		const stem = path.replace(MODULE, "");
		add("module", stem);
		if (stem.endsWith("/index")) add("module", stem.slice(0, -"/index".length));
	}
	return [...byLower.values()]
		.filter((names) => names.size > 1)
		.map((names) => [...names].sort());
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
				"lib/A/x.ts",
				"lib/a/y.ts",
				"app/B/index.ts",
				"app/b.ts",
			]),
		).toEqual([
			["src/web/code/Invisibles", "src/web/code/invisibles"],
			["docs/A.md", "docs/a.md"],
			["lib/A", "lib/a"],
			["app/B", "app/b"],
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
