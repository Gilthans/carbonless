import { Lexer, type Token, type Tokens } from "marked";

// The rendered blocks of a Markdown file as exact source line ranges. Shared by
// the server (it cuts review clusters at block edges) and the web renderer (it
// tags rendered blocks), so both agree on what a block is. No DOM: runs in Node
// and the browser.

export type MdBlockKind =
	| "paragraph"
	| "heading"
	| "hr"
	| "list-item"
	| "table-row"
	| "code"
	| "front-matter"
	| "html"
	| "def";

/** `from`/`to`: 1-based inclusive source lines. `depth`: list and quote nesting. */
export interface MdBlock {
	kind: MdBlockKind;
	from: number;
	to: number;
	depth: number;
}

export const isMarkdownPath = (path: string): boolean =>
	/\.(md|markdown)$/i.test(path);

const newlines = (s: string): number => {
	let n = 0;
	for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
	return n;
};

/** Lines a token covers once trailing newlines (blank lines) are dropped. */
const spanLines = (raw: string): number =>
	newlines(raw.replace(/\n+$/, "")) + 1;

const SIMPLE_KINDS: Record<string, MdBlockKind> = {
	paragraph: "paragraph",
	heading: "heading",
	hr: "hr",
	code: "code",
	html: "html",
	def: "def",
};

function walk(
	tokens: Token[],
	start: number,
	depth: number,
	out: MdBlock[],
): void {
	let line = start;
	for (const token of tokens) {
		const first = line;
		line += newlines(token.raw);
		const lines = spanLines(token.raw);
		const simple = SIMPLE_KINDS[token.type];
		if (simple) {
			out.push({ kind: simple, from: first, to: first + lines - 1, depth });
		} else if (token.type === "table") {
			out.push({ kind: "table-row", from: first, to: first + 1, depth });
			for (let l = first + 2; l < first + lines; l++) {
				out.push({ kind: "table-row", from: l, to: l, depth });
			}
		} else if (token.type === "blockquote") {
			walk((token as Tokens.Blockquote).tokens, first, depth + 1, out);
		} else if (token.type === "list") {
			let itemStart = first;
			for (const item of (token as Tokens.List).items) {
				walkItem(item, itemStart, depth, out);
				itemStart += newlines(item.raw);
			}
		}
		// "space" and anything else: no block (blank lines belong to none)
	}
}

function walkItem(
	item: Tokens.ListItem,
	start: number,
	depth: number,
	out: MdBlock[],
): void {
	const end = start + spanLines(item.raw) - 1;
	const nested = item.tokens.findIndex((t) => t.type === "list");
	if (nested === -1) {
		out.push({ kind: "list-item", from: start, to: end, depth });
		return;
	}
	const before = item.tokens.slice(0, nested);
	const ownLines =
		newlines(
			before
				.map((t) => t.raw)
				.join("")
				.replace(/\n+$/, ""),
		) + 1;
	// `- - a`: the nested item starts on the item's own first line, so the
	// item owns no line of its own (each line belongs to the innermost block).
	if (before.some((t) => t.type !== "space")) {
		out.push({
			kind: "list-item",
			from: start,
			to: Math.min(end, start + ownLines - 1),
			depth,
		});
	}
	const mark = out.length;
	// A nested list starts on the line after the item's own lines and any blank lines.
	const beforeRaw = before.map((t) => t.raw).join("");
	walk(
		item.tokens.slice(nested, nested + 1),
		start + newlines(beforeRaw),
		depth + 1,
		out,
	);
	// Blocks are in document order, so the last one ends the nested list.
	const nestedEnd =
		out.length > mark ? (out[out.length - 1] as MdBlock).to : start;
	const after = item.tokens.slice(nested + 1);
	if (
		after.some((t) => t.type !== "space" && t.type !== "list") &&
		nestedEnd < end
	) {
		// Blank lines belong to no block: the tail starts at its first text line.
		const rawLines = item.raw.split("\n");
		let tail = nestedEnd + 1;
		while (tail < end && (rawLines[tail - start] ?? "").trim() === "") tail++;
		out.push({ kind: "list-item", from: tail, to: end, depth });
	}
}

