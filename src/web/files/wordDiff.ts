import DiffMatchPatch from "diff-match-patch";
import type { Mark } from "../code/Invisibles";

/**
 * Word marks inside one pair of lines: GitHub's tokens, pairing and length
 * cut, the owner's marking rules (words first, nothing folds but the
 * spaces between two changes, a lone `\r` marked; spec:
 * docs/superpowers/specs/2026-11-01-inline-diff-design.md).
 * A pair with a line this long or longer (UTF-16 `length`) has no marks, as
 * on GitHub.
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
/** The codes (from `codes`) of whitespace tokens. */
const blanks = new Set<number>();
/** A whitespace code point: a token of its own. */
const BLANK = /^\s$/u;

/**
 * The line's tokens as one character each (`codes`), each one's end, and
 * its non-whitespace tokens alone: their indices (`at`) and characters.
 */
function encode(text: string): {
	chars: string;
	ends: number[];
	at: number[];
	words: string;
} {
	const units: number[] = [];
	const ends: number[] = [];
	const at: number[] = [];
	const words: number[] = [];
	for (let i = 0; i < text.length; ) {
		const end = tokenEnd(text, i);
		const t = text.slice(i, end);
		let c = codes.get(t);
		if (c === undefined) {
			c = 0x100 + codes.size;
			codes.set(t, c);
			if (BLANK.test(t)) blanks.add(c);
		}
		if (!blanks.has(c)) {
			at.push(units.length);
			words.push(c);
		}
		units.push(c);
		ends.push(end);
		i = end;
	}
	return {
		chars: String.fromCharCode(...units),
		ends,
		at,
		words: String.fromCharCode(...words),
	};
}

/** A plain pair. */
const none = (): { old: Mark[]; new: Mark[] } => ({ old: [], new: [] });

/** The token diff: no time limit, so exact (a longest common subsequence). */
const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 0;

/**
 * Diffs tokens `[fromA, toA)` of `a` against `[fromB, toB)` of `b` (one
 * character per token) and flags each changed one in `changedA` /
 * `changedB`. A shared prefix and suffix are kept without running the diff;
 * a side left empty leaves the other all changed.
 */
function flag(
	a: string,
	fromA: number,
	toA: number,
	changedA: Uint8Array,
	b: string,
	fromB: number,
	toB: number,
	changedB: Uint8Array,
) {
	while (
		fromA < toA &&
		fromB < toB &&
		a.charCodeAt(fromA) === b.charCodeAt(fromB)
	) {
		fromA++;
		fromB++;
	}
	while (
		fromA < toA &&
		fromB < toB &&
		a.charCodeAt(toA - 1) === b.charCodeAt(toB - 1)
	) {
		toA--;
		toB--;
	}
	if (fromA === toA || fromB === toB) {
		changedA.fill(1, fromA, toA);
		changedB.fill(1, fromB, toB);
		return;
	}
	let ia = fromA;
	let ib = fromB;
	for (const [op, chars] of dmp.diff_main(
		a.slice(fromA, toA),
		b.slice(fromB, toB),
		false,
	)) {
		const n = chars.length;
		if (op === DiffMatchPatch.DIFF_EQUAL) {
			ia += n;
			ib += n;
		} else if (op === DiffMatchPatch.DIFF_DELETE) {
			changedA.fill(1, ia, ia + n);
			ia += n;
		} else {
			changedB.fill(1, ib, ib + n);
			ib += n;
		}
	}
}

/** The changed tokens' ranges, adjacent ones merged. */
function ranges(changed: Uint8Array, ends: number[]): Mark[] {
	const out: [number, number][] = [];
	for (let i = 0; i < changed.length; i++) {
		if (!changed[i]) continue;
		const from = i === 0 ? 0 : (ends[i - 1] as number);
		const to = ends[i] as number;
		const last = out[out.length - 1];
		if (last && last[1] === from) last[1] = to;
		else out.push([from, to]);
	}
	return out;
}

/**
 * The changed tokens of a removed line (`old`) and its paired added line
 * (`new`), as sorted, non-overlapping, merged UTF-16 ranges. Two token
 * diffs (diff-match-patch over one character per token, exact):
 * 1. the non-whitespace tokens alone; their equal tokens are anchors, so a
 *    shared word is never traded for a shared space;
 * 2. each gap between anchors (and before the first, after the last),
 *    spaces included.
 * A token is marked when a diff says it changed; nothing folds (owner,
 * 2026-11-04). A trailing `\r` is marked only when one line alone ends in
 * it. No marks when either line is too long. Before bridging: `wordMarks`
 * is what the view shows.
 */
