import { Lexer } from "marked";
import type { MdBlockKind } from "../../../../shared/markdownBlocks";
import { tokenEnd, WORD_DIFF_MAX } from "../../../../shared/tokenize";
import { tokenMarks } from "../../wordDiff";

/**
 * Word marks in a changed Markdown block: the old and new block sources
 * merged into one, removed words between `DEL_OPEN`/`DEL_CLOSE` and added
 * ones between `INS_OPEN`/`INS_CLOSE`. The marks are private-use code points,
 * not `<del>`/`<ins>`: a file can already write `~~x~~` and `<ins>x</ins>`,
 * and those must never pass for a mark. Content's own sentinels are replaced
 * (`scrub`) before merging, and the renderer turns ours into its own
 * elements after sanitizing (`renderMerged` in renderBlocks.ts).
 *
 * The diff is the line view's (`tokenMarks`: words first, then the gaps),
 * over Markdown tokens: inline code, links, images, autolinks, bare URLs,
 * raw HTML tags, entities, escapes and emphasis / strong / strikethrough
 * spans are one token each, so a mark only ever wraps a whole span (never
 * lands in a URL, attribute or code span). View-agnostic: the full diff and
 * the since view merge alike.
 */

export const DEL_OPEN = "\uE000";
export const DEL_CLOSE = "\uE001";
export const INS_OPEN = "\uE002";
export const INS_CLOSE = "\uE003";

/** Any of the four marks (global: for `replace`). */
export const SENTINELS = /[\uE000-\uE003]/g;
/** Any of the four marks (for `test` and `search`). */
export const SENTINEL = /[\uE000-\uE003]/;

/** Content's own sentinel code points, made harmless. */
export const scrub = (s: string): string => s.replace(SENTINELS, "\uFFFD");

/**
 * The longest side a block takes marks on. The line view cuts at
 * `WORD_DIFF_MAX` per line; a block of several such lines still gets marks,
 * up to four lines' worth, which keeps the exact diff's worst case small.
 */
export const BLOCK_DIFF_MAX = 4 * WORD_DIFF_MAX;

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const ENTITY =
	/&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const HTML_COMMENT = /<!--[\s\S]*?-->/y;
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/y;
const EMAIL_AUTOLINK = /<[^\s<>@\\]+@[^\s<>\\]+>/y;
const HTML_TAG =
	/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/y;
const BARE_URL = /(?:(?:https?|ftp):\/\/|www\.)[^\s<]*/iy;
const BARE_EMAIL =
	/[A-Za-z0-9._+-]+@[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]*[a-zA-Z0-9])+(?![-_])/y;
const WORDISH = /[\p{L}\p{M}\p{N}_]/u;

/** `re` (sticky) matched at `i`: its end, or -1. */
function stickyEnd(re: RegExp, text: string, i: number): number {
	re.lastIndex = i;
	const m = re.exec(text);
	return m ? i + m[0].length : -1;
}

