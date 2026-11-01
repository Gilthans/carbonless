/**
 * Keeps what a reviewer types in a GitHub comment as typed. GitHub's
 * markdown reads `<String>` in `List<String>` (or `<T>`) as an HTML tag,
 * and its sanitizer then drops it: the text is lost for everyone. Before
 * a body is posted, every `<` that starts a tag GitHub would drop gets a
 * markdown backslash escape (`\<`); the edit box undoes exactly those.
 *
 * Left alone: code spans and fenced or indented code blocks (an unclosed
 * fence runs to the end, as in CommonMark), HTML blocks, a `<` that
 * doesn't start a tag (`a < b`, `x<3`, `<=`, `Map<K, V>`), one already
 * escaped, HTML comments (carbonless's marker is one), autolinks, and
 * the tags GitHub keeps (GITHUB_KEPT_TAGS). Where the markdown is
 * ambiguous (a list item's indented paragraph) it errs towards code:
 * left as typed, never a stray backslash in code.
 */

/**
 * The tags GitHub keeps in a comment, opening or closing, any case
 * (probed on carbonless-scratch#1, 2026-11-01; `video` is kept by its
 * markdown API only, and left alone here as GitHub may keep it). The
 * rest (`abbr`, `cite`, `small`, `u`, `figure`, `caption`, `<T>`, ...)
 * it drops.
 */
export const GITHUB_KEPT_TAGS: ReadonlySet<string> = new Set([
	"a",
	"b",
	"blockquote",
	"br",
	"code",
	"dd",
	"del",
	"details",
	"div",
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
	"ins",
	"kbd",
	"li",
	"mark",
	"ol",
	"p",
	"picture",
	"pre",
	"q",
	"rp",
	"rt",
	"ruby",
	"s",
	"samp",
	"section",
	"source",
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
	"tt",
	"ul",
	"var",
	"video",
]);

/** GFM's tag filter: GitHub already shows these as text (`&lt;script>`). */
const TAG_FILTER = new Set([
	"iframe",
	"noembed",
	"noframes",
	"plaintext",
	"script",
	"style",
	"textarea",
	"title",
	"xmp",
]);

/** CommonMark's HTML block type 6 tag names (a line starting with one opens a block). */
const BLOCK_TAGS = new Set([
	"blockquote",
	"dd",
	"details",
	"div",
	"dl",
	"dt",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"li",
	"ol",
	"p",
	"section",
	"summary",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"ul",
]);

/** An HTML tag as CommonMark reads one (open or closing), at the regex's lastIndex. */
const TAG =
	/<(\/)?([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*)\s*(\/?)>/y;
/** Processing instructions, declarations and CDATA: GitHub drops them too. */
const OTHER_MARKUP =
	/<(?:\?[\s\S]*?\?>|![A-Za-z][^>]*>|!\[CDATA\[[\s\S]*?\]\]>)/y;
const COMMENT = /<!--[\s\S]*?-->/y;
const AUTOLINK =
	/<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;

/** Whether GitHub drops tag `name` (so it is escaped). */
function dropped(name: string, closing: boolean, bare: boolean): boolean {
	const n = name.toLowerCase();
	if (TAG_FILTER.has(n)) return false;
	if (!GITHUB_KEPT_TAGS.has(n)) return true;
	if (closing) return false;
	// `<a>` without an href GitHub drops; `Foo<B>` is a type parameter, not bold.
	return bare && (n === "a" || /^[A-Z]$/.test(name));
}

/** A `<` that starts a tag GitHub drops, and whether it is escaped already. */
interface Hit {
	at: number;
	escaped: boolean;
}

/**
 * What the markup at `at` (a `<`) is: a tag or markup GitHub drops
 * ("drop"), something to skip whole (kept tag, comment, autolink; its
 * end), or plain text (null).
 */
function markupAt(text: string, at: number): "drop" | { end: number } | null {
	for (const skip of [COMMENT, AUTOLINK]) {
		skip.lastIndex = at;
		if (skip.test(text)) return { end: skip.lastIndex };
	}
	TAG.lastIndex = at;
	const tag = TAG.exec(text);
	if (tag) {
		const bare = !(tag[3] ?? "").trim() && !tag[4];
		return dropped(tag[2] ?? "", !!tag[1], bare)
			? "drop"
			: { end: TAG.lastIndex };
	}
	OTHER_MARKUP.lastIndex = at;
	return OTHER_MARKUP.test(text) ? "drop" : null;
}

/** Inline markdown in `text` from `start` to `end`: the hits outside code spans. */
function scanInline(text: string, start: number, end: number, hits: Hit[]) {
	const seg = text.slice(0, end);
	let i = start;
	while (i < end) {
		const c = seg[i];
		if (c === "\\") {
			if (seg[i + 1] === "<" && markupAt(seg, i + 1) === "drop") {
				hits.push({ at: i + 1, escaped: true });
			}
			i += 2;
		} else if (c === "`") {
			let n = 1;
			while (seg[i + n] === "`") n++;
			const close = closingRun(seg, i + n, n);
			i = close < 0 ? i + n : close + n;
		} else if (c === "<") {
			// An angle-bracketed link destination: `[text](<dest>)`.
			if (seg[i - 1] === "(" && seg[i - 2] === "]") {
				i++;
				continue;
			}
			const m = markupAt(seg, i);
			if (m === "drop") hits.push({ at: i, escaped: false });
			i = m && m !== "drop" ? m.end : i + 1;
		} else {
			i++;
		}
	}
}

/** Where a run of exactly `n` backticks starts at or after `from`; -1 if none. */
function closingRun(text: string, from: number, n: number): number {
	let i = text.indexOf("`", from);
	while (i >= 0) {
		let k = 1;
		while (text[i + k] === "`") k++;
		if (k === n) return i;
		i = text.indexOf("`", i + k);
	}
	return -1;
}

/** A line's indent in columns (a tab to the next multiple of 4) and where its text starts. */
function indentOf(line: string): { cols: number; at: number } {
	let cols = 0;
	let at = 0;
	for (; at < line.length; at++) {
		if (line[at] === " ") cols++;
		else if (line[at] === "\t") cols += 4 - (cols % 4);
		else break;
	}
	return { cols, at };
}

/** A line without its block quote markers (`> `). */
const unquoted = (line: string) => line.replace(/^(?: {0,3}> ?)+/, "");

/** A line without block quote and list markers, for fences (lists err towards code). */
const unmarked = (line: string) =>
	line.replace(/^(?:\s*(?:>|[-*+]|\d{1,9}[.)])(?=\s|$) ?)+/, "");

