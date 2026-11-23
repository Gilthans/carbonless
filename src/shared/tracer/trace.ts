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
import {
	claimedByMove,
	contested,
	hasTwin,
	movedTo,
	sameFileTexts,
	TUNING,
} from "./moved.js";

/**
 * Bumped when a placement for the same inputs could change. 2: a line in a
 * replaced hunk goes to its similar partner, else unplaced (was: the same
 * offset in the replacement). 3: a line moved with its block follows it
 * elsewhere in the file (`moved`); a partner that a line elsewhere
 * resembles as much is `rewritten`.
 */
export const TRACER_VERSION = 3;

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
	 * every thread traced through it; a memo read from other texts than the
	 * caller's is dropped, never answered from.
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
	/**
	 * The line was edited in place: its replacement, with the text as it
	 * was; `moved`: it went elsewhere in the file with its block (moved.ts),
	 * edited or not.
	 */
	| {
			kind: "changed";
			side: DiffSide;
			line: number;
			oldText: string | null;
			moved?: true;
	  }
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
	if (partner !== null && typeof partner === "object") {
		return {
			kind: "changed",
			side: "RIGHT",
			line: partner.line,
			oldText: diffs.oldLineText?.(pos) ?? null,
			...(partner.moved ? { moved: true as const } : {}),
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

/** A replacing line found; `moved`: elsewhere, with its block (moved.ts). */
type Found = { line: number; moved?: true };
type Partner = Found | null | "unknown";

/**
 * Per `bd` mapper (TraceDiffs.bd), shared by every thread traced through
 * it: each hunk's pairings with the texts they read, and each old line's
 * partner.
 */
interface Memo {
	regions: Map<MapHunk, Region[]>;
	/**
	 * Per hunk, its joined run (shared by every hunk of it): the run's
	 * pairing and the texts its pairings read, checked on every lookup.
	 */
	runs: Map<MapHunk, Run>;
	/** Each hunk's index in `bd.hunks`. */
	index?: Map<MapHunk, number>;
	partners: Map<number, Partner>;
}

/** A run of joined hunks: its first and last index, its pairing, its texts. */
interface Run {
	first: number;
	last: number;
	/** The run's pairing; null for a run of one hunk. */
	wide: Region | null;
	read: Read;
}
const memos = new WeakMap<LineMapper, Memo>();

/** The texts a hunk's pairings read: old lines from `from`, new from `newFrom`. */
interface Read {
	from: number;
	old: (string | null)[];
	newFrom: number;
	fresh: (string | null)[];
	/** Readers already found to read these texts (checked once each). */
	checked: WeakSet<(pos: Position) => string | null>;
}

function memoOf(diffs: TraceDiffs): Memo {
	let memo = memos.get(diffs.bd);
	if (!memo) {
		memo = { regions: new Map(), runs: new Map(), partners: new Map() };
		memos.set(diffs.bd, memo);
	}
	return memo;
}

/**
 * The texts `hunk`'s pairings depend on: its joined run's old lines with
 * REGION_GAP more on each side (the gaps `joins` reads) and its new lines.
 */
function readFor(
	all: readonly MapHunk[],
	first: number,
	last: number,
	diffs: TraceDiffs,
): Read {
	const a = all[first] as MapHunk;
	const b = all[last] as MapHunk;
	const from = Math.max(1, a.oldStart - REGION_GAP);
	const to = b.oldStart + Math.max(b.oldCount, 1) + REGION_GAP;
	const old: (string | null)[] = [];
	for (let n = from; n <= to; n++) old.push(read(diffs.oldLineText, n));
	const fresh: (string | null)[] = [];
	for (let n = a.newStart; n < b.newStart + b.newCount; n++) {
		fresh.push(read(diffs.newLineText, n));
	}
	const checked = new WeakSet<(pos: Position) => string | null>();
	if (diffs.oldLineText) checked.add(diffs.oldLineText);
	if (diffs.newLineText) checked.add(diffs.newLineText);
	return { from, old, newFrom: a.newStart, fresh, checked };
}

/**
 * Whether `diffs` still reads the texts `r` was read from: each reader
 * checked once (the server hands every thread of a file the same ones).
 */
function sameTexts(r: Read, diffs: TraceDiffs): boolean {
	const old = diffs.oldLineText;
	if (old && !r.checked.has(old)) {
		for (let i = 0; i < r.old.length; i++) {
			if (read(old, r.from + i) !== r.old[i]) return false;
		}
		r.checked.add(old);
	}
	const fresh = diffs.newLineText;
	if (fresh && !r.checked.has(fresh)) {
		for (let i = 0; i < r.fresh.length; i++) {
			if (read(fresh, r.newFrom + i) !== r.fresh[i]) return false;
		}
		r.checked.add(fresh);
	}
	return true;
}

/**
 * The memo of `diffs.bd`, unless `hunk`'s pairings in it were read from
 * other texts (the mapper reused with another pair of files): then a fresh
 * one, so a memo never answers for texts it didn't read.
 */
function checkedMemo(hunk: MapHunk, diffs: TraceDiffs): Memo {
	const memo = memoOf(diffs);
	const r = memo.runs.get(hunk)?.read;
	if (!r || sameTexts(r, diffs)) return memo;
	memos.delete(diffs.bd);
	return memoOf(diffs);
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
		// A line at the left margin (a top-level `}`, the next declaration)
		// is a boundary between two pieces of code, as an opener is.
		if (t.trim() !== "" && !/^\s/u.test(t)) return false;
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
	const memo = memoOf(diffs);
	const known = memo.regions.get(hunk);
	if (known) return known;
	const run = runOf(hunk, diffs, memo);
	const out = [linesOf([hunk], diffs)];
	if (run.wide !== null) out.push(run.wide);
	memo.regions.set(hunk, out);
	return out;
}

/**
 * `hunk`'s joined run, found once for all its hunks (a long run of hunks
 * joined end to end is walked and paired once, not once per hunk).
 */
function runOf(hunk: MapHunk, diffs: TraceDiffs, memo: Memo): Run {
	const known = memo.runs.get(hunk);
	if (known) return known;
	const all = diffs.bd.hunks;
	memo.index ??= new Map(all.map((h, i) => [h, i]));
	const i = memo.index.get(hunk) ?? all.indexOf(hunk);
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
	const run: Run = {
		first,
		last,
		wide: first === last ? null : linesOf(all.slice(first, last + 1), diffs),
		read: readFor(all, first, last, diffs),
	};
	for (let k = first; k <= last; k++) memo.runs.set(all[k] as MapHunk, run);
	return run;
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
	// A partner also depends on the whole file's changed lines (moved.ts).
	if (!sameFileTexts(diffs)) memos.delete(diffs.bd);
	const memo = checkedMemo(hunk, diffs).partners;
	let partner = memo.get(line);
	if (partner === undefined) {
		partner = findPartner(hunk, line, diffs);
		memo.set(line, partner);
	}
	return partner;
}

/**
 * The replacing line that carries old line `line`: its partner nearby
 * (`localPartner`) when equal ignoring whitespace, or when the line was
 * edited in place (`anchored`); else the partner, where it went with its
 * moved block (moved.ts) and the file's look-alikes compete on likeness
 * plus context (`contested`), or, with no partner nearby, the moved
 * block's line (`moved` when outside its own hunk). An ambiguous move or
 * contest is "unknown". null: nothing resembles it.
 */
function findPartner(hunk: MapHunk, line: number, diffs: TraceDiffs): Partner {
	const readers = {
		...diffs,
		stays: (n: number, image: number) => {
			const h = diffs.bd.hunkRemovingOld(n);
			const p = h ? localPartner(h, n, diffs) : null;
			return p !== null && p !== "unknown" && p.line !== image;
		},
	};
	let local = localPartner(hunk, line, diffs);
	const plain = (p: Local): Partner =>
		p === null || p === "unknown" ? p : { line: p.line };
	// Equal, ignoring whitespace, in its own region: it stayed. Found equal
	// only across kept lines, with another removed line of the same text:
	// which of the two it is can't be told.
	if (local !== null && local !== "unknown" && local.score >= 1 - EPS) {
		if (local.wide && diffs.newLineText && hasTwin(line, readers)) {
			return "unknown";
		}
		return plain(local);
	}
	const own = read(diffs.oldLineText, line);
	if (own === null || !HAS_WORD.test(own) || !diffs.newLineText) {
		return plain(local);
	}
	if (
		local !== null &&
		local !== "unknown" &&
		anchored(hunk, line, local.line, diffs)
	) {
		return plain(local);
	}
	// Its partner nearby is where another line moved with its block: that
	// line's, not this one's.
	if (
		local !== null &&
		local !== "unknown" &&
		claimedByMove(line, local.line, readers)
	) {
		local = null;
	}
	// Found again in its own hunk (a re-indented block too large to pair):
	// rewritten there, not moved.
	const away = (at: number): Found =>
		diffs.bd.hunkAddingNew(at) === hunk
			? { line: at }
			: { line: at, moved: true };
	// No partner nearby: a move must carry its whole hunk.
	const moved = movedTo(line, readers, local === null || local === "unknown");
	if (moved === "ambiguous") return "unknown";
	if (local === null || local === "unknown") {
		// Its text is among the added lines as it was, but no move was
		// decided: "deleted" would be a false claim.
		if (moved === "copies") return "unknown";
		return moved ? away(moved.line) : local;
	}
	const won = contested(
		line,
		local.line,
		local.score,
		diffs,
		moved === null || moved === "copies" ? null : moved.line,
	);
	return won === "unknown" ? won : won.moved ? away(won.line) : won;
}

/**
 * Whether `line` was edited in place, onto `partner`: every line with a
 * word within TUNING.contextLines of it either stayed (git kept it) or has
 * a partner in a hunk's pairing (its own, joined, or the neighbour's own),
 * landing on the same side of
 * `partner` and within as many lines of it; and there is one. Its partner
 * nearby then carries it, whatever looks like it elsewhere: a line copied
 * into new code and edited at home, a version bumped, an assertion
 * changed, never jump to the copy.
 */
function anchored(
	hunk: MapHunk,
	line: number,
	partner: number,
	diffs: TraceDiffs,
): boolean {
	const regions = regionsOf(hunk, diffs).filter(
		(r): r is Exclude<Region, "unknown"> => r !== "unknown",
	);
	if (regions.length === 0) return false;
	/**
	 * A removed neighbour's partner: in this hunk's pairing or the joined
	 * one's, else in its own hunk's (a table edited row by row is a run of
	 * small hunks, too large to pair joined).
	 */
	const pairedOf = (n: number): number | null => {
		const theirs = diffs.bd.hunkRemovingOld(n);
		const own =
			theirs && theirs !== hunk ? regionsOf(theirs, diffs)[0] : undefined;
		for (const region of [
			...regions,
			...(own && own !== "unknown" ? [own] : []),
		]) {
			const at = region.oldLines.indexOf(n);
			const j = at === -1 ? undefined : region.partner.get(at);
			if (j !== undefined) return region.newLines[j] ?? null;
		}
		return null;
	};
	const k = TUNING.contextLines;
	let any = false;
	for (let i = -k; i <= k; i++) {
		const n = line + i;
		if (i === 0 || n < 1) continue;
		const t = read(diffs.oldLineText, n);
		if (t === null || !HAS_WORD.test(t)) continue;
		any = true;
		const image = diffs.bd.oldToNew(n) ?? pairedOf(n);
		if (image === null) return false;
		const d = image - partner;
		if (Math.sign(d) !== Math.sign(i) || Math.abs(d) > k) return false;
	}
	return any;
}

/** A partner found nearby, its likeness, and the new lines searched. */
type Local =
	| {
			line: number;
			score: number;
			from: number;
			to: number;
			/** Found only in the region joined across kept lines, not its own hunk. */
			wide?: true;
	  }
	| null
	| "unknown";

/**
 * The replacing line nearby that carries old line `line`: its partner in
 * the similarity pairing of the hunk's old and new lines (whitespace
 * doesn't count, so a re-indented line is its own partner), or of the hunk
 * with its joined neighbours when that partner is closer ("unknown" when
 * another line there is as close); else the line it most resembles
 * between its neighbours' partners at SHARE_MIN_SIMILARITY or more. null:
 * nothing replacing it resembles it; "unknown": it can't be told (a
 * pairing too large, a text missing, a line past the pairing's length
 * cut, a line without a word).
 */
function localPartner(hunk: MapHunk, line: number, diffs: TraceDiffs): Local {
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
	let best: { line: number; score: number; wide?: true } | null = null;
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
		best = {
			line: region.newLines[partner] as number,
			score,
			...(i > 0 ? { wide: true as const } : {}),
		};
	});
	const span = widest as Exclude<Region, "unknown"> | null;
	const from = span?.newLines[0] ?? 0;
	const to = span?.newLines.at(-1) ?? -1;
	const found = best as { line: number; score: number; wide?: true } | null;
	if (found) return { ...found, from, to };
	// Two lines as like it, past its own hunk: which one carries it can't
	// be told.
	if (twins) return "unknown";
	const shared = span ? sharedIn(span, line) : null;
	if (shared !== null && typeof shared === "object") {
		return { ...shared, from, to };
	}
	if (shared !== null) return shared;
	// No likeness here, but a pairing that couldn't be made might have one.
	return regions.includes("unknown") ? "unknown" : null;
}

