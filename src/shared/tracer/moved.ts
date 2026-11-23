/**
 * A replaced line that went elsewhere in its file: the tracer's move search
 * (CAR-95 step 3), and the contest that keeps a partner nearby from losing
 * to a line elsewhere that only resembles the old one.
 *
 * A moved block is a run of the old file's removed lines found again, line
 * for line, as a run of the new file's added lines: equal (as `sameKey`
 * compares them), or alike (PAIR_MIN_SIMILARITY) beside an equal one. A
 * run moves a thread only with two lines with a word or more,
 * TUNING.minAlnum letters and digits on its equal lines (git's
 * `--color-moved` minimum), and more than half of its hunk's removed lines
 * carried (`carries`: a block that moved takes most of what git removed
 * around it; two lines of boilerplate don't). An alike line that opens a
 * block (`func a() {` against `func b() {`) never extends a run: a block's
 * header names it. A line follows its run only when that run leads every
 * other by TUNING.contextMargin: an identical block that appears twice is
 * ambiguous, never a pick. No move, but the text is among the added lines
 * as it was: "copies" (the caller says `rewritten`, not `deleted`).
 *
 * A line edited in place keeps its partner nearby (trace.ts's `anchored`,
 * and `held` here). Otherwise the partner, a move, and the file's
 * look-alikes compete on likeness plus context (`contested`), where a line
 * elsewhere needs its surroundings to lead, gets nothing for neighbours
 * that stayed at home, and never wins from new code.
 *
 * Every lookup works from an index of the file's added and removed lines
 * built once per `bd` mapper (shared by every thread traced through it, as
 * trace.ts's pairings are), checked against the caller's texts (once per
 * pair of readers) and rebuilt on a mismatch, never answered from.
 *
 * Pure: no git, no I/O, nothing from `src/server/`.
 */

import {
	alikeAtLeast,
	PAIR_MIN_SIMILARITY,
	similarityMemo,
} from "../linePairing.js";
import { HAS_WORD } from "../tokenize.js";
import type { LineMapper, MapHunk } from "./lineMapper.js";
import type { Position } from "./trace.js";

/**
 * The move search's and the contest's tuning. Tests nudge each value (the
 * property test in placement.test.ts) to check no placement goes wrong at
 * a neighbouring setting; nothing else writes it.
 *
 * - minAlnum: letters and digits a moved run's equal lines need between
 *   them (git's COLOR_MOVED_MIN_ALNUM_COUNT).
 * - contextLines: neighbours each way whose likeness counts as a
 *   candidate's context (and whose staying makes a partner anchored).
 * - contextMargin: how far ahead (likeness plus context) a contest's or a
 *   move's winner must be.
 * - contestMargin: how close a look-alike's likeness must come to the
 *   partner's to contest it (or beat it).
 */
export const TUNING = {
	minAlnum: 20,
	contextLines: 3,
	contextMargin: 0.25,
	contestMargin: 0.15,
};

/**
 * Added lines equal to the one looked up past this: too common to say
 * where it went; no move (the partner nearby, if any, decides).
 */
export const MOVE_MAX_CANDIDATES = 32;

/** How far a run extends from its seed, each way. */
const MOVE_MAX_RUN = 200;

/** Rivals a contest weighs at most, once no bound settles it. */
const CONTEST_MAX_RIVALS = 64;

/** Two scores this close are a tie. */
const EPS = 1e-9;

