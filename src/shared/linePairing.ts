import { HAS_WORD, tokenize, WORD_DIFF_MAX } from "./tokenize.js";

/**
 * Pairing the removed and added lines of one diff cluster by similarity
 * (spec: docs/superpowers/specs/2026-11-08-inline-diff-step2-design.md).
 */

/**
 * **Part of cluster identity in Markdown files.** The block cut
 * (src/shared/blockCut.ts, CAR-167) pairs old blocks with new ones by these
 * pairs, and so decides where a Markdown hunk is cut and its pieces' keys:
 * any change here (the threshold, the scoring, tie-breaks, the caps) moves
 * cuts, and marks on pieces cut the old way would no longer match (fail
 * safe, but the reviewer loses them). Treat it as a key format change, as
 * splitHunk's comment says for the whitespace cut.
 */

/** The least `lineSimilarity` at which two lines may be a pair. */
export const PAIR_MIN_SIMILARITY = 0.5;

/** Removed × added lines above this: no pairs, the layout stays as today. */
export const ALIGN_CAP = 2500;

/** Total characters of a cluster's lines above this: no pairs. */
export const ALIGN_CHARS = 120_000;

/**
 * Word steps of the token LCS (Σ ⌈|old|/32⌉ × Σ |new|, in tokens) above
 * this: no pairs. The most expensive shape it lets through (50 x 50 lines
 * of 192 tokens) measured about 30 ms of CPU on the devbox; the CPU tests
 * (linePairing.test.ts) pin it as a ratio, not a time.
 */
export const ALIGN_WORD_OPS = 3_000_000;

/**
 * Word steps (as ALIGN_WORD_OPS counts them) one hunk's unequal clusters may
 * spend between them (hunkPairs): about four of the costliest clusters
 * ALIGN_WORD_OPS lets through. Past it, a cluster and every later one in
 * the hunk get no pairs, the layout as today (CPU tests: wordBlocks.test.ts,
 * findInPr.test.ts).
 */
export const HUNK_ALIGN_WORD_OPS = 4 * ALIGN_WORD_OPS;

/**
 * What a hunk has left of its word steps (hunkPairs, HUNK_ALIGN_WORD_OPS):
 * alignCluster takes each cluster's estimate out of `left`. A cluster it
 * doesn't cover gets no pairs and leaves it below 0, so no later cluster
 * gets any either.
 */
export type AlignBudget = { left: number };

/** Two scores this close are a tie. */
const EPS = 1e-9;

const BLANK = /^\s+$/u;

/** `arr[i]`, known to be there. */
const at = <T>(arr: readonly T[], i: number): T => arr[i] as T;

/** Token to its one-character code, for the lines being scored. */
type Codes = Map<string, string>;

const code = (codes: Codes, t: string): string => {
	let c = codes.get(t);
	if (c === undefined) {
		c = String.fromCharCode(0x100 + codes.size);
		codes.set(t, c);
	}
	return c;
};

