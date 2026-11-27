import { type AlignBudget, alignCluster } from "./linePairing.js";
import { blockOfLine, type MdBlock } from "./markdownBlocks.js";
import type { HunkPart, LineCluster } from "./types.js";

// The Markdown block cut (CAR-167): one line cluster (a git hunk, or a piece
// of one) cut so that no piece mixes lines of two blocks on either side, old
// blocks paired with new ones in order. Shared by the server's snapshot cut
// and the since view's pieces, so both cut the same way.

/**
 * The block cut's grouping, shared with the since view's pieces. Half-open
 * index ranges `[from, to)` into removed/added, in order; a side with no
 * lines is `[at, at]`, where its lines would sit.
 */
export interface BlockGroup {
	removed: [from: number, to: number];
	added: [from: number, to: number];
}

/** Maximal runs of indices in `[0, n)` with the same block, half-open. */
function runs(n: number, blockOf: (i: number) => number): [number, number][] {
	const out: [number, number][] = [];
	let prev: number | undefined;
	for (let i = 0; i < n; i++) {
		const b = blockOf(i);
		const last = out.at(-1);
		if (last && b === prev) last[1] = i + 1;
		else out.push([i, i + 1]);
		prev = b;
	}
	return out;
}

/**
 * Cuts removed/added lines at block edges: removed lines grouped by their old
 * block (`oldBlockOf(i)`, a block index; -1, a file without blocks, is one
 * group too), added by their new one. Each old group pairs with the new
 * group holding most of its line pairs (`alignCluster`; ties: the earlier);
 * with no pairs at all, by position when both sides have as many groups,
 * else not at all. Pairings never cross and a new group's old groups are
 * adjacent: an old group that would break either is removal-only.
 *
 * One piece per new group (with its old groups) and one per unpaired old
 * group, in hunk order: every line in exactly one piece, each side's ranges
 * contiguous and non-decreasing. One group: nothing cuts.
 */
export function groupByBlocks(
	removed: readonly string[],
	added: readonly string[],
	oldBlockOf: (i: number) => number,
	newBlockOf: (i: number) => number,
	budget?: AlignBudget,
): BlockGroup[] {
	const n = removed.length;
	const m = added.length;
	const olds = runs(n, oldBlockOf);
	const news = runs(m, newBlockOf);
	if (olds.length <= 1 && news.length <= 1) {
		return [{ removed: [0, n], added: [0, m] }];
	}
	const newGroupOf = new Array<number>(m);
	news.forEach(([from, to], g) => {
		newGroupOf.fill(g, from, to);
	});
	const oldGroupOf = new Array<number>(n);
	olds.forEach(([from, to], g) => {
		oldGroupOf.fill(g, from, to);
	});

	const target: (number | undefined)[] = olds.map(() => undefined);
	const pairs = alignCluster(removed, added, budget);
	if (pairs.length > 0) {
		const counts = olds.map(() => new Array<number>(news.length).fill(0));
		for (const [d, a] of pairs) {
			const row = counts[oldGroupOf[d] as number] as number[];
			const g = newGroupOf[a] as number;
			row[g] = (row[g] as number) + 1;
		}
		counts.forEach((row, g) => {
			let best = 0;
			row.forEach((count, t) => {
				if (count > best) {
					best = count;
					target[g] = t;
				}
			});
		});
	} else if (olds.length === news.length) {
		olds.forEach((_, g) => {
			target[g] = g;
		});
	}

	// Keep order and contiguity: no crossing, a new group's old groups adjacent.
	let last = -1;
	let prevTarget: number | undefined;
	for (let g = 0; g < olds.length; g++) {
		const t = target[g];
		if (t === undefined || t < last || (t === last && prevTarget !== t)) {
			target[g] = undefined;
		} else {
			last = t;
		}
		prevTarget = target[g];
	}

	const out: BlockGroup[] = [];
	let oi = 0;
	const nextPaired = (from: number): number => {
		let g = from;
		while (g < olds.length && target[g] === undefined) g++;
		return g;
	};
	const removalOnly = (g: number, at: number) => {
		const [from, to] = olds[g] as [number, number];
		out.push({ removed: [from, to], added: [at, at] });
	};
	news.forEach(([addedFrom, addedTo], t) => {
		// Paired targets increase and a new group's old groups are adjacent:
		// this group's, if any, start at the next paired old group.
		const next = nextPaired(oi);
		const first = next < olds.length && target[next] === t ? next : -1;
		let lastOld = first;
		while (lastOld !== -1 && target[lastOld + 1] === t) lastOld++;
		// Unpaired old groups before this new group's (or before the next
		// paired one) come first: removals before additions, as git orders.
		const limit = first === -1 ? next : first;
		for (; oi < limit; oi++) removalOnly(oi, addedFrom);
		if (first === -1) {
			const at = oi < olds.length ? (olds[oi] as [number, number])[0] : n;
			out.push({ removed: [at, at], added: [addedFrom, addedTo] });
		} else {
			out.push({
				removed: [
					(olds[first] as [number, number])[0],
					(olds[lastOld] as [number, number])[1],
				],
				added: [addedFrom, addedTo],
			});
			oi = lastOld + 1;
		}
	});
	for (; oi < olds.length; oi++) removalOnly(oi, m);
	return out;
}