/** SHARE_MIN_SIMILARITY's step: the unpaired line's likeliest replacement. */
function sharedIn(
	region: Exclude<Region, "unknown">,
	line: number,
): { line: number; score: number } | "unknown" | null {
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
	// A line another old line pairs with exactly was not merged into: it is
	// that line, as it was.
	const taken = new Set<number>();
	for (const [d, a] of region.partner) {
		if (d !== k && scoreIn(region, d, a) >= 1 - EPS) taken.add(a);
	}
	let best = -1;
	let score = SHARE_MIN_SIMILARITY;
	for (let j = lo; j <= hi; j++) {
		if (taken.has(j)) continue;
		const s = scoreIn(region, k, j);
		if (s > score || (s === score && best === -1)) {
			best = j;
			score = s;
		}
	}
	const at = region.newLines[best];
	return best === -1 || at === undefined ? null : { line: at, score };
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
				...(p.kind === "changed" && p.moved ? { moved: true as const } : {}),
			};
		}
	}
	return null;
}

/**
 * When a range has a line with a word and none of those places, the last
 * one's unplaced placement; else null (one places, or none has a word).
 */
function wordsGone(
	start: Position,
	end: Position,
	diffs: TraceDiffs,
): Placement | null {
	let gone: Placement | null = null;
	for (let n = start.line; n <= end.line; n++) {
		const t = diffs.oldLineText?.({ side: start.side, line: n });
		if (t === null || t === undefined) return null;
		if (!HAS_WORD.test(t)) continue;
		const p = tracePosition({ side: start.side, line: n }, diffs);
		if (p.kind !== "unplaced") return null;
		gone = p;
	}
	return gone;
}