/** Number of 1 bits in a 32-bit word. */
function ones(x: number): number {
	x -= (x >>> 1) & 0x55555555;
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

/** Per token, the bit set of its places in `a`, for `lcs`. */
function patterns(a: string): Uint32Array[] {
	const words = (a.length + 31) >>> 5;
	const masks = [] as Uint32Array[];
	for (let i = 0; i < a.length; i++) {
		const c = a.charCodeAt(i);
		let mask = masks[c];
		if (!mask) {
			mask = new Uint32Array(words);
			masks[c] = mask;
		}
		const w = i >>> 5;
		mask[w] = (mask[w] as number) | (1 << (i & 31));
	}
	return masks;
}

/**
 * Feeds the tokens of `b` to a bit-parallel LCS state `v` (Hyyro) over the
 * tokens `masks` were made of, 32 tokens of them per word operation: the
 * state carries on, so a run's lines can be fed one after the other.
 */
function feed(v: Uint32Array, masks: Uint32Array[], b: string): void {
	const words = v.length;
	for (let k = 0; k < b.length; k++) {
		const mask = masks[b.charCodeAt(k)];
		if (!mask) continue; // V + 0 | V & ~0: unchanged
		let carry = 0;
		for (let w = 0; w < words; w++) {
			const x = v[w] as number;
			const u = (x & (mask[w] as number)) >>> 0;
			const sum = x + u + carry;
			carry = sum > 0xffffffff ? 1 : 0;
			v[w] = (sum | (x & ~(mask[w] as number))) >>> 0;
		}
	}
}

/** The LCS length a state `v` over `m` tokens holds: its 0 bits. */
function zeros(v: Uint32Array, m: number): number {
	const words = v.length;
	let out = 0;
	for (let w = 0; w < words; w++) {
		const bits = w === words - 1 && m & 31 ? m & 31 : 32;
		const live = bits === 32 ? 0xffffffff : (1 << bits) - 1;
		out += ones(~(v[w] as number) & live);
	}
	return out;
}

/**
 * Length of the longest common subsequence of two one-char-per-token
 * strings, by the bit-parallel algorithm (Hyyro): 32 tokens of `a` per word
 * operation, so a cell costs |b|·|a|/32 steps whether or not the lines are alike.
 */
function lcs(a: string, b: string, masks = patterns(a)): number {
	const v = new Uint32Array((a.length + 31) >>> 5).fill(0xffffffff);
	feed(v, masks, b);
	return zeros(v, a.length);
}

/** A line's scoring tokens, one character each. */
type Scored = {
	all: string;
	words: string;
	long: boolean;
	/** `patterns` of `all` / `words`, made when first scored as the old side. */
	allMasks?: Uint32Array[];
	wordMasks?: Uint32Array[];
};

function prepare(text: string, codes: Codes): Scored {
	const all = tokenize(text).filter((t) => !BLANK.test(t));
	return {
		all: all.map((t) => code(codes, t)).join(""),
		words: all
			.filter((t) => HAS_WORD.test(t))
			.map((t) => code(codes, t))
			.join(""),
		long: text.length >= WORD_DIFF_MAX,
	};
}

/** Per removed line, per added line it shares tokens with: the shared count. */
type Overlaps = Map<number, number>[];

/**
 * How many tokens (counted with repeats) each removed line shares with each
 * added line, from an index of the added lines' tokens, so work follows
 * what is shared. Lines sharing nothing have no entry.
 */
function overlaps(dels: readonly string[], adds: readonly string[]): Overlaps {
	const index = new Map<string, Map<number, number>>();
	adds.forEach((line, j) => {
		for (const t of line) {
			let posting = index.get(t);
			if (!posting) {
				posting = new Map();
				index.set(t, posting);
			}
			posting.set(j, (posting.get(j) ?? 0) + 1);
		}
	});
	return dels.map((line) => {
		const counts = new Map<string, number>();
		for (const t of line) counts.set(t, (counts.get(t) ?? 0) + 1);
		const out = new Map<number, number>();
		for (const [t, c] of counts) {
			for (const [j, cj] of index.get(t) ?? []) {
				out.set(j, (out.get(j) ?? 0) + Math.min(c, cj));
			}
		}
		return out;
	});
}

/** `shared`: tokens the lines have in common, when known (bounds the LCS). */
function score(a: Scored, b: Scored, shared = Infinity): number {
	if (a.long || b.long) return 0;
	const [x, y] =
		a.words.length > 0 && b.words.length > 0
			? [a.words, b.words]
			: [a.all, b.all];
	const total = x.length + y.length;
	if (total === 0) return 0;
	// Even a full match of what the lines share can't reach the threshold.
	const common = Math.min(x.length, y.length, shared);
	if ((2 * common) / total < PAIR_MIN_SIMILARITY) return 0;
	let masks: Uint32Array[];
	if (x === a.words) {
		a.wordMasks ??= patterns(a.words);
		masks = a.wordMasks;
	} else {
		a.allMasks ??= patterns(a.all);
		masks = a.allMasks;
	}
	return (2 * lcs(x, y, masks)) / total;
}

/**
 * How alike two lines are, in [0, 1]: twice the longest common run of
 * tokens over both lines' token count. Whitespace doesn't count; when both
 * lines have a word, only words do, else every other token does too. A
 * line of `WORD_DIFF_MAX` characters or more scores 0.
 */
export function lineSimilarity(oldText: string, newText: string): number {
	const codes: Codes = new Map();
	return score(prepare(oldText, codes), prepare(newText, codes));
}

/**
 * `lineSimilarity` of any old line against the added lines `adds` (by
 * index), each line prepared once however many times it is scored: the
 * tracer scores one old line against many added ones (CAR-95).
 */
export function similarityTo(
	adds: readonly string[],
): (oldText: string, j: number) => number {
	const codes: Codes = new Map();
	const fresh: (Scored | undefined)[] = [];
	const old = new Map<string, Scored>();
	return (oldText, j) => {
		const text = adds[j];
		if (text === undefined) return 0;
		let a = old.get(oldText);
		if (!a) {
			a = prepare(oldText, codes);
			old.set(oldText, a);
		}
		let b = fresh[j];
		if (!b) {
			b = prepare(text, codes);
			fresh[j] = b;
		}
		return score(a, b);
	};
}

/** A chosen set of pairs, as a persistent list (earliest pair first). */
type Chain = { del: number; add: number; rest: Chain } | null;
type Cell = { total: number; positions: number; chain: Chain };

/** Whether chain `a` sorts before chain `b` (earlier pair, then longer). */
function earlier(a: Chain, b: Chain): boolean {
	for (; a && b; a = a.rest, b = b.rest) {
		if (a.del !== b.del) return a.del < b.del;
		if (a.add !== b.add) return a.add < b.add;
	}
	return a === null && b !== null ? false : a !== null && b === null;
}

/** Whether `x` is a better choice than `y`. */
function better(x: Cell, y: Cell): boolean {
	if (Math.abs(x.total - y.total) >= EPS) return x.total > y.total;
	if (x.positions !== y.positions) return x.positions > y.positions;
	return earlier(x.chain, y.chain);
}

/**
 * Pairs removed lines with added ones: the non-crossing, one-partner set of
 * pairs scoring at least `PAIR_MIN_SIMILARITY` with the most total
 * similarity. Ties keep the most position pairs (same index on both sides),
 * then the earliest pairs. Index pairs, increasing in both; none above
 * `ALIGN_CAP` lines², `ALIGN_CHARS` or `ALIGN_WORD_OPS`, or when nothing is
 * similar. With a `budget`, also none once the word steps (as
 * ALIGN_WORD_OPS counts them) don't fit what it has left; a cluster that
 * scores spends them from it. A cluster over the guards above spends none.
 */
export function alignCluster(
	dels: readonly string[],
	adds: readonly string[],
	budget?: AlignBudget,
): [del: number, add: number][] {
	if (dels.length === 0 || adds.length === 0) return [];
	return alignOrOver(dels, adds, budget) ?? [];
}

/**
 * alignCluster's pairs, but null when a guard (`ALIGN_CAP`, `ALIGN_CHARS`,
 * `ALIGN_WORD_OPS`, the budget) stopped it: "too large to pair" apart from
 * "nothing is similar" (the tracer flags the first as uncertain).
 */
export function alignOrOver(
	dels: readonly string[],
	adds: readonly string[],
	budget?: AlignBudget,
): [del: number, add: number][] | null {
	const n = dels.length;
	const m = adds.length;
	if (budget && budget.left < 0) return null;
	if (n === 0 || m === 0) return [];
	if (n * m > ALIGN_CAP) return null;
	let chars = 0;
	for (const t of dels) chars += t.length;
	for (const t of adds) chars += t.length;
	if (chars > ALIGN_CHARS) return null;
	const codes: Codes = new Map();
	const d = dels.map((t) => prepare(t, codes));
	const a = adds.map((t) => prepare(t, codes));
	let oldSteps = 0;
	let newTokens = 0;
	for (const x of d) oldSteps += (x.all.length + 31) >>> 5;
	for (const x of a) newTokens += x.all.length;
	const ops = oldSteps * newTokens;
	if (ops > ALIGN_WORD_OPS) return null;
	if (budget) {
		budget.left -= ops;
		if (budget.left < 0) return null;
	}
	const sharedAll = overlaps(
		d.map((x) => x.all),
		a.map((x) => x.all),
	);
	const sim = (i: number, j: number): number => {
		const all = at(sharedAll, i).get(j) ?? 0;
		if (all === 0) return 0; // sharing no token: no pair
		return score(at(d, i), at(a, j), all);
	};
	const empty: Cell = { total: 0, positions: 0, chain: null };
	// best[i][j]: the best pairs of dels[i..] with adds[j..].
	const best: Cell[][] = Array.from({ length: n + 1 }, () =>
		new Array<Cell>(m + 1).fill(empty),
	);
	const row = (i: number): Cell[] => at(best, i);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			let cell = at(row(i + 1), j);
			if (better(at(row(i), j + 1), cell)) cell = at(row(i), j + 1);
			const s = sim(i, j);
			if (s >= PAIR_MIN_SIMILARITY) {
				const rest = at(row(i + 1), j + 1);
				const take: Cell = {
					total: rest.total + s,
					positions: rest.positions + (i === j ? 1 : 0),
					chain: { del: i, add: j, rest: rest.chain },
				};
				if (better(take, cell)) cell = take;
			}
			row(i)[j] = cell;
		}
	}
	const out: [number, number][] = [];
	for (let c = at(row(0), 0).chain; c; c = c.rest) out.push([c.del, c.add]);
	return out;
}

