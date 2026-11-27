import DOMPurify from "dompurify";
import { Lexer, type Links, Marked, Parser } from "marked";
import { type MdBlock, parseable } from "../../../../shared/markdownBlocks";
import { safeHref } from "../../../ui";
import { hasUnseen, looksOf } from "./visibleText";
import {
	DEL_CLOSE,
	DEL_OPEN,
	INS_CLOSE,
	INS_OPEN,
	mergedSource,
	newSide,
	oldSide,
	SENTINEL,
} from "./wordMarks";

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
 *   a relative one it turns down shows still (an icon and its path); a
 *   remote one (any scheme, or `//host`) becomes a placeholder button that
 *   shows its URL and never loads it.
 *
 * View-agnostic: nothing here knows which side or revision the lines are from,
 * so the full diff and the since view render alike.
 */

export interface RenderedBlock {
	index: number;
	/** Sanitized HTML for the one block. */
	html: string;
	/**
	 * Sanitizing dropped some of the block's source (an HTML comment, a
	 * script, a style or class attribute): its rendering may not show
	 * everything its source says, so the view shows a changed block's
	 * changed lines under it (MarkdownView's hidden change).
	 */
	hidden?: true;
}

/** Whether sanitizing dropped anything of the content (`RenderedBlock.hidden`). */
interface Lost {
	any: boolean;
}

export interface RenderOptions {
	/** A relative image src → a URL to load it from; null: show a placeholder. */
	image: (src: string) => string | null;
}

/**
 * The document DOMPurify parses into: its removal isn't a loss, unless
 * content gave it attributes (`<body onload=…>` lands on it).
 */
const WRAPPER = new Set(["HTML", "HEAD", "BODY"]);
const isWrapper = (n: Node): boolean =>
	WRAPPER.has(n.nodeName) && !(n instanceof Element && n.attributes.length > 0);

