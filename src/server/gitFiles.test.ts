import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * CAR-326, the owner: "I don't want us reading refs not through git's
 * CLI". crb reads git data only through git processes (for-each-ref,
 * cat-file, log, ...), never git's own files: loose refs, packed-refs,
 * reftable, objects, HEAD and the like. This fails when crb's code names
 * one of them in a string, the way a file read of them would: a backstop
 * to gitFilesSpy.test.ts, which watches crb's real flows' fs calls.
 */

const SRC = join(import.meta.dirname, "..");

/** String literals naming git's internal files or directories. */
const INTERNAL = [
	// Anywhere in a string: these name nothing but git's files.
	/["'`][^"'`\n]*\b(packed-refs|reftable|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)\b/,
	// A path segment of its own, as join(dir, "refs", ...) passes it.
	/["'`](refs|objects)["'`]\s*[,)]/,
	// A path into a git directory.
	/["'`][^"'`\n]*\.git[/\\]+(refs|objects|HEAD|logs|packed-refs)\b/,
	// A git file or directory joined onto a path, alone or with more after it.
	/(join|resolve)\([^)]*["'`](HEAD|config|index|shallow|objects|refs|logs)["'`/]/,
	// The same in a template: `${repo}/refs/...`.
	/\}\/(refs|objects|logs|HEAD|packed-refs|config|index|shallow)\b/,
	/["'`]objects\//,
];

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
		const path = join(dir, d.name);
		if (d.isDirectory()) return sources(path);
		return /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name)
			? [path]
			: [];
	});
}

/** The lines of `text` that name a git internal, comments left out. */
function namesGitInternals(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.filter((line) => INTERNAL.some((re) => re.test(line)));
}

describe("no reads of git's files (CAR-326)", () => {
	it("catches the reads it is there for", () => {
		for (const bad of [
			`await readFile(join(dir, "packed-refs"), "utf8");`,
			`const root = resolve(dir, "refs", "crb");`,
			`isDir(join(dir, "reftable"))`,
			`readFile(join(repo, ".git/HEAD"))`,
			`stat(join(dir, "objects"))`,
			`readFile(join(repo, "refs/crb/reviews", id, "meta"))`,
			"readFile(`${repo}/refs/crb/x`)",
			`readFile(join(repo, "HEAD"))`,
			`readFile(join(repo, "config"))`,
			`stat(join(repo, "objects/pack"))`,
			`join(repo, "refs", "crb")`,
			`join(repo, "objects", "pack")`,
		]) {
			expect(namesGitInternals(bad), bad).toEqual([bad]);
		}
		for (const fine of [
			`runGit(repo, ["for-each-ref", "refs/crb/reviews/*/meta"])`,
			`const ref = "refs/crb/inbox/x";`,
			`// packed-refs, in a comment`,
			`["rev-parse", "HEAD^{tree}"]`,
			`join(configDir(), "config.json")`,
			`runGit(path, ["symbolic-ref", "HEAD", head])`,
		]) {
			expect(namesGitInternals(fine), fine).toEqual([]);
		}
	});

	it("crb's code names none of git's files", () => {
		const found = sources(SRC).flatMap((file) =>
			namesGitInternals(readFileSync(file, "utf8")).map(
				(line) => `${relative(SRC, file)}: ${line.trim()}`,
			),
		);
		expect(found).toEqual([]);
	});
});