/** The most lines a group's run may have (spec CAR-130: a split or join). */
export const GROUP_MAX_LINES = 20;

/**
 * A group's weight in alignGroups' choice is its similarity times this, a
 * pair's its similarity: a group replaces today's pair on one of its lines
 * only when it scores over 1/0.9 (about 1.11) times as high. Tuned on step
 * 2's case 6, where a line that inlined a variable reads as a join of two
 * old lines scoring 0.81 against today's 0.78 pair (and 0.79 against
 * 0.83), and stays a pair; the wrapped comment (0.72 against 0.56), the
 * join (0.88 against 0.55) and the pure split (no pair) group.
 */
const GROUP_WEIGHT = 0.9;

/**
 * The length of a run's lines joined into one text, a line end between each
 * two: under `WORD_DIFF_MAX` for a group (and its marks).
 */
export function joinedLength(texts: readonly string[]): number {
	let n = texts.length > 0 ? texts.length - 1 : 0;
	for (const t of texts) n += t.length;
	return n;
}

/**
 * A group as indexes into one stretch: the one line (`at`, a removed line
 * for a split, an added one for a join) and its run, lines [from, to) of
 * the other side.
 */
export type GroupAt = {
	one: "del" | "add";
	at: number;
	from: number;
	to: number;
};