/**
 * A range split by a move (one-side): the first and last placement of the
 * part, moved or stayed, with more of its lines with a word (`movedWins`
 * on a tie); null when it can't be read.
 */
function majority(
	start: Position,
	end: Position,
	diffs: TraceDiffs,
	movedWins: boolean,
): [Placement, Placement] | null {
	if (start.side !== end.side) return null;
	const parts: { moved: Placement[]; stayed: Placement[] } = {
		moved: [],
		stayed: [],
	};
	for (let n = start.line; n <= end.line; n++) {
		const t = diffs.oldLineText?.({ side: start.side, line: n });
		if (t === null || t === undefined) return null;
		if (!HAS_WORD.test(t)) continue;
		const p = tracePosition({ side: start.side, line: n }, diffs);
		if (p.kind === "unplaced") continue;
		(p.kind === "changed" && p.moved ? parts.moved : parts.stayed).push(p);
	}
	const { moved, stayed } = parts;
	const part =
		moved.length > stayed.length ||
		(moved.length === stayed.length && movedWins)
			? moved
			: stayed;
	const a = part[0];
	const b = part.at(-1);
	return a && b ? [a, b] : null;
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
		// Its statements all gone, a range doesn't live on in a `}` or a
		// blank line that stayed: those say nothing about where it went.
		const gone = start.side === "RIGHT" ? wordsGone(start, end, diffs) : null;
		if (gone) return { start: gone, end: gone, collapsed: false };
	}
	const moved = (p: Placement) => p.kind === "changed" && p.moved === true;
	// One end moved with its block and the other didn't: the span between
	// them is no range of the thread's. It follows the part holding more of
	// its lines with a word (the end's part on a tie), each end as traced.
	if (
		first.kind !== "unplaced" &&
		last.kind !== "unplaced" &&
		moved(first) !== moved(last)
	) {
		const part = majority(start, end, diffs, moved(last));
		if (part) return { start: part[0], end: part[1], collapsed: true };
		const collapsed: Placement = {
			kind: "changed",
			side: last.side,
			line: last.line,
			oldText: diffs.oldLineText?.(end) ?? null,
			...(moved(last) ? { moved: true as const } : {}),
		};
		return { start: collapsed, end: collapsed, collapsed: true };
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
