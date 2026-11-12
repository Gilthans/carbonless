import { tokenize, WORD_DIFF_MAX } from "./wordDiff";

/**
 * Pairing the removed and added lines of one diff cluster by similarity
 * (spec: docs/superpowers/specs/2026-11-08-inline-diff-step2-design.md).
 */

/** The least `lineSimilarity` at which two lines may be a pair. */
export const PAIR_MIN_SIMILARITY = 0.5;

/** Removed × added lines above this: no pairs, the layout stays as today. */
export const ALIGN_CAP = 2500;

/** Total characters of a cluster's lines above this: no pairs. */
export const ALIGN_CHARS = 120_000;

/**
 * Word steps of the token LCS (Σ ⌈|old|/32⌉ × Σ |new|, in tokens) above
 * this: no pairs. About 60 ms of CPU, inside the 100 ms budget.
 */
export const ALIGN_WORD_OPS = 3_000_000;

/** Two scores this close are a tie. */
const EPS = 1e-9;

/** A letter, combining mark, digit or `_`. */
const HAS_WORD = /[\p{L}\p{M}\p{N}_]/u;
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
 * Length of the longest common subsequence of two one-char-per-token
 * strings, by the bit-parallel algorithm (Hyyro): 32 tokens of `a` per word
 * operation, so a cell costs |b|·|a|/32 steps whether or not the lines alike.
 */
function lcs(a: string, b: string, masks = patterns(a)): number {
	const m = a.length;
	const words = (m + 31) >>> 5;
	const v = new Uint32Array(words).fill(0xffffffff);
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
	let zeros = 0;
	for (let w = 0; w < words; w++) {
		const bits = w === words - 1 && m & 31 ? m & 31 : 32;
		const live = bits === 32 ? 0xffffffff : (1 << bits) - 1;
		zeros += ones(~(v[w] as number) & live);
	}
	return zeros;
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

/** A chosen set of pairs, as a persistent list (earliest pair first). */
type Chain = { del: number; add: number; rest: Chain } | null;
type Cell = { total: number; positions: number; chain: Chain };

/** Whether chain `a` sorts before chain `b` (earlier pair, then shorter). */
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
 * similar.
 */
export function alignCluster(
	dels: readonly string[],
	adds: readonly string[],
): [del: number, add: number][] {
	const n = dels.length;
	const m = adds.length;
	if (n === 0 || m === 0 || n * m > ALIGN_CAP) return [];
	let chars = 0;
	for (const t of dels) chars += t.length;
	for (const t of adds) chars += t.length;
	if (chars > ALIGN_CHARS) return [];
	const codes: Codes = new Map();
	const d = dels.map((t) => prepare(t, codes));
	const a = adds.map((t) => prepare(t, codes));
	let oldSteps = 0;
	let newTokens = 0;
	for (const x of d) oldSteps += (x.all.length + 31) >>> 5;
	for (const x of a) newTokens += x.all.length;
	if (oldSteps * newTokens > ALIGN_WORD_OPS) return [];
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