/** One direction of alignGroups: splits (a removed one line, runs of added lines) or joins. */
type Side = {
	one: "del" | "add";
	ones: Scored[];
	others: Scored[];
	otherTexts: readonly string[];
	runOne: readonly number[];
	runOther: readonly number[];
	/** Whether one line `o` shares a token with other line `x`. */
	shares: (o: number, x: number) => boolean;
};

/** A candidate item of the choice: a pair of today's, or a group. */
type Item = {
	/** Where it ends: the next removed and added line after it. */
	endDel: number;
	endAdd: number;
	/** A pair's similarity, a group's times GROUP_WEIGHT. */
	weight: number;
	pair?: [number, number];
	group?: GroupAt;
};

/**
 * Groups of one unequal stretch, given today's pairs (alignCluster's, for
 * the same lines): a removed line split into a run of 2 to
 * `GROUP_MAX_LINES` adjacent added lines, or such a run of removed lines
 * joined into one added line (spec:
 * docs/superpowers/specs/2026-11-24-split-joined-lines-design.md). A
 * candidate is a group when
 *
 * - its one line and every run line are in the same view run (`runOfDel`,
 *   `runOfAdd`: each line's), so a run stops at a run's end;
 * - every run line holds part of the one line: walking the run in order
 *   with the one line's non-whitespace tokens (a multiset), each line takes
 *   out at least one token still there (all of its tokens it finds);
 * - the one line against the run joined scores at least
 *   `PAIR_MIN_SIMILARITY` (as `lineSimilarity`: words only when both have
 *   one);
 * - the joined run (`joinedLength`) is under `WORD_DIFF_MAX`.
 *
 * A walk that runs on past either cap (a next line, in the same view run,
 * that still takes a token: a 21st line, or one that makes the joined text
 * `WORD_DIFF_MAX` long) while what it has so far scores is a split or join
 * too long to be a group: no candidate of the one line overlapping its
 * lines stays (in doubt, no group, rather than the first 20 lines of it).
 * A walk that runs on without scoring (new code after a wrap that happens
 * to share tokens with it) vetoes nothing.
 *
 * The choice: today's pairs and the groups are items; the non-crossing set,
 * each line in one at most, with the most total weight wins. A pair weighs
 * its similarity, a group its similarity times `GROUP_WEIGHT`: a group
 * replaces the pairs it covers only when it scores clearly higher than
 * they do. Ties go to today's pairs, then to the longer groups (a closing
 * `):` that holds no word stays in its split). Only today's pairs are kept or
 * dropped, never new ones made, and a group crossing a pair it shares no
 * line with is no candidate: a pair is dropped only for a group holding
 * one of its lines. With no group chosen, the pairs are `pairs` as given,
 * and so always for an equal stretch (step 1's i-th with i-th).
 *
 * Cost: the bit-parallel LCS streams a window's lines over the one line's
 * masks, so every run length of one start costs one LCS over its longest
 * window. The estimate, Σ over one lines of ⌈tokens/32⌉ × the tokens of
 * every window (a start's run of up to `GROUP_MAX_LINES` lines sharing a
 * token with it, in its view run, joined under `WORD_DIFF_MAX`), must be
 * within `ALIGN_WORD_OPS`, and is taken from `budget` (what the hunk's
 * pairs left: hunkItems); else no group (a stretch over its own guard
 * spends nothing). The words-only state, streamed next to the all-token
 * one, at most doubles it.
 */