/**
 * `c` cut at Markdown block edges (`groupByBlocks`), its old lines placed in
 * `oldBlocks` and new ones in `newBlocks`. Pieces are numbered as git would
 * number them as hunks (a side with no lines starts at the line it follows,
 * as `splitCluster`); `noNewlineOld`/`New` stay on the piece holding the
 * last line. A cut piece drops `split` (the caller keys pieces) and keeps
 * `whitespaceOnly` when `c` has it: since CAR-218 a whitespace-only cluster
 * is one whose every line the display hunk's matching gave a twin (maybe
 * outside it, maybe one side only), so any part of it is too, and the view
 * draws all its lines as `~` rows. `removedAt`/`addedAt` are relative to
 * `c`; nothing to cut gives `[{ cluster: c, removedAt: 0, addedAt: 0 }]`.
 */
export function cutAtBlocks<C extends LineCluster>(
	c: C,
	oldBlocks: readonly MdBlock[],
	newBlocks: readonly MdBlock[],
	budget?: AlignBudget,
): HunkPart<C>[] {
	// The line a removed/added index 0 is on (a side with no lines is
	// numbered as the line it follows).
	const oldBase = c.oldCount > 0 ? c.oldStart : c.oldStart + 1;
	const newBase = c.newCount > 0 ? c.newStart : c.newStart + 1;
	const groups = groupByBlocks(
		c.removed,
		c.added,
		(i) => blockOfLine(oldBlocks, oldBase + i),
		(i) => blockOfLine(newBlocks, newBase + i),
		budget,
	);
	if (groups.length === 1) return [{ cluster: c, removedAt: 0, addedAt: 0 }];
	return groups.map(({ removed: [rf, rt], added: [af, at] }) => {
		const oldCount = rt - rf;
		const newCount = at - af;
		const {
			noNewlineOld: _o,
			noNewlineNew: _n,
			whitespaceOnly: _w,
			split: _s,
			...rest
		} = c;
		const cluster = {
			...rest,
			oldStart: oldBase + rf - (oldCount === 0 ? 1 : 0),
			oldCount,
			newStart: newBase + af - (newCount === 0 ? 1 : 0),
			newCount,
			removed: c.removed.slice(rf, rt),
			added: c.added.slice(af, at),
			lines: oldCount + newCount,
			...(c.noNewlineOld && oldCount > 0 && rt === c.removed.length
				? { noNewlineOld: true }
				: {}),
			...(c.noNewlineNew && newCount > 0 && at === c.added.length
				? { noNewlineNew: true }
				: {}),
			...(c.whitespaceOnly ? { whitespaceOnly: true } : {}),
		} as unknown as C;
		return { cluster, removedAt: rf, addedAt: af };
	});
}
