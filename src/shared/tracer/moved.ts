/**
 * A replaced line that went elsewhere in its file: the tracer's move search
 * (CAR-95 step 3), and the contest that keeps a partner nearby from winning
 * when a line elsewhere resembles the old one as much.
 *
 * A moved block is a run of the old file's removed lines found again, line
 * for line, as a run of the new file's added lines: equal (as `same`
 * compares them), or alike (PAIR_MIN_SIMILARITY) beside an equal one. A
 * run counts only with two lines with a word or more (one line alone says
 * nothing about where it went: a copied line, a shared boilerplate line)
 * and TUNING.minAlnum letters and digits on its equal lines (git's
 * `--color-moved` minimum). An alike line that opens a block (`func a() {`
 * against `func b() {`) never extends a run: a block's header names it. A
 * line follows its run only when that run leads every other by
 * TUNING.contextMargin: an identical block that appears twice (two added,
 * or two removed) is ambiguous, never a pick.
 *
 * A line edited in place keeps its partner nearby: when every line with a
 * word around it stayed (kept by git) or was paired in place beside it
 * (`anchored`, trace.ts), neither a move nor a look-alike contests it.
 * Otherwise the partner, a move, and the file's look-alikes compete on
 * likeness plus context (`contested`).
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
import type { LineMapper } from "./lineMapper.js";
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

/** Where old line `o` went with its moved run: its new line, ambiguous, or none. */
export type Moved = { line: number } | "ambiguous" | null;

/** Whether a run is enough to move a thread: see the file's doc. */
const enough = (run: Run | null): run is Run =>
	run !== null && run.words >= 2 && run.equalAlnum >= TUNING.minAlnum;

/**
 * The best run through old line `o` among the added lines equal to it:
 * one run enough to move, ahead of every other by TUNING.contextMargin,
 * else ambiguous (a near tie, or an equal removed line with a run to the
 * same place as good); null: none (or more equal lines than
 * MOVE_MAX_CANDIDATES, either side: too common to say).
 */
function bestRun(
	o: number,
	r: TextReaders,
	x: FileIndex,
): Run | "ambiguous" | null {
	const text = readOld(r, o);
	if (text === null || !HAS_WORD.test(text)) return null;
	const key = x.same(text);
	const candidates = x.addedBySame.get(key) ?? [];
	if (candidates.length === 0 || candidates.length > MOVE_MAX_CANDIDATES) {
		return null;
	}
	const runs = candidates
		.map((n) => runThrough(o, n, r, x))
		.filter(enough)
		.sort((a, b) => b.score - a.score);
	const [best, second] = runs;
	if (!best) return null;
	if (second && best.score - second.score < TUNING.contextMargin) {
		return "ambiguous";
	}
	// Another removed line equal to this one, with as good a run to the
	// same place: which of the two moved can't be told.
	const twins = x.removedBySame.get(key) ?? [];
	if (twins.length > MOVE_MAX_CANDIDATES) return null;
	const at = best.newFrom + (o - best.oldFrom);
	for (const t of twins) {
		if (t === o) continue;
		const run = runThrough(t, at, r, x);
		if (enough(run) && best.score - run.score < TUNING.contextMargin) {
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
export function movedTo(o: number, r: TextReaders): Moved {
	const x = indexOf(r);
	const own = bestRun(o, r, x);
	if (own === "ambiguous") return own;
	if (own) return { line: own.newFrom + (o - own.oldFrom) };
	const text = readOld(r, o);
	if (text === null || !OPENS_BLOCK.test(text)) return null;
	// The body: the lines after `o` up to the first one indented no deeper
	// (its close, or the next statement outside it).
	const depth = indent(text);
	let last = o;
	let words = 0;
	for (let n = o + 1; n <= o + MOVE_MAX_RUN; n++) {
		const t = readOld(r, n);
		if (t === null) return null;
		if (t.trim() === "") continue;
		if (indent(t) <= depth) break;
		last = n;
		if (HAS_WORD.test(t)) words++;
	}
	if (words < 2) return null;
	// The body's first word line seeds the run; the run must hold it all
	// (its close may stay: the block it joined has its own).
	let seed = o + 1;
	while (seed <= last && !HAS_WORD.test(readOld(r, seed) ?? "")) seed++;
	const body = bestRun(seed, r, x);
	if (body === "ambiguous") return body;
	if (!body || body.oldFrom > o + 1 || body.oldTo < last) return null;
	return { line: body.newFrom + (o + 1 - body.oldFrom) };
}

/**
 * How much old line `o`'s neighbours (TUNING.contextLines each way, word
 * lines) resemble new line `n`'s, each its best match on the same side of
 * `n` within as many lines: a statement's surroundings follow it.
 */
function contextOf(o: number, n: number, r: TextReaders, x: FileIndex): number {
	const k = TUNING.contextLines;
	let total = 0;
	for (const step of [-1, 1]) {
		for (let i = 1; i <= k; i++) {
			const a = readOld(r, o + step * i);
			if (a === null || !HAS_WORD.test(a)) continue;
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
 * ahead: "unknown".
 * When no rival could catch up with the partner even with every neighbour
 * alike, they aren't weighed one by one; past CONTEST_MAX_RIVALS otherwise,
 * "unknown". Uncontested: `found`.
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
	// Look-alikes sharing only common words with it past the cap: too
	// common to tell (a generated table, say).
	const near = x.alike(text, min - EPS, CONTEST_MAX_RIVALS);
	if (near === null) return "unknown";
	const rivals = near
		.map((i) => x.added[i] as number)
		.filter((n) => n !== found && n !== move);
	if (move !== null) rivals.unshift(move);
	if (rivals.length === 0) return { line: found };
	const likeness = (n: number) =>
		n === found ? score : x.sim(text, readNew(r, n) ?? "");
	const home = contextOf(o, found, r, x);
	const ours = score + home;
	// Every rival's best: its likeness and a fully alike neighbourhood.
	const reach = wordNeighbours(o, r);
	const best = Math.max(...rivals.map(likeness));
	if (ours - (best + reach) >= TUNING.contextMargin) return { line: found };
	const weighed = rivals.filter(
		(n) => n === move || !claimed(o, text, n, score, r, x),
	);
	if (weighed.length === 0) return { line: found };
	if (weighed.length > CONTEST_MAX_RIVALS) return "unknown";
	const totals = [
		{ n: found, total: ours, context: home },
		...weighed.map((n) => {
			const context = contextOf(o, n, r, x);
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
	return first.n === found ? { line: found } : { line: first.n, moved: true };
}