export function alignGroups(
	dels: readonly string[],
	adds: readonly string[],
	pairs: readonly (readonly [number, number])[],
	runOfDel: readonly number[],
	runOfAdd: readonly number[],
	budget?: AlignBudget,
): { pairs: [number, number][]; groups: GroupAt[] } {
	const keep = () => ({
		pairs: pairs.map(([i, j]): [number, number] => [i, j]),
		groups: [] as GroupAt[],
	});
	if (budget && budget.left < 0) return keep();
	const n = dels.length;
	const m = adds.length;
	if (n === 0 || m === 0 || n === m || n * m > ALIGN_CAP) return keep();
	let chars = 0;
	for (const t of dels) chars += t.length;
	for (const t of adds) chars += t.length;
	if (chars > ALIGN_CHARS) return keep();
	const codes: Codes = new Map();
	const d = dels.map((t) => prepare(t, codes));
	const a = adds.map((t) => prepare(t, codes));
	const shared = overlaps(
		d.map((x) => x.all),
		a.map((x) => x.all),
	);
	const splits: Side = {
		one: "del",
		ones: d,
		others: a,
		otherTexts: adds,
		runOne: runOfDel,
		runOther: runOfAdd,
		shares: (o, x) => at(shared, o).has(x),
	};
	const joins: Side = {
		one: "add",
		ones: a,
		others: d,
		otherTexts: dels,
		runOne: runOfAdd,
		runOther: runOfDel,
		shares: (o, x) => at(shared, x).has(o),
	};
	const sides = [splits, joins];
	// Each one line's windows: per start, where its run would end.
	const windows = sides.map((side) => windowsOf(side));
	let ops = 0;
	sides.forEach((side, k) => {
		for (const [o, starts] of at(windows, k)) {
			const steps = (at(side.ones, o).all.length + 31) >>> 5;
			for (const [s, e] of starts) {
				for (let x = s; x < e; x++)
					ops += steps * at(side.others, x).all.length;
			}
		}
	});
	if (ops > ALIGN_WORD_OPS) return keep();
	if (budget) {
		budget.left -= ops;
		if (budget.left < 0) return keep();
	}
	const candidates: GroupAt[] = [];
	const weights: number[] = [];
	const counts = new Int32Array(codes.size);
	const used = new Int32Array(codes.size);
	const stamp = new Int32Array(codes.size);
	const walk = { stamp: 0, counts, used, stampOf: stamp };
	sides.forEach((side, k) => {
		for (const [o, starts] of at(windows, k)) {
			groupsOf(side, o, starts, walk, candidates, weights);
		}
	});
	if (candidates.length === 0) return keep();
	return choose(d, a, pairs, candidates, weights);
}