function frontMatterEnd(lines: readonly string[]): number {
	if (lines[0]?.trimEnd() !== "---") return 0;
	for (let i = 1; i < lines.length; i++) {
		const l = lines[i]?.trimEnd();
		if (l === "---" || l === "...") return i + 1;
	}
	return 0;
}

/** Deepest quote/list/indent nesting a line may open before the parse is skipped. */
const MAX_NESTING = 64;
/** Largest document (characters) the parser is given. */
const MAX_CHARS = 1_000_000;
/** Longest line (characters) the parser is given. */
const MAX_LINE = 10_000;

/** Nesting a line opens: `>` quotes, list markers, and indent in steps of 4. */
function nestingOf(line: string): number {
	let depth = 0;
	let i = 0;
	for (;;) {
		let indent = 0;
		while (line[i] === " " || line[i] === "\t") {
			indent += line[i] === "\t" ? 4 : 1;
			i++;
			if (indent > MAX_NESTING * 4) return MAX_NESTING + 1;
		}
		depth += Math.floor(indent / 4);
		if (depth > MAX_NESTING) return depth;
		const rest = line.slice(i, i + 12);
		const marker = /^(?:>|[-*+](?=\s)|\d{1,9}[.)](?=\s))/.exec(rest);
		if (!marker) return depth;
		depth++;
		i += marker[0].length;
	}
}

/**
 * Backstop for the order and no-overlap contract: a block never starts at or
 * before the previous one's end. Trimming keeps every line covered.
 */
function disjoint(blocks: MdBlock[]): MdBlock[] {
	const out: MdBlock[] = [];
	let end = 0;
	for (const b of blocks) {
		const from = Math.max(b.from, end + 1);
		if (from > b.to) continue;
		out.push(from === b.from ? b : { ...b, from });
		end = b.to;
	}
	return out;
}

/** Hostile or oversized input: one paragraph per run of non-blank lines. */
function fallbackBlocks(lines: readonly string[], offset: number): MdBlock[] {
	const out: MdBlock[] = [];
	let from = 0;
	lines.forEach((l, i) => {
		const blank = l.trim() === "";
		if (blank && from) {
			out.push({ kind: "paragraph", from, to: offset + i, depth: 0 });
			from = 0;
		} else if (!blank && !from) from = offset + i + 1;
	});
	if (from)
		out.push({ kind: "paragraph", from, to: offset + lines.length, depth: 0 });
	return out;
}

export function markdownBlocks(lines: readonly string[]): MdBlock[] {
	// marked turns a lone \r into a newline, which would shift every later
	// range (git splits lines on \n only): keep each line's length, lose the \r.
	const clean = lines.map((l) => l.replace(/\r$/, "").replace(/\r/g, " "));
	const out: MdBlock[] = [];
	const fm = frontMatterEnd(clean);
	if (fm > 0) out.push({ kind: "front-matter", from: 1, to: fm, depth: 0 });
	const rest = clean.slice(fm);
	const size = rest.reduce((n, l) => n + l.length + 1, 0);
	if (
		size <= MAX_CHARS &&
		rest.every((l) => l.length <= MAX_LINE && nestingOf(l) <= MAX_NESTING)
	) {
		try {
			// Block structure only: no inline tokens (they cost, and are not needed).
			walk(new Lexer().blockTokens(rest.join("\n")), fm + 1, 0, out);
			return disjoint(out);
		} catch {
			out.length = fm > 0 ? 1 : 0;
		}
	}
	out.push(...fallbackBlocks(rest, fm));
	return out;
}

/**
 * The index of the block `line` falls in: the last block starting at or
 * before it (a blank or bare `>` line goes to the block before it), else the
 * first block; -1 with no blocks. A binary search: the block cut asks this
 * for every changed line.
 */
export function blockOfLine(blocks: readonly MdBlock[], line: number): number {
	if (blocks.length === 0) return -1;
	let lo = 0;
	let hi = blocks.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if ((blocks[mid] as MdBlock).from <= line) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}
