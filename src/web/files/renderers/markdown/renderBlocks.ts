import DOMPurify from "dompurify";
import { Lexer, type Links, Marked, Parser } from "marked";
import { type MdBlock, parseable } from "../../../../shared/markdownBlocks";
import { safeHref } from "../../../ui";

/**
 * A Markdown file's blocks (`markdownBlocks`) as sanitized HTML, one entry per
 * block, so the view can lay each rendered block next to the source lines it
 * came from. The file is the PR's: untrusted. marked's HTML never reaches the
 * DOM unsanitized:
 *
 * - raw HTML blocks, front matter and `$$` math show as escaped source;
 * - everything else goes through DOMPurify with an allow-list modelled on
 *   `sanitizeGithubHtml` (no scripts, styles, ids, data-*, forms or media);
 * - every href goes through `safeHref` (absolute http(s) only) and opens in a
 *   new tab;
 * - an image loads only through `opts.image` (a relative src → the PR's blob);
 *   a remote one (any scheme, or `//host`) becomes a placeholder button that
 *   shows its URL and never loads it.
 *
 * View-agnostic: nothing here knows which side or revision the lines are from,
 * so the full diff and the since view render alike.
 */

export interface RenderedBlock {
	index: number;
	/** Sanitized HTML for the one block. */
	html: string;
}

export interface RenderOptions {
	/** A relative image src → a URL to load it from; null: show a placeholder. */
	image: (src: string) => string | null;
}

const ALLOWED_TAGS = [
	"a",
	"abbr",
	"b",
	"blockquote",
	"br",
	"code",
	"dd",
	"del",
	"details",
	"dl",
	"dt",
	"em",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"i",
	"img",
	"input",
	"ins",
	"kbd",
	"li",
	"mark",
	"ol",
	"p",
	"pre",
	"q",
	"s",
	"samp",
	"small",
	"span",
	"strike",
	"strong",
	"sub",
	"summary",
	"sup",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"u",
	"ul",
	"var",
	"wbr",
];

const ALLOWED_ATTR = [
	"href",
	"src",
	"alt",
	"title",
	"width",
	"height",
	"align",
	"class",
	"type",
	"checked",
	"disabled",
	"open",
	"colspan",
	"rowspan",
	"start",
	"reversed",
	"lang",
	"dir",
];

