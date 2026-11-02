import DiffMatchPatch from "diff-match-patch";
import type { Mark } from "../code/Invisibles";

/**
 * Word marks inside one pair of lines, GitHub's way (spec:
 * docs/superpowers/specs/2026-11-01-inline-diff-design.md). A pair with a
 * line this long or longer (UTF-16 `length`) has no marks, as on GitHub.
 */
export const WORD_DIFF_MAX = 1024;

/** A letter, combining mark, digit or `_`: what a word run is made of. */
const WORD = /^[\p{L}\p{M}\p{N}_]$/u;

/** Whether the code point at `i` is a word one (ASCII without the regex). */
function wordAt(text: string, i: number): boolean {
	const c = text.charCodeAt(i);
	if (c < 0x80) {
		return (
			(c >= 0x61 && c <= 0x7a) || // a-z
			(c >= 0x41 && c <= 0x5a) || // A-Z
			(c >= 0x30 && c <= 0x39) || // 0-9
			c === 0x5f // _
		);
	}
	return WORD.test(String.fromCodePoint(text.codePointAt(i) as number));
}

/** UTF-16 length of the code point at `i`. */
const widthAt = (text: string, i: number): number =>
	(text.codePointAt(i) as number) > 0xffff ? 2 : 1;

/** The end of the token that starts at `i`. */
function tokenEnd(text: string, i: number): number {
	const n = text.length;
	const word = wordAt(text, i);
	let end = i + widthAt(text, i);
	if (word) while (end < n && wordAt(text, end)) end += widthAt(text, end);
	return end;
}

/**
 * The line's tokens: a run of letters, marks, digits and `_` whole, every
 * other code point alone.
 */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < text.length; ) {
		const end = tokenEnd(text, i);
		out.push(text.slice(i, end));
		i = end;
	}
	return out;
}

/** Token to its one-character code, for the pair being diffed. */
const codes = new Map<string, number>();

/** The line's tokens as one character each (`codes`), and each one's end. */
function encode(text: string): { chars: string; ends: number[] } {
	const units: number[] = [];
	const ends: number[] = [];
	for (let i = 0; i < text.length; ) {
		const end = tokenEnd(text, i);
		const t = text.slice(i, end);
		let c = codes.get(t);
		if (c === undefined) {
			c = 0x100 + codes.size;
			codes.set(t, c);
		}
		units.push(c);
		ends.push(end);
		i = end;
	}
	return { chars: String.fromCharCode(...units), ends };
}

/** A plain pair. */
const none = (): { old: Mark[]; new: Mark[] } => ({ old: [], new: [] });

/**
 * diff-match-patch's `diff_bisect_` (Myers' middle snake), step for step,
 * on typed arrays and without its per-step clock read (there is no
 * deadline: `Diff_Timeout = 0`). Same diffs as the library's
 * (wordDiff.test.ts compares them), in about half the CPU.
 */
/** The library's own split step (private, so not in its types). */
type Splitting = DiffMatchPatch & {
	diff_bisectSplit_(
		text1: string,
		text2: string,
		x: number,
		y: number,
		deadline: number,
	): DiffMatchPatch.Diff[];
};

/**
 * The bisect's two paths, reused: a call is done with them before it
 * recurses (it returns the split's result), so one pair is enough.
 */
let V1 = new Int32Array(256);
let V2 = new Int32Array(256);

