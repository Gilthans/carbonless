/**
 * Where a position of an old snapshot sits in a new one: GitLab's
 * three-diff trace over `LineMapper`s.
 *
 * The old snapshot is `(B1, H1)`, the new one `(B2, H2)`; a RIGHT line
 * lives in `H1`, a LEFT one in `B1`. Three diffs of one file carry a line
 * across: `ac` (B1 to B2), `bd` (H1 to H2) and `cd` (the new snapshot's
 * own diff, B2 to H2). Nothing here assumes H2 descends from H1 or B2 from
 * B1: the diffs are all that is used. Lines pair by position in those
 * diffs; inside a hunk that replaced the line, by similarity alone (the
 * side-by-side view's pairing, src/shared/linePairing.ts: whitespace
 * doesn't count), never by searching text across hunks. So a position is
 * never placed on a line whose text differs without saying so
 * (`changed`), never on a replacing line that doesn't resemble it, and
 * never dropped: every input yields a placement, unplaced ones with a
 * reason.
 *
 * Pure: no git, no I/O, nothing from `src/server/`.
 */

import { alignOrOver, similarityTo } from "../linePairing.js";
import { HAS_WORD, WORD_DIFF_MAX } from "../tokenize.js";
import type { DiffSide } from "../types.js";
import type { LineMapper, MapHunk } from "./lineMapper.js";

/**
 * Bumped when a placement for the same inputs could change. 2: a line in a
 * replaced hunk goes to its similar partner, else unplaced (was: the same
 * offset in the replacement).
 */
export const TRACER_VERSION = 2;

export interface Position {
	side: DiffSide;
	line: number;
}

export interface TraceDiffs {
	/** Old base to new base, this file. */
	ac: LineMapper;
	/**
	 * Old head to new head, this file (through its rename pair). The
	 * pairings of its replaced hunks are memoized on this object, shared by
	 * every thread traced through it: one mapper, one pair of texts.
	 */
	bd: LineMapper;
	/** The new snapshot's own diff, this file. */
	cd: LineMapper;
	/** Text in the old snapshot, for `changed` and for pairing a replaced hunk. */
	oldLineText?: (pos: Position) => string | null;
	/**
	 * Text in the new snapshot (`bd`'s new side on RIGHT), for pairing a
	 * replaced hunk's lines. Without both texts a replaced line is
	 * `rewritten`: nothing tells which replacing line carries it.
	 */
	newLineText?: (pos: Position) => string | null;
	/** File lengths in the new snapshot, for "outside". */
	newLineCount?: { LEFT: number; RIGHT: number };
}

export type Placement =
	/** Same text, at this line; `became: "context"`: the new snapshot no longer changes it. */
	| { kind: "placed"; side: DiffSide; line: number; became?: "context" }
	/** The line was edited in place: its replacement, with the text as it was. */
	| { kind: "changed"; side: DiffSide; line: number; oldText: string | null }
	/**
	 * Gone; `nearest`: the closest surviving line above, in the new
	 * snapshot. `rewritten`: replaced, but which replacing line carries it
	 * can't be told (too large to pair, or the text unknown).
	 */
	| {
			kind: "unplaced";
			reason: "deleted" | "rewritten" | "base-changed" | "outside";
			nearest: Position | null;
	  };

const OUTSIDE: Placement = {
	kind: "unplaced",
	reason: "outside",
	nearest: null,
};

/** The image of the last line above `line` that the mapper keeps, or null. */
function nearestAbove(
	mapper: LineMapper,
	line: number,
	side: DiffSide,
): Position | null {
	let n = line - 1;
	while (n >= 1) {
		const mapped = mapper.oldToNew(n);
		if (mapped !== null) return { side, line: mapped };
		// Skip the whole removed range this line is in.
		const hunk = mapper.hunkRemovingOld(n);
		n = hunk ? hunk.oldStart - 1 : n - 1;
	}
	return null;
}

function traceRight(pos: Position, diffs: TraceDiffs): Placement {
	const { bd, cd } = diffs;
	const mapped = bd.oldToNew(pos.line);
	if (mapped !== null) {
		return cd.newToOld(mapped) === null
			? { kind: "placed", side: "RIGHT", line: mapped }
			: { kind: "placed", side: "RIGHT", line: mapped, became: "context" };
	}
	const hunk = bd.hunkRemovingOld(pos.line);
	const partner = hunk ? partnerIn(hunk, pos.line, diffs) : null;
	if (typeof partner === "number") {
		return {
			kind: "changed",
			side: "RIGHT",
			line: partner,
			oldText: diffs.oldLineText?.(pos) ?? null,
		};
	}
	return {
		kind: "unplaced",
		reason: partner === "unknown" ? "rewritten" : "deleted",
		nearest: nearestAbove(bd, pos.line, "RIGHT"),
	};
}

