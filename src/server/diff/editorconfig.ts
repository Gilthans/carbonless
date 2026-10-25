import { runGitBuffer } from "../git.js";

/**
 * Tab widths from .editorconfig (https://editorconfig.org), read from a
 * commit: only what tabs need (`tab_width`, else a numeric `indent_size`),
 * with the spec's precedence (closer files and later sections win, `root =
 * true` stops the search upward).
 */

interface Section {
	pattern: Glob;
	props: Record<string, string>;
}

interface EditorConfig {
	root: boolean;
	sections: Section[];
}

/** A compiled glob: whether a path (relative to the config's dir) matches. */
export interface Glob {
	test(path: string): boolean;
}

type GlobNode =
	| { t: "char"; test: (ch: string) => boolean }
	/** `*`: any run within one path segment. */
	| { t: "star" }
	/** `**`: any run, across segments. */
	| { t: "any" }
	/** `**` + `/`: any run of whole directories, or none. */
	| { t: "dirs" }
	| { t: "alt"; options: GlobNode[][] }
	| { t: "range"; lo: number; hi: number };

type State =
	| { t: "char"; test: (ch: string) => boolean; next: number }
	| { t: "split"; next: number[] }
	| { t: "range"; lo: number; hi: number; next: number }
	| { t: "match" };

/** Past these, a header is a pathological pattern: its section is ignored. */
const MAX_STATES = 4096;
const MAX_RANGES = 16;

const literal = (c: string): GlobNode => ({
	t: "char",
	test: (ch) => ch === c,
});

/** Parses the spec's glob syntax into nodes (runs of `*` collapsed). */
function parseGlob(body: string): GlobNode[] {
	const frames: GlobNode[][][] = [[[]]];
	const current = () => {
		const options = frames[frames.length - 1] as GlobNode[][];
		return options[options.length - 1] as GlobNode[];
	};
	let ranges = 0;
	let i = 0;
	while (i < body.length) {
		const ch = body[i] as string;
		if (ch === "\\" && i + 1 < body.length) {
			current().push(literal(body[i + 1] as string));
			i += 2;
			continue;
		}
		if (ch === "*") {
			let end = i;
			while (body[end] === "*") end++;
			if (end - i === 1) current().push({ t: "star" });
			else if (body[end] === "/") {
				// "**/" also matches no directory at all.
				current().push({ t: "dirs" });
				end++;
			} else current().push({ t: "any" });
			i = end;
			continue;
		}
		if (ch === "?") {
			current().push({ t: "char", test: (c) => c !== "/" });
			i++;
			continue;
		}
		if (ch === "[") {
			const close = body.indexOf("]", i + 1);
			if (close > i + 1) {
				let set = body.slice(i + 1, close);
				const negate = set.startsWith("!");
				if (negate) set = set.slice(1);
				// One character against a class: no backtracking.
				const re = new RegExp(
					`^[${negate ? "^" : ""}${set.replace(/[\\\]^]/g, "\\$&")}]$`,
				);
				current().push({ t: "char", test: (c) => re.test(c) });
				i = close + 1;
				continue;
			}
			current().push(literal("["));
			i++;
			continue;
		}
		if (ch === "{") {
			const close = body.indexOf("}", i + 1);
			const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body.slice(i + 1, close));
			if (close > 0 && range) {
				if (++ranges > MAX_RANGES) throw new Error("too many ranges");
				const [lo, hi] = [Number(range[1]), Number(range[2])].sort(
					(a, b) => a - b,
				) as [number, number];
				current().push({ t: "range", lo, hi });
				i = close + 1;
				continue;
			}
			if (close > 0 && body.slice(i + 1, close).includes(",")) {
				frames.push([[]]);
				i++;
				continue;
			}
			current().push(literal("{"));
			i++;
			continue;
		}
		if (ch === "," && frames.length > 1) {
			(frames[frames.length - 1] as GlobNode[][]).push([]);
			i++;
			continue;
		}
		if (ch === "}" && frames.length > 1) {
			const options = frames.pop() as GlobNode[][];
			current().push({ t: "alt", options });
			i++;
			continue;
		}
		current().push(literal(ch));
		i++;
	}
	// An unclosed brace closes at the end.
	while (frames.length > 1) {
		const options = frames.pop() as GlobNode[][];
		current().push({ t: "alt", options });
	}
	return (frames[0] as GlobNode[][])[0] as GlobNode[];
}

