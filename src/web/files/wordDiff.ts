import DiffMatchPatch from "diff-match-patch";
import { joinedLength } from "../../shared/linePairing";
import { tokenEnd, WORD_DIFF_MAX } from "../../shared/tokenize";
import type { Mark } from "../code/Invisibles";

export { tokenize, WORD_DIFF_MAX } from "../../shared/tokenize";

/**
 * Word marks inside one pair of lines: GitHub's tokens, pairing and length
 * cut, the owner's marking rules (words first, nothing folds but the
 * spaces between two changes, a lone `\r` marked; spec:
 * docs/superpowers/specs/2026-11-01-inline-diff-design.md). The tokens and
 * the length cut live in src/shared/tokenize.ts (the tracer pairs lines
 * with them too).
 */

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
function encode(
	text: string,
	tokens: (text: string) => (i: number) => number,
): {
	chars: string;
	ends: number[];
	at: number[];
	words: string;
} {
	const units: number[] = [];
	const ends: number[] = [];
	const at: number[] = [];
	const words: number[] = [];
	const end = tokens(text);
	for (let i = 0; i < text.length; ) {
		const to = end(i);
		const t = text.slice(i, to);
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
		ends.push(to);
		i = to;
	}
	return {
		chars: String.fromCharCode(...units),
		ends,
		at,
		words: String.fromCharCode(...words),
	};
}

/** Another caller's tokens and length cut. */
export interface TokenRules {
	/** A text's tokenizer: where the token at `i` ends. */
	tokens?: (text: string) => (i: number) => number;
	/** A side this long or longer (UTF-16) gets no marks. */
	max?: number;
}

/** The line view's tokens. */
const lineTokens =
	(text: string) =>
	(i: number): number =>
		tokenEnd(text, i);

/** A plain pair. */
const none = (): { old: Mark[]; new: Mark[] } => ({ old: [], new: [] });

/** The token diff: no time limit, so exact (a longest common subsequence). */
const dmp = new DiffMatchPatch();
dmp.Diff_Timeout = 0;

/**
 * Where a diff changed something: tokens `[fromA, toA)` of one side against
 * `[fromB, toB)` of the other, a maximal stretch with no equal token.
 */
type OnBlock = (fromA: number, toA: number, fromB: number, toB: number) => void;

/**
 * Diffs tokens `[fromA, toA)` of `a` against `[fromB, toB)` of `b` (one
 * character per token) and flags each changed one in `changedA` /
 * `changedB`. A shared prefix and suffix are kept without running the diff;
 * a side left empty leaves the other all changed. `onBlock` hears each
 * changed stretch.
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
	onBlock?: OnBlock,
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
		if (fromA < toA || fromB < toB) onBlock?.(fromA, toA, fromB, toB);
		return;
	}
	let ia = fromA;
	let ib = fromB;
	// The open changed stretch's start, or -1.
	let blockA = -1;
	let blockB = -1;
	for (const [op, chars] of dmp.diff_main(
		a.slice(fromA, toA),
		b.slice(fromB, toB),
		false,
	)) {
		const n = chars.length;
		if (op !== DiffMatchPatch.DIFF_EQUAL && blockA < 0) {
			blockA = ia;
			blockB = ib;
		}
		if (op === DiffMatchPatch.DIFF_EQUAL) {
			if (blockA >= 0) onBlock?.(blockA, ia, blockB, ib);
			blockA = -1;
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
	if (blockA >= 0) onBlock?.(blockA, ia, blockB, ib);
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

/** A side's tokens as `encode` gives them. */
type Coded = { chars: string; at: number[]; words: string };

/**
 * The token diff of `tokenMarks`, flagging changed tokens in `changedA` /
 * `changedB`:
 * 1. the non-whitespace tokens alone; their equal tokens are anchors, so a
 *    shared word is never traded for a shared space;
 * 2. each gap between anchors (and before the first, after the last),
 *    spaces included. `onBlock` hears each changed stretch of this pass.
 */
