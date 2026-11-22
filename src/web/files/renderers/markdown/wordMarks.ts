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
/** A bare e-mail's domain, from just after its `@`. */
const EMAIL_DOMAIN = /[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]*[a-zA-Z0-9])+(?![-_])/y;
/** What a bare e-mail's local part is made of. */
const EMAIL_LOCAL = /[A-Za-z0-9._+-]/;
const WORDISH = /[\p{L}\p{M}\p{N}_]/u;
const SPACE = /\s/;

/** `re` (sticky) matched at `i`: its end, or -1. */
function stickyEnd(re: RegExp, text: string, i: number): number {
	re.lastIndex = i;
	const m = re.exec(text);
	return m ? i + m[0].length : -1;
}

/**
 * A raw HTML tag, comment or autolink at `i` (a `<`): its end, or -1. Only
 * within the line: every `<` of a block tried to the block's end would make
 * the block quadratic, and the line is under the line view's cut.
 */
function angleEnd(text: string, i: number): number {
	const nl = text.indexOf("\n", i);
	const line = text.slice(i, nl === -1 ? text.length : nl);
	for (const re of [HTML_COMMENT, AUTOLINK, EMAIL_AUTOLINK, HTML_TAG]) {
		const end = stickyEnd(re, line, 0);
		if (end !== -1) return i + end;
	}
	return -1;
}