function bisect(
	this: Splitting,
	text1: string,
	text2: string,
	deadline: number,
): DiffMatchPatch.Diff[] {
	const n1 = text1.length;
	const n2 = text2.length;
	const maxD = Math.ceil((n1 + n2) / 2);
	const off = maxD;
	const len = 2 * maxD;
	if (V1.length < len) {
		V1 = new Int32Array(len);
		V2 = new Int32Array(len);
	}
	const v1 = V1;
	const v2 = V2;
	v1.fill(-1, 0, len);
	v2.fill(-1, 0, len);
	v1[off + 1] = 0;
	v2[off + 1] = 0;
	const delta = n1 - n2;
	// An odd total: the front path meets the reverse one.
	const front = delta % 2 !== 0;
	let k1start = 0;
	let k1end = 0;
	let k2start = 0;
	let k2end = 0;
	const at = (v: Int32Array, i: number) => v[i] as number;
	for (let d = 0; d < maxD; d++) {
		for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
			const k1o = off + k1;
			let x1 =
				k1 === -d || (k1 !== d && at(v1, k1o - 1) < at(v1, k1o + 1))
					? at(v1, k1o + 1)
					: at(v1, k1o - 1) + 1;
			let y1 = x1 - k1;
			while (
				x1 < n1 &&
				y1 < n2 &&
				text1.charCodeAt(x1) === text2.charCodeAt(y1)
			) {
				x1++;
				y1++;
			}
			v1[k1o] = x1;
			if (x1 > n1) k1end += 2;
			else if (y1 > n2) k1start += 2;
			else if (front) {
				const k2o = off + delta - k1;
				if (k2o >= 0 && k2o < len && at(v2, k2o) !== -1) {
					if (x1 >= n1 - at(v2, k2o)) {
						return this.diff_bisectSplit_(text1, text2, x1, y1, deadline);
					}
				}
			}
		}
		for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
			const k2o = off + k2;
			let x2 =
				k2 === -d || (k2 !== d && at(v2, k2o - 1) < at(v2, k2o + 1))
					? at(v2, k2o + 1)
					: at(v2, k2o - 1) + 1;
			let y2 = x2 - k2;
			while (
				x2 < n1 &&
				y2 < n2 &&
				text1.charCodeAt(n1 - x2 - 1) === text2.charCodeAt(n2 - y2 - 1)
			) {
				x2++;
				y2++;
			}
			v2[k2o] = x2;
			if (x2 > n1) k2end += 2;
			else if (y2 > n2) k2start += 2;
			else if (!front) {
				const k1o = off + delta - k2;
				if (k1o >= 0 && k1o < len && at(v1, k1o) !== -1) {
					const x1 = at(v1, k1o);
					const y1 = off + x1 - k1o;
					if (x1 >= n1 - x2) {
						return this.diff_bisectSplit_(text1, text2, x1, y1, deadline);
					}
				}
			}
		}
	}
	// No common token at all.
	return [
		[DiffMatchPatch.DIFF_DELETE, text1],
		[DiffMatchPatch.DIFF_INSERT, text2],
	];
}

/**
 * The diff-match-patch the marks use: no timeout, `Diff_EditCost = 3`, and
 * (unless `stock`) the typed-array bisect.
 */
export function tokenDiffer(stock = false): DiffMatchPatch {
	const d = new DiffMatchPatch();
	d.Diff_Timeout = 0;
	d.Diff_EditCost = 3;
	if (!stock) d.diff_bisect_ = bisect as DiffMatchPatch["diff_bisect_"];
	return d;
}

const dmp = tokenDiffer();

/** One trailing `\r` is never part of a mark (a CRLF-only pair is plain). */
const withoutCr = (text: string): string =>
	text.endsWith("\r") ? text.slice(0, -1) : text;

/** Adds `[from, to)` to sorted ranges, joining it to the last when they touch. */
function push(ranges: [number, number][], from: number, to: number) {
	const last = ranges[ranges.length - 1];
	if (last && last[1] === from) last[1] = to;
	else ranges.push([from, to]);
}

/**
 * The changed tokens of a removed line (`old`) and its paired added line
 * (`new`), as sorted, non-overlapping, merged UTF-16 ranges: a token diff
 * (diff-match-patch over one character per token) tightened by
 * `diff_cleanupEfficiency`. No marks when either line is too long.
 */
export function wordMarks(
	oldText: string,
	newText: string,
): { old: Mark[]; new: Mark[] } {
	if (oldText.length >= WORD_DIFF_MAX || newText.length >= WORD_DIFF_MAX) {
		return none();
	}
	const a = withoutCr(oldText);
	const b = withoutCr(newText);
	if (a === b) return none();
	// Each distinct token as one character (from U+0100, far below the
	// surrogates: a pair has at most 2,046 tokens).
	codes.clear();
	const ta = encode(a);
	const tb = encode(b);
	const diffs = dmp.diff_main(ta.chars, tb.chars, false);
	dmp.diff_cleanupEfficiency(diffs);
	const old: [number, number][] = [];
	const young: [number, number][] = [];
	// Token counts walked on each side; a token's range is ends[i-1]..ends[i].
	let ia = 0;
	let ib = 0;
	const endOf = (ends: number[], i: number) =>
		i === 0 ? 0 : (ends[i - 1] as number);
	for (const [op, chars] of diffs) {
		const n = chars.length;
		if (op === DiffMatchPatch.DIFF_EQUAL) {
			ia += n;
			ib += n;
		} else if (op === DiffMatchPatch.DIFF_DELETE) {
			push(old, endOf(ta.ends, ia), endOf(ta.ends, ia + n));
			ia += n;
		} else {
			push(young, endOf(tb.ends, ib), endOf(tb.ends, ib + n));
			ib += n;
		}
	}
	return { old, new: young };
}
