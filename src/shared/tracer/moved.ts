/**
 * A replaced line that went elsewhere in its file: the tracer's move search
 * (CAR-95 step 3), and the look-alike check that keeps a hunk's own
 * partner from winning when a line elsewhere resembles the old one as much.
 *
 * A moved block is a run of the old file's removed lines found again, line
 * for line, as a run of the new file's added lines: equal ignoring
 * whitespace, or alike (PAIR_MIN_SIMILARITY) when the run holds an equal
 * line too, and at least MOVE_MIN_ALNUM letters and digits on its equal
 * lines (git's `--color-moved` minimum), so a generic line (`return nil`)
 * never moves on its own. A line follows its run only when that run is the
 * one best place: an identical block that appears twice (two added, or
 * two removed) is ambiguous, never a pick.
 *
 * Every lookup works from an index of the file's added and removed lines
 * built once per `bd` mapper (shared by every thread traced through it, as
 * trace.ts's pairings are), checked against the caller's texts on every
 * lookup and rebuilt on a mismatch, never answered from.
 *
 * Pure: no git, no I/O, nothing from `src/server/`.
 */

import {
	alikeAtLeast,
	lineSimilarity,
	PAIR_MIN_SIMILARITY,
} from "../linePairing.js";
import { HAS_WORD } from "../tokenize.js";
import type { LineMapper } from "./lineMapper.js";
import type { Position } from "./trace.js";

/** Letters and digits a moved run's equal lines need between them (git's). */
export const MOVE_MIN_ALNUM = 20;

/**
 * Added lines equal to the one looked up past this: too common to tell
 * which one carries it (ambiguous), and never a scan of every one.
 */
export const MOVE_MAX_CANDIDATES = 32;

/** How far a run extends from its seed, each way. */
const MOVE_MAX_RUN = 200;

/** Two scores this close are a tie. */
const EPS = 1e-9;