/**
 * Per one line of `side` (by index), its windows: [start, end) runs of up
 * to `GROUP_MAX_LINES` other lines that each share a token with it, in its
 * view run, joined under `WORD_DIFF_MAX`, of 2 lines or more. One lines of
 * `WORD_DIFF_MAX` characters or more, or with no token, have none.
 */
function windowsOf(side: Side): Map<number, [number, number][]> {
	const out = new Map<number, [number, number][]>();
	const m = side.others.length;
	side.ones.forEach((one, o) => {
		if (one.long || one.all.length === 0) return;
		const run = side.runOne[o];
		const starts: [number, number][] = [];
		for (let s = 0; s < m; s++) {
			let e = s;
			let len = -1;
			while (
				e < m &&
				e - s < GROUP_MAX_LINES &&
				side.runOther[e] === run &&
				side.shares(o, e)
			) {
				len += 1 + (side.otherTexts[e] as string).length;
				if (len >= WORD_DIFF_MAX) break;
				e++;
			}
			if (e - s >= 2) starts.push([s, e]);
		}
		if (starts.length > 0) out.set(o, starts);
	});
	return out;
}

/** The multiset walk's arrays, by token code, reused for every start. */
type Walk = {
	stamp: number;
	counts: Int32Array;
	used: Int32Array;
	stampOf: Int32Array;
};

const index = (c: string, i: number) => c.charCodeAt(i) - 0x100;

/**
 * The groups of one line `o` of `side`: per window, every run length from 2
 * that holds part of it line by line and scores, streamed. None that
 * overlaps a scoring walk run past a cap (see alignGroups).
 */
