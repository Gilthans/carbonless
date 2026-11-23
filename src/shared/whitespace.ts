import { lineRuns } from "./pieces.js";
import type { DiffLine } from "./types.js";

/**
 * Whitespace-only change, as git's `-w` sees it: two lines are equal once
 * every ASCII whitespace character is removed. Shared by the server, which
 * cuts a hunk's whitespace-only runs into clusters of their own
 * (`hunkCuts`, `cutByLines`; CAR-156), and the view, which draws whitespace-equal lines
 * as quiet `~` rows with "Ignore whitespace" on (src/web/files/whitespace.ts);
 * both read one matching per display hunk (`matchDisplayHunk`, CAR-218).
 */

/** ASCII whitespace, as git's `-w` ignores it. Unicode blanks are content. */
const WHITESPACE = /[ \t\r\v\f]/g;

export const stripWhitespace = (text: string): string =>
	text.replace(WHITESPACE, "");

/** Byte-identical after removing every ASCII whitespace character. */
export const whitespaceEqual = (a: string, b: string): boolean =>
	stripWhitespace(a) === stripWhitespace(b);

/**
 * A line's matching key: its text without whitespace, and whether git's
 * "No newline at end of file" follows it (`-w` doesn't ignore that: a
 * final newline lost or gained is a real change).
 */
export const whitespaceKey = (text: string, noNewline = false): string =>
	`${stripWhitespace(text)}${noNewline ? "\0" : ""}`;

/** One side of a line as the matching sees it. */
export interface Side {
	key: string;
	context: boolean;
}

/**
 * Shared by the view's `~` rows and the server's cut (hunkCuts,
 * splitHunk): a change here moves cluster keys, see splitHunk.
 *
 * The heaviest common subsequence of `a` and `b` under key equality, as
 * index pairs in order. A context side weighs P = n + m + 1 (more than
 * every change-to-change match together could), a change side nothing but
 * a floor of 1: context↔context = 2P, context side↔change = P,
 * change↔change = 1. Matching every context line to itself is always
 * possible, so any optimum matches every context side, to itself or to
 * changes: no unmatched line is ever a context side, which is what makes
 * the rows a sound `-w` edit script (a block moved across an unchanged
 * line is never "whitespace only"). With no context side at all, it is
 * the longest common subsequence.
 *
 * Fast path (`fast`, on but in its test): when both sides are the same
 * keys line for line, with context sides at the same places (a wholesale
 * re-indent), the identity is the optimum (each context side matched to
 * itself, the most changes matched) and the DP's traceback takes exactly
 * that diagonal: O(n), not O(n·m). The tests check it gives what the DP
 * gives.
 */
export function matchSides(
	a: Side[],
	b: Side[],
	fast = true,
): [number, number][] {
	const n = a.length;
	const m = b.length;
	if (
		fast &&
		n === m &&
		a.every(
			(s, i) =>
				s.key === (b[i] as Side).key && s.context === (b[i] as Side).context,
		)
	)
		return a.map((_, i) => [i, i]);
	const w = m + 1;
	const P = n + m + 1;
	const weight = (i: number, j: number) =>
		((a[i] as Side).context ? P : 0) + ((b[j] as Side).context ? P : 0) || 1;
	// best[i * w + j]: the best weight over a[i..] and b[j..]; up to
	// 2P × min(n, m), about 1e6 within SPLIT_CELLS (n × m ≤ 250,000), so 32
	// bits (1 MB at the cap, once per hunk).
	const best = new Uint32Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			const skip = Math.max(
				best[(i + 1) * w + j] as number,
				best[i * w + j + 1] as number,
			);
			const take =
				(a[i] as Side).key === (b[j] as Side).key
					? weight(i, j) + (best[(i + 1) * w + j + 1] as number)
					: 0;
			best[i * w + j] = Math.max(skip, take);
		}
	}
	const out: [number, number][] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (
			(a[i] as Side).key === (b[j] as Side).key &&
			best[i * w + j] === weight(i, j) + (best[(i + 1) * w + j + 1] as number)
		) {
			out.push([i, j]);
			i++;
			j++;
		} else if (
			(best[(i + 1) * w + j] as number) >= (best[i * w + j + 1] as number)
		) {
			i++;
		} else {
			j++;
		}
	}
	return out;
}

/**
 * A piece of a `-U0` hunk: its removed lines `[removedFrom, removedTo)`
 * and added lines `[addedFrom, addedTo)`. A whitespace-only piece holds
 * only lines the matching gave a `-w`-equal twin; splitHunk's (matched
 * within the hunk alone) pair side for side, while a piece of the display
 * hunk's cut (cutByLines) may hold lines whose twins sit outside it, and
 * may have lines on one side only.
 */
