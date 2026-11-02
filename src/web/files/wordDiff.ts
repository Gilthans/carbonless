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

/** The token diff: no time limit (exact), and the owner's tighter marks. */
const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 0;
dmp.Diff_EditCost = 3;

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