function groupsOf(
	side: Side,
	o: number,
	starts: readonly [number, number][],
	walk: Walk,
	out: GroupAt[],
	weights: number[],
): void {
	const one = at(side.ones, o);
	const run = side.runOne[o];
	const m = side.others.length;
	one.allMasks ??= patterns(one.all);
	const hasWords = one.words.length > 0;
	if (hasWords) one.wordMasks ??= patterns(one.words);
	const vAll = new Uint32Array((one.all.length + 31) >>> 5);
	const vWords = new Uint32Array((one.words.length + 31) >>> 5);
	for (let i = 0; i < one.all.length; i++) {
		const c = index(one.all, i);
		walk.counts[c] = (walk.counts[c] as number) + 1;
	}
	const found: GroupAt[] = [];
	const foundWeights: number[] = [];
	// Walks that ran past a cap while scoring: their lines [s, x].
	const vetoes: [number, number][] = [];
	for (const [s] of starts) {
		walk.stamp++;
		vAll.fill(0xffffffff);
		vWords.fill(0xffffffff);
		let allLen = 0;
		let wordLen = 0;
		let joined = -1;
		let scores = false;
		for (let x = s; ; x++) {
			if (x >= m || side.runOther[x] !== run || !side.shares(o, x)) break;
			const line = at(side.others, x);
			// Takes out of what the lines before it left of the one line.
			let took = 0;
			for (let i = 0; i < line.all.length; i++) {
				const c = index(line.all, i);
				if (walk.stampOf[c] !== walk.stamp) {
					walk.stampOf[c] = walk.stamp;
					walk.used[c] = 0;
				}
				if ((walk.used[c] as number) < (walk.counts[c] as number)) {
					walk.used[c] = (walk.used[c] as number) + 1;
					took++;
				}
			}
			if (took === 0) break;
			const lines = x - s + 1;
			joined += 1 + (side.otherTexts[x] as string).length;
			if (lines > GROUP_MAX_LINES || joined >= WORD_DIFF_MAX) {
				if (scores) vetoes.push([s, x]);
				break;
			}
			feed(vAll, one.allMasks, line.all);
			allLen += line.all.length;
			if (hasWords && line.words.length > 0) {
				feed(vWords, one.wordMasks as Uint32Array[], line.words);
				wordLen += line.words.length;
			}
			const [l, total] =
				hasWords && wordLen > 0
					? [zeros(vWords, one.words.length), one.words.length + wordLen]
					: [zeros(vAll, one.all.length), one.all.length + allLen];
			scores = total > 0 && (2 * l) / total >= PAIR_MIN_SIMILARITY;
			if (lines >= 2 && scores) {
				found.push({ one: side.one, at: o, from: s, to: x + 1 });
				foundWeights.push((GROUP_WEIGHT * 2 * l) / total);
			}
		}
	}
	for (let i = 0; i < one.all.length; i++) walk.counts[index(one.all, i)] = 0;
	found.forEach((g, k) => {
		if (vetoes.some(([s, x]) => g.from <= x && g.to > s)) return;
		out.push(g);
		weights.push(foundWeights[k] as number);
	});
}

/**
 * alignGroups' choice over today's pairs and the candidate groups: the
 * non-crossing set, each line once, of the most weight; ties to the pairs'
 * weight, then to the group lines.
 */
