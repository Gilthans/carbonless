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
const AUTOLINK =
	/<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;
/** The schemes GitHub links bare (`https://…`), any case, after anything but a letter. */
const SCHEMES = ["https", "http", "ftp"];

/** Whether GitHub drops tag `name` (so it is escaped). */
function dropped(name: string, closing: boolean, bare: boolean): boolean {
	const n = name.toLowerCase();
	if (TAG_FILTER.has(n)) return false;
	if (!GITHUB_KEPT_TAGS.has(n)) return true;
	// `Foo<B>` is a type parameter, not bold: `<B>` and `</B>` both.
	if (/^[A-Z]$/.test(name)) return bare;
	if (closing) return false;
	// `<a>` without an href GitHub drops.
	return bare && n === "a";
}

/** A `<` that starts a tag GitHub drops, and whether it is escaped already. */
interface Hit {
	at: number;
	escaped: boolean;
}

/**
 * One stretch of inline markdown (a paragraph or a heading), scanned
 * once from left to right. Each terminator (`-->`, `?>`, a backtick run
 * of a given length...) is looked for at most once per position it can
 * be at: the scan only moves forward, so a found one (or none) holds
 * until the scan passes it. Linear in the stretch's length.
 */
class Inline {
	readonly #seg: string;
	readonly #next = new Map<string, number>();
	#runs: Map<number, { at: number[]; next: number }> | null = null;
	/** Where the current run of non-space text starts, up to #wordAt. */
	#word = 0;
	#wordAt = 0;
	/** Whether that run holds a scheme GitHub links (`https://`), up to #wordAt. */
	#linked = false;

	constructor(seg: string) {
		this.#seg = seg;
	}

	/** Where `s` next occurs at or after `from`; -1 if never. */
	#find(s: string, from: number): number {
		const known = this.#next.get(s);
		if (known !== undefined && (known < 0 || known >= from)) return known;
		const at = this.#seg.indexOf(s, from);
		this.#next.set(s, at);
		return at;
	}

	/** Where a run of exactly `n` backticks starts at or after `from`; -1 if none. */
	#closingRun(from: number, n: number): number {
		if (!this.#runs) {
			// Every run, once: its starts by length, in order.
			const runs = new Map<number, { at: number[]; next: number }>();
			const seg = this.#seg;
			for (let i = seg.indexOf("`"); i >= 0; ) {
				let k = 1;
				while (seg[i + k] === "`") k++;
				const of = runs.get(k) ?? { at: [], next: 0 };
				of.at.push(i);
				runs.set(k, of);
				i = seg.indexOf("`", i + k);
			}
			this.#runs = runs;
		}
		const of = this.#runs.get(n);
		if (!of) return -1;
		// The scan only moves forward: so does each length's pointer.
		while (of.next < of.at.length && (of.at[of.next] ?? 0) < from) of.next++;
		return of.at[of.next] ?? -1;
	}

	/**
	 * Whether `at` is inside a bare URL GitHub links (GFM's extended
	 * autolinks, as GitHub has them): its run of non-space text holds
	 * `https://`, `http://` or `ftp://` (any case) not right after an
	 * ASCII letter, or starts (after any of `*_~(`) with a lowercase
	 * `www.`. One forward pointer: linear.
	 */
	#inBareUrl(at: number): boolean {
		const seg = this.#seg;
		for (; this.#wordAt < at; this.#wordAt++) {
			const k = this.#wordAt;
			const c = seg[k] ?? "";
			if (/\s/.test(c)) {
				this.#word = k + 1;
				this.#linked = false;
			} else if (c === ":" && seg.startsWith("//", k + 1)) {
				this.#linked ||= SCHEMES.some((scheme) => {
					const from = k - scheme.length;
					return (
						from >= this.#word &&
						seg.slice(from, k).toLowerCase() === scheme &&
						!/[A-Za-z]/.test(seg[from - 1] ?? "")
					);
				});
			}
		}
		if (this.#linked) return true;
		let w = this.#word;
		while (w < at && "*_~(".includes(seg[w] ?? "")) w++;
		return seg.startsWith("www.", w) && w + 4 <= at;
	}

	/**
	 * What the markup at `at` (a `<`) is: a tag or markup GitHub drops
	 * ("drop"), something to skip whole (kept tag, comment, autolink; its
	 * end), or plain text (null).
	 */
	#markupAt(at: number): "drop" | { end: number } | null {
		const seg = this.#seg;
		if (seg.startsWith("<!--", at)) {
			const close = this.#find("-->", at + 4);
			return close < 0 ? null : { end: close + 3 };
		}
		AUTOLINK.lastIndex = at;
		if (AUTOLINK.test(seg)) return { end: AUTOLINK.lastIndex };
		TAG.lastIndex = at;
		const tag = TAG.exec(seg);
		if (tag) {
			const bare = !(tag[3] ?? "").trim() && !tag[4];
			return dropped(tag[2] ?? "", !!tag[1], bare)
				? "drop"
				: { end: TAG.lastIndex };
		}
		// Processing instructions, CDATA and declarations: GitHub drops them too.
		if (seg[at + 1] === "?")
			return this.#find("?>", at + 2) < 0 ? null : "drop";
		if (seg.startsWith("<![CDATA[", at)) {
			return this.#find("]]>", at + 9) < 0 ? null : "drop";
		}
		if (seg[at + 1] === "!" && /[A-Za-z]/.test(seg[at + 2] ?? "")) {
			return this.#find(">", at + 3) < 0 ? null : "drop";
		}
		return null;
	}

	/** The hits, at their place in the stretch plus `offset`. */
	scan(offset: number, hits: Hit[]): void {
		const seg = this.#seg;
		let i = 0;
		while (i < seg.length) {
			const c = seg[i];
			if (c === "\\") {
				if (
					seg[i + 1] === "<" &&
					!this.#inBareUrl(i) &&
					this.#markupAt(i + 1) === "drop"
				) {
					hits.push({ at: offset + i + 1, escaped: true });
				}
				i += 2;
			} else if (c === "`") {
				let n = 1;
				while (seg[i + n] === "`") n++;
				const close = this.#closingRun(i + n, n);
				i = close < 0 ? i + n : close + n;
			} else if (c === "<") {
				// An angle-bracketed link destination, `[text](<dest>)`, and a
				// bare URL GitHub links (an escape would land inside the link):
				// left as they are.
				if ((seg[i - 1] === "(" && seg[i - 2] === "]") || this.#inBareUrl(i)) {
					i++;
					continue;
				}
				const m = this.#markupAt(i);
				if (m === "drop") hits.push({ at: offset + i, escaped: false });
				i = m && m !== "drop" ? m.end : i + 1;
			} else {
				i++;
			}
		}
	}
}