/** sanitize's options: with `tokens`, local images wait for resolveImages. */
interface SanitizeOptions extends RenderOptions {
	tokens?: Map<string, string>;
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

/** Where a relative src is resolved to tell it from a remote one. */
const PROBE_BASE = "http://local.invalid/a/b/";
const PROBE_ORIGIN = "http://local.invalid";

/**
 * As the URL parser reads a src: C0 controls and spaces trimmed, tabs and
 * newlines dropped, backslashes as slashes (http(s) URLs).
 */
const normalizeSrc = (s: string): string =>
	s
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the URL parser's own trim
		.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
		.replace(/[\t\n\r]/g, "")
		.replace(/\\/g, "/");

/** No scheme, and resolved against a page it stays on that page's origin. */
function isLocalSrc(s: string): boolean {
	if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
	try {
		return new URL(s, PROBE_BASE).origin === PROBE_ORIGIN;
	} catch {
		return false;
	}
}

/**
 * A src as a path relative to the Markdown file, or null when it is remote
 * (any scheme, another host however spelled) or doesn't parse. Decided the
 * way the browser will read it, both as written and percent-decoded, so the
 * path handed to `image()` can't turn remote when the view resolves it.
 */
function localSrc(raw: string): string | null {
	const clean = normalizeSrc(raw);
	if (!clean || !isLocalSrc(clean)) return null;
	let decoded = clean;
	try {
		decoded = normalizeSrc(decodeURIComponent(clean));
	} catch {
		// A malformed escape: the src as written.
	}
	return decoded && isLocalSrc(decoded) ? decoded : null;
}

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

/**
 * A placeholder's words: the image's alt text, when it has one, then where
 * it is from (so a changed alt, or another path, reads as changed).
 */
function placeholderText(
	doc: Document,
	el: HTMLElement,
	alt: string,
	where: string,
) {
	if (alt) {
		const a = doc.createElement("span");
		a.className = "md-image-alt";
		a.textContent = alt;
		el.appendChild(a);
	}
	const w = doc.createElement("span");
	w.className = "md-image-path";
	w.textContent = where;
	el.appendChild(w);
}

function placeholder(
	doc: Document,
	url: string,
	alt: string,
): HTMLButtonElement {
	const button = doc.createElement("button");
	button.type = "button";
	button.className = "md-remote-image";
	button.setAttribute("data-remote-src", url);
	placeholderText(doc, button, alt, url);
	return button;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** Octicons' image (16px). */
const IMAGE_PATH =
	"M16 13.25A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75ZM1.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h.94l.03-.03 6.077-6.078a1.75 1.75 0 0 1 2.412-.06L14.5 10.31V2.75a.25.25 0 0 0-.25-.25Zm12.5 11a.25.25 0 0 0 .25-.25v-.917l-4.298-3.889a.25.25 0 0 0-.344.009L4.81 13.5ZM7 6a2 2 0 1 1-3.999.001A2 2 0 0 1 7 6ZM5.5 6a.5.5 0 1 0-1 0 .5.5 0 0 0 1 0Z";

/**
 * A relative image the review can't load (not one of its changed images):
 * its icon, alt text and path, nothing to click (until CAR-268 loads any
 * image of the repo).
 */
function localPlaceholder(
	doc: Document,
	path: string,
	alt: string,
	why = "Not in this PR",
): HTMLSpanElement {
	const span = doc.createElement("span");
	span.className = "md-local-image";
	span.setAttribute("role", "img");
	span.setAttribute(
		"aria-label",
		`${alt ? `${alt}, ` : ""}${path}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`,
	);
	span.setAttribute("title", why);
	const svg = doc.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("aria-hidden", "true");
	const d = doc.createElementNS(SVG_NS, "path");
	d.setAttribute("d", IMAGE_PATH);
	d.setAttribute("fill", "currentColor");
	svg.appendChild(d);
	span.appendChild(svg);
	placeholderText(doc, span, alt, path);
	return span;
}

/**
 * An image's src while a merged block is checked (mergedBody): its path,
 * not yet a side's URL, so the merged and each side's render compare
 * equal; `resolveImages` then loads each from its side.
 */
const IMAGE_TOKEN = "crb-image:";

/** A loaded image's path as written (placeImage). */
const PATH_ATTR = "data-md-path";

/**
 * A loaded image that failed to load (an image missing at the compared
 * patch set, a blob the route turns down) → a still placeholder saying
 * `why`, never a broken image. Only images placeImage loaded: content's
 * own can't reach here (DOMPurify strips data-*).
 */
export function stillImage(img: HTMLImageElement, why: string): boolean {
	const path = img.getAttribute(PATH_ATTR);
	if (path === null) return false;
	const alt = (img.getAttribute("alt") ?? "").trim();
	img.replaceWith(localPlaceholder(img.ownerDocument, path, alt, why));
	return true;
}

/**
 * A remote image's placeholder (`placeholder`) clicked: the image, loaded
 * from `url` (already checked http(s): remoteImageUrl) without a
 * referrer, with the placeholder's alt; should it fail to load, it becomes
 * a still placeholder (`stillImage`) as a loaded local one does, never a
 * broken image (CAR-318).
 */
export function loadRemoteImage(button: Element, url: string): void {
	const img = button.ownerDocument.createElement("img");
	img.setAttribute("referrerpolicy", "no-referrer");
	img.alt = button.querySelector(".md-image-alt")?.textContent ?? "";
	img.setAttribute(PATH_ATTR, url);
	img.src = url;
	button.replaceWith(img);
}

/** `img`, its src resolved to `url`, or the placeholder it becomes. */
function placeImage(
	img: HTMLImageElement,
	raw: string,
	src: string | null,
	url: string | null,
) {
	const doc = img.ownerDocument;
	const alt = (img.getAttribute("alt") ?? "").trim();
	if (url) {
		img.setAttribute("src", url);
		img.setAttribute("referrerpolicy", "no-referrer");
		// Its path as written, for the still it becomes if it fails to
		// load (`stillImage`). Set after DOMPurify: content can't forge it.
		img.setAttribute(PATH_ATTR, raw.trim());
	} else if (src !== null) {
		img.replaceWith(localPlaceholder(doc, raw.trim(), alt));
	} else if (raw) {
		img.replaceWith(placeholder(doc, raw, alt));
	} else {
		img.remove();
	}
}

/**
 * marked's HTML → safe HTML. Placeholders and link targets are added after
 * DOMPurify ran, so content can never bring its own (buttons and data-*
 * attributes are not on the allow-list).
 */
function sanitize(
	html: string,
	opts: SanitizeOptions,
	lost?: Lost,
): HTMLElement {
	const purify = getPurify();
	const body = purify.sanitize(html, {
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
		RETURN_DOM: true,
	}) as HTMLElement;
	// What DOMPurify took out (its `removed`, this call's): elements,
	// comments and attributes the source had and the rendering won't show.
	// Not the document it parsed into (its body is always on the list).
	if (
		lost &&
		purify.removed.some((r) => !("element" in r) || !isWrapper(r.element))
	) {
		lost.any = true;
	}
	const doc = body.ownerDocument;
	for (const el of body.querySelectorAll("[class]")) {
		const kept = [...el.classList].filter((c) => KEPT_CLASS.test(c));
		if (lost && kept.length < el.classList.length) lost.any = true;
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
		const src = localSrc(raw);
		if (opts.tokens && src !== null) {
			// Resolved once checked (resolveImages): kept as written for now.
			opts.tokens.set(src, raw);
			img.setAttribute("src", `${IMAGE_TOKEN}${encodeURIComponent(src)}`);
			continue;
		}
		placeImage(img, raw, src, src === null ? null : opts.image(src));
	}
	for (const table of body.querySelectorAll("table")) {
		// A table scrolls sideways in its own box (the page never does).
		const box = doc.createElement("div");
		box.className = "md-table";
		table.replaceWith(box);
		box.appendChild(table);
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
	lost?: Lost,
): string {
	if (!parseable(src.split("\n"))) return sourcePre(src);
	try {
		const body = sanitize(toHtml(src, links), opts, lost);
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

export interface MergedOptions extends RenderOptions {
	/**
	 * The old side's image resolver: a removed image (in a `del.md-del`
	 * mark) and the old side alone load from it, never from the new side's
	 * blob. `image` when unset.
	 */
	oldImage?: (src: string) => string | null;
	/** The file's reference definitions (`[a]: url`), as `renderBlocks` resolves them. */
	links?: Links;
	/**
	 * A table row's header block source (header + delimiter lines): the row is
	 * rendered under it and the header dropped, as `renderBlocks` does.
	 */
	header?: string;
	/**
	 * Each side's own block source (renderPair's, CAR-318): the merged
	 * body is checked against these rendered, not against the merged
	 * source's sides, so a merge that lost or moved a change (or a side
	 * that isn't the block's own) gives null. Without them, against the
	 * merged source's own sides.
	 */
	sources?: { old: string; new: string };
}

/** Elements a mark never wraps: it goes inside them (a run split at each). */
const BLOCK_TAGS = new Set([
	"BLOCKQUOTE",
	"DD",
	"DETAILS",
	"DIV",
	"DL",
	"DT",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HR",
	"LI",
	"OL",
	"P",
	"PRE",
	"SUMMARY",
	"TABLE",
	"TBODY",
	"TD",
	"TFOOT",
	"TH",
	"THEAD",
	"TR",
	"UL",
]);

/** Parents whose text the HTML parser moves out: no mark goes in them. */
const NO_TEXT = new Set(["OL", "UL", "TABLE", "TBODY", "TFOOT", "THEAD", "TR"]);

/** The node after `n` and its subtree, in document order. */
function nextAfter(n: Node | null): Node | null {
	while (n && !n.nextSibling) n = n.parentNode;
	return n?.nextSibling ?? null;
}

/**
 * Wraps everything strictly between the sentinel nodes `open` and `close`
 * in mark elements: inline nodes in maximal sibling groups, block elements
 * entered rather than wrapped, so a run crossing a cell or item splits at
 * its edge. Nothing is copied or dropped: nodes only move into wrappers.
 */
function wrapBetween(open: Node, close: Node, make: () => HTMLElement) {
	let group: Node[] = [];
	const flush = () => {
		const first = group[0];
		const parent = first?.parentNode;
		if (first && parent && !NO_TEXT.has(parent.nodeName)) {
			const w = make();
			parent.insertBefore(w, first);
			for (const g of group) w.appendChild(g);
		}
		group = [];
	};
	let n = nextAfter(open);
	while (n && n !== close) {
		if (n.contains(close) || BLOCK_TAGS.has(n.nodeName)) {
			flush();
			n = n.firstChild ?? nextAfter(n);
			continue;
		}
		if (group.length && group[group.length - 1]?.nextSibling !== n) flush();
		group.push(n);
		n = nextAfter(n);
	}
	flush();
	if (n !== close) throw new Error("mark not closed");
}

/**
 * Turns the sentinels in `body`'s text into `del.md-del` / `ins.md-ins`.
 * Throws when they don't pair up in order (the caller then shows no marks).
 */
function applyMarks(body: HTMLElement) {
	const doc = body.ownerDocument;
	const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
	const marks: Text[] = [];
	for (let t = walker.nextNode() as Text | null; t; ) {
		const k = t.data.search(SENTINEL);
		if (k === -1) {
			t = walker.nextNode() as Text | null;
			continue;
		}
		const mark = k === 0 ? t : t.splitText(k);
		const rest = mark.data.length > 1 ? mark.splitText(1) : null;
		marks.push(mark);
		walker.currentNode = mark;
		t = rest ?? (walker.nextNode() as Text | null);
	}
	if (marks.length % 2) throw new Error("unpaired mark");
	for (let i = 0; i < marks.length; i += 2) {
		const open = (marks[i] as Text).data;
		const close = (marks[i + 1] as Text).data;
		const del = open === DEL_OPEN && close === DEL_CLOSE;
		if (!del && !(open === INS_OPEN && close === INS_CLOSE)) {
			throw new Error("crossed marks");
		}
		wrapBetween(marks[i] as Text, marks[i + 1] as Text, () => {
			const el = doc.createElement(del ? "del" : "ins");
			el.className = del ? "md-del" : "md-ins";
			return el;
		});
	}
	for (const m of marks) m.remove();
}

/** `body` with one side's marks: the other side's dropped, this side's unwrapped. */
function sideOf(body: HTMLElement, keep: "del" | "ins"): string {
	const copy = body.cloneNode(true) as HTMLElement;
	const drop = keep === "del" ? "ins.md-ins" : "del.md-del";
	for (const el of copy.querySelectorAll(drop)) el.remove();
	for (const el of copy.querySelectorAll(
		keep === "del" ? "del.md-del" : "ins.md-ins",
	)) {
		el.replaceWith(...el.childNodes);
	}
	copy.normalize();
	return copy.innerHTML;
}

/**
 * A merged source (`mergedSource`, wordMarks.ts) → sanitized HTML with the
 * removed words in `del.md-del` and the added ones in `ins.md-ins`, or null
 * when the marks can't be shown faithfully: the view then shows the old
 * block struck above the new.
 *
 * The marks are elements the renderer adds after DOMPurify, from the
 * sentinels, so content can't forge one (its own `<del>`/`<ins>` render
 * but lose every class). The result is checked against both sides: with
 * the `md-ins` marks dropped it must equal the old side rendered alone, and
 * with the `md-del` ones dropped, the new side (each block's own source,
 * `opts.sources`, when given). So a mark that moved syntax
 * (a split link, emphasis across a mark, a pipe in a struck run) gives null,
 * never a wrong picture; and no sentinel survives into the output.
 */
export function renderMerged(src: string, opts: MergedOptions): string | null {
	const checked = mergedBody(src, opts);
	if (!checked) return null;
	resolveImages(checked.body, checked.raws, opts);
	return checked.body.innerHTML;
}

/**
 * A checked merged body's images, each from its side: in a `del.md-del`
 * mark (a removed image) the old side's (`oldImage`), else the new
 * side's; with `only`, every image from that side (one side shown alone).
 */
function resolveImages(
	body: HTMLElement,
	raws: ReadonlyMap<string, string>,
	opts: MergedOptions,
	only?: "old" | "new",
) {
	for (const img of body.querySelectorAll("img")) {
		const token = img.getAttribute("src") ?? "";
		if (!token.startsWith(IMAGE_TOKEN)) continue;
		const src = decodeURIComponent(token.slice(IMAGE_TOKEN.length));
		const old =
			only === undefined ? img.closest("del.md-del") !== null : only === "old";
		const resolve = old ? (opts.oldImage ?? opts.image) : opts.image;
		placeImage(img, raws.get(src) ?? src, src, resolve(src));
	}
}

/**
 * `renderMerged`'s checked body, or null; its local images still tokens
 * (IMAGE_TOKEN) for resolveImages, with each one's src as written.
 */
function mergedBody(
	src: string,
	opts: MergedOptions,
): { body: HTMLElement; raws: ReadonlyMap<string, string> } | null {
	if (!parseable(src.split("\n"))) return null;
	const links = opts.links ?? {};
	const tokens = new Map<string, string>();
	const body = (s: string): HTMLElement | null => {
		const full = opts.header === undefined ? s : `${opts.header}\n${s}`;
		const el = sanitize(toHtml(full, links), { ...opts, tokens });
		if (opts.header !== undefined) {
			const heads = el.querySelectorAll("thead");
			if (!heads.length) return null;
			for (const thead of heads) thead.remove();
		}
		return el;
	};
	try {
		const merged = body(src);
		const oldBody = body(opts.sources?.old ?? oldSide(src));
		const newBody = body(opts.sources?.new ?? newSide(src));
		if (!merged || !oldBody || !newBody) return null;
		applyMarks(merged);
		const html = merged.innerHTML;
		if (!html.trim() || SENTINEL.test(html)) return null;
		oldBody.normalize();
		newBody.normalize();
		if (sideOf(merged, "del") !== oldBody.innerHTML) return null;
		if (sideOf(merged, "ins") !== newBody.innerHTML) return null;
		return { body: merged, raws: tokens };
	} catch {
		return null;
	}
}

/** `body` showing one side, its own marks kept: the other side's dropped. */
function markedSide(body: HTMLElement, keep: "del" | "ins"): string {
	const copy = body.cloneNode(true) as HTMLElement;
	const drop = keep === "del" ? "ins.md-ins" : "del.md-del";
	for (const el of copy.querySelectorAll(drop)) el.remove();
	copy.normalize();
	return copy.innerHTML;
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

const MARKER_RUN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;

/**
 * How many lists a list item sits in beyond what its own source opens: its
 * depth less its quotes, less the extra markers on its first line (`- - a`
 * already renders nested). Its HTML goes in that many list wrappers, so a
 * nested item renders nested.
 */
function nestOf(b: MdBlock, own: readonly string[], quotes: number): number {
	if (b.kind !== "list-item") return 0;
	let rest = own[0] ?? "";
	let markers = 0;
	for (let m = MARKER_RUN.exec(rest); m?.[0]; m = MARKER_RUN.exec(rest)) {
		markers++;
		rest = rest.slice(m[0].length);
	}
	return Math.max(0, b.depth - quotes - Math.max(0, markers - 1));
}

/**
 * Each list item tail's list (a continuation after a nested list: no
 * marker of its own): the kind of the item it continues, `ol` under a
 * numbered one, so the tail stays in that list (CAR-318); undefined for
 * any other block. One forward pass: the last item opened at each depth.
 */
export function tailLists(
	lines: readonly string[],
	blocks: readonly MdBlock[],
): ("ol" | "ul" | undefined)[] {
	const open: ("ol" | "ul")[] = [];
	return blocks.map((b) => {
		if (b.kind !== "list-item") return undefined;
		const marker = LIST_MARKER.exec(unwrap(lines, b).lines[0] ?? "");
		if (marker) {
			open.length = b.depth;
			open[b.depth] = /^\d/.test(marker[0]) ? "ol" : "ul";
			return undefined;
		}
		return open[b.depth] ?? "ul";
	});
}

/** A tail's HTML as its item's own: in a list of its kind, with no marker. */
const continued = (html: string, list: "ol" | "ul"): string =>
	`<${list}><li class="md-continuation">${html}</li></${list}>`;

/** `html` inside `levels` list wrappers (no markers of their own). */
const renest = (html: string, levels: number): string =>
	'<ul class="md-nest"><li class="md-nest">'.repeat(levels) +
	html +
	"</li></ul>".repeat(levels);

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

/**
 * Each table row's header block (header + delimiter lines), in one forward
 * pass: a walk back per row would make a long table quadratic.
 */
export function tableHeaders(
	blocks: readonly MdBlock[],
): (MdBlock | undefined)[] {
	let header: MdBlock | undefined;
	return blocks.map((b) => {
		if (b.kind !== "table-row") header = undefined;
		else if (b.to > b.from) header = b;
		return header;
	});
}

function renderBlock(
	lines: readonly string[],
	blocks: readonly MdBlock[],
	i: number,
	opts: RenderOptions,
	links: Links,
	header: MdBlock | undefined,
	lost: Lost,
	tail: "ol" | "ul" = "ul",
): string {
	const b = blocks[i] as MdBlock;
	const { lines: own, quotes } = unwrap(lines, b);
	const src = own.join("\n");
	const kind = b.kind;
	const nest = nestOf(b, own, quotes);
	if (
		kind === "front-matter" ||
		kind === "html" ||
		kind === "def" ||
		(kind === "paragraph" && isMath(src))
	) {
		return requote(sourcePre(src), quotes);
	}
	if (kind === "table-row" && b.to === b.from) {
		if (header) {
			const head = unwrap(lines, header).lines.join("\n");
			const html = renderMarkdown(
				`${head}\n${src}`,
				opts,
				links,
				(body) => {
					for (const thead of body.querySelectorAll("thead")) thead.remove();
				},
				lost,
			);
			return requote(html, quotes);
		}
	}
	if (kind === "list-item" && !LIST_MARKER.test(own[0] ?? "")) {
		// The tail of an item after its nested list: still part of the item.
		const html = renderMarkdown(src, opts, links, undefined, lost);
		return requote(renest(continued(html, tail), nest), quotes);
	}
	return requote(
		renest(renderMarkdown(src, opts, links, undefined, lost), nest),
		quotes,
	);
}

/** Sanitized HTML for each of a file's blocks, in order; never drops one. */
export function renderBlocks(
	lines: readonly string[],
	blocks: readonly MdBlock[],
	opts: RenderOptions,
): RenderedBlock[] {
	const links = fileLinks(lines, blocks);
	const headers = tableHeaders(blocks);
	const tails = tailLists(lines, blocks);
	return blocks.map((b, index) => {
		try {
			const lost: Lost = { any: false };
			const html = renderBlock(
				lines,
				blocks,
				index,
				opts,
				links,
				headers[index],
				lost,
				tails[index],
			);
			return lost.any ? { index, html, hidden: true } : { index, html };
		} catch {
			const src = lines
				.slice(b.from - 1, b.to)
				.map(cleanLine)
				.join("\n");
			return { index, html: sourcePre(src) };
		}
	});
}

/**
 * One side's text and blocks, with what rendering a block of it reads of
 * the whole file (its reference links, each table row's header), worked
 * out once per file.
 */
export interface SideBlocks {
	lines: readonly string[];
	blocks: readonly MdBlock[];
	links: Links;
	headers: readonly (MdBlock | undefined)[];
	/** Each item tail's list (tailLists). */
	tails: readonly ("ol" | "ul" | undefined)[];
}

export function sideBlocks(
	lines: readonly string[],
	blocks: readonly MdBlock[],
): SideBlocks {
	return {
		lines,
		blocks,
		links: fileLinks(lines, blocks),
		headers: tableHeaders(blocks),
		tails: tailLists(lines, blocks),
	};
}

/** A changed block with its words marked: both sides in one, and each alone. */
export interface PairHtml {
	/** Removed words in `del.md-del`, added ones in `ins.md-ins`. */
	merged: string;
	/** The old side with its removed words marked (side by side). */
	old: string;
	/** The new side with its added words marked. */
	new: string;
	/**
	 * A word mark shows nothing (`marksHidden`): the view shows the
	 * block's changed lines as source too.
	 */
	hidden?: true;
}

/**
 * Whether a word mark may hide what it marks (no invisible change): one
 * that looks empty (`looksOf`: a tag character, a zero width alone);
 * one holding a character that prints as nothing or not as itself (a
 * zero width, a bidi control, a soft hyphen, a no-break space:
 * `hasUnseen`); or a removed mark next to an added one that looks the
 * same, or whose links, images and other elements look the same but for
 * their attributes (a link's target or title, an image's alt).
 */
function marksHidden(body: HTMLElement): boolean {
	for (const m of body.querySelectorAll("del.md-del, ins.md-ins")) {
		const look = looksOf(m);
		if (/^(?:<\/?[a-z][a-z0-9]*>)*$/.test(look) && !/<img /.test(look)) {
			return true;
		}
		if (hasUnseen(m.textContent ?? "")) return true;
		const next = m.nextSibling;
		if (
			m.matches("del.md-del") &&
			next instanceof Element &&
			next.matches("ins.md-ins")
		) {
			if (looksOf(next) === look) return true;
			const a = elementsOf(m);
			const b = elementsOf(next);
			if (
				a.length === b.length &&
				a.some((x, i) => {
					const y = b[i];
					return (
						y !== undefined &&
						x.tag === y.tag &&
						x.look === y.look &&
						x.attrs !== y.attrs
					);
				})
			) {
				return true;
			}
		}
	}
	return false;
}

/** Attributes the renderer sets the same way on both sides, or per side (an image's URL). */
const OWN_ATTRS = new Set(["class", "src", "target", "rel", "referrerpolicy"]);

/** A mark's elements: each one's tag, look and content-given attributes. */
function elementsOf(m: Element) {
	return [...m.querySelectorAll("*")].map((el) => ({
		tag: el.nodeName,
		look: looksOf(el),
		attrs: [...el.attributes]
			.filter((a) => !OWN_ATTRS.has(a.name))
			.map((a) => `${a.name}=${a.value}`)
			.sort()
			.join(" "),
	}));
}

const isContinuation = (b: MdBlock, own: readonly string[]) =>
	b.kind === "list-item" && !LIST_MARKER.test(own[0] ?? "");

const wrapBlock = (
	html: string,
	tail: "ol" | "ul" | undefined,
	quotes: number,
	nest: number,
) => requote(renest(tail ? continued(html, tail) : html, nest), quotes);

/**
 * Old block `oi` paired with new block `ni` (the cut's pairing), as one
 * block with the changed words marked (`mergedSource`, `renderMerged`), or
 * null when the marks can't show the change faithfully (another kind, a
 * code fence, a heading's level, another table header, other containers):
 * the view then shows the old block struck above the new. A removed image
 * (and the old side alone) loads through `opts.oldImage`, the rest through
 * `opts.image`.
 */
export function renderPair(
	old: SideBlocks,
	oi: number,
	nu: SideBlocks,
	ni: number,
	opts: Pick<MergedOptions, "image" | "oldImage">,
): PairHtml | null {
	const ob = old.blocks[oi];
	const nb = nu.blocks[ni];
	if (!ob || !nb || ob.kind !== nb.kind) return null;
	try {
		const uo = unwrap(old.lines, ob);
		const un = unwrap(nu.lines, nb);
		if (uo.quotes !== un.quotes) return null;
		const continuation = isContinuation(nb, un.lines);
		if (continuation !== isContinuation(ob, uo.lines)) return null;
		const tail = continuation ? (nu.tails[ni] ?? "ul") : undefined;
		if (continuation && (old.tails[oi] ?? "ul") !== tail) return null;
		let header: string | undefined;
		if (nb.kind === "table-row") {
			const oneRow = (b: MdBlock) => b.to === b.from;
			if (oneRow(nb) !== oneRow(ob)) return null;
			if (oneRow(nb)) {
				const nh = nu.headers[ni];
				const oh = old.headers[oi];
				if (!nh || !oh) return null;
				header = unwrap(nu.lines, nh).lines.join("\n");
				if (unwrap(old.lines, oh).lines.join("\n") !== header) return null;
			}
		}
		const merged = mergedSource(
			uo.lines.join("\n"),
			un.lines.join("\n"),
			nb.kind,
		);
		if (merged === null) return null;
		const mergedOpts: MergedOptions = {
			image: opts.image,
			// Checked against each block's own source, as written.
			sources: { old: uo.lines.join("\n"), new: un.lines.join("\n") },
			...(opts.oldImage ? { oldImage: opts.oldImage } : {}),
			links: { ...old.links, ...nu.links },
			...(header === undefined ? {} : { header }),
		};
		const checked = mergedBody(merged, mergedOpts);
		if (!checked) return null;
		const { body, raws } = checked;
		const sided = (only?: "old" | "new") => {
			const copy = body.cloneNode(true) as HTMLElement;
			resolveImages(copy, raws, mergedOpts, only);
			return copy;
		};
		const nest = nestOf(nb, un.lines, un.quotes);
		if (nest !== nestOf(ob, uo.lines, uo.quotes)) return null;
		const wrap = (html: string) => wrapBlock(html, tail, un.quotes, nest);
		const shown = sided();
		return {
			merged: wrap(shown.innerHTML),
			old: wrap(markedSide(sided("old"), "del")),
			new: wrap(markedSide(sided("new"), "ins")),
			...(marksHidden(shown) ? { hidden: true as const } : {}),
		};
	} catch {
		return null;
	}
}