/**
 * A run of hunks the tracer pairs as one replacement: neighbours with at
 * most `REGION_GAP` old lines between them, at most `REGION_GAP_WORDS` of
 * those with a word and none of those opening a block (the rest a `}`, a
 * blank line). git's diff often splits one rewritten block at such a line,
 * leaving a statement's new place in the hunk next door. One word line lets
 * a run join across a kept statement inside the block (the corpus's
 * rewrites split around one kept call or log line); a line opening a block
 * (`func b() {`, `def b():`) is a boundary between two pieces of code, so
 * it never joins: a generic line (`return nil`) would find its twin in the
 * next function. Wider runs, or more word lines, measured no better on a
 * real review's threads: they hit the pairing's caps (CAR-95).
 */
export const REGION_GAP = 5;
export const REGION_GAP_WORDS = 1;

/**
 * A line the pairing left without a partner still goes to the replacing
 * line it most resembles, between its neighbours' partners (shared with
 * them: two lines merged into one), when they are this alike. Below the
 * pairing's own PAIR_MIN_SIMILARITY: a line merged into another keeps only
 * part of its tokens, and the window between the neighbours' partners is
 * narrow. Above every unrelated replacing line measured on a real review's
 * threads (CAR-95), with a margin.
 */
export const SHARE_MIN_SIMILARITY = 0.45;

/** Two scores this close are a tie (a wider region's partner isn't unique). */
const EPS = 1e-9;