function twoPass(
	ta: Coded,
	changedA: Uint8Array,
	tb: Coded,
	changedB: Uint8Array,
	onBlock?: OnBlock,
) {
	// Pass 1: the words. Their equal tokens are the anchors.
	let ia = 0; // word index walked
	let ib = 0;
	// Token indices just past the last anchor.
	let ga = 0;
	let gb = 0;
	const gap = (endA: number, endB: number) =>
		flag(ta.chars, ga, endA, changedA, tb.chars, gb, endB, changedB, onBlock);
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
	gap(changedA.length, changedB.length);
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
 *
 * `tokens` swaps the tokens and the length cut for another caller (the
 * Markdown renderer's word marks: spans as one token, a whole block).
 */
export function tokenMarks(
	oldText: string,
	newText: string,
	tokens: TokenRules = {},
): { old: Mark[]; new: Mark[] } {
	const max = tokens.max ?? WORD_DIFF_MAX;
	const tokenizer = tokens.tokens ?? lineTokens;
	if (oldText.length >= max || newText.length >= max) {
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
	// surrogates: a pair has fewer than 2 * `max` tokens, and `max` stays
	// well under 0xD700 / 2).
	codes.clear();
	blanks.clear();
	const ta = encode(a, tokenizer);
	const tb = encode(b, tokenizer);
	const changedA = new Uint8Array(ta.ends.length);
	const changedB = new Uint8Array(tb.ends.length);
	twoPass(ta, changedA, tb, changedB);
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
 * Never across a range of `apart` (a group's break).
 */
function bridge(
	text: string,
	marks: Mark[],
	apart: readonly Mark[] = [],
): Mark[] {
	const out: [number, number][] = [];
	for (const [from, to] of marks) {
		const last = out[out.length - 1];
		if (
			last &&
			blankRun(text, last[1], from) &&
			!apart.some(([f, t]) => f < from && t > last[1])
		)
			last[1] = to;
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

/** The end of the spaces and tabs from `i`. */
function skipBlank(text: string, i: number): number {
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c !== 0x20 && c !== 0x09) break;
		i++;
	}
	return i;
}

/** Comment leaders, the longer of two that share a start first. */
const LEADERS = ["///", "//", "#", "--", ";", "%", "*"] as const;

/**
 * The comment leader the line starts with after its indentation (`///`,
 * `//`, `#`, `--`, `;`, `%` or `*`, the longest that fits), if any. A
 * leader is followed by a space, a tab or the line's end (before a trailing
 * `\r`): `*out`, `--i`, `#!` and `#b` are code, not comments (and a rare
 * `//x` comment counts as none, the safe side: its text stays marked).
 */
export function commentLeader(text: string): string | undefined {
	const i = skipBlank(text, 0);
	return LEADERS.find((l) => {
		if (!text.startsWith(l, i)) return false;
		const j = i + l.length;
		const c = text.charCodeAt(j);
		return (
			j === text.length ||
			c === 0x20 ||
			c === 0x09 ||
			(c === 0x0d && j === text.length - 1)
		);
	});
}

/** A split or join to mark (spec 2026-11-24-split-joined-lines, "The marks"). */
export type GroupMarkJob = {
	/** The one line. */
	one: string;
	/** The run of lines on the other side, in order. */
	run: readonly string[];
	/** A split (the one line removed, the run added); else a join. */
	oneIsOld: boolean;
	/** A prose file (`proseFile`: Markdown, text, extensionless): no comment
	 * leader is part of a break. */
	prose: boolean;
};

/** A side's tokens, each with its line and range in that line. */
type Placed = Coded & {
	starts: number[];
	ends: number[];
	lines: number[];
	/** Token indices a break sits right before, one entry per break. */
	breaks: number[];
};

/** The tokens of `[from, to)` of each part's text, a break between parts. */
function encodeParts(
	parts: readonly { text: string; from: number; to: number }[],
): Placed {
	let chars = "";
	let words = "";
	const at: number[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	const lines: number[] = [];
	const breaks: number[] = [];
	for (const [k, { text, from, to }] of parts.entries()) {
		const n = ends.length;
		if (k > 0) breaks.push(n);
		const t = encode(text.slice(from, to), lineTokens);
		chars += t.chars;
		words += t.words;
		for (const i of t.at) at.push(n + i);
		let start = from;
		for (const end of t.ends) {
			starts.push(start);
			ends.push(from + end);
			lines.push(k);
			start = from + end;
		}
	}
	return { chars, words, at, starts, ends, lines, breaks };
}

/** Each line's changed tokens as merged ranges. */
function paint(side: Placed, changed: Uint8Array, count: number): Mark[][] {
	const out: [number, number][][] = Array.from({ length: count }, () => []);
	for (let i = 0; i < changed.length; i++) {
		if (!changed[i]) continue;
		const marks = out[side.lines[i] as number] as [number, number][];
		const from = side.starts[i] as number;
		const to = side.ends[i] as number;
		const last = marks[marks.length - 1];
		if (last && last[1] === from) last[1] = to;
		else marks.push([from, to]);
	}
	return out;
}

/** `marks` with the line's last character (its `\r`) marked too. */
function markCr(marks: [number, number][], length: number) {
	const last = marks[marks.length - 1];
	if (last && last[1] === length - 1) last[1] = length;
	else marks.push([length - 1, length]);
}

/**
 * Unmarks what each break of the run matches on the one line: a run of
 * spaces and tabs, the whole of it (the tokens the diff matched there are
 * interchangeable with those it didn't), or nothing. A break inside a
 * changed stretch takes the stretch's next run of spaces and tabs on the
 * one line; one between two matched tokens takes the run its place on the
 * one line touches. Returns the runs taken, which `bridge` never crosses.
 */
function takeBreaks(
	one: string,
	ones: Placed,
	changedOne: Uint8Array,
	runs: Placed,
	changedRun: Uint8Array,
	blocks: readonly [number, number, number, number][],
): Mark[] {
	const blank = (i: number) =>
		i >= 0 &&
		i < ones.ends.length &&
		blankRun(one, ones.starts[i] as number, ones.ends[i] as number);
	// Each matched run token's one-line token: the unchanged tokens of the
	// two sides, in order, are the diff's matches.
	const match = new Int32Array(changedRun.length).fill(-1);
	for (let i = 0, j = 0; i < changedRun.length; i++) {
		if (changedRun[i]) continue;
		while (changedOne[j]) j++;
		match[i] = j++;
	}
	const taken: Mark[] = [];
	const take = (i: number): number => {
		let from = i;
		let to = i + 1;
		while (blank(from - 1)) from--;
		while (blank(to)) to++;
		changedOne.fill(0, from, to);
		taken.push([ones.starts[from] as number, ones.ends[to - 1] as number]);
		return to;
	};
	// Each stretch's next token to look at.
	const next = blocks.map(([fromOne]) => fromOne);
	for (const b of runs.breaks) {
		const k = blocks.findIndex(([, , fr, tr]) => fr <= b && b <= tr);
		if (k >= 0) {
			const toOne = (blocks[k] as [number, number, number, number])[1];
			let i = next[k] as number;
			while (i < toOne && !blank(i)) i++;
			next[k] = i < toOne ? take(i) : toOne;
			continue;
		}
		// Between matched tokens (or a side's end): its place on the one line.
		const at =
			b < changedRun.length && match[b] !== -1
				? (match[b] as number)
				: b > 0 && match[b - 1] !== -1
					? (match[b - 1] as number) + 1
					: -1;
		if (at < 0) continue;
		if (blank(at - 1)) take(at - 1);
		else if (blank(at)) take(at);
	}
	return taken;
}

/**
 * The word marks of a group: the one line against its run, the lines of
 * the run tokenized one by one with one break token between two lines, so
 * a word at a line's end and one at the next line's start never fuse
 * (spec docs/superpowers/specs/2026-11-24-split-joined-lines-design.md,
 * "The marks"). Otherwise as `wordMarks`: words first as anchors, then the
 * gaps between anchors with spaces included; nothing folds.
 *
 * A break stands for the line end, the next line's indentation (spaces and
 * tabs) and, outside prose (`proseFile`), a comment leader the next line starts with
 * when the one line starts with the same one (`commentLeader`), with the
 * spaces and tabs after it. It is never marked. It matches one run of
 * spaces and tabs on the one line, or nothing (`takeBreaks`): that run is
 * never marked either. The first run line's indentation and leader, and
 * spaces before a line end, are ordinary tokens.
 *
 * `\r`: one is marked when the line endings disagree, never otherwise.
 * When the one line ends in `\r` (a CRLF file), no run line's trailing
 * `\r` is marked, and the one line's is unless the run's last line ends in
 * one too. When it doesn't, every run line's trailing `\r` is marked.
 * (A middle run line without `\r` in a CRLF file has nothing to mark.)
 *
 * Marks are bridged per line (`bridge`), never across a break; a change
 * across a break is one mark per line. No marks when the one line or the
 * joined run (`joinedLength`) is `WORD_DIFF_MAX` long or more.
 */
export function groupMarks(job: GroupMarkJob): { one: Mark[]; run: Mark[][] } {
	const { one, run, oneIsOld, prose } = job;
	if (one.length >= WORD_DIFF_MAX || joinedLength(run) >= WORD_DIFF_MAX) {
		return { one: [], run: run.map(() => []) };
	}
	const oneCr = one.endsWith("\r");
	const leader = prose ? undefined : commentLeader(one);
	codes.clear();
	blanks.clear();
	const ones = encodeParts([
		{ text: one, from: 0, to: one.length - (oneCr ? 1 : 0) },
	]);
	const runs = encodeParts(
		run.map((text, k) => {
			let from = 0;
			if (k > 0) {
				from = skipBlank(text, 0);
				if (leader !== undefined && commentLeader(text) === leader) {
					from = skipBlank(text, from + leader.length);
				}
			}
			const to = text.length - (text.endsWith("\r") ? 1 : 0);
			return { text, from, to: Math.max(from, to) };
		}),
	);
	const changedOne = new Uint8Array(ones.ends.length);
	const changedRun = new Uint8Array(runs.ends.length);
	// The changed stretches, as [fromOne, toOne, fromRun, toRun].
	const blocks: [number, number, number, number][] = [];
	if (oneIsOld) {
		twoPass(ones, changedOne, runs, changedRun, (fo, to, fr, tr) =>
			blocks.push([fo, to, fr, tr]),
		);
	} else {
		twoPass(runs, changedRun, ones, changedOne, (fr, tr, fo, to) =>
			blocks.push([fo, to, fr, tr]),
		);
	}
	const taken = takeBreaks(one, ones, changedOne, runs, changedRun, blocks);
	const oneMarks = paint(ones, changedOne, 1)[0] as [number, number][];
	const runMarks = paint(runs, changedRun, run.length) as [number, number][][];
	const lastCr =
		run.length > 0 && (run[run.length - 1] as string).endsWith("\r");
	if (oneCr && !lastCr) markCr(oneMarks, one.length);
	if (!oneCr) {
		for (const [k, text] of run.entries()) {
			if (text.endsWith("\r"))
				markCr(runMarks[k] as [number, number][], text.length);
		}
	}
	return {
		one: bridge(one, oneMarks, taken),
		run: runMarks.map((marks, k) => bridge(run[k] as string, marks)),
	};
}
