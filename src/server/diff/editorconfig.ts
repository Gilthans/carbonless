import { runGitBuffer } from "../git.js";

/**
 * Tab widths from .editorconfig (https://editorconfig.org), read from a
 * commit: only what tabs need (`tab_width`, else a numeric `indent_size`),
 * with the spec's precedence (closer files and later sections win, `root =
 * true` stops the search upward).
 */

interface Section {
	pattern: RegExp;
	props: Record<string, string>;
}

interface EditorConfig {
	root: boolean;
	sections: Section[];
}

/** The spec's globs as a regex over a path relative to the file's directory. */
export function globToRegExp(glob: string): RegExp {
	let source = "";
	let i = 0;
	let braces = 0;
	const anchored = glob.includes("/");
	const body = glob.startsWith("/") ? glob.slice(1) : glob;
	while (i < body.length) {
		const ch = body[i] as string;
		if (ch === "\\" && i + 1 < body.length) {
			source += escapeChar(body[i + 1] as string);
			i += 2;
			continue;
		}
		if (ch === "*") {
			if (body[i + 1] === "*") {
				// "**/" also matches no directory at all.
				if (body[i + 2] === "/") {
					source += "(?:.*/)?";
					i += 3;
				} else {
					source += ".*";
					i += 2;
				}
			} else {
				source += "[^/]*";
				i++;
			}
			continue;
		}
		if (ch === "?") {
			source += "[^/]";
			i++;
			continue;
		}
		if (ch === "[") {
			const close = body.indexOf("]", i + 1);
			if (close > i + 1) {
				let set = body.slice(i + 1, close);
				const negate = set.startsWith("!");
				if (negate) set = set.slice(1);
				source += `[${negate ? "^" : ""}${set.replace(/[\\\]^]/g, "\\$&")}]`;
				i = close + 1;
				continue;
			}
			source += "\\[";
			i++;
			continue;
		}
		if (ch === "{") {
			const close = body.indexOf("}", i + 1);
			const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body.slice(i + 1, close));
			if (close > 0 && range) {
				const [lo, hi] = [Number(range[1]), Number(range[2])].sort(
					(a, b) => a - b,
				) as [number, number];
				const numbers = Array.from(
					{ length: Math.min(hi - lo + 1, 10_000) },
					(_, k) => lo + k,
				);
				source += `(?:${numbers.join("|")})`;
				i = close + 1;
				continue;
			}
			if (close > 0 && body.slice(i + 1, close).includes(",")) {
				source += "(?:";
				braces++;
				i++;
				continue;
			}
			source += "\\{";
			i++;
			continue;
		}
		if (ch === "," && braces > 0) {
			source += "|";
			i++;
			continue;
		}
		if (ch === "}" && braces > 0) {
			source += ")";
			braces--;
			i++;
			continue;
		}
		source += escapeChar(ch);
		i++;
	}
	source += ")".repeat(braces);
	return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}$`);
}

const escapeChar = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function parseEditorConfig(text: string): EditorConfig {
	const config: EditorConfig = { root: false, sections: [] };
	let current: Section | null = null;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const header = /^\[(.*)\]$/.exec(line);
		if (header) {
			try {
				current = { pattern: globToRegExp(header[1] as string), props: {} };
				config.sections.push(current);
			} catch {
				current = null;
			}
			continue;
		}
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim().toLowerCase();
		const value = line
			.slice(eq + 1)
			.trim()
			.toLowerCase();
		if (current) current.props[key] = value;
		else if (key === "root") config.root = value === "true";
	}
	return config;
}

/** Directories from the repo root down to the file's own (""-rooted). */
function directories(path: string): string[] {
	const parts = path.split("/").slice(0, -1);
	return ["", ...parts.map((_, i) => `${parts.slice(0, i + 1).join("/")}/`)];
}

const width = (value: string | undefined) => {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const n = Number(value);
	return n >= 1 ? n : undefined;
};

/** The tab width the configs give `path` (closest last), if any. */
export function tabWidthFor(
	path: string,
	configs: Map<string, EditorConfig>,
): number | undefined {
	const dirs = directories(path);
	let start = 0;
	dirs.forEach((dir, i) => {
		if (configs.get(dir)?.root) start = i;
	});
	const props: Record<string, string> = {};
	for (const dir of dirs.slice(start)) {
		const config = configs.get(dir);
		if (!config) continue;
		const relative = path.slice(dir.length);
		for (const section of config.sections) {
			if (section.pattern.test(relative)) Object.assign(props, section.props);
		}
	}
	return width(props.tab_width) ?? width(props.indent_size);
}

/**
 * Reads every .editorconfig above `paths` in `commit` (one `git cat-file
 * --batch`) and gives each path's tab width, or undefined.
 */
export async function readTabWidths(
	repo: string,
	commit: string,
	paths: string[],
): Promise<(number | undefined)[]> {
	// A path git can't take on one line can't be looked up: no config there.
	const dirs = [...new Set(paths.flatMap(directories))].filter(
		(d) => !/[\n\r]/.test(d),
	);
	const configs = new Map<string, EditorConfig>();
	if (dirs.length > 0) {
		const out = await runGitBuffer(repo, ["cat-file", "--batch"], {
			input: dirs.map((d) => `${commit}:${d}.editorconfig\n`).join(""),
		});
		let pos = 0;
		for (const dir of dirs) {
			const eol = out.indexOf(0x0a, pos);
			if (eol < 0) break;
			const header = out.toString("utf8", pos, eol);
			const match = / (\w+) (\d+)$/.exec(header);
			if (!match || header.endsWith(" missing")) {
				pos = eol + 1;
				continue;
			}
			const start = eol + 1;
			const end = start + Number(match[2]);
			if (match[1] === "blob") {
				configs.set(dir, parseEditorConfig(out.toString("utf8", start, end)));
			}
			pos = end + 1;
		}
	}
	return paths.map((path) => tabWidthFor(path, configs));
}