export interface HunkPiece {
	removedFrom: number;
	removedTo: number;
	addedFrom: number;
	addedTo: number;
	whitespaceOnly: boolean;
}

/**
 * The most removed × added lines a hunk may have for splitHunk to match
 * it (O(n·m), on the server's event loop as a snapshot is built): about
 * 4 ms of CPU at the cap (500 × 500), measured 2026-11-16, against 45-55 ms
 * for 2000 × 2000. A hunk over it stays one change cluster (the safe
 * direction: progress counts it), unless both sides are the same keys line
 * for line (a wholesale re-indent: no matching needed).
 */
export const SPLIT_CELLS = 250_000;

/**
 * A `-U0` hunk cut at its whitespace-only runs as matched on its own
 * (CAR-156; the server now cuts by the display hunk's matching, hunkCuts,
 * CAR-218, and falls back to this cut per hunk only where it has no display
 * hunk, as the cap's fallback matches it): the longest
 * order-preserving matching of its removed lines to its added ones under
 * `-w` equality (`matchSides`, every side a change), each maximal run of
 * pairs that follow each other on both sides a whitespace-only piece, and
 * the lines between runs a change piece. So a line moved across others is
 * a change, a pure addition or deletion (an added blank line too) is a
 * change, and a blank line paired with a whitespace-only one is
 * whitespace-only, as `git diff -w` shows them. `noNewlineOld`/`New`: the
 * last removed / added line has no newline at end of file.
 *
 * The pieces cover every line exactly once, in order (whitespace.test.ts
 * checks it for any input). A hunk with nothing to pair, or of more than
 * SPLIT_CELLS removed × added lines and not the same keys line for line,
 * is one change piece; an all-whitespace hunk is one whitespace-only piece.
 *
 * **Part of cluster identity.** Where the cut falls decides the clusters
 * and so their keys (docs/review-data-storage.md, "Split carries"): any
 * change here, in cutByLines, hunkCuts, matchDisplayHunk or `matchSides`
 * (weights, tie-breaks, the fast path, the caps, `whitespaceKey`) moves
 * cuts, and marks on pieces cut the old way would no
 * longer match (fail safe, but the reviewer loses them). Treat it as a key
 * format change; `snapshot.test.ts` pins the keys of a few fixed hunks.
 */
export function splitHunk(
	removed: readonly string[],
	added: readonly string[],
	noNewlineOld = false,
	noNewlineNew = false,
): HunkPiece[] {
	const { removedWs, addedWs, pairs } = hunkCut(
		removed,
		added,
		noNewlineOld,
		noNewlineNew,
	);
	return cutByLines(removedWs, addedWs, pairs);
}

/**
 * Which lines of a `-U0` hunk are whitespace-only, and which of them pair
 * with each other inside it (index pairs, removed → added, in order): the
 * input `cutByLines` cuts a hunk by.
 */
export interface HunkCut {
	removedWs: boolean[];
	addedWs: boolean[];
	pairs: [number, number][];
}

/**
 * A `-U0` hunk's cut matched on its own (splitHunk's matching, every side
 * a change): the server's cut where it has no display hunk to match over.
 */
export function hunkCut(
	removed: readonly string[],
	added: readonly string[],
	noNewlineOld = false,
	noNewlineNew = false,
): HunkCut {
	const n = removed.length;
	const m = added.length;
	const cut: HunkCut = {
		removedWs: Array(n).fill(false),
		addedWs: Array(m).fill(false),
		pairs: [],
	};
	if (n === 0 || m === 0) return cut;
	const side = (lines: readonly string[], noNewline: boolean) =>
		lines.map(
			(text, i): Side => ({
				key: whitespaceKey(text, noNewline && i === lines.length - 1),
				context: false,
			}),
		);
	const a = side(removed, noNewlineOld);
	const b = side(added, noNewlineNew);
	const same = n === m && a.every((s, i) => s.key === (b[i] as Side).key);
	if (!same) {
		if (n * m > SPLIT_CELLS) return cut;
		const keys = new Set(a.map((s) => s.key));
		if (!b.some((s) => keys.has(s.key))) return cut;
	}
	cut.pairs = matchSides(a, b);
	for (const [i, j] of cut.pairs) {
		cut.removedWs[i] = true;
		cut.addedWs[j] = true;
	}
	return cut;
}

