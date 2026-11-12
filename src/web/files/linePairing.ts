import { tokenize, WORD_DIFF_MAX } from "./wordDiff";

/**
 * Pairing the removed and added lines of one diff cluster by similarity
 * (spec: docs/superpowers/specs/2026-11-08-inline-diff-step2-design.md).
 */

/** The least `lineSimilarity` at which two lines may be a pair. */
export const PAIR_MIN_SIMILARITY = 0.5;

/** Removed × added lines above this: no pairs, the layout stays as today. */
export const ALIGN_CAP = 2500;

/** Two scores this close are a tie. */
const EPS = 1e-9;

/** A letter, combining mark, digit or `_`. */
const HAS_WORD = /[\p{L}\p{M}\p{N}_]/u;
const BLANK = /^\s+$/u;

/** A line's tokens for scoring: no whitespace; `wordy` if any is a word. */
function scoringTokens(text: string): { all: string[]; words: string[] } {
	const all = tokenize(text).filter((t) => !BLANK.test(t));
	return { all, words: all.filter((t) => HAS_WORD.test(t)) };
}

/** `arr[i]`, known to be there. */
const at = <T>(arr: readonly T[], i: number): T => arr[i] as T;

/** Length of the longest common subsequence of two token lists. */
function lcs(a: readonly string[], b: readonly string[]): number {
	let prev = new Array<number>(b.length + 1).fill(0);
	let cur = new Array<number>(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			cur[j] =
				a[i - 1] === b[j - 1]
					? at(prev, j - 1) + 1
					: Math.max(at(prev, j), at(cur, j - 1));
		}
		[prev, cur] = [cur, prev];
	}
	return at(prev, b.length);
}

type Scored = { all: string[]; words: string[]; long: boolean };

function prepare(text: string): Scored {
	return { ...scoringTokens(text), long: text.length >= WORD_DIFF_MAX };
}

function score(a: Scored, b: Scored): number {
	if (a.long || b.long) return 0;
	const [x, y] =
		a.words.length > 0 && b.words.length > 0
			? [a.words, b.words]
			: [a.all, b.all];
	if (x.length + y.length === 0) return 0;
	return (2 * lcs(x, y)) / (x.length + y.length);
}

/**
 * How alike two lines are, in [0, 1]: twice the longest common run of
 * tokens over both lines' token count. Whitespace doesn't count; when both
 * lines have a word, only words do, else every other token does too. A
 * line of `WORD_DIFF_MAX` characters or more scores 0.
 */
export function lineSimilarity(oldText: string, newText: string): number {
	return score(prepare(oldText), prepare(newText));
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
 * `ALIGN_CAP` lines² or when nothing is similar.
 */
export function alignCluster(
	dels: readonly string[],
	adds: readonly string[],
): [del: number, add: number][] {
	const n = dels.length;
	const m = adds.length;
	if (n === 0 || m === 0 || n * m > ALIGN_CAP) return [];
	const d = dels.map(prepare);
	const a = adds.map(prepare);
	// Cheap prefilter: lines that share no token can't be a pair.
	const sets = a.map((x) => new Set(x.all));
	const sim = (i: number, j: number): number => {
		const x = at(d, i);
		const y = at(a, j);
		if (!x.all.some((t) => at(sets, j).has(t))) return 0;
		return score(x, y);
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