function choose(
	d: Scored[],
	a: Scored[],
	pairs: readonly (readonly [number, number])[],
	candidates: readonly GroupAt[],
	weights: readonly number[],
): { pairs: [number, number][]; groups: GroupAt[] } {
	const n = d.length;
	const m = a.length;
	// Per removed line, the last added line a pair before it takes, and the
	// first one a pair after it takes; per added line, the same for removed.
	const lastAddBefore = new Int32Array(n + 1).fill(-1);
	const firstAddAfter = new Int32Array(n + 1).fill(m);
	const lastDelBefore = new Int32Array(m + 1).fill(-1);
	const firstDelAfter = new Int32Array(m + 1).fill(n);
	for (const [p, q] of pairs) {
		for (let i = p + 1; i <= n; i++)
			lastAddBefore[i] = Math.max(lastAddBefore[i] as number, q);
		for (let i = 0; i < p; i++)
			firstAddAfter[i] = Math.min(firstAddAfter[i] as number, q);
		for (let j = q + 1; j <= m; j++)
			lastDelBefore[j] = Math.max(lastDelBefore[j] as number, p);
		for (let j = 0; j < q; j++)
			firstDelAfter[j] = Math.min(firstDelAfter[j] as number, p);
	}
	const items = new Map<number, Item[]>();
	const put = (i: number, j: number, item: Item) => {
		const key = i * (m + 1) + j;
		const list = items.get(key);
		if (list) list.push(item);
		else items.set(key, [item]);
	};
	let groupsLeft = 0;
	candidates.forEach((g, k) => {
		// Crossing a pair it shares no line with: no candidate.
		const crosses =
			g.one === "del"
				? (lastAddBefore[g.at] as number) >= g.to ||
					(firstAddAfter[g.at] as number) < g.from
				: (lastDelBefore[g.at] as number) >= g.to ||
					(firstDelAfter[g.at] as number) < g.from;
		if (crosses) return;
		groupsLeft++;
		const weight = weights[k] as number;
		if (g.one === "del")
			put(g.at, g.from, { endDel: g.at + 1, endAdd: g.to, weight, group: g });
		else
			put(g.from, g.at, { endDel: g.to, endAdd: g.at + 1, weight, group: g });
	});
	if (groupsLeft === 0) {
		return {
			pairs: pairs.map(([i, j]): [number, number] => [i, j]),
			groups: [],
		};
	}
	for (const [i, j] of pairs) {
		put(i, j, {
			endDel: i + 1,
			endAdd: j + 1,
			weight: score(at(d, i), at(a, j)),
			pair: [i, j],
		});
	}
	// best[i][j]: the best items of dels[i..] with adds[j..], as its total
	// weight, the pairs' part of it, its group lines and the first choice.
	const w = m + 1;
	const total = new Float64Array((n + 1) * w);
	const pairW = new Float64Array((n + 1) * w);
	const glines = new Int32Array((n + 1) * w);
	const choice: (Item | 0 | 1 | undefined)[] = new Array((n + 1) * w);
	const better = (t: number, p: number, g: number, c: number) =>
		Math.abs(t - (total[c] as number)) >= EPS
			? t > (total[c] as number)
			: Math.abs(p - (pairW[c] as number)) >= EPS
				? p > (pairW[c] as number)
				: g > (glines[c] as number);
	for (let i = n; i >= 0; i--) {
		for (let j = m; j >= 0; j--) {
			const c = i * w + j;
			if (i === n || j === m) continue; // nothing left: all 0
			// Skip the removed line, or the added one.
			let from = (i + 1) * w + j;
			total[c] = total[from] as number;
			pairW[c] = pairW[from] as number;
			glines[c] = glines[from] as number;
			choice[c] = 0;
			from = i * w + j + 1;
			if (
				better(
					total[from] as number,
					pairW[from] as number,
					glines[from] as number,
					c,
				)
			) {
				total[c] = total[from] as number;
				pairW[c] = pairW[from] as number;
				glines[c] = glines[from] as number;
				choice[c] = 1;
			}
			for (const item of items.get(c) ?? []) {
				const r = item.endDel * w + item.endAdd;
				const t = (total[r] as number) + item.weight;
				const p = (pairW[r] as number) + (item.pair ? item.weight : 0);
				const g =
					(glines[r] as number) +
					(item.group ? item.group.to - item.group.from + 1 : 0);
				if (better(t, p, g, c)) {
					total[c] = t;
					pairW[c] = p;
					glines[c] = g;
					choice[c] = item;
				}
			}
		}
	}
	const out = { pairs: [] as [number, number][], groups: [] as GroupAt[] };
	for (let i = 0, j = 0; i < n && j < m; ) {
		const c = choice[i * w + j];
		if (c === 0) i++;
		else if (c === 1) j++;
		else if (c === undefined) break;
		else {
			if (c.pair) out.pairs.push(c.pair);
			if (c.group) out.groups.push(c.group);
			i = c.endDel;
			j = c.endAdd;
		}
	}
	if (out.groups.length === 0)
		return {
			pairs: pairs.map(([i, j]): [number, number] => [i, j]),
			groups: [],
		};
	return out;
}