/** A bare URL's end, its trailing punctuation left out as GFM does. */
function bareUrlEnd(text: string, i: number): number {
	let end = stickyEnd(BARE_URL, text, i);
	if (end === -1) return -1;
	for (;;) {
		const c = text[end - 1] as string;
		if (/[?!.,:;*_'"~]/.test(c)) end--;
		else if (c === ")") {
			const url = text.slice(i, end);
			const open = url.split("(").length - 1;
			const close = url.split(")").length - 1;
			if (close > open) end--;
			else break;
		} else break;
	}
	return end > i ? end : -1;
}

/** After the bracket at `i` (`[` or `(`), the index past its match, or -1. */
function closeOf(text: string, i: number, open: string, close: string): number {
	let depth = 0;
	for (let j = i; j < text.length; j++) {
		const c = text[j];
		if (c === "\\") j++;
		else if (c === "`") {
			// A code span inside is opaque.
			const end = codeSpanEnd(text, j);
			if (end > j + 1) j = end - 1;
		} else if (c === open) depth++;
		else if (c === close && --depth === 0) return j + 1;
		else if (c === "\n" && text[j + 1] === "\n") return -1;
	}
	return -1;
}

/** A code span (or a lone backtick run) starting at `i`: its end. */
function codeSpanEnd(text: string, i: number): number {
	let k = i;
	while (text[k] === "`") k++;
	const n = k - i;
	for (let j = k; j < text.length; ) {
		if (text[j] !== "`") {
			j++;
			continue;
		}
		let e = j;
		while (text[e] === "`") e++;
		if (e - j === n) return e;
		j = e;
	}
	return k;
}

/** A link or image (`[` at `i`): its end, or -1. */
function linkEnd(text: string, i: number): number {
	const label = closeOf(text, i, "[", "]");
	if (label === -1) return -1;
	if (text[label] === "(") {
		const dest = closeOf(text, label, "(", ")");
		if (dest !== -1) return dest;
	} else if (text[label] === "[") {
		const ref = closeOf(text, label, "[", "]");
		if (ref !== -1) return ref;
	}
	return label;
}

/**
 * An emphasis, strong or strikethrough span (a `*`, `_` or `~` run at `i`
 * that can open): its end at the first run of the same length that can
 * close, or -1.
 */
function emphasisEnd(text: string, i: number): number {
	const c = text[i] as string;
	let k = i;
	while (text[k] === c) k++;
	const n = k - i;
	if (k >= text.length || /\s/.test(text[k] as string)) return -1;
	for (let j = k; j < text.length; ) {
		const d = text[j];
		if (d === "\\") {
			j += 2;
			continue;
		}
		if (d === "`") {
			j = Math.max(codeSpanEnd(text, j), j + 1);
			continue;
		}
		if (d === "\n" && text[j + 1] === "\n") return -1;
		if (d !== c) {
			j++;
			continue;
		}
		let e = j;
		while (text[e] === c) e++;
		if (e - j === n && !/\s/.test(text[j - 1] as string)) return e;
		j = e;
	}
	return -1;
}

/**
 * Where the Markdown token at `i` ends: a span whole, else the line view's
 * token (a word run, or one code point).
 */
export function mdTokenEnd(text: string, i: number): number {
	const c = text[i] as string;
	const prev = i > 0 ? (text[i - 1] as string) : "";
	let end = -1;
	if (c === "\\" && ASCII_PUNCT.test(text[i + 1] ?? "")) return i + 2;
	if (c === "`") return codeSpanEnd(text, i);
	if (c === "&") end = stickyEnd(ENTITY, text, i);
	else if (c === "<") {
		for (const re of [HTML_COMMENT, AUTOLINK, EMAIL_AUTOLINK, HTML_TAG]) {
			end = stickyEnd(re, text, i);
			if (end !== -1) break;
		}
	} else if (c === "!" && text[i + 1] === "[") end = linkEnd(text, i + 1);
	else if (c === "[") end = linkEnd(text, i);
	else if (c === "*" || c === "_" || c === "~") end = emphasisEnd(text, i);
	else if (!WORDISH.test(prev)) {
		end = bareUrlEnd(text, i);
		if (end === -1) end = stickyEnd(BARE_EMAIL, text, i);
	}
	return end > i ? end : tokenEnd(text, i);
}

/** A segment of the merged block: shared text, or one change. */
type Seg = { eq: string } | { del: string; ins: string };

/** The text of `[from, to)` ranges' complement, with each range's start in it. */
function split(
	text: string,
	marks: readonly (readonly [number, number])[],
): { kept: string; at: { pos: number; text: string }[] } {
	let kept = "";
	let last = 0;
	const at: { pos: number; text: string }[] = [];
	for (const [from, to] of marks) {
		kept += text.slice(last, from);
		at.push({ pos: kept.length, text: text.slice(from, to) });
		last = to;
	}
	kept += text.slice(last);
	return { kept, at };
}

const BLANKS = /^[ \t]+$/;

/**
 * A run of spaces and tabs between two changes that each remove and add
 * joins them, as the line view bridges (owner, 2026-11-04). Only when both
 * sides change around it: one side's bridge alone can't be shown in one
 * merged source without repeating the spaces.
 */
function bridge(segs: Seg[]): Seg[] {
	const out: Seg[] = [];
	for (let i = 0; i < segs.length; i++) {
		const s = segs[i] as Seg;
		const prev = out[out.length - 1];
		const next = segs[i + 1];
		if (
			"eq" in s &&
			BLANKS.test(s.eq) &&
			prev &&
			"del" in prev &&
			next &&
			"del" in next &&
			prev.del &&
			prev.ins &&
			next.del &&
			next.ins
		) {
			prev.del += s.eq + next.del;
			prev.ins += s.eq + next.ins;
			i++;
			continue;
		}
		out.push("eq" in s ? { eq: s.eq } : { del: s.del, ins: s.ins });
	}
	return out;
}

/** Rewrites a bare scheme URL as `<url>`, so a mark right after it can't join its link. */
function fenceUrls(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; ) {
		const end = mdTokenEnd(s, i);
		const t = s.slice(i, end);
		const bare =
			end === bareUrlEnd(s, i) &&
			/^(?:https?|ftp):\/\//i.test(t) &&
			!/[<>]/.test(t);
		out += bare ? `<${t}>` : t;
		i = end;
	}
	return out;
}

/** The changes, in order, as segments (deletions before insertions at a spot). */
function segments(a: string, b: string): Seg[] {
	const marks = tokenMarks(a, b, { end: mdTokenEnd, max: BLOCK_DIFF_MAX });
	const o = split(a, marks.old);
	const n = split(b, marks.new);
	// The text outside the marks is the same on both sides: the unchanged
	// tokens, in order.
	const kept = n.kept;
	const segs: Seg[] = [];
	let pos = 0;
	let io = 0;
	let jn = 0;
	while (io < o.at.length || jn < n.at.length) {
		const po = o.at[io]?.pos ?? Number.POSITIVE_INFINITY;
		const pn = n.at[jn]?.pos ?? Number.POSITIVE_INFINITY;
		const p = Math.min(po, pn);
		if (p > pos) segs.push({ eq: kept.slice(pos, p) });
		pos = p;
		const del = po === p ? (o.at[io++]?.text ?? "") : "";
		const ins = pn === p ? (n.at[jn++]?.text ?? "") : "";
		segs.push({ del, ins });
	}
	if (pos < kept.length) segs.push({ eq: kept.slice(pos) });
	return bridge(segs);
}

/** Cells in a GFM table row: unescaped pipes, less an outer pair. */
function cellCount(line: string): number {
	const t = line.trim();
	let pipes = 0;
	for (let i = 0; i < t.length; i++) {
		if (t[i] === "\\") i++;
		else if (t[i] === "|") pipes++;
	}
	const lead = t.startsWith("|") ? 1 : 0;
	const trail = t.length > 1 && t.endsWith("|") && !t.endsWith("\\|") ? 1 : 0;
	return pipes + 1 - lead - trail;
}

/** The last line's cell count: a header block's header and delimiter agree. */
const rowCells = (src: string): number =>
	cellCount(src.split("\n").at(-1) ?? "");

function headingLevel(src: string): number {
	try {
		const t = new Lexer({ gfm: true }).lex(src).find((x) => x.type !== "space");
		return t?.type === "heading" ? (t as { depth: number }).depth : 0;
	} catch {
		return 0;
	}
}

const isMath = (src: string): boolean => {
	const t = src.trim();
	return t.length >= 4 && t.startsWith("$$") && t.endsWith("$$");
};

/** Kinds that render as source or as a fence: no inline marks. */
const UNMARKED: ReadonlySet<MdBlockKind> = new Set([
	"code",
	"html",
	"def",
	"front-matter",
	"hr",
]);

/**
 * One source with removed words between `DEL_OPEN`…`DEL_CLOSE` and added
 * ones between `INS_OPEN`…`INS_CLOSE`, or null when the block can't take
 * inline marks: a code fence, raw HTML, a definition, front matter, a
 * thematic break or `$$` math (they render as source or as a whole); a
 * table row whose cell count changed; a heading whose level changed; a side
 * as long as `BLOCK_DIFF_MAX` or a line as long as `WORD_DIFF_MAX` (the line
 * view's cut). Identical sources come back as they are. Content's own
 * sentinel code points are replaced first, so every mark in the result is
 * ours. Render it with `renderMerged`, which can still say null (the marks
 * didn't land cleanly): the view then shows old struck above new.
 */
export function mergedSource(
	oldSrc: string,
	newSrc: string,
	kind: MdBlockKind,
): string | null {
	const a = scrub(oldSrc);
	const b = scrub(newSrc);
	if (a === b) return b;
	if (UNMARKED.has(kind)) return null;
	if (kind === "paragraph" && (isMath(a) || isMath(b))) return null;
	if (kind === "table-row" && rowCells(a) !== rowCells(b)) return null;
	if (kind === "heading" && headingLevel(a) !== headingLevel(b)) return null;
	if (a.length >= BLOCK_DIFF_MAX || b.length >= BLOCK_DIFF_MAX) return null;
	const long = (s: string) =>
		s.split("\n").some((l) => l.length >= WORD_DIFF_MAX);
	if (long(a) || long(b)) return null;
	let out = "";
	for (const s of segments(a, b)) {
		if ("eq" in s) out += fenceUrls(s.eq);
		else {
			if (s.del) out += DEL_OPEN + fenceUrls(s.del) + DEL_CLOSE;
			if (s.ins) out += INS_OPEN + fenceUrls(s.ins) + INS_CLOSE;
		}
	}
	return out;
}

/** The merged source's old side: insertions dropped, marks removed. */
export const oldSide = (merged: string): string =>
	merged.replace(/\uE002[^\uE003]*\uE003/g, "").replace(SENTINELS, "");

/** The merged source's new side: deletions dropped, marks removed. */
export const newSide = (merged: string): string =>
	merged.replace(/\uE000[^\uE001]*\uE001/g, "").replace(SENTINELS, "");