/** Thompson construction: the nodes as states, built back to front. */
function build(nodes: GlobNode[], next: number, states: State[]): number {
	const add = (state: State) => {
		if (states.length >= MAX_STATES) throw new Error("glob too large");
		states.push(state);
		return states.length - 1;
	};
	let entry = next;
	for (let k = nodes.length - 1; k >= 0; k--) {
		const node = nodes[k] as GlobNode;
		const after = entry;
		switch (node.t) {
			case "char":
				entry = add({ t: "char", test: node.test, next: after });
				break;
			case "range":
				entry = add({ t: "range", lo: node.lo, hi: node.hi, next: after });
				break;
			case "star":
			case "any": {
				const loop = add({ t: "split", next: [] });
				const test = node.t === "star" ? (c: string) => c !== "/" : () => true;
				const step = add({ t: "char", test, next: loop });
				(states[loop] as { next: number[] }).next = [step, after];
				entry = loop;
				break;
			}
			case "dirs": {
				const slash = add({ t: "char", test: (c) => c === "/", next: after });
				const loop = add({ t: "split", next: [] });
				const step = add({ t: "char", test: () => true, next: loop });
				(states[loop] as { next: number[] }).next = [step, slash];
				entry = add({ t: "split", next: [loop, after] });
				break;
			}
			case "alt":
				entry = add({
					t: "split",
					next: node.options.map((option) => build(option, after, states)),
				});
				break;
		}
	}
	return entry;
}

/**
 * The spec's globs over a path relative to the config's directory, matched
 * by simulating all states at once: linear in the path, whatever the glob
 * (no backtracking, so no pathological headers). Throws for a header too
 * large to match safely.
 */
export function compileGlob(glob: string): Glob {
	const anchored = glob.includes("/");
	const body = glob.startsWith("/") ? glob.slice(1) : glob;
	const nodes = parseGlob(body);
	if (!anchored) nodes.unshift({ t: "dirs" });
	const states: State[] = [{ t: "match" }];
	const start = build(nodes, 0, states);
	return {
		test(path: string): boolean {
			const chars = Array.from(path);
			// Live states at each position (a range jumps ahead). `mark` keeps
			// a state from being added twice to a position.
			const at: number[][] = [[start]];
			const mark = new Int32Array(states.length).fill(-1);
			mark[start] = 0;
			const add = (pos: number, id: number) => {
				if (mark[id] === pos) return;
				mark[id] = pos;
				let list = at[pos];
				if (!list) {
					list = [];
					at[pos] = list;
				}
				list.push(id);
			};
			for (let pos = 0; pos <= chars.length; pos++) {
				const live = at[pos];
				if (!live) continue;
				// Splits add to the list while it is walked: their targets too.
				for (let k = 0; k < live.length; k++) {
					const state = states[live[k] as number] as State;
					if (state.t === "split") {
						for (const n of state.next) add(pos, n);
					} else if (state.t === "match") {
						if (pos === chars.length) return true;
					} else if (pos < chars.length) {
						if (state.t === "char") {
							if (state.test(chars[pos] as string)) add(pos + 1, state.next);
						} else {
							// An integer: digits, maybe signed, read up to 20 of them.
							let end = pos;
							const sign = chars[end] === "-" ? -1 : 1;
							if (sign < 0) end++;
							let n = 0;
							for (let digits = 0; digits < 20; digits++) {
								const d = (chars[end] ?? "").charCodeAt(0) - 48;
								if (!(d >= 0 && d <= 9)) break;
								n = n * 10 + d;
								end++;
								if (sign * n >= state.lo && sign * n <= state.hi) {
									add(end, state.next);
								}
							}
						}
					}
				}
				at[pos] = [];
			}
			return false;
		},
	};
}

export function parseEditorConfig(text: string): EditorConfig {
	const config: EditorConfig = { root: false, sections: [] };
	let current: Section | null = null;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const header = /^\[(.*)\]$/.exec(line);
		if (header) {
			try {
				current = { pattern: compileGlob(header[1] as string), props: {} };
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