/** A bare URL's end, its trailing punctuation left out as GFM does. */
function bareUrlEnd(text: string, i: number): number {
	let end = stickyEnd(BARE_URL, text, i);
	if (end === -1) return -1;
	let open = 0;
	let close = 0;
	for (let j = i; j < end; j++) {
		if (text[j] === "(") open++;
		else if (text[j] === ")") close++;
	}
	for (;;) {
		const c = text[end - 1] as string;
		if (/[?!.,:;*_'"~]/.test(c)) end--;
		else if (c === ")" && close > open) {
			end--;
			close--;
		} else break;
	}
	return end > i ? end : -1;
}

/**
 * Where each span of one block ends, found in a few linear passes, so a
 * token's end is a lookup: an opener that never closes costs nothing more
 * (scanning to the block's end per opener made a block quadratic).
 */
interface Spans {
	/** A backtick run's start → the end of its code span, or of the run alone. */
	code: Map<number, number>;
	/** A `[` or `(` → just past its match (escapes, code spans and paragraph breaks respected). */
	close: Map<number, number>;
	/** An emphasis run that can open → the end of the first same run that can close. */
	emphasis: Map<number, number>;
	/** Each index → the end of the e-mail local-part run from it (0 outside one). */
	local: Int32Array;
	/** An `@` → the end of the bare e-mail domain after it, or -1 (memo). */
	domain: Map<number, number>;
}

const escapeAt = (text: string, i: number): boolean =>
	text[i] === "\\" && ASCII_PUNCT.test(text[i + 1] ?? "");

const breakAt = (text: string, i: number): boolean =>
	text[i] === "\n" && text[i + 1] === "\n";

function spansOf(text: string): Spans {
	const n = text.length;
	// Code spans: a backtick run closes at the next run of its length.
	const runs: { at: number; len: number }[] = [];
	for (let i = 0; i < n; i++) {
		if (escapeAt(text, i)) i++;
		else if (text[i] === "`") {
			let e = i;
			while (text[e] === "`") e++;
			runs.push({ at: i, len: e - i });
			i = e - 1;
		}
	}
	const nextSame = new Int32Array(runs.length).fill(-1);
	const lastOf = new Map<number, number>();
	for (let r = runs.length - 1; r >= 0; r--) {
		const { len } = runs[r] as { len: number };
		nextSame[r] = lastOf.get(len) ?? -1;
		lastOf.set(len, r);
	}
	const code = new Map<number, number>();
	const inCode = new Uint8Array(n);
	for (let r = 0; r < runs.length; ) {
		const { at, len } = runs[r] as { at: number; len: number };
		const c = nextSame[r] as number;
		if (c === -1) {
			code.set(at, at + len);
			r++;
			continue;
		}
		const closer = runs[c] as { at: number; len: number };
		code.set(at, closer.at + closer.len);
		inCode.fill(1, at, closer.at + closer.len);
		r = c + 1;
	}
	// Brackets and parens, matched on stacks; emphasis runs collected.
	const close = new Map<number, number>();
	const squares: number[] = [];
	const parens: number[] = [];
	const ems: {
		at: number;
		end: number;
		key: string;
		para: number;
		opens: boolean;
		closes: boolean;
	}[] = [];
	let para = 0;
	for (let i = 0; i < n; i++) {
		if (inCode[i]) continue;
		const c = text[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (breakAt(text, i)) {
			squares.length = 0;
			parens.length = 0;
			para++;
			continue;
		}
		if (c === "[") squares.push(i);
		else if (c === "(") parens.push(i);
		else if (c === "]" || c === ")") {
			const open = (c === "]" ? squares : parens).pop();
			if (open !== undefined) close.set(open, i + 1);
		} else if (c === "*" || c === "_" || c === "~") {
			let e = i;
			while (text[e] === c) e++;
			ems.push({
				at: i,
				end: e,
				key: c + (e - i),
				para,
				opens: e < n && !SPACE.test(text[e] as string),
				closes: i > 0 && !SPACE.test(text[i - 1] as string),
			});
			i = e - 1;
		}
	}
	// Each opener's closer: the nearest closing run of the same kind to its
	// right in the same paragraph, found walking right to left.
	const emphasis = new Map<number, number>();
	const nearest = new Map<string, number>();
	let seen = para;
	for (let r = ems.length - 1; r >= 0; r--) {
		const run = ems[r] as (typeof ems)[number];
		if (run.para !== seen) {
			nearest.clear();
			seen = run.para;
		}
		const end = run.opens ? nearest.get(run.key) : undefined;
		if (end !== undefined) emphasis.set(run.at, end);
		if (run.closes) nearest.set(run.key, run.end);
	}
	// E-mail local-part runs, right to left.
	const local = new Int32Array(n + 1);
	for (let i = n - 1; i >= 0; i--) {
		if (EMAIL_LOCAL.test(text[i] as string)) {
			local[i] = local[i + 1] || i + 1;
		}
	}
	return { code, close, emphasis, local, domain: new Map() };
}

/** A link or image (`[` at `i`): its end, or -1. */
function linkEnd(s: Spans, text: string, i: number): number {
	const label = s.close.get(i);
	if (label === undefined) return -1;
	const next = text[label];
	if (next === "(" || next === "[") return s.close.get(label) ?? label;
	return label;
}

/** A bare e-mail at `i`: its end, or -1. */
function emailEnd(s: Spans, text: string, i: number): number {
	const at = s.local[i] ?? 0;
	if (at <= i || text[at] !== "@") return -1;
	let end = s.domain.get(at);
	if (end === undefined) {
		end = stickyEnd(EMAIL_DOMAIN, text, at + 1);
		s.domain.set(at, end);
	}
	return end;
}

/**
 * The Markdown tokens of `text`: where the token at `i` ends, a span whole,
 * else the line view's token (a word run, or one code point). Linear over
 * the text: the spans are found once, up front.
 */
export function mdTokenizer(text: string): (i: number) => number {
	const s = spansOf(text);
	return (i) => {
		const c = text[i] as string;
		let end = -1;
		if (escapeAt(text, i)) return i + 2;
		if (c === "`") {
			end = s.code.get(i) ?? -1;
			if (end === -1) {
				end = i;
				while (text[end] === "`") end++;
			}
			return end;
		}
		if (c === "&") end = stickyEnd(ENTITY, text, i);
		else if (c === "<") end = angleEnd(text, i);
		else if (c === "!" && text[i + 1] === "[") end = linkEnd(s, text, i + 1);
		else if (c === "[") end = linkEnd(s, text, i);
		else if (c === "*" || c === "_" || c === "~") {
			end = s.emphasis.get(i) ?? -1;
		} else if (!WORDISH.test(i > 0 ? (text[i - 1] as string) : "")) {
			end = bareUrlEnd(text, i);
			if (end === -1) end = emailEnd(s, text, i);
		}
		return end > i ? end : tokenEnd(text, i);
	};
}

/** The Markdown token at `i`'s end (one-off; `mdTokenizer` for a whole text). */
export const mdTokenEnd = (text: string, i: number): number =>
	mdTokenizer(text)(i);

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
	const tokenAt = mdTokenizer(s);
	for (let i = 0; i < s.length; ) {
		const end = tokenAt(i);
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

/** What may follow a cell's content: spaces, then a pipe, a line end or the end. */
const CELL_END = /^[ \t]*(?:\||\n|$)/;

/**
 * A one-sided change that ends in a space right before a cell's (or the
 * line's) end slides left over the equal space before it: `a [-b -]|`
 * becomes `a[- b-] |`. GFM trims a cell's edges, and a mark between the
 * content and its trailing space keeps that space in the cell, so the side
 * rendered without the change would differ (and `renderMerged` says null).
 * The two spellings are the same diff.
 */
function keepCellEdges(segs: Seg[]): Seg[] {
	for (let i = 1; i < segs.length; i++) {
		const s = segs[i] as Seg;
		const prev = segs[i - 1] as Seg;
		if (!("del" in s) || (s.del && s.ins) || !("eq" in prev)) continue;
		let next = segs[i + 1];
		if (next && !("eq" in next)) continue;
		const side = s.del ? "del" : "ins";
		for (;;) {
			const run = s[side];
			const c = run.at(-1) as string;
			if (
				(c !== " " && c !== "\t") ||
				!prev.eq.endsWith(c) ||
				!CELL_END.test(next && "eq" in next ? next.eq : "")
			) {
				break;
			}
			prev.eq = prev.eq.slice(0, -1);
			s[side] = c + run.slice(0, -1);
			if (!next) {
				next = { eq: "" };
				segs.push(next);
			}
			(next as { eq: string }).eq = c + (next as { eq: string }).eq;
		}
	}
	return segs;
}

/** The changes, in order, as segments (deletions before insertions at a spot). */
function segments(a: string, b: string): Seg[] {
	const marks = tokenMarks(a, b, { tokens: mdTokenizer, max: BLOCK_DIFF_MAX });
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
	return keepCellEdges(bridge(segs));
}

/** A row line split at its unescaped pipes (the pipes dropped). */
function pipeSplit(line: string): string[] {
	const out: string[] = [];
	let from = 0;
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "\\") i++;
		else if (line[i] === "|") {
			out.push(line.slice(from, i));
			from = i + 1;
		}
	}
	out.push(line.slice(from));
	return out;
}

/**
 * A table row diffed cell by cell, its pipes kept equal, so a word that
 * moved to the next cell shows removed from one and added to the other
 * rather than a struck pipe (which can't render). Null when the lines or
 * pipes don't line up: the whole row is diffed instead.
 */
function rowSegments(a: string, b: string): Seg[] | null {
	const la = a.split("\n");
	const lb = b.split("\n");
	if (la.length !== lb.length) return null;
	const out: Seg[] = [];
	for (let k = 0; k < la.length; k++) {
		const pa = pipeSplit(la[k] as string);
		const pb = pipeSplit(lb[k] as string);
		if (pa.length !== pb.length) return null;
		if (k) out.push({ eq: "\n" });
		for (let j = 0; j < pa.length; j++) {
			if (j) out.push({ eq: "|" });
			out.push(...segments(pa[j] as string, pb[j] as string));
		}
	}
	return out;
}

/** Cells in a GFM table row: unescaped pipes, less an outer pair. */
function cellCount(line: string): number {
	const t = line.trim();
	let pipes = 0;
	let last = -1;
	for (let i = 0; i < t.length; i++) {
		if (t[i] === "\\") i++;
		else if (t[i] === "|") {
			pipes++;
			last = i;
		}
	}
	const lead = t.startsWith("|") ? 1 : 0;
	// The closing pipe as the loop read it: `\\|` is an escaped backslash
	// before a real pipe, `\|` an escaped pipe.
	const trail = t.length > 1 && last === t.length - 1 ? 1 : 0;
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
	const segs =
		(kind === "table-row" ? rowSegments(a, b) : null) ?? segments(a, b);
	for (const s of segs) {
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