/** Inline markdown in `text` from `start` to `end`: the hits outside code spans. */
function scanInline(text: string, start: number, end: number, hits: Hit[]) {
	new Inline(text.slice(start, end)).scan(start, hits);
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

/** A line's block quote depth and the rest after its markers. */
function quoteDepth(line: string): { depth: number; rest: string } {
	let depth = 0;
	let rest = line;
	for (let m = QUOTE.exec(rest); m; m = QUOTE.exec(rest)) {
		depth++;
		rest = rest.slice(m[0].length);
	}
	return { depth, rest };
}
const QUOTE = /^ {0,3}> ?/;

/**
 * A fence's opening line: block quotes, then any list markers, then the
 * fence (lists and any indent err towards code). Its container (quote
 * depth, a list item's content column) is where it must close.
 */
const FENCE_OPEN =
	/^([ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*)(`{3,}|~{3,})([^\n]*)$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*\r?$/;

interface Fence {
	char: string;
	len: number;
	depth: number;
	/** Its opening line's column (indent and list markers): a closer needs it, plus 0-3 spaces. */
	column: number;
}

/** The fence `line` opens; null if none. */
function fenceOpen(line: string): Fence | null {
	const { depth, rest } = quoteDepth(line);
	const m = FENCE_OPEN.exec(rest);
	const run = m?.[2] ?? "";
	if (!m || (run[0] === "`" && (m[3] ?? "").includes("`"))) return null;
	const before = m[1] ?? "";
	return {
		char: run[0] ?? "`",
		len: run.length,
		depth,
		// Its own indent, list markers included: a closer further left may
		// be outside its list item, where it opens a new fence instead.
		column: indentOf(before.replace(/[^\s]/g, " ")).cols,
	};
}

/**
 * Whether `line` closes `fence`: as CommonMark, in the same container
 * (its quote markers, its list item's column), then 0-3 spaces. In
 * doubt it stays open: code is never escaped.
 */
function closes(fence: Fence, line: string): boolean {
	let rest = line;
	for (let k = 0; k < fence.depth; k++) {
		const m = QUOTE.exec(rest);
		if (!m) return false;
		rest = rest.slice(m[0].length);
	}
	const { cols, at } = indentOf(rest);
	if (cols < fence.column || cols - fence.column > 3) return false;
	const m = FENCE_CLOSE.exec(rest.slice(at));
	return m?.[1]?.[0] === fence.char && (m[1]?.length ?? 0) >= fence.len;
}

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
	let fence: Fence | null = null;
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
			if (closes(fence, line)) fence = null;
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
			const open = fenceOpen(line);
			const quoted = unquoted(line);
			const block = htmlBlock(quoted, prev === "para");
			if (open) {
				flush();
				fence = open;
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
	if (!body.includes("<")) return body;
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
	if (!body.includes("\\<")) return body;
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