/**
 * A `-U0` hunk cut into pieces of its own lines, in order, every line
 * exactly once (CAR-156, CAR-218), from which lines are whitespace-only
 * (`removedWs`, `addedWs`: the display hunk's matching matched them) and
 * which of those pair with each other inside the hunk (`pairs`, removed →
 * added index pairs in order). The lines are walked as splitHunk walks
 * them: each pair, and between two pairs (a gap) the gap's removed lines,
 * then its added lines. Each maximal run of whitespace-only lines on that
 * walk is one whitespace-only piece, each maximal run of the others one
 * change piece. So pairs that follow each other on both sides are one
 * two-sided piece, as splitHunk cut them; a whitespace-only line whose
 * twin is outside the hunk (in another git hunk, or an unchanged line)
 * joins the run it sits in, which may leave a piece with lines on one
 * side only; and a gap with no whitespace-only line is one change piece,
 * both sides, as before.
 *
 * Principle 2: a pair counts only when both its lines are flagged and it
 * comes after the last one taken, inside the hunk; any other is skipped,
 * its lines going by their flags. A whitespace-only piece holds only
 * flagged lines, a change piece at least one unflagged line.
 *
 * **Part of cluster identity**: see splitHunk.
 */
export function cutByLines(
	removedWs: readonly boolean[],
	addedWs: readonly boolean[],
	pairs: readonly (readonly [number, number])[],
): HunkPiece[] {
	const n = removedWs.length;
	const m = addedWs.length;
	const pieces: HunkPiece[] = [];
	let i = 0;
	let j = 0;
	/** The lines up to removed `toI`, added `toJ`, as one step of the walk. */
	const step = (toI: number, toJ: number, ws: boolean) => {
		const prev = pieces.at(-1);
		if (prev && prev.whitespaceOnly === ws) {
			prev.removedTo = toI;
			prev.addedTo = toJ;
		} else {
			pieces.push({
				removedFrom: i,
				removedTo: toI,
				addedFrom: j,
				addedTo: toJ,
				whitespaceOnly: ws,
			});
		}
		i = toI;
		j = toJ;
	};
	const gap = (toI: number, toJ: number) => {
		while (i < toI) step(i + 1, j, removedWs[i] === true);
		while (j < toJ) step(i, j + 1, addedWs[j] === true);
	};
	for (const [mi, mj] of pairs) {
		if (mi < i || mj < j || mi >= n || mj >= m) continue;
		if (removedWs[mi] !== true || addedWs[mj] !== true) continue;
		gap(mi, mj);
		step(mi + 1, mj + 1, true);
	}
	gap(n, m);
	if (pieces.length === 0) {
		pieces.push({
			removedFrom: 0,
			removedTo: 0,
			addedFrom: 0,
			addedTo: 0,
			whitespaceOnly: false,
		});
	}
	return pieces;
}

/**
 * Each git hunk of a display hunk (its lines' `clusterKey`) as `cutByLines`
 * cuts it, by the display hunk's one matching (`matchDisplayHunk`): its
 * removed and added lines in order, which are whitespace-only, and the
 * twins that are both in it. The server's cut (CAR-218): it agrees with
 * the view's `~` rows line for line, the cap's per-hunk fallback included.
 */
export function hunkCuts(lines: readonly DiffLine[]): Map<string, HunkCut> {
	const ws = whitespaceLines(lines);
	const twins = matchDisplayHunk(lines);
	const byKey = new Map<string, { dels: DiffLine[]; adds: DiffLine[] }>();
	for (const line of lines) {
		if (line.kind === "context" || line.clusterKey === undefined) continue;
		let hunk = byKey.get(line.clusterKey);
		if (!hunk) {
			hunk = { dels: [], adds: [] };
			byKey.set(line.clusterKey, hunk);
		}
		(line.kind === "del" ? hunk.dels : hunk.adds).push(line);
	}
	const out = new Map<string, HunkCut>();
	for (const [key, { dels, adds }] of byKey) {
		const addAt = new Map(adds.map((l, k) => [l, k]));
		const pairs: [number, number][] = [];
		dels.forEach((d, k) => {
			const twin = twins.get(d);
			const at = twin && addAt.get(twin);
			if (at !== undefined) pairs.push([k, at]);
		});
		out.set(key, {
			removedWs: dels.map((l) => ws.has(l)),
			addedWs: adds.map((l) => ws.has(l)),
			pairs,
		});
	}
	return out;
}

/** A line's matching key (whitespaceKey), with its final-newline flag. */
const lineKey = (line: DiffLine): string =>
	whitespaceKey(line.text, line.noNewline === true);

const twinsByHunk = new WeakMap<
	readonly DiffLine[],
	ReadonlyMap<DiffLine, DiffLine>
>();
const wsByHunk = new WeakMap<readonly DiffLine[], ReadonlySet<DiffLine>>();

