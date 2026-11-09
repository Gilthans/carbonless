import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DisplayHunk } from "../../shared/types.js";
import { runGitBuffer } from "../git.js";
import { cacheDir } from "../paths.js";
import { headersFor, splitPatch } from "./clusters.js";
import { DIFF_ARGS } from "./files.js";
import type { TextEncoding } from "./text.js";

/**
 * Hunk headings: the line git prints after `@@ … @@` (the "function
 * context", e.g. `def foo(self):`), as GitHub shows it.
 *
 * git finds a hunk's heading by searching the OLD file upwards from the line
 * above the hunk's first old line for a line its funcname rule matches (the
 * file's userdiff driver, picked by the `diff` attribute; without one, any
 * line starting with a letter, `_` or `$`). So a heading depends only on the
 * old file and the hunk's old start line. carbonless takes them from git
 * itself: one `git diff -U3` per snapshot with the same options as the
 * clusters' `-U0` run, its hunks keyed by old start.
 */

/**
 * Built-in userdiff drivers by file name, as GitHub picks them by language.
 * Read with the lowest precedence (`core.attributesFile`), so the repo's own
 * `.gitattributes` (read from the head commit) wins, as on GitHub. JS/TS
 * and others git has no driver for keep git's default rule, and so does
 * Markdown: GitHub doesn't use git's markdown driver (checked on a real PR,
 * 2026-11-09).
 */
export const FUNCNAME_ATTRIBUTES = `${[
	["ada", "*.ada *.adb *.ads"],
	["bash", "*.sh *.bash"],
	["bibtex", "*.bib"],
	[
		"cpp",
		"*.c *.h *.cc *.cpp *.cxx *.c++ *.hh *.hpp *.hxx *.h++ *.inl *.ino *.cu *.cuh",
	],
	["csharp", "*.cs"],
	["css", "*.css *.scss *.less"],
	["dts", "*.dts *.dtsi"],
	["elixir", "*.ex *.exs"],
	["fortran", "*.f *.for *.f90 *.f95 *.f03 *.f08"],
	["fountain", "*.fountain"],
	["golang", "*.go"],
	["html", "*.html *.htm *.xhtml"],
	["java", "*.java"],
	["kotlin", "*.kt *.kts"],
	["objc", "*.m *.mm"],
	["pascal", "*.pas *.pp *.dpr"],
	["perl", "*.pl *.pm *.t"],
	["php", "*.php *.phtml"],
	["python", "*.py *.pyi *.pyw"],
	["ruby", "*.rb *.rake *.gemspec Rakefile Gemfile"],
	["rust", "*.rs"],
	["scheme", "*.scm *.ss *.sld"],
	["tex", "*.tex *.sty *.cls"],
]
	.flatMap(([driver, patterns]) =>
		(patterns as string).split(" ").map((p) => `${p} diff=${driver}`),
	)
	.join("\n")}\n`;

let attributesFile: Promise<string> | undefined;

/**
 * FUNCNAME_ATTRIBUTES as a file (in carbonless's cache: never in a
 * reviewer's repository), written once per process, atomically.
 */
function funcnameAttributesFile(): Promise<string> {
	attributesFile ??= (async () => {
		const dir = cacheDir();
		const path = join(dir, "funcname.gitattributes");
		const current = await readFile(path, "utf8").catch(() => null);
		if (current !== FUNCNAME_ATTRIBUTES) {
			await mkdir(dir, { recursive: true });
			const tmp = `${path}.${randomUUID()}`;
			await writeFile(tmp, FUNCNAME_ATTRIBUTES);
			await rename(tmp, path);
		}
		return path;
	})().catch((error) => {
		attributesFile = undefined;
		throw error;
	});
	return attributesFile;
}