const FENCE = /^\s*(`{3,}|~{3,})([^\n]*)$/;

/** Whether `line` opens an HTML block GitHub keeps (left alone), and how it ends. */
function htmlBlock(
	line: string,
	afterParagraph: boolean,
): "comment" | "pre" | "blank" | null {
	const { cols, at } = indentOf(line);
	if (cols > 3 || line[at] !== "<") return null;
	const rest = line.slice(at).replace(/\r$/, "");
	if (rest.startsWith("<!--")) return "comment";
	const open = /^<(\/)?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(rest);
	if (!open) return null;
	const name = (open[2] ?? "").toLowerCase();
	TAG.lastIndex = 0;
	const tag = TAG.exec(rest);
	const whole = tag !== null && !rest.slice(TAG.lastIndex).trim();
	const bare = tag ? !(tag[3] ?? "").trim() && !tag[4] : true;
	if (dropped(open[2] ?? "", !!open[1], bare)) return null;
	if (name === "pre" && !open[1]) return "pre";
	if (BLOCK_TAGS.has(name)) return "blank";
	// Any other tag alone on its line, not inside a paragraph.
	return whole && !afterParagraph && !TAG_FILTER.has(name) ? "blank" : null;
}

/** Every `<` in `text` that starts a tag GitHub drops, outside code and HTML blocks. */
function hitsOf(text: string): Hit[] {
	const hits: Hit[] = [];
	let fence: { char: string; len: number } | null = null;
	let html: "comment" | "pre" | "blank" | null = null;
	let prev: "blank" | "para" | "other" = "blank";
	/** Where the paragraph being gathered starts; -1 if none. */
	let para = -1;
	let paraEnd = 0;
	const flush = () => {
		if (para >= 0) scanInline(text, para, paraEnd, hits);
		para = -1;
	};
	let pos = 0;
	while (pos <= text.length) {
		const nl = text.indexOf("\n", pos);
		const end = nl < 0 ? text.length : nl;
		const line = text.slice(pos, end);
		const blank = !line.trim();
		if (fence) {
			const close = FENCE.exec(unmarked(line));
			if (
				close?.[1]?.[0] === fence.char &&
				close[1].length >= fence.len &&
				!(close[2] ?? "").trim()
			) {
				fence = null;
			}
			prev = "other";
		} else if (html) {
			if (
				(html === "blank" && blank) ||
				(html === "comment" && line.includes("-->")) ||
				(html === "pre" && /<\/pre>/i.test(line))
			) {
				html = null;
			}
			prev = blank ? "blank" : "other";
		} else if (blank) {
			flush();
			prev = "blank";
		} else {
			const open = FENCE.exec(unmarked(line));
			const quoted = unquoted(line);
			const block = htmlBlock(quoted, prev === "para");
			if (open && !(open[1]?.[0] === "`" && (open[2] ?? "").includes("`"))) {
				flush();
				fence = { char: open[1]?.[0] ?? "`", len: open[1]?.length ?? 3 };
				prev = "other";
			} else if (indentOf(quoted).cols >= 4 && prev !== "para") {
				// Indented code: it can't interrupt a paragraph.
				flush();
				prev = "other";
			} else if (block) {
				flush();
				const ends =
					(block === "comment" &&
						line.slice(line.indexOf("<!--") + 4).includes("-->")) ||
					(block === "pre" && /<\/pre>/i.test(line));
				html = ends ? null : block;
				prev = "other";
			} else if (/^ {0,3}#{1,6}(?:\s|$)/.test(quoted)) {
				flush();
				scanInline(text, pos, end, hits);
				prev = "other";
			} else {
				if (para < 0) para = pos;
				paraEnd = end;
				prev = "para";
			}
		}
		if (nl < 0) break;
		pos = nl + 1;
	}
	flush();
	return hits;
}

/**
 * `body` with a backslash before every `<` that starts a tag GitHub
 * drops, so it shows as typed. Idempotent: an escaped `<` stays as is.
 */
export function escapeTags(body: string): string {
	const hits = hitsOf(body).filter((h) => !h.escaped);
	if (!hits.length) return body;
	let out = "";
	let from = 0;
	for (const { at } of hits) {
		out += `${body.slice(from, at)}\\`;
		from = at;
	}
	return out + body.slice(from);
}

/**
 * Undoes exactly what escapeTags adds: the backslash before a `<` that
 * starts a tag GitHub drops (`List\<String>` reads `List<String>`).
 * escapeTags(unescapeTags(escapeTags(x))) === escapeTags(x).
 */
export function unescapeTags(body: string): string {
	const hits = hitsOf(body).filter((h) => h.escaped);
	if (!hits.length) return body;
	let out = "";
	let from = 0;
	for (const { at } of hits) {
		out += body.slice(from, at - 1);
		from = at;
	}
	return out + body.slice(from);
}