export function tokenMarks(
	oldText: string,
	newText: string,
): { old: Mark[]; new: Mark[] } {
	if (oldText.length >= WORD_DIFF_MAX || newText.length >= WORD_DIFF_MAX) {
		return none();
	}
	// A trailing `\r` both lines end in is never marked; one only one line
	// ends in is a changed (whitespace) token like any other (owner,
	// 2026-11-04: a CRLF-only pair is not plain).
	const cr = oldText.endsWith("\r") && newText.endsWith("\r");
	const a = cr ? oldText.slice(0, -1) : oldText;
	const b = cr ? newText.slice(0, -1) : newText;
	if (a === b) return none();
	// Each distinct token as one character (from U+0100, far below the
	// surrogates: a pair has at most 2,046 tokens).
	codes.clear();
	blanks.clear();
	const ta = encode(a);
	const tb = encode(b);
	const changedA = new Uint8Array(ta.ends.length);
	const changedB = new Uint8Array(tb.ends.length);
	// Pass 1: the words. Their equal tokens are the anchors.
	let ia = 0; // word index walked
	let ib = 0;
	// Token indices just past the last anchor.
	let ga = 0;
	let gb = 0;
	const gap = (endA: number, endB: number) =>
		flag(ta.chars, ga, endA, changedA, tb.chars, gb, endB, changedB);
	for (const [op, chars] of dmp.diff_main(ta.words, tb.words, false)) {
		const n = chars.length;
		if (op === DiffMatchPatch.DIFF_DELETE) ia += n;
		else if (op === DiffMatchPatch.DIFF_INSERT) ib += n;
		else {
			for (let k = 0; k < n; k++) {
				const anchorA = ta.at[ia + k] as number;
				const anchorB = tb.at[ib + k] as number;
				// Pass 2: the gap before this anchor, spaces included.
				gap(anchorA, anchorB);
				ga = anchorA + 1;
				gb = anchorB + 1;
			}
			ia += n;
			ib += n;
		}
	}
	gap(ta.ends.length, tb.ends.length);
	return { old: ranges(changedA, ta.ends), new: ranges(changedB, tb.ends) };
}

/**
 * Whether `[from, to)` of `text` is spaces and tabs only, at least one.
 * Other whitespace doesn't bridge: no-break, ideographic and zero-width
 * no-break spaces draw as `\uXXXX` escapes, and a mid-line `\r`, `\v`, `\f`
 * or line separator isn't a plain blank.
 */
function blankRun(text: string, from: number, to: number): boolean {
	if (from >= to) return false;
	for (let i = from; i < to; i++) {
		const c = text.charCodeAt(i);
		if (c !== 0x20 && c !== 0x09) return false;
	}
	return true;
}

/**
 * Two marks joined when only spaces and tabs sit between them (owner,
 * 2026-11-04: "Merge the spaces between two changes into one. That makes
 * sense."). Marks are merged ranges of whole tokens and every whitespace
 * code point is a token of its own, so the gap between two marks is
 * unchanged tokens, all spaces and tabs exactly when `blankRun` says so.
 */
function bridge(text: string, marks: Mark[]): Mark[] {
	const out: [number, number][] = [];
	for (const [from, to] of marks) {
		const last = out[out.length - 1];
		if (last && blankRun(text, last[1], from)) last[1] = to;
		else out.push([from, to]);
	}
	return out;
}

/**
 * The marks the view shows: `tokenMarks`, then on each side a run of
 * unchanged spaces and tabs with a change right before and right after it is
 * marked too, so the two changes and the spaces between are one mark. An
 * unchanged word, digit run or punctuation token keeps two changes apart;
 * whitespace next to one change alone stays plain.
 */
export function wordMarks(
	oldText: string,
	newText: string,
): { old: Mark[]; new: Mark[] } {
	const marks = tokenMarks(oldText, newText);
	return {
		old: bridge(oldText, marks.old),
		new: bridge(newText, marks.new),
	};
}