/** A `-U3` hunk's old start (as git prints it) and its heading's bytes. */
export interface GitHunkHeading {
	oldStart: number;
	oldCount: number;
	/** latin1: one character per byte of the file's encoding. */
	heading: string;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/;

/**
 * The hunks of one file's `-U3` section (read as latin1), with their
 * headings (empty when git printed none). Hunk lines are skipped by count,
 * so a content line can't pass for a header.
 */
export function parseHeadings(section: string): GitHunkHeading[] {
	const result: GitHunkHeading[] = [];
	let oldLeft = 0;
	let newLeft = 0;
	const lines = section.split("\n");
	for (const line of lines) {
		if (oldLeft > 0 || newLeft > 0) {
			const sign = line[0];
			if (sign === " ") {
				oldLeft--;
				newLeft--;
			} else if (sign === "-") oldLeft--;
			else if (sign === "+") newLeft--;
			continue;
		}
		const header = HEADER.exec(line);
		if (!header) continue;
		const oldCount = header[2] === undefined ? 1 : Number(header[2]);
		result.push({
			oldStart: Number(header[1]),
			oldCount,
			heading: (header[5] ?? "").replace(/\r$/, ""),
		});
		oldLeft = oldCount;
		newLeft = header[4] === undefined ? 1 : Number(header[4]);
	}
	return result;
}

/** A file of the snapshot, as far as finding its section goes. */
export interface HeadingFile {
	path: string;
	oldPath?: string;
	binary?: boolean;
	submodule?: boolean;
}

/**
 * The `-U3` hunks and headings of every file in `files` (by index), from ONE
 * whole-diff run with the clusters' options. Attributes: the repo's own
 * `.gitattributes` at `head`, over FUNCNAME_ATTRIBUTES. A file git prints
 * no section for (or only a binary one) has none.
 */
export async function buildAllHeadings(
	repo: string,
	base: string,
	head: string,
	files: HeadingFile[],
): Promise<GitHunkHeading[][]> {
	const attributes = await funcnameAttributesFile();
	const patch = await runGitBuffer(repo, [
		`--attr-source=${head}`,
		"-c",
		`core.attributesFile=${attributes}`,
		...DIFF_ARGS,
		"-U3",
		base,
		head,
		"--",
	]);
	const sections = splitPatch(patch);
	return files.map((file) => {
		if (file.binary || file.submodule) return [];
		const header = headersFor(file).find((h) => sections.has(h));
		const section = header === undefined ? undefined : sections.get(header);
		return section ? parseHeadings(section.toString("latin1")) : [];
	});
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenientUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * A heading's bytes as text in its file's encoding. git cuts a heading at 80
 * bytes, which can split a UTF-8 character: the broken tail is dropped.
 */
export function decodeHeading(raw: string, encoding: TextEncoding): string {
	if (encoding === "latin1") return raw;
	const bytes = Buffer.from(raw, "latin1");
	for (let cut = 0; cut <= 3 && cut < bytes.length; cut++) {
		try {
			return strictUtf8.decode(bytes.subarray(0, bytes.length - cut));
		} catch {}
	}
	return lenientUtf8.decode(bytes);
}

/**
 * Each display hunk with git's heading for the `-U3` hunk that starts on
 * the same old line (the heading depends on nothing else). A display hunk
 * no git hunk starts with (git aligned the file differently, or printed it
 * as binary) gets none: no heading rather than one that may be wrong.
 */
export function withHeadings(
	hunks: DisplayHunk[],
	gitHunks: GitHunkHeading[],
	encoding: TextEncoding,
): DisplayHunk[] {
	const byStart = new Map<number, string>();
	for (const g of gitHunks) {
		if (g.oldCount > 0 && g.heading !== "") byStart.set(g.oldStart, g.heading);
	}
	return hunks.map((hunk) => {
		const raw = hunk.oldCount > 0 ? byStart.get(hunk.oldStart) : undefined;
		if (raw === undefined) return hunk;
		const heading = decodeHeading(raw, encoding);
		return heading === "" ? hunk : { ...hunk, heading };
	});
}