/** A line that opens a block, as trace.ts's OPENS_BLOCK. */
export const OPENS_BLOCK = /[{([:]\s*$/u;

const ALNUM = /[\p{L}\p{N}_]/gu;

/**
 * A line's tokens without whitespace, apart: equal when only whitespace
 * differs (indentation, alignment, spaces around an operator), never when
 * it joins or splits a word (`int x` vs `intx`). Whitespace inside a string
 * literal counts as whitespace too, as in the similarity pairing: telling
 * a literal apart needs the language.
 */
function sameKey(t: string): string {
	const parts: string[] = [];
	let from = -1;
	let lastWord = false;
	let gap = false;
	for (let i = 0; i <= t.length; i++) {
		const c = i < t.length ? t.charCodeAt(i) : 32;
		const space =
			c === 32 ||
			(c >= 9 && c <= 13) ||
			(c > 127 && SPACE.test(t[i] as string));
		if (space) {
			if (from !== -1) {
				const run = t.slice(from, i);
				const word = isWord(run.charCodeAt(0), run[0] as string);
				if (gap && lastWord && word) parts.push("\u0001");
				parts.push(run);
				lastWord = isWord(run.charCodeAt(run.length - 1), run.at(-1) as string);
				gap = true;
				from = -1;
			}
		} else if (from === -1) from = i;
	}
	return parts.join("");
}

/** HAS_WORD, with an ASCII test first (the index tests every changed line). */
const hasWord = (t: string) => ASCII_HAS_WORD.test(t) || HAS_WORD.test(t);
const ASCII_HAS_WORD = /[A-Za-z0-9_]/;

const isWord = (c: number, ch: string) =>
	c < 128 ? ASCII_WORD[c] === 1 : WORD.test(ch);

const SPACE = /\s/u;
const WORD = /[\p{L}\p{M}\p{N}_]/u;
/** 1 for an ASCII letter, digit or `_`. */
const ASCII_WORD = Uint8Array.from({ length: 128 }, (_, c) =>
	(c >= 48 && c <= 57) ||
	(c >= 65 && c <= 90) ||
	(c >= 97 && c <= 122) ||
	c === 95
		? 1
		: 0,
);

/** `sameKey`, memoized per text (one cache per file index). */
type Same = (t: string) => string;
function sameMemo(): Same {
	const known = new Map<string, string>();
	return (t) => {
		let k = known.get(t);
		if (k === undefined) {
			k = sameKey(t);
			known.set(t, k);
		}
		return k;
	};
}

const alnum = (t: string) => t.match(ALNUM)?.length ?? 0;

const indent = (t: string) => t.length - t.trimStart().length;

export interface TextReaders {
	bd: LineMapper;
	oldLineText?: (pos: Position) => string | null;
	newLineText?: (pos: Position) => string | null;
	/**
	 * Whether removed old line `oldLine` has a partner in place other than
	 * new line `image` (trace.ts): it stayed, edited.
	 */
	stays?: (oldLine: number, image: number) => boolean;
}

type Reader = (pos: Position) => string | null;

/** The file's changed lines, as one `bd` diff and its two texts give them. */
interface FileIndex {
	/** New lines the diff added, ascending, and their text. */
	added: number[];
	addedText: (string | null)[];
	/** Old lines the diff removed, ascending, and their text. */
	removed: number[];
	removedText: (string | null)[];
	/** `same` text (with a word) to its added lines. */
	addedBySame: Map<string, number[]>;
	/** The same for removed lines. */
	removedBySame: Map<string, number[]>;
	/** Readers already checked against the texts above. */
	checked: WeakSet<Reader>;
	/** lineSimilarity, each text prepared once. */
	sim: (a: string, b: string) => number;
	/** `sameKey`, memoized. */
	same: Same;
	/** Indices into `added` of lines at least `min` alike `oldText` (alikeAtLeast). */
	alike?: (oldText: string, min: number, cap?: number) => number[] | null;
	/** Indices into `removed` of lines at least `min` alike a new text. */
	alikeRemoved?: (
		newText: string,
		min: number,
		cap?: number,
	) => number[] | null;
	/** Per added line, the removed line it is the mutual best of (claimed). */
	mutual: Map<number, { other: number; score: number } | null>;
	/** Per hunk, its removed lines with a word. */
	hunkWords: Map<MapHunk, number>;
	/** How often each `same` key occurs in the whole old file (made when needed). */
	oldCounts?: Map<string, number>;
}

const indexes = new WeakMap<LineMapper, FileIndex>();

function readOld(r: TextReaders, n: number): string | null {
	return r.oldLineText?.({ side: "RIGHT", line: n }) ?? null;
}
function readNew(r: TextReaders, n: number): string | null {
	return r.newLineText?.({ side: "RIGHT", line: n }) ?? null;
}

function build(r: TextReaders): FileIndex {
	const added: number[] = [];
	const removed: number[] = [];
	for (const h of r.bd.hunks) {
		for (let n = h.newStart; n < h.newStart + h.newCount; n++) added.push(n);
		for (let n = h.oldStart; n < h.oldStart + h.oldCount; n++) removed.push(n);
	}
	added.sort((a, b) => a - b);
	removed.sort((a, b) => a - b);
	const addedText = added.map((n) => readNew(r, n));
	const removedText = removed.map((n) => readOld(r, n));
	const same = sameMemo();
	const bySame = (lines: number[], texts: (string | null)[]) => {
		const out = new Map<string, number[]>();
		lines.forEach((n, i) => {
			const t = texts[i];
			if (t == null || !hasWord(t)) return;
			const key = sameKey(t);
			const list = out.get(key);
			if (list) list.push(n);
			else out.set(key, [n]);
		});
		return out;
	};
	const checked = new WeakSet<Reader>();
	if (r.oldLineText) checked.add(r.oldLineText);
	if (r.newLineText) checked.add(r.newLineText);
	return {
		added,
		addedText,
		removed,
		removedText,
		addedBySame: bySame(added, addedText),
		removedBySame: bySame(removed, removedText),
		checked,
		sim: similarityMemo(),
		same,
		mutual: new Map(),
		hunkWords: new Map(),
	};
}

/** The index of `r.bd`, rebuilt when the caller's texts differ from its own. */
function indexOf(r: TextReaders): FileIndex {
	const known = indexes.get(r.bd);
	if (known && sameTexts(known, r)) return known;
	const fresh = build(r);
	indexes.set(r.bd, fresh);
	return fresh;
}

/**
 * False when `r.bd`'s index was read from other texts than `r`'s: a memo
 * of answers that depend on it (trace.ts's partners) is stale.
 */
export function sameFileTexts(r: TextReaders): boolean {
	const known = indexes.get(r.bd);
	return !known || sameTexts(known, r);
}

/**
 * Whether `r` reads the texts `x` was built from: every changed line read
 * once per reader (the server passes the same readers for every thread of
 * a file, so this costs once per file, not per thread).
 */
function sameTexts(x: FileIndex, r: TextReaders): boolean {
	const fresh = r.newLineText;
	if (fresh && !x.checked.has(fresh)) {
		for (let i = 0; i < x.added.length; i++) {
			if (readNew(r, x.added[i] as number) !== x.addedText[i]) return false;
		}
		x.checked.add(fresh);
	}
	const old = r.oldLineText;
	if (old && !x.checked.has(old)) {
		for (let i = 0; i < x.removed.length; i++) {
			if (readOld(r, x.removed[i] as number) !== x.removedText[i]) {
				return false;
			}
		}
		x.checked.add(old);
	}
	return true;
}

/** A run of old lines found again as new lines, line for line. */
interface Run {
	/** First and last old line, and the new line of the first. */
	oldFrom: number;
	oldTo: number;
	newFrom: number;
	/** Sum of its word lines' similarity (an equal line: 1). */
	score: number;
	/** Letters and digits on its equal word lines. */
	equalAlnum: number;
	/** Its lines with a word. */
	words: number;
}

/**
 * The run through old line `o` and new line `n` (taken as a pair): both
 * ways, while the old line is removed, the new one added, and the two are
 * equal (a wordless line too: a `}`, a blank) or both have a word, are
 * alike, and don't open a block. Alike lines never follow one another: one
 * sits beside an equal line, or the run ends (a run of look-alikes is a
 * near-copy, not the block itself).
 */
function runThrough(
	o: number,
	n: number,
	r: TextReaders,
	x: FileIndex,
): Run | null {
	const first = pairScore(o, n, r, x);
	if (first === null) return null;
	const run: Run = {
		oldFrom: o,
		oldTo: o,
		newFrom: n,
		score: first.score,
		equalAlnum: first.equalAlnum,
		words: first.word ? 1 : 0,
	};
	for (const step of [-1, 1]) {
		let alike = first.equalAlnum === 0 && first.word;
		for (let i = 1; i <= MOVE_MAX_RUN; i++) {
			const p = pairScore(o + step * i, n + step * i, r, x);
			if (p === null) break;
			const isAlike = p.word && p.score < 1;
			if (isAlike && alike) break;
			alike = isAlike;
			run.score += p.score;
			run.equalAlnum += p.equalAlnum;
			if (p.word) run.words++;
			if (step < 0) {
				run.oldFrom = o - i;
				run.newFrom = n - i;
			} else run.oldTo = o + i;
		}
	}
	return run;
}

function pairScore(
	o: number,
	n: number,
	r: TextReaders,
	x: FileIndex,
): { score: number; equalAlnum: number; word: boolean } | null {
	if (o < 1 || n < 1) return null;
	if (r.bd.hunkRemovingOld(o) === null || r.bd.hunkAddingNew(n) === null) {
		return null;
	}
	const a = readOld(r, o);
	const b = readNew(r, n);
	if (a === null || b === null) return null;
	const word = HAS_WORD.test(a);
	if (x.same(a) === x.same(b)) {
		return word
			? { score: 1, equalAlnum: alnum(a), word }
			: { score: 0, equalAlnum: 0, word };
	}
	if (!word || !HAS_WORD.test(b)) return null;
	if (OPENS_BLOCK.test(a) || OPENS_BLOCK.test(b)) return null;
	const s = x.sim(a, b);
	return s >= PAIR_MIN_SIMILARITY ? { score: s, equalAlnum: 0, word } : null;
}

/**
 * Where old line `o` went with its moved run: its new line; "ambiguous";
 * "copies": none decided, but its text is among the added lines as it was
 * (so "deleted" would be a false claim); null: none.
 */
export type Moved = { line: number } | "ambiguous" | "copies" | null;

/** Whether a run is a block (two word lines, enough letters): see the file's doc. */
const block = (run: Run | null): run is Run =>
	run !== null && run.words >= 2 && run.equalAlnum >= TUNING.minAlnum;

/**
 * Whether new line `n` sits directly under an opener like `opener` (equal
 * ignoring whitespace, or alike): the nearest line with a word above it,
 * indented less than `n`. A block that joined another of its kind (`const
 * (` under `const (`) took its opener's place; a block dropped from an `if
 * strict {` or a `with mock.patch(...):` and found under another opener
 * left that opener behind.
 */
function joinsLike(
	opener: string,
	n: number,
	r: TextReaders,
	x: FileIndex,
): boolean {
	const own = readNew(r, n);
	if (own === null) return false;
	const depth = indent(own);
	for (let m = n - 1; m >= 1; m--) {
		const t = readNew(r, m);
		if (t === null) return false;
		if (!hasWord(t) || indent(t) >= depth) continue;
		return (
			x.same(t) === x.same(opener) || x.sim(opener, t) >= PAIR_MIN_SIMILARITY
		);
	}
	return false;
}

/**
 * Whether old line `o`'s text says something on its own: TUNING.minAlnum
 * letters and digits, or once in the old file. A copy of `t.Parallel()` or
 * `return nil` among the added lines says nothing about where a deleted
 * one went: it stays `deleted`.
 */
function telling(o: number, r: TextReaders, x: FileIndex): boolean {
	const t = readOld(r, o);
	if (t === null) return false;
	return alnum(t) >= TUNING.minAlnum || oldCounts(r, x).get(x.same(t)) === 1;
}

/** `telling` of old line `o`, for trace.ts (its index built when needed). */
export function tellingLine(o: number, r: TextReaders): boolean {
	return telling(o, r, indexOf(r));
}

/** `hunk`'s removed lines with a word, memoized. */
function wordsOf(hunk: MapHunk, r: TextReaders, x: FileIndex): number {
	let n = x.hunkWords.get(hunk);
	if (n === undefined) {
		n = 0;
		for (let o = hunk.oldStart; o < hunk.oldStart + hunk.oldCount; o++) {
			if (hasWord(readOld(r, o) ?? "")) n++;
		}
		x.hunkWords.set(hunk, n);
	}
	return n;
}

/**
 * Whether a block moved a thread of `hunk`. With no partner nearby
 * (`whole`, a pure deletion), the run must carry every removed line with a
 * word of the hunk that has no partner in place of its own (`stays`):
 * the block really moved. Two or three lines of boilerplate dropped from a
 * function that is still there, found in new code, did not (owner's call,
 * 2026-11-23: wrong is worse than unplaced). With a partner nearby, the
 * move only enters the contest, and must carry more than half of the
 * hunk's removed lines with a word. `extra`: lines carried besides the
 * run's own (a block opener that joined another block with its body).
 * Lines the run carries that have their own edited version at home don't
 * count: they stayed; at least two must have left together.
 */
function carries(
	run: Run | null,
	hunk: MapHunk | null,
	r: TextReaders,
	x: FileIndex,
	whole: boolean,
	extra = 0,
): run is Run {
	if (!block(run) || hunk === null) return false;
	let gone = extra;
	// The line right above the run, removed with it, opening a block the run
	// is the body of (`const (` over its constants): it went with its body.
	const above = run.oldFrom - 1;
	const opener = readOld(r, above);
	if (
		extra === 0 &&
		opener !== null &&
		OPENS_BLOCK.test(opener) &&
		hasWord(opener) &&
		above >= hunk.oldStart &&
		r.bd.hunkRemovingOld(above) === hunk &&
		joinsLike(opener, run.newFrom, r, x)
	) {
		gone++;
	}
	for (let o = run.oldFrom; o <= run.oldTo; o++) {
		const image = run.newFrom + (o - run.oldFrom);
		if (hasWord(readOld(r, o) ?? "") && !(r.stays?.(o, image) ?? false)) {
			gone++;
		}
	}
	// Two lines at least left their place together: one line beside a copy
	// of its neighbour that stayed (edited) at home didn't move.
	if (gone < 2) return false;
	if (!whole) return gone * 2 > wordsOf(hunk, r, x);
	let needed = 0;
	for (let o = hunk.oldStart; o < hunk.oldStart + hunk.oldCount; o++) {
		if (hasWord(readOld(r, o) ?? "") && !(r.stays?.(o, -1) ?? false)) {
			needed++;
		}
	}
	return gone >= needed;
}

/**
 * The best run through old line `o` among the added lines equal to it:
 * one run that carries the line's hunk (`carries`), ahead of every other
 * by TUNING.contextMargin, else "ambiguous" (a near tie, or an equal
 * removed line with a run to the same place as good); "copies": equal
 * lines but no such run (or more than MOVE_MAX_CANDIDATES: too common to
 * say); null: no equal line.
 */
function bestRun(
	o: number,
	r: TextReaders,
	x: FileIndex,
	whole: boolean,
	extra = 0,
): Run | "ambiguous" | "copies" | null {
	const text = readOld(r, o);
	if (text === null || !HAS_WORD.test(text)) return null;
	const key = x.same(text);
	const candidates = x.addedBySame.get(key) ?? [];
	if (candidates.length === 0) return null;
	if (candidates.length > MOVE_MAX_CANDIDATES) return "copies";
	const hunk = r.bd.hunkRemovingOld(o);
	const runs = candidates
		.map((n) => runThrough(o, n, r, x))
		.filter((run): run is Run => carries(run, hunk, r, x, whole, extra))
		.sort((a, b) => b.score - a.score);
	const [best, second] = runs;
	if (!best) return "copies";
	if (second && best.score - second.score < TUNING.contextMargin) {
		return "ambiguous";
	}
	// Another removed line equal to this one, with as good a run to the
	// same place: which of the two moved can't be told.
	const twins = x.removedBySame.get(key) ?? [];
	if (twins.length > MOVE_MAX_CANDIDATES) return "copies";
	const at = best.newFrom + (o - best.oldFrom);
	for (const t of twins) {
		if (t === o) continue;
		const run = runThrough(t, at, r, x);
		if (block(run) && best.score - run.score < TUNING.contextMargin) {
			return "ambiguous";
		}
	}
	return best;
}

/**
 * Where removed old line `o` went with a moved block: its own line in the
 * block's one best run; or, for a line opening a block (`const (`, `func
 * f() {`) that didn't move itself, the first line of its body when the
 * whole body (two lines with a word or more) moved as one run: the opener
 * joined another block. A one-line body (a `case` arm) says nothing of
 * where its opener went.
 */
export function movedTo(o: number, r: TextReaders, whole = true): Moved {
	const x = indexOf(r);
	const own = bestRun(o, r, x, whole);
	if (own === "ambiguous") return own;
	if (own && own !== "copies") return { line: own.newFrom + (o - own.oldFrom) };
	const copies = own === "copies" && telling(o, r, x) ? own : null;
	const text = readOld(r, o);
	if (text === null || !OPENS_BLOCK.test(text)) return copies;
	// The body: the lines after `o` up to the first one indented no deeper
	// (its close, or the next statement outside it).
	const depth = indent(text);
	let last = o;
	let words = 0;
	for (let n = o + 1; n <= o + MOVE_MAX_RUN; n++) {
		const t = readOld(r, n);
		if (t === null) break;
		if (t.trim() === "") continue;
		if (indent(t) <= depth) break;
		last = n;
		if (HAS_WORD.test(t)) words++;
	}
	if (words < 2) return copies;
	// The body's first word line seeds the run; the run must hold it all
	// (its close may stay: the block it joined has its own), and carry
	// most of the opener's hunk with the opener.
	let seed = o + 1;
	while (seed <= last && !HAS_WORD.test(readOld(r, seed) ?? "")) seed++;
	const body = bestRun(seed, r, x, whole);
	if (body === "ambiguous") return body;
	if (!body || body === "copies" || body.oldFrom > o + 1 || body.oldTo < last) {
		return copies;
	}
	return { line: body.newFrom + (o + 1 - body.oldFrom) };
}

/** Each `same` key's count over the whole old file, read once per index. */
function oldCounts(r: TextReaders, x: FileIndex): Map<string, number> {
	if (x.oldCounts) return x.oldCounts;
	const counts = new Map<string, number>();
	for (let n = 1; ; n++) {
		const t = readOld(r, n);
		if (t === null) break;
		if (!hasWord(t)) continue;
		const key = x.same(t);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	x.oldCounts = counts;
	return counts;
}

/** Whether another removed line has old line `o`'s text (`same`). */
export function hasTwin(o: number, r: TextReaders): boolean {
	const x = indexOf(r);
	const t = readOld(r, o);
	if (t === null || !hasWord(t)) return false;
	return (x.removedBySame.get(x.same(t)) ?? []).some((other) => other !== o);
}

/**
 * Whether new line `n` is where another removed line than `o` moved with
 * its block (`movedTo`): then it is that line's, never `o`'s partner. Past
 * MOVE_MAX_CANDIDATES equal removed lines: too common to say (false).
 */
export function claimedByMove(o: number, n: number, r: TextReaders): boolean {
	const x = indexOf(r);
	const t = readNew(r, n);
	if (t === null || !hasWord(t)) return false;
	const twins = x.removedBySame.get(x.same(t)) ?? [];
	if (twins.length > MOVE_MAX_CANDIDATES) return false;
	return twins.some((other) => {
		if (other === o) return false;
		const m = movedTo(other, r);
		return m !== null && typeof m === "object" && m.line === n;
	});
}

/**
 * How much old line `o`'s neighbours (TUNING.contextLines each way, word
 * lines) resemble new line `n`'s, each its best match on the same side of
 * `n` within as many lines: a statement's surroundings follow it. For a
 * line away from home (`away`), a neighbour git kept at home with unique
 * text counts nothing: it stayed, so its look-alike beside `n` is a copy's,
 * not the statement's surroundings (copy a function, then edit the
 * original). A generic kept line (`t.Parallel()`) still counts.
 */
function contextOf(
	o: number,
	n: number,
	r: TextReaders,
	x: FileIndex,
	away = false,
): number {
	const k = TUNING.contextLines;
	let total = 0;
	for (const step of [-1, 1]) {
		for (let i = 1; i <= k; i++) {
			const a = readOld(r, o + step * i);
			if (a === null || !HAS_WORD.test(a)) continue;
			// Kept at home (not beside `n`) with unique text: a copy's.
			const kept = away ? r.bd.oldToNew(o + step * i) : null;
			if (
				kept !== null &&
				(Math.sign(kept - n) !== step || Math.abs(kept - n) > k) &&
				oldCounts(r, x).get(x.same(a)) === 1
			) {
				continue;
			}
			let best = 0;
			for (let j = 1; j <= k; j++) {
				const b = readNew(r, n + step * j);
				if (b === null || !HAS_WORD.test(b)) continue;
				// Whitespace never counts: an equal line scores 1.
				const s = x.sim(a, b);
				if (s > best) best = s;
			}
			total += best;
		}
	}
	return total;
}

/**
 * Whether `found` sits where old line `o` sat: between the images of the
 * nearest lines with a word git kept above and below `o`, both within
 * TUNING.contextLines of it, with a kept line of unique text in the old
 * file among those within reach on either side (generic kept lines alone,
 * `t.Parallel()`, `}`-like boilerplate, could be any function's). Its
 * function is still around it, edited in place, lines inserted or deleted
 * beside it or not: a look-alike elsewhere never takes it (copy it, then
 * edit the original); only a moved block can.
 */
function held(o: number, found: number, r: TextReaders, x: FileIndex): boolean {
	let unique = false;
	const bracket = (step: number) => {
		let nearest: number | null = null;
		for (let i = 1; i <= TUNING.contextLines; i++) {
			const n = o + step * i;
			const t = readOld(r, n);
			if (t === null) break;
			if (!hasWord(t)) continue;
			const image = r.bd.oldToNew(n);
			if (image === null) continue;
			nearest ??= image;
			if (oldCounts(r, x).get(x.same(t)) === 1) unique = true;
		}
		return nearest;
	};
	const above = bracket(-1);
	const below = bracket(1);
	return (
		unique && above !== null && below !== null && above < found && found < below
	);
}

/**
 * Whether new line `n` is new code: inserted by a hunk that removed
 * nothing, or with no line with a word git kept within
 * TUNING.contextLines of it (a kept `}` or blank line between two
 * functions doesn't make the code around it old).
 */
function inNewCode(n: number, r: TextReaders): boolean {
	// Inserted where nothing was removed: new code, whatever kept lines
	// border it.
	if (r.bd.hunkAddingNew(n)?.oldCount === 0) return true;
	const k = TUNING.contextLines;
	for (let i = -k; i <= k; i++) {
		const m = n + i;
		const t = m < 1 ? null : readNew(r, m);
		if (t === null || !hasWord(t)) continue;
		if (r.bd.newToOld(m) !== null) return false;
	}
	return true;
}

/** Old line `o`'s neighbours with a word, within TUNING.contextLines. */
function wordNeighbours(o: number, r: TextReaders): number {
	let count = 0;
	for (let i = -TUNING.contextLines; i <= TUNING.contextLines; i++) {
		if (i === 0) continue;
		const t = readOld(r, o + i);
		if (t !== null && HAS_WORD.test(t)) count++;
	}
	return count;
}

/**
 * The removed line added line `n` is the mutual best of: the one removed
 * line most alike it (alone), whose own most alike added line is `n`
 * alone; memoized per line.
 */
function mutualOf(
	n: number,
	r: TextReaders,
	x: FileIndex,
): { other: number; score: number } | null {
	const known = x.mutual.get(n);
	if (known !== undefined) return known;
	const t = readNew(r, n) ?? "";
	x.alike ??= alikeAtLeast(x.addedText.map((a) => a ?? ""));
	x.alikeRemoved ??= alikeAtLeast(x.removedText.map((a) => a ?? ""));
	let best: { other: number; score: number } | null = null;
	let tie = false;
	const near = x.alikeRemoved(t, PAIR_MIN_SIMILARITY, CONTEST_MAX_RIVALS);
	for (const i of near ?? []) {
		const other = x.removed[i] as number;
		const s = x.sim(readOld(r, other) ?? "", t);
		if (best && Math.abs(s - best.score) < EPS) tie = true;
		else if (!best || s > best.score) {
			best = { other, score: s };
			tie = false;
		}
	}
	let out = tie ? null : best;
	if (out) {
		const theirs = readOld(r, out.other) ?? "";
		const score = out.score;
		const theirsNear = x.alike(theirs, score - EPS, CONTEST_MAX_RIVALS);
		if (!theirsNear?.every((j) => x.added[j] === n)) out = null;
	}
	x.mutual.set(n, out);
	return out;
}

/**
 * Whether added line `n`, more alike old line `o` (`text`) than its partner
 * nearby is (`score`), belongs to another removed line: its mutual best,
 * and more alike it. A line carries one statement; only a rival that beats
 * the partner on likeness alone is checked, so the claim never helps a
 * weaker line win.
 */
function claimed(
	o: number,
	text: string,
	n: number,
	score: number,
	r: TextReaders,
	x: FileIndex,
): boolean {
	const own = x.sim(text, readNew(r, n) ?? "");
	if (own <= score + EPS) return false;
	const m = mutualOf(n, r, x);
	return m !== null && m.other !== o && m.score > own + EPS;
}

/** A contest's answer: the line, `moved` when not the partner nearby. */
export type Contest = { line: number; moved?: true } | "unknown";

/**
 * Old line `o`'s partner nearby, `found` (at `score`), against `move` (its
 * line in a moved block, when the move search found one) and the file's
 * other added lines at least `score - TUNING.contestMargin` alike (and
 * PAIR_MIN_SIMILARITY), unless `claimed`: the one whose likeness plus
 * context (contextOf) is ahead of every other by TUNING.contextMargin
 * carries it (`moved` when that isn't `found`), a line elsewhere only
 * when its context alone also leads the partner's, by half as much; none
 * ahead: "unknown". A partner `held` by kept lines of its function faces
 * the move only; past CONTEST_MAX_RIVALS look-alikes (too many to weigh)
 * too. When no rival could catch up with the partner even with every
 * neighbour alike, they aren't weighed one by one. Uncontested: `found`.
 */
export function contested(
	o: number,
	found: number,
	score: number,
	r: TextReaders,
	move: number | null = null,
): Contest {
	const x = indexOf(r);
	const text = readOld(r, o);
	if (text === null) return { line: found };
	x.alike ??= alikeAtLeast(x.addedText.map((t) => t ?? ""));
	const min = Math.max(score - TUNING.contestMargin, PAIR_MIN_SIMILARITY);
	// Held by its own function: only a moved block contests it.
	const near = held(o, found, r, x)
		? []
		: x.alike(text, min - EPS, CONTEST_MAX_RIVALS);
	// Look-alikes past the cap (a generated table, say): too many to weigh;
	// the partner nearby keeps it against them, as before this search
	// existed (a moved block still contests it).
	const rivals = (near ?? [])
		.map((i) => x.added[i] as number)
		.filter((n) => n !== found && n !== move);
	if (move !== null) rivals.unshift(move);
	if (rivals.length === 0) return { line: found };
	const likeness = (n: number) =>
		n === found ? score : x.sim(text, readNew(r, n) ?? "");
	const home = contextOf(o, found, r, x);
	const ours = score + home;
	// Every rival's best: its likeness and every neighbour at its most.
	const reach = wordNeighbours(o, r);
	const best = Math.max(...rivals.map(likeness));
	if (ours - (best + reach) >= TUNING.contextMargin) return { line: found };
	const weighed = rivals.filter(
		(n) => n === move || !claimed(o, text, n, score, r, x),
	);
	if (weighed.length === 0) return { line: found };
	if (weighed.length > CONTEST_MAX_RIVALS) return { line: found };
	const totals = [
		{ n: found, total: ours, context: home },
		...weighed.map((n) => {
			const context = contextOf(o, n, r, x, true);
			return { n, total: likeness(n) + context, context };
		}),
	].sort((a, b) => b.total - a.total);
	const [first, second] = totals as [
		{ n: number; total: number; context: number },
		{ n: number; total: number; context: number },
	];
	if (first.total - second.total < TUNING.contextMargin) return "unknown";
	// A line elsewhere takes it from its partner nearby only when its
	// surroundings, not its likeness alone, say it went there.
	if (first.n !== found && first.context - home < TUNING.contextMargin / 2) {
		return "unknown";
	}
	// A partner nearby against a line in new code (nothing with a word kept
	// around it): a copy of the old code, or the statement rewritten into
	// new code; which, text can't tell. Never a pick.
	if (first.n !== found && inNewCode(first.n, r)) return "unknown";
	return first.n === found ? { line: found } : { line: first.n, moved: true };
}