/**
 * One whitespace matching per display hunk (CAR-218), shared by the view's
 * `~` rows and the server's cut: each removed or added line that has a
 * whitespace-equal twin on the other side, by `matchSides` over the hunk's
 * whole old side (context and removed lines) and new side (context and
 * added lines). The twin is a line added or removed anywhere in the hunk,
 * or a context line.
 *
 * Sound: dropping the lines left unmatched from both sides leaves
 * whitespace-equal sequences. The weights see to it that every context
 * side is matched, to its own other side or to a change (two context lines
 * of one key may also match each other across, their other sides taken by
 * changes: the same thing along a chain), so the matched
 * lines on each side are one sequence of equal keys; should a context side
 * ever be left unmatched, nothing pairs (all changes: the safe direction).
 *
 * Cap: a hunk of more than SPLIT_CELLS old × new lines (context included),
 * unless both sides are the same keys line for line (matchSides' fast
 * path), is matched per git hunk instead (each run of one cluster's lines,
 * `lineRuns`), changes only, as `splitHunk` cuts it: so a twin never
 * crosses a git hunk there, and a git hunk over the cap on its own has no
 * twins (one change). Cached per `lines` array: callers must never change
 * it in place.
 */
export function matchDisplayHunk(
	lines: readonly DiffLine[],
): ReadonlyMap<DiffLine, DiffLine> {
	let twins = twinsByHunk.get(lines);
	if (!twins) {
		twins = matchLines(lines);
		twinsByHunk.set(lines, twins);
	}
	return twins;
}

/** The changed lines `matchDisplayHunk` matched: the whitespace-only lines. */
export function whitespaceLines(
	lines: readonly DiffLine[],
): ReadonlySet<DiffLine> {
	let ws = wsByHunk.get(lines);
	if (!ws) {
		ws = new Set(matchDisplayHunk(lines).keys());
		wsByHunk.set(lines, ws);
	}
	return ws;
}

function matchLines(lines: readonly DiffLine[]): Map<DiffLine, DiffLine> {
	const twins = new Map<DiffLine, DiffLine>();
	const old = lines.filter((l) => l.kind !== "add");
	const young = lines.filter((l) => l.kind !== "del");
	const side = (l: DiffLine): Side => ({
		key: lineKey(l),
		context: l.kind === "context",
	});
	const a = old.map(side);
	const b = young.map(side);
	// matchSides' fast-path test, repeated here on purpose: a wholesale
	// re-indent (same keys and context line for line) costs O(n) there, so
	// it must skip the cap and keep its rows however big; without this
	// check a big re-indented file would fall back per git hunk.
	const same =
		a.length === b.length &&
		a.every(
			(s, i) =>
				s.key === (b[i] as Side).key && s.context === (b[i] as Side).context,
		);
	if (!same && a.length * b.length > SPLIT_CELLS) {
		for (const run of lineRuns(lines)) {
			if (run.change) matchChanges(run.lines, twins);
		}
		return twins;
	}
	const oldKeys = new Set(a.map((s) => s.key));
	const newKeys = new Set(b.map((s) => s.key));
	const can =
		old.some((l, i) => l.kind === "del" && newKeys.has((a[i] as Side).key)) ||
		young.some((l, j) => l.kind === "add" && oldKeys.has((b[j] as Side).key));
	if (!can) return twins;
	let contextSides = 0;
	for (const [i, j] of matchSides(a, b)) {
		const o = old[i] as DiffLine;
		const n = young[j] as DiffLine;
		if (o.kind === "context") contextSides++;
		if (n.kind === "context") contextSides++;
		if (o.kind === "del") twins.set(o, n);
		if (n.kind === "add") twins.set(n, o);
	}
	const contexts = lines.filter((l) => l.kind === "context").length;
	if (contextSides !== 2 * contexts) twins.clear();
	return twins;
}

/**
 * One git hunk's removed lines matched to its added ones, every side a
 * change, under splitHunk's cap: the pairs splitHunk's whitespace-only
 * pieces hold.
 */
function matchChanges(
	run: readonly DiffLine[],
	twins: Map<DiffLine, DiffLine>,
): void {
	const dels = run.filter((l) => l.kind === "del");
	const adds = run.filter((l) => l.kind === "add");
	const side = (l: DiffLine): Side => ({ key: lineKey(l), context: false });
	const a = dels.map(side);
	const b = adds.map(side);
	const same =
		a.length === b.length && a.every((s, i) => s.key === (b[i] as Side).key);
	if (!same && a.length * b.length > SPLIT_CELLS) return;
	for (const [i, j] of matchSides(a, b)) {
		const d = dels[i] as DiffLine;
		const n = adds[j] as DiffLine;
		twins.set(d, n);
		twins.set(n, d);
	}
}