/** A line that opens a block, as trace.ts's OPENS_BLOCK. */
const OPENS_BLOCK = /[{([:]\s*$/u;

const ALNUM = /[\p{L}\p{N}_]/gu;

/** A line's text with no whitespace: equal ignoring whitespace. */
const bare = (t: string) => t.replace(/\s+/gu, "");

const alnum = (t: string) => t.match(ALNUM)?.length ?? 0;

const indent = (t: string) => t.length - t.trimStart().length;

export interface TextReaders {
	bd: LineMapper;
	oldLineText?: (pos: Position) => string | null;
	newLineText?: (pos: Position) => string | null;
}

/** The file's changed lines, as one `bd` diff and its two texts give them. */
interface FileIndex {
	/** New lines the diff added, ascending, and their text. */
	added: number[];
	addedText: (string | null)[];
	/** Old lines the diff removed, ascending, and their text. */
	removed: number[];
	removedText: (string | null)[];
	/** Equal-ignoring-whitespace text (with a word) to its added lines. */
	addedByBare: Map<string, number[]>;
	/** The same for removed lines. */
	removedByBare: Map<string, number[]>;
	/** Indices into `added` of lines at least `min` alike `oldText`. */
	alike?: (oldText: string, min: number) => number[];
	/** Indices into `removed` of lines at least `min` alike a new text. */
	alikeRemoved?: (newText: string, min: number) => number[];
}

const indexes = new WeakMap<LineMapper, FileIndex>();

const readOld = (r: TextReaders, n: number) =>
	r.oldLineText?.({ side: "RIGHT", line: n }) ?? null;
const readNew = (r: TextReaders, n: number) =>
	r.newLineText?.({ side: "RIGHT", line: n }) ?? null;

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
	const byBare = (lines: number[], texts: (string | null)[]) => {
		const out = new Map<string, number[]>();
		lines.forEach((n, i) => {
			const t = texts[i];
			if (t == null || !HAS_WORD.test(t)) return;
			const key = bare(t);
			const list = out.get(key);
			if (list) list.push(n);
			else out.set(key, [n]);
		});
		return out;
	};
	return {
		added,
		addedText,
		removed,
		removedText,
		addedByBare: byBare(added, addedText),
		removedByBare: byBare(removed, removedText),
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

function sameTexts(x: FileIndex, r: TextReaders): boolean {
	for (let i = 0; i < x.added.length; i++) {
		if (readNew(r, x.added[i] as number) !== x.addedText[i]) return false;
	}
	for (let i = 0; i < x.removed.length; i++) {
		if (readOld(r, x.removed[i] as number) !== x.removedText[i]) return false;
	}
	return true;
}

/** A run of old lines found again as new lines, `old` to `fresh` line for line. */
interface Run {
	/** First and last old line, and the new line of the first. */
	oldFrom: number;
	oldTo: number;
	newFrom: number;
	/** Sum of its word lines' similarity (an equal line: 1). */
	score: number;
	/** Letters and digits on its equal word lines. */
	equalAlnum: number;
}

/**
 * The run through old line `o` and new line `n` (taken as a pair): both
 * ways, while the old line is removed, the new one added, and the two are
 * equal ignoring whitespace (a wordless line too: a `}`, a blank) or both
 * have a word and are alike.
 */
function runThrough(o: number, n: number, r: TextReaders): Run | null {
	const first = pairScore(o, n, r);
	if (first === null) return null;
	const run: Run = {
		oldFrom: o,
		oldTo: o,
		newFrom: n,
		score: first.score,
		equalAlnum: first.equalAlnum,
	};
	for (const step of [-1, 1]) {
		for (let i = 1; i <= MOVE_MAX_RUN; i++) {
			const p = pairScore(o + step * i, n + step * i, r);
			if (p === null) break;
			run.score += p.score;
			run.equalAlnum += p.equalAlnum;
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
): { score: number; equalAlnum: number } | null {
	if (o < 1 || n < 1) return null;
	if (r.bd.hunkRemovingOld(o) === null || r.bd.hunkAddingNew(n) === null) {
		return null;
	}
	const a = readOld(r, o);
	const b = readNew(r, n);
	if (a === null || b === null) return null;
	const word = HAS_WORD.test(a);
	if (bare(a) === bare(b)) {
		return word
			? { score: 1, equalAlnum: alnum(a) }
			: { score: 0, equalAlnum: 0 };
	}
	if (!word || !HAS_WORD.test(b)) return null;
	const s = lineSimilarity(a, b);
	return s >= PAIR_MIN_SIMILARITY ? { score: s, equalAlnum: 0 } : null;
}

/** Where old line `o` went with its moved run: its new line, ambiguous, or none. */
export type Moved = { line: number } | "ambiguous" | null;

/**
 * The best run through old line `o` among the added lines equal to it:
 * one run that moved enough letters and scores above every other, else
 * ambiguous (a tie, an equal removed line with as good a run, or more
 * equal lines than MOVE_MAX_CANDIDATES); null: no such run.
 */
function bestRun(
	o: number,
	r: TextReaders,
	x: FileIndex,
): Run | "ambiguous" | null {
	const text = readOld(r, o);
	if (text === null || !HAS_WORD.test(text)) return null;
	const key = bare(text);
	const candidates = x.addedByBare.get(key) ?? [];
	if (candidates.length === 0) return null;
	if (candidates.length > MOVE_MAX_CANDIDATES) return "ambiguous";
	let best: Run | null = null;
	let tie = false;
	for (const n of candidates) {
		const run = runThrough(o, n, r);
		if (!run || run.equalAlnum < MOVE_MIN_ALNUM) continue;
		if (best && run.score <= best.score + EPS) {
			if (run.score >= best.score - EPS) tie = true;
			continue;
		}
		tie = best !== null && best.score >= run.score - EPS;
		best = run;
	}
	if (!best) return null;
	if (tie) return "ambiguous";
	// Another removed line equal to this one, with as good a run to the
	// same place: which of the two moved can't be told.
	const twins = x.removedByBare.get(key) ?? [];
	if (twins.length > MOVE_MAX_CANDIDATES) return "ambiguous";
	const at = best.newFrom + (o - best.oldFrom);
	for (const t of twins) {
		if (t === o) continue;
		const run = runThrough(t, at, r);
		if (run && run.score >= best.score - EPS) return "ambiguous";
	}
	return best;
}

/**
 * Where removed old line `o` went with a moved block: its own line in the
 * block's one best run; or, for a line opening a block (`const (`, `func
 * f() {`) that didn't move itself, the first line of its body when the
 * whole body, up to its close, moved as one run (the opener joined
 * another block).
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
	let close = o + 1;
	let last = o;
	for (; close <= o + MOVE_MAX_RUN; close++) {
		const t = readOld(r, close);
		if (t === null) return null;
		if (t.trim() === "") continue;
		if (indent(t) <= depth) break;
		last = close;
	}
	if (last === o) return null;
	// The body's first word line seeds the run; the run must hold it all
	// (its close may stay: the block it joined has its own).
	let seed = o + 1;
	while (seed <= last && !HAS_WORD.test(readOld(r, seed) ?? "")) seed++;
	if (seed > last) return null;
	const body = bestRun(seed, r, x);
	if (body === "ambiguous") return body;
	if (!body || body.oldFrom > o + 1 || body.oldTo < last) return null;
	return { line: body.newFrom + (o + 1 - body.oldFrom) };
}

/**
 * A look-alike elsewhere contests a partner when it comes this close to
 * the partner's likeness (or beats it). The winner of a contest must be
 * ahead of every other by CONTEXT_MARGIN in likeness plus context. Measured
 * on a real review's threads (CAR-95): a contest's right line led by 0.27
 * to 0.48, a wrong one never by more than 0.11; no line went wrong for any
 * margin from 0.2 to 0.5.
 */
export const CONTEST_MARGIN = 0.15;
export const CONTEXT_MARGIN = 0.25;

/** Neighbours each way whose likeness counts as a candidate's context. */
const CONTEXT_LINES = 3;

/**
 * How much old line `o`'s neighbours (CONTEXT_LINES each way, word lines)
 * resemble new line `n`'s, each its best match on the same side of `n`
 * within CONTEXT_LINES: a statement's surroundings follow it.
 */
function contextOf(o: number, n: number, r: TextReaders): number {
	let total = 0;
	for (const step of [-1, 1]) {
		for (let i = 1; i <= CONTEXT_LINES; i++) {
			const a = readOld(r, o + step * i);
			if (a === null || !HAS_WORD.test(a)) continue;
			let best = 0;
			for (let j = 1; j <= CONTEXT_LINES; j++) {
				const b = readNew(r, n + step * j);
				if (b === null || !HAS_WORD.test(b)) continue;
				const s = bare(a) === bare(b) ? 1 : lineSimilarity(a, b);
				if (s > best) best = s;
			}
			total += best;
		}
	}
	return total;
}

/**
 * Whether added line `n`, more alike old line `o` (`text`) than its partner
 * nearby is (`score`), belongs to another removed line: one more alike it,
 * whose own most alike added line is `n` alone (mutual best). A line
 * carries one statement; only a rival that beats the partner on likeness
 * alone is checked, so the claim never helps a weaker line win.
 */
function claimed(
	o: number,
	text: string,
	n: number,
	score: number,
	r: TextReaders,
	x: FileIndex,
): boolean {
	const t = readNew(r, n) ?? "";
	const own = lineSimilarity(text, t);
	if (own <= score + EPS) return false;
	x.alike ??= alikeAtLeast(x.addedText.map((a) => a ?? ""));
	x.alikeRemoved ??= alikeAtLeast(x.removedText.map((a) => a ?? ""));
	const alike = x.alike;
	return x.alikeRemoved(t, own + EPS).some((i) => {
		const other = x.removed[i] as number;
		if (other === o) return false;
		const theirs = readOld(r, other) ?? "";
		const s = lineSimilarity(theirs, t);
		if (s <= own + EPS) return false;
		return alike(theirs, s - EPS).every((j) => x.added[j] === n);
	});
}

/**
 * Old line `o`'s partner nearby, `found` (at `score`), contested by the
 * file's other added lines at least `score - CONTEST_MARGIN` alike (and
 * PAIR_MIN_SIMILARITY), unless `claimed`: the one whose likeness plus
 * context (contextOf) is ahead of every other by CONTEXT_MARGIN carries it
 * (`moved` when that isn't `found`); none ahead, or more rivals than
 * MOVE_MAX_CANDIDATES: "unknown". Uncontested: `found`.
 */
export function contested(
	o: number,
	found: number,
	score: number,
	r: TextReaders,
): { line: number; moved?: true } | "unknown" {
	const x = indexOf(r);
	const text = readOld(r, o);
	if (text === null) return { line: found };
	x.alike ??= alikeAtLeast(x.addedText.map((t) => t ?? ""));
	const min = Math.max(score - CONTEST_MARGIN, PAIR_MIN_SIMILARITY);
	const near = x.alike(text, min - EPS).map((i) => x.added[i] as number);
	if (near.length > MOVE_MAX_CANDIDATES + 1) return "unknown";
	const rivals = near.filter(
		(n) => n !== found && !claimed(o, text, n, score, r, x),
	);
	if (rivals.length === 0) return { line: found };
	const totals = [found, ...rivals].map((n) => ({
		n,
		total:
			(n === found ? score : lineSimilarity(text, readNew(r, n) ?? "")) +
			contextOf(o, n, r),
	}));
	totals.sort((a, b) => b.total - a.total);
	const [first, second] = totals as [
		{ n: number; total: number },
		{ n: number; total: number },
	];
	if (first.total - second.total < CONTEXT_MARGIN) return "unknown";
	return first.n === found ? { line: found } : { line: first.n, moved: true };
}
