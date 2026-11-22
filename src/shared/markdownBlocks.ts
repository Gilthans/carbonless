import { marked, type Token, type Tokens } from "marked";

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
	out.push({
		kind: "list-item",
		from: start,
		to: Math.min(end, start + ownLines - 1),
		depth,
	});
	const mark = out.length;
	// A nested list starts on the line after the item's own lines and any blank lines.
	const beforeRaw = before.map((t) => t.raw).join("");
	walk(
		item.tokens.slice(nested, nested + 1),
		start + newlines(beforeRaw),
		depth + 1,
		out,
	);
	const nestedEnd =
		out.length > mark ? Math.max(...out.slice(mark).map((b) => b.to)) : start;
	const after = item.tokens.slice(nested + 1);
	if (
		after.some((t) => t.type !== "space" && t.type !== "list") &&
		nestedEnd < end
	) {
		out.push({ kind: "list-item", from: nestedEnd + 1, to: end, depth });
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

export function markdownBlocks(lines: readonly string[]): MdBlock[] {
	const clean = lines.map((l) => l.replace(/\r$/, ""));
	const out: MdBlock[] = [];
	const fm = frontMatterEnd(clean);
	if (fm > 0) out.push({ kind: "front-matter", from: 1, to: fm, depth: 0 });
	const rest = clean.slice(fm);
	const tokens = marked.lexer(rest.join("\n"));
	walk(tokens, fm + 1, 0, out);
	return out;
}

export function blockOfLine(blocks: readonly MdBlock[], line: number): number {
	if (blocks.length === 0) return -1;
	let found = -1;
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i] as MdBlock;
		if (b.from > line) break;
		found = i;
	}
	return found === -1 ? 0 : found;
}