/** A line that opens a block: never a line two hunks join across. */
const OPENS_BLOCK = /[{([:]\s*$/u;

/** One region's lines and their pairing; "unknown": it can't be paired. */
type Region =
	| {
			oldLines: number[];
			newLines: number[];
			dels: string[];
			adds: string[];
			/** Index in `dels` to index in `adds`. */
			partner: Map<number, number>;
			/** lineSimilarity of an old text to `adds[j]` (made when first needed). */
			scorer?: (oldText: string, j: number) => number;
	  }
	| "unknown";

type Partner = number | null | "unknown";

/**
 * Per `bd` mapper (TraceDiffs.bd: one mapper, one pair of texts), shared
 * by every thread traced through it: each hunk's pairings, and each old
 * line's partner.
 */
interface Memo {
	regions: Map<MapHunk, Region[]>;
	partners: Map<number, Partner>;
}
const memos = new WeakMap<LineMapper, Memo>();

function memoOf(diffs: TraceDiffs): Memo {
	let memo = memos.get(diffs.bd);
	if (!memo) {
		memo = { regions: new Map(), partners: new Map() };
		memos.set(diffs.bd, memo);
	}
	return memo;
}

const read = (
	reader: ((pos: Position) => string | null) | undefined,
	line: number,
) => reader?.({ side: "RIGHT", line }) ?? null;

/** The old lines between two neighbouring hunks (first, last inclusive). */
function between(a: MapHunk, b: MapHunk): [number, number] {
	const from = a.oldCount > 0 ? a.oldStart + a.oldCount : a.oldStart + 1;
	const to = b.oldCount > 0 ? b.oldStart - 1 : b.oldStart;
	return [from, to];
}

/** Whether `a` and `b` join one region (old text read through `diffs`). */
function joins(a: MapHunk, b: MapHunk, diffs: TraceDiffs): boolean {
	const [from, to] = between(a, b);
	if (to - from + 1 > REGION_GAP) return false;
	let words = 0;
	for (let n = from; n <= to; n++) {
		const t = read(diffs.oldLineText, n);
		if (t === null) return false;
		if (!HAS_WORD.test(t)) continue;
		if (OPENS_BLOCK.test(t)) return false;
		words++;
	}
	return words <= REGION_GAP_WORDS;
}

function linesOf(hunks: readonly MapHunk[], diffs: TraceDiffs): Region {
	const oldLines: number[] = [];
	const newLines: number[] = [];
	for (const h of hunks) {
		for (let n = h.oldStart; n < h.oldStart + h.oldCount; n++) oldLines.push(n);
		for (let n = h.newStart; n < h.newStart + h.newCount; n++) newLines.push(n);
	}
	const dels: string[] = [];
	const adds: string[] = [];
	// Nothing replaced them: deleted, whatever their text.
	if (newLines.length === 0) {
		return { oldLines, newLines, dels, adds, partner: new Map() };
	}
	for (const n of oldLines) {
		const t = read(diffs.oldLineText, n);
		if (t === null) return "unknown";
		dels.push(t);
	}
	for (const n of newLines) {
		const t = read(diffs.newLineText, n);
		if (t === null) return "unknown";
		adds.push(t);
	}
	const pairs = alignOrOver(dels, adds);
	if (!pairs) return "unknown";
	return {
		oldLines,
		newLines,
		dels,
		adds,
		partner: new Map(pairs),
	};
}

/**
 * The pairings `hunk` is looked up in, nearest first: the hunk alone (git's
 * own alignment wins a tie: a twin elsewhere in the region never takes
 * the line from its own hunk), then with its joined neighbours.
 */
function regionsOf(hunk: MapHunk, diffs: TraceDiffs): Region[] {
	const memo = memoOf(diffs).regions;
	const known = memo.get(hunk);
	if (known) return known;
	const all = diffs.bd.hunks;
	const i = all.indexOf(hunk);
	let first = i;
	let last = i;
	while (
		first > 0 &&
		joins(all[first - 1] as MapHunk, all[first] as MapHunk, diffs)
	)
		first--;
	while (
		last < all.length - 1 &&
		joins(all[last] as MapHunk, all[last + 1] as MapHunk, diffs)
	)
		last++;
	const out = [linesOf([hunk], diffs)];
	if (first !== last) out.push(linesOf(all.slice(first, last + 1), diffs));
	memo.set(hunk, out);
	return out;
}

/** lineSimilarity of the region's old line `k` to its added line `j`. */
function scoreIn(
	region: Exclude<Region, "unknown">,
	k: number,
	j: number,
): number {
	region.scorer ??= similarityTo(region.adds);
	return region.scorer(region.dels[k] as string, j);
}

/**
 * The replacing line that carries old line `line` (removed by `hunk`),
 * memoized per line for every thread on the same diff.
 */
function partnerIn(hunk: MapHunk, line: number, diffs: TraceDiffs): Partner {
	const memo = memoOf(diffs).partners;
	let partner = memo.get(line);
	if (partner === undefined) {
		partner = findPartner(hunk, line, diffs);
		memo.set(line, partner);
	}
	return partner;
}

/**
 * The replacing line that carries old line `line`: its partner in the
 * similarity pairing of the hunk's old and new lines (whitespace doesn't
 * count, so a re-indented line is its own partner), or of the hunk with its
 * joined neighbours when that partner is closer ("unknown" when another
 * line there is as close); else the line it most resembles between its neighbours'
 * partners at SHARE_MIN_SIMILARITY or more. null: nothing replacing it
 * resembles it; "unknown": it can't be told (a pairing too large, a text
 * missing, a line past the pairing's length cut, a line without a word).
 */
function findPartner(hunk: MapHunk, line: number, diffs: TraceDiffs): Partner {
	const regions = regionsOf(hunk, diffs);
	// Nothing at all replaced it: deleted, whatever its text.
	if (regions.every((r) => r !== "unknown" && r.newLines.length === 0)) {
		return null;
	}
	// A line without a word (a `}`, a blank line) is like every other one:
	// its likeness says nothing about where it went, nor whether it did.
	const own = read(diffs.oldLineText, line);
	if (own === null || !HAS_WORD.test(own)) return "unknown";
	let widest: Exclude<Region, "unknown"> | null = null;
	let best: { line: number; score: number } | null = null;
	let twins = false;
	regions.forEach((region, i) => {
		if (region === "unknown") return;
		widest = region;
		const k = region.oldLines.indexOf(line);
		const partner = region.partner.get(k);
		if (partner === undefined) return;
		const score = scoreIn(region, k, partner);
		// Nearest first: a wider region wins only with a closer likeness,
		// and only when its partner is the one line there that close.
		if (best && score <= best.score) return;
		if (i > 0) {
			for (let j = 0; j < region.adds.length; j++) {
				if (j !== partner && scoreIn(region, k, j) >= score - EPS) {
					twins = true;
					return;
				}
			}
		}
		best = { line: region.newLines[partner] as number, score };
	});
	const found = best as { line: number } | null;
	if (found) return found.line;
	// Two lines as like it, past its own hunk: which one carries it can't
	// be told.
	if (twins) return "unknown";
	const shared = widest ? sharedIn(widest, line) : null;
	if (shared !== null) return shared;
	// No likeness here, but a pairing that couldn't be made might have one.
	return regions.includes("unknown") ? "unknown" : null;
}

/** SHARE_MIN_SIMILARITY's step: the unpaired line's likeliest replacement. */
function sharedIn(
	region: Exclude<Region, "unknown">,
	line: number,
): number | "unknown" | null {
	if (region.newLines.length === 0) return null;
	const k = region.oldLines.indexOf(line);
	// A line the pairing can't score never pairs: that says nothing about
	// whether it survived.
	if ((region.dels[k] ?? "").length >= WORD_DIFF_MAX) return "unknown";
	let lo = 0;
	let hi = region.adds.length - 1;
	for (const [d, a] of region.partner) {
		if (d < k && a > lo) lo = a;
		if (d > k && a < hi) hi = a;
	}
	let best = -1;
	let score = SHARE_MIN_SIMILARITY;
	for (let j = lo; j <= hi; j++) {
		const s = scoreIn(region, k, j);
		if (s > score || (s === score && best === -1)) {
			best = j;
			score = s;
		}
	}
	return best === -1 ? null : (region.newLines[best] ?? null);
}

function traceLeft(pos: Position, diffs: TraceDiffs): Placement {
	const { ac, cd } = diffs;
	const mapped = ac.oldToNew(pos.line);
	if (mapped === null) {
		return {
			kind: "unplaced",
			reason: "base-changed",
			nearest: nearestAbove(ac, pos.line, "LEFT"),
		};
	}
	const kept = cd.oldToNew(mapped);
	return kept === null
		? { kind: "placed", side: "LEFT", line: mapped }
		: { kind: "placed", side: "RIGHT", line: kept, became: "context" };
}

/** A line below 1 or, when the new file's lengths are known, past the end. */
function outside(placement: Placement, diffs: TraceDiffs): boolean {
	if (placement.kind === "unplaced") return false;
	const count = diffs.newLineCount?.[placement.side];
	return count !== undefined && placement.line > count;
}

export function tracePosition(pos: Position, diffs: TraceDiffs): Placement {
	if (!Number.isInteger(pos.line) || pos.line < 1) return OUTSIDE;
	const placement =
		pos.side === "LEFT" ? traceLeft(pos, diffs) : traceRight(pos, diffs);
	return outside(placement, diffs) ? OUTSIDE : placement;
}

/**
 * The first line from `from` towards `to` (one side, inclusive) that
 * places, marked changed (the range lost its end there), with the text
 * `from` had; null when none does.
 */
function inward(
	from: Position,
	to: Position,
	diffs: TraceDiffs,
): Placement | null {
	const step = to.line > from.line ? 1 : -1;
	for (
		let n = from.line + step;
		step > 0 ? n <= to.line : n >= to.line;
		n += step
	) {
		const p = tracePosition({ side: from.side, line: n }, diffs);
		if (p.kind !== "unplaced") {
			return {
				kind: "changed",
				side: p.side,
				line: p.line,
				oldText: diffs.oldLineText?.(from) ?? null,
			};
		}
	}
	return null;
}

/**
 * Both ends of a range. An end that doesn't place, on a one-side range,
 * moves inwards to the nearest line of the range that does (marked
 * changed): a range maps to the span its surviving lines landed on. When
 * the traced end precedes the start on the same side, or the start landed
 * on the new side and the end on the old one, the range collapses: both
 * ends are the end line, marked changed.
 */
export function traceRange(
	start: Position,
	end: Position,
	diffs: TraceDiffs,
): { start: Placement; end: Placement; collapsed: boolean } {
	let first = tracePosition(start, diffs);
	let last = tracePosition(end, diffs);
	if (start.side === end.side && start.line < end.line) {
		const lost = first.kind === "unplaced";
		if (lost) first = inward(start, end, diffs) ?? first;
		// When no line from the start on placed, none from the end does.
		if (last.kind === "unplaced" && !(lost && first.kind === "unplaced")) {
			last = inward(end, start, diffs) ?? last;
		}
	}
	if (
		first.kind !== "unplaced" &&
		last.kind !== "unplaced" &&
		((first.side === last.side && last.line < first.line) ||
			// A new-side start can't precede an old-side end.
			(first.side === "RIGHT" && last.side === "LEFT"))
	) {
		const collapsed: Placement = {
			kind: "changed",
			side: last.side,
			line: last.line,
			oldText: diffs.oldLineText?.(end) ?? null,
		};
		return { start: collapsed, end: collapsed, collapsed: true };
	}
	return { start: first, end: last, collapsed: false };
}

/**
 * The span's text, re-found in the new line: its new columns when it occurs
 * exactly once there, else null (the caller falls back to whole lines).
 */
export function traceSpan(
	span: { startCol: number; endCol: number },
	oldLineText: string,
	newLineText: string,
): { startCol: number; endCol: number } | null {
	if (span.endCol <= span.startCol) return null;
	const text = oldLineText.slice(span.startCol, span.endCol);
	if (text === "") return null;
	const at = newLineText.indexOf(text);
	if (at === -1 || newLineText.indexOf(text, at + 1) !== -1) return null;
	return { startCol: at, endCol: at + text.length };
}