/** Only a code block's language class survives: content can't borrow the app's classes. */
const KEPT_CLASS = /^language-[\w+#-]+$/;

/** A src that names its own host or scheme: never loaded (a placeholder). */
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i;

const marked = new Marked({ gfm: true, async: false });

let purify: ReturnType<typeof DOMPurify> | undefined;
function getPurify() {
	purify ??= DOMPurify(window);
	return purify;
}

const escapeHtml = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

/** A block shown as its source, escaped. */
const sourcePre = (src: string): string =>
	`<pre class="md-source">${escapeHtml(src)}</pre>`;

function placeholder(doc: Document, url: string): HTMLButtonElement {
	const button = doc.createElement("button");
	button.type = "button";
	button.className = "md-remote-image";
	button.setAttribute("data-remote-src", url);
	button.textContent = url;
	return button;
}

/**
 * marked's HTML → safe HTML. Placeholders and link targets are added after
 * DOMPurify ran, so content can never bring its own (buttons and data-*
 * attributes are not on the allow-list).
 */
function sanitize(html: string, opts: RenderOptions): HTMLElement {
	const body = getPurify().sanitize(html, {
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
		RETURN_DOM: true,
	}) as HTMLElement;
	const doc = body.ownerDocument;
	for (const el of body.querySelectorAll("[class]")) {
		const kept = [...el.classList].filter((c) => KEPT_CLASS.test(c));
		if (kept.length) el.setAttribute("class", kept.join(" "));
		else el.removeAttribute("class");
	}
	for (const a of body.querySelectorAll("a")) {
		const href = safeHref(a.getAttribute("href") ?? undefined);
		if (href) {
			a.setAttribute("href", href);
			a.setAttribute("target", "_blank");
			a.setAttribute("rel", "noreferrer noopener");
		} else {
			a.removeAttribute("href");
			a.removeAttribute("target");
			a.removeAttribute("rel");
		}
	}
	for (const img of body.querySelectorAll("img")) {
		const raw = img.getAttribute("src") ?? "";
		let src = raw;
		try {
			src = decodeURI(raw);
		} catch {
			// A malformed escape: hand on the src as written.
		}
		const url = raw && !REMOTE.test(raw.trim()) ? opts.image(src) : null;
		if (url) {
			img.setAttribute("src", url);
			img.setAttribute("referrerpolicy", "no-referrer");
		} else if (raw) {
			img.replaceWith(placeholder(doc, raw));
		} else {
			img.remove();
		}
	}
	for (const input of body.querySelectorAll("input")) {
		// Task-list checkboxes show state; nothing else is an input here.
		if (input.getAttribute("type") !== "checkbox") input.remove();
		else input.setAttribute("disabled", "");
	}
	return body;
}

function toHtml(src: string, links: Links): string {
	const lexer = new Lexer(marked.defaults);
	Object.assign(lexer.tokens.links, links);
	return new Parser(marked.defaults).parse(lexer.lex(src));
}

/** Source → sanitized HTML; hostile or failing source shows as itself. */
function renderMarkdown(
	src: string,
	opts: RenderOptions,
	links: Links,
	post?: (body: HTMLElement) => void,
): string {
	if (!parseable(src.split("\n"))) return sourcePre(src);
	try {
		const body = sanitize(toHtml(src, links), opts);
		post?.(body);
		const html = body.innerHTML;
		// Never an empty block: what rendered to nothing shows as its source.
		return html.trim() ? html : sourcePre(src);
	} catch {
		return sourcePre(src);
	}
}

/** A block's (or several merged blocks') source → sanitized HTML. */
export function renderSource(src: string, opts: RenderOptions): string {
	return renderMarkdown(src, opts, {});
}

const cleanLine = (l: string): string =>
	l.replace(/\r$/, "").replace(/\r/g, " ");

const QUOTE = /^[ \t]{0,3}>[ ]?/;

/** How many `>` the first line opens (its containing quotes). */
function quoteDepth(line: string): number {
	let q = 0;
	let rest = line;
	for (let m = QUOTE.exec(rest); m; m = QUOTE.exec(rest)) {
		q++;
		rest = rest.slice(m[0].length);
	}
	return q;
}

function stripQuotes(lines: string[], q: number): string[] {
	return lines.map((l) => {
		let rest = l;
		for (let i = 0; i < q; i++) {
			const m = QUOTE.exec(rest);
			if (!m) break;
			rest = rest.slice(m[0].length);
		}
		return rest;
	});
}

const indentOf = (l: string): number => {
	let n = 0;
	for (const c of l) {
		if (c === " ") n++;
		else if (c === "\t") n += 4 - (n % 4);
		else break;
	}
	return n;
};

/** Drops up to `n` columns of leading indent from each line. */
function dedent(lines: string[], n: number): string[] {
	if (n === 0) return lines;
	return lines.map((l) => {
		let col = 0;
		let i = 0;
		while (i < l.length && col < n && (l[i] === " " || l[i] === "\t")) {
			col += l[i] === "\t" ? 4 - (col % 4) : 1;
			i++;
		}
		return l.slice(i);
	});
}

const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * A block's lines without the containers around it: its quote markers and,
 * for a list item, the indent of the list it is nested in. `quotes` is how
 * many blockquotes to put back around its HTML.
 */
function unwrap(
	lines: readonly string[],
	b: MdBlock,
): { lines: string[]; quotes: number } {
	const raw = lines.slice(b.from - 1, b.to).map(cleanLine);
	const quotes = quoteDepth(raw[0] ?? "");
	let own = stripQuotes(raw, quotes);
	if (b.kind === "list-item") own = dedent(own, indentOf(own[0] ?? ""));
	return { lines: own, quotes };
}

const requote = (html: string, quotes: number): string =>
	"<blockquote>".repeat(quotes) + html + "</blockquote>".repeat(quotes);

const isMath = (src: string): boolean => {
	const t = src.trim();
	return t.length >= 4 && t.startsWith("$$") && t.endsWith("$$");
};

/** The links every reference definition in the file declares. */
function fileLinks(
	lines: readonly string[],
	blocks: readonly MdBlock[],
): Links {
	const links: Links = {};
	for (const b of blocks) {
		if (b.kind !== "def") continue;
		try {
			const src = unwrap(lines, b).lines.join("\n");
			Object.assign(links, new Lexer(marked.defaults).lex(src).links);
		} catch {
			// A definition that doesn't lex resolves nothing.
		}
	}
	return links;
}

/** The nearest table header block (header + delimiter lines) before `i`. */
function headerOf(blocks: readonly MdBlock[], i: number): MdBlock | undefined {
	for (let j = i - 1; j >= 0; j--) {
		const b = blocks[j] as MdBlock;
		if (b.kind !== "table-row") return undefined;
		if (b.to > b.from) return b;
	}
	return undefined;
}

function renderBlock(
	lines: readonly string[],
	blocks: readonly MdBlock[],
	i: number,
	opts: RenderOptions,
	links: Links,
): string {
	const b = blocks[i] as MdBlock;
	const { lines: own, quotes } = unwrap(lines, b);
	const src = own.join("\n");
	const kind = b.kind;
	if (
		kind === "front-matter" ||
		kind === "html" ||
		kind === "def" ||
		(kind === "paragraph" && isMath(src))
	) {
		return requote(sourcePre(src), quotes);
	}
	if (kind === "table-row" && b.to === b.from) {
		const header = headerOf(blocks, i);
		if (header) {
			const head = unwrap(lines, header).lines.join("\n");
			const html = renderMarkdown(`${head}\n${src}`, opts, links, (body) => {
				for (const thead of body.querySelectorAll("thead")) thead.remove();
			});
			return requote(html, quotes);
		}
	}
	if (kind === "list-item" && !LIST_MARKER.test(own[0] ?? "")) {
		// The tail of an item after its nested list: still part of the item.
		const html = renderMarkdown(src, opts, links);
		return requote(`<ul><li class="md-continuation">${html}</li></ul>`, quotes);
	}
	return requote(renderMarkdown(src, opts, links), quotes);
}

/** Sanitized HTML for each of a file's blocks, in order; never drops one. */
export function renderBlocks(
	lines: readonly string[],
	blocks: readonly MdBlock[],
	opts: RenderOptions,
): RenderedBlock[] {
	const links = fileLinks(lines, blocks);
	return blocks.map((b, index) => {
		try {
			return { index, html: renderBlock(lines, blocks, index, opts, links) };
		} catch {
			const src = lines
				.slice(b.from - 1, b.to)
				.map(cleanLine)
				.join("\n");
			return { index, html: sourcePre(src) };
		}
	});
}
