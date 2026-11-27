/**
 * Prose files (CAR-130): Markdown and its kin, plain text, and files with
 * no extension (a `README`, a `LICENSE`). In them a line's leading `*`,
 * `#` or `-` is a bullet or a heading, not a comment leader, so a split or
 * joined group's marks never absorb one into a break: a new bullet stays
 * marked (the owner: "Any added text should be visible"). Keyed on the
 * path, never on the highlighter's language: C, C++, Ruby and others have
 * no grammar and still have comment leaders. A dotfile (`.gitignore`,
 * `.bashrc`) has its name as its extension: not prose.
 */
const PROSE = new Set([
	"md",
	"markdown",
	"mdx",
	"mdown",
	"mkd",
	"rst",
	"adoc",
	"txt",
]);

/** Whether `path` is a prose file (see above), by its extension. */
export function proseFile(path: string): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	if (dot < 0) return true;
	return PROSE.has(name.slice(dot + 1).toLowerCase());
}
