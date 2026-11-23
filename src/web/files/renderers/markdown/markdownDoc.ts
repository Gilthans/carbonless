import {
	type LineRanges,
	normalize,
	size,
} from "../../../../shared/lineRanges";
import {
	blockOfLine,
	type MdBlock,
	markdownBlocks,
} from "../../../../shared/markdownBlocks";
import type { DiffLine, FileHunks } from "../../../../shared/types";
import type { SpanRange } from "../../../threads/spanMarks";

/**
 * The Rendered view's document (CAR-167): which blocks show, in what order,
 * and which review units (the full diff's clusters, the since view's
 * pieces) sit on each. Pure, so the coverage rule is tested here: every
 * unit lands on exactly one row (`unplaced` says otherwise, and the view
 * then shows Text: principle 2).
 */

/** A unit's changed lines, by line number on each side (half-open ranges). */
export interface DocUnit {
	key: string;
	old: LineRanges;
	new: LineRanges;
}

/** Both sides' text, line `n` at index `n - 1`. */
export interface Sides {
	old: string[];
	new: string[];
	/** Unchanged lines: old number → new number. */
	same: Map<number, number>;
}

/**
 * Both sides of the file rebuilt from what the line view reads: its hunks
 * (removed, added and context lines) and the file's unchanged lines (the
 * context route over the whole new side), which carry both numbers. Null
 * when a line of either side is missing: the view can't show a document
 * it doesn't have whole.
 */
export function rebuildSides(
	hunks: FileHunks,
	context: readonly DiffLine[],
): Sides | null {
	const old: (string | undefined)[] = [];
	const nu: (string | undefined)[] = [];
	const same = new Map<number, number>();
	const put = (line: DiffLine) => {
		if (
			line.kind === "context" &&
			line.oldNo !== undefined &&
			line.newNo !== undefined
		) {
			same.set(line.oldNo, line.newNo);
		}
		if (line.kind !== "add" && line.oldNo !== undefined) {
			old[line.oldNo - 1] = line.text;
		}
		if (line.kind !== "del" && line.newNo !== undefined) {
			nu[line.newNo - 1] = line.text;
		}
	};
	for (const hunk of hunks.hunks) for (const line of hunk.lines) put(line);
	for (const line of context) put(line);
	if (nu.length > hunks.newLineCount) return null;
	nu.length = hunks.newLineCount;
	const whole = (side: (string | undefined)[]): string[] | null => {
		for (let i = 0; i < side.length; i++) {
			if (side[i] === undefined) return null;
		}
		return side as string[];
	};
	const o = whole(old);
	const n = whole(nu);
	return o && n ? { old: o, new: n, same } : null;
}

/**
 * A side's blocks; a side with lines but no block (all blank) gets one
 * covering them, so a changed blank line still has a block to sit on.
 */
export function blocksOf(lines: readonly string[]): MdBlock[] {
	const blocks = markdownBlocks(lines);
	if (blocks.length === 0 && lines.length > 0) {
		return [{ kind: "paragraph", from: 1, to: lines.length, depth: 0 }];
	}
	return blocks;
}

export type Tone = "added" | "removed" | "changed";

export type DocRow =
	/** An unchanged block of the new side, at full strength. */
	| { kind: "same"; block: number }
	/**
	 * Unchanged blocks folded into one row (more than FOLD_MIN in a run),
	 * named by the headings among them; it expands in place.
	 */
	| { kind: "fold"; blocks: number[]; headings: string[] }
	/** Changed blocks and the units on them, in source order. */
	| {
			kind: "change";
			tone: Tone;
			oldBlocks: number[];
			newBlocks: number[];
			units: string[];
	  };

/** A run of more than this many unchanged blocks folds. */
export const FOLD_MIN = 3;

export interface Doc {
	rows: DocRow[];
	/** Units no row holds (a bug): the view must not pretend they're shown. */
	unplaced: string[];
}

const linesOf = (ranges: LineRanges): number[] =>
	ranges.flatMap(([a, b]) => Array.from({ length: b - a }, (_, i) => a + i));

/** A heading block's text, for a fold's name. */
export function headingText(lines: readonly string[], b: MdBlock): string {
	const first = lines[b.from - 1] ?? "";
	const atx = /^\s{0,3}#{1,6}(?:\s+|$)(.*?)(?:\s+#+\s*)?$/.exec(first);
	return (atx ? (atx[1] ?? "") : first).trim();
}

/**
 * The document: the new side's blocks in order, each changed one with
 * its units and the old blocks paired with it; old blocks with no new
 * block (removals) where they were, before the new block that follows
 * their place; long runs of unchanged blocks folded.
 */
export function buildDoc(opts: {
	sides: Sides;
	oldBlocks: readonly MdBlock[];
	newBlocks: readonly MdBlock[];
	units: readonly DocUnit[];
}): Doc {
	const { sides, oldBlocks, newBlocks, units } = opts;
	// Union-find over blocks: old block i is node i, new block j is
	// node oldBlocks.length + j.
	const N = oldBlocks.length;
	const parent = Array.from({ length: N + newBlocks.length }, (_, i) => i);
	const find = (x: number): number => {
		let r = x;
		while (parent[r] !== r) r = parent[r] as number;
		while (parent[x] !== r) {
			const next = parent[x] as number;
			parent[x] = r;
			x = next;
		}
		return r;
	};
	const join = (a: number, b: number) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
	};
	// Unchanged lines: old number → new number, for where a removal sat.
	const sameAt = sides.same;
	/** Unchanged lines: new number → old number. */
	const oldAt = new Map<number, number>();
	for (const [o, n] of sameAt) oldAt.set(n, o);
	const sameOld = [...sameAt.keys()].sort((a, b) => a - b);
	/** The unchanged line just before old line `a`, and just after `b`. */
	const around = (a: number, b: number) => {
		let before: number | undefined;
		let after: number | undefined;
		for (const o of sameOld) {
			if (o < a) before = o;
			else if (o > b) {
				after = o;
				break;
			}
		}
		return {
			before: before === undefined ? undefined : sameAt.get(before),
			after: after === undefined ? undefined : sameAt.get(after),
		};
	};
	const nodesOf = new Map<string, number[]>();
	/** Where a removal-only unit's blocks go: before this new block. */
	const anchorOf = new Map<number, number>();
	const placeOf = (line: number, blocks: readonly MdBlock[]) =>
		blocks.length === 0 ? -1 : blockOfLine(blocks, line);
	const unplaced: string[] = [];
	for (const u of units) {
		const nodes = new Set<number>();
		const olds = linesOf(u.old);
		const news = linesOf(u.new);
		// A blank line goes with the block before it, unless the unit has
		// lines of its own text: then those say where it is (a removed
		// section's blank line must not pull its neighbour in).
		const own = (list: number[], text: readonly string[]) => {
			const filled = list.filter((n) => (text[n - 1] ?? "").trim() !== "");
			return filled.length ? filled : list;
		};
		for (const n of own(olds, sides.old)) {
			const b = placeOf(n, oldBlocks);
			if (b >= 0) nodes.add(b);
		}
		for (const n of own(news, sides.new)) {
			const b = placeOf(n, newBlocks);
			if (b >= 0) nodes.add(N + b);
		}
		if (news.length === 0 && olds.length > 0) {
			// Lines taken out of a block that stays (its other lines are
			// unchanged, all in one new block: a line of a paragraph, a blank
			// line after an item): that block changed, it isn't gone.
			const kept = new Set<number>();
			for (const node of nodes) {
				const b = oldBlocks[node] as MdBlock;
				for (let o = b.from; o <= b.to; o++) {
					const n = sameAt.get(o);
					if (n !== undefined) kept.add(placeOf(n, newBlocks));
				}
			}
			const stays = kept.size === 1 ? ([...kept][0] as number) : -1;
			if (stays >= 0) nodes.add(N + stays);
			else {
				const first = olds[0] as number;
				const last = olds[olds.length - 1] as number;
				const pos = around(first, last).before ?? 0;
				const next = newBlocks.findIndex((b) => b.from > pos);
				for (const node of nodes) {
					anchorOf.set(node, next === -1 ? newBlocks.length : next);
				}
			}
		}
		if (olds.length === 0 && news.length > 0) {
			// Lines added to a block that was there (its other lines are
			// unchanged, all from one old block: a line of a paragraph or a
			// fence, a blank line after an item): that block changed, it isn't
			// new, so its words are marked against the old one.
			const was = new Set<number>();
			for (const node of nodes) {
				const b = newBlocks[node - N] as MdBlock;
				for (let n = b.from; n <= b.to; n++) {
					const o = oldAt.get(n);
					if (o !== undefined) was.add(placeOf(o, oldBlocks));
				}
			}
			const from = was.size === 1 ? ([...was][0] as number) : -1;
			if (from >= 0) nodes.add(from);
		}
		if (nodes.size === 0) {
			unplaced.push(u.key);
			continue;
		}
		const list = [...nodes];
		for (const node of list) join(list[0] as number, node);
		nodesOf.set(u.key, list);
	}
	// Components: their blocks and units.
	interface Comp {
		old: number[];
		new: number[];
		units: string[];
	}
	const comps = new Map<number, Comp>();
	const compOf = (root: number) => {
		let c = comps.get(root);
		if (!c) {
			c = { old: [], new: [], units: [] };
			comps.set(root, c);
		}
		return c;
	};
	const touched = new Set<number>();
	for (const list of nodesOf.values()) for (const n of list) touched.add(n);
	for (const node of [...touched].sort((a, b) => a - b)) {
		const c = compOf(find(node));
		if (node < N) c.old.push(node);
		else c.new.push(node - N);
	}
	for (const u of units) {
		const list = nodesOf.get(u.key);
		if (list) compOf(find(list[0] as number)).units.push(u.key);
	}
	// New-side components cover lo..hi of the new blocks; overlapping
	// spans merge into one row.
	const spans: Comp[] = [];
	const removals: { anchor: number; comp: Comp }[] = [];
	for (const c of comps.values()) {
		if (c.new.length === 0) {
			const anchor = Math.min(
				...c.old.map((o) => anchorOf.get(o) ?? newBlocks.length),
			);
			removals.push({ anchor, comp: c });
		} else spans.push(c);
	}
	spans.sort((a, b) => (a.new[0] as number) - (b.new[0] as number));
	const merged: { lo: number; hi: number; comp: Comp }[] = [];
	for (const c of spans) {
		const lo = c.new[0] as number;
		const hi = c.new[c.new.length - 1] as number;
		const last = merged[merged.length - 1];
		if (last && lo <= last.hi) {
			last.hi = Math.max(last.hi, hi);
			last.comp = {
				old: [...last.comp.old, ...c.old].sort((a, b) => a - b),
				new: [],
				units: [...last.comp.units, ...c.units],
			};
		} else merged.push({ lo, hi, comp: c });
	}
	// A removal anchored inside a changed span goes before the span.
	const spanAt = new Map<number, number>();
	for (const m of merged)
		for (let j = m.lo; j <= m.hi; j++) spanAt.set(j, m.lo);
	const before = new Map<number, Comp[]>();
	for (const r of removals.sort(
		(a, b) => (a.comp.old[0] as number) - (b.comp.old[0] as number),
	)) {
		const at = spanAt.get(r.anchor) ?? r.anchor;
		before.set(at, [...(before.get(at) ?? []), r.comp]);
	}
	const order = new Map(units.map((u, i) => [u.key, i]));
	const byOrder = (keys: string[]) =>
		[...keys].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
	const flat: DocRow[] = [];
	const pushRemovals = (at: number) => {
		for (const c of before.get(at) ?? []) {
			flat.push({
				kind: "change",
				tone: "removed",
				oldBlocks: c.old,
				newBlocks: [],
				units: byOrder(c.units),
			});
		}
	};
	const spanFrom = new Map(merged.map((m) => [m.lo, m]));
	for (let j = 0; j < newBlocks.length; ) {
		pushRemovals(j);
		const m = spanFrom.get(j);
		if (m) {
			const newList = Array.from(
				{ length: m.hi - m.lo + 1 },
				(_, i) => m.lo + i,
			);
			flat.push({
				kind: "change",
				tone: m.comp.old.length === 0 ? "added" : "changed",
				oldBlocks: m.comp.old,
				newBlocks: newList,
				units: byOrder(m.comp.units),
			});
			j = m.hi + 1;
		} else {
			flat.push({ kind: "same", block: j });
			j++;
		}
	}
	pushRemovals(newBlocks.length);
	// Anything anchored past the end that no loop reached (never, but safe).
	for (const [at] of before) {
		if (at > newBlocks.length) pushRemovals(at);
	}
	return { rows: fold(flat, sides.new, newBlocks), unplaced };
}

/** Runs of more than FOLD_MIN unchanged blocks fold, one kept by each change. */
function fold(
	rows: DocRow[],
	lines: readonly string[],
	blocks: readonly MdBlock[],
): DocRow[] {
	const out: DocRow[] = [];
	for (let i = 0; i < rows.length; ) {
		if (rows[i]?.kind !== "same") {
			out.push(rows[i] as DocRow);
			i++;
			continue;
		}
		let j = i;
		while (j < rows.length && rows[j]?.kind === "same") j++;
		const run = rows.slice(i, j) as { kind: "same"; block: number }[];
		if (run.length > FOLD_MIN) {
			const keepHead = i > 0 ? 1 : 0;
			const keepTail = j < rows.length ? 1 : 0;
			const head = run.slice(0, keepHead);
			const mid = run.slice(keepHead, run.length - keepTail);
			const tail = run.slice(run.length - keepTail);
			out.push(...head);
			const ids = mid.map((r) => r.block);
			out.push({
				kind: "fold",
				blocks: ids,
				headings: ids
					.map((b) => blocks[b] as MdBlock)
					.filter((b) => b.kind === "heading")
					.map((b) => headingText(lines, b))
					.filter((t) => t !== ""),
			});
			out.push(...tail);
		} else out.push(...run);
		i = j;
	}
	return out;
}

/** A cluster's lines as ranges of line numbers on each side. */
export function clusterLines(c: {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
}): { old: LineRanges; new: LineRanges } {
	return {
		old:
			c.oldCount > 0 ? normalize([[c.oldStart, c.oldStart + c.oldCount]]) : [],
		new:
			c.newCount > 0 ? normalize([[c.newStart, c.newStart + c.newCount]]) : [],
	};
}

/** A unit on a block, for its comment: its lines, and whether it is whitespace only. */
export interface CommentUnit {
	old: LineRanges;
	new: LineRanges;
	ws?: boolean;
}

/**
 * What a block's comment button comments on (the owner, 2026-11-22: "all
 * the changed lines in the last cluster of the block"): the last unit's
 * changed lines, `startLine..line`, on the new side; on the old side when
 * that unit only removes lines. A whitespace-only unit is the last only
 * when the block has no other. `units` are the block's, in source order
 * (a full-diff cluster or a since piece each), numbered as the view
 * numbers its rows; null for a block with none (an unchanged block takes
 * no comment: GitHub takes line comments only inside the diff).
 */
export function blockCommentSpan(
	units: readonly CommentUnit[],
): SpanRange | null {
	const real = units.filter((u) => !u.ws);
	const last = (real.length > 0 ? real : units).at(-1);
	if (!last) return null;
	// From its first changed line to its last: a since piece whose lines
	// on that side are two runs (an unchanged line between, kept by the
	// cut) is one span over that line too, as GitHub takes a range.
	const pick = size(last.new) > 0 ? last.new : last.old;
	const first = pick[0];
	const end = pick.at(-1);
	if (!first || !end) return null;
	const side = pick === last.new ? "RIGHT" : "LEFT";
	return { startSide: side, startLine: first[0], side, line: end[1] - 1 };
}

/**
 * Where a line shows in the document (a thread, a composer, a find's
 * hit): a new block (its row is whatever holds it: unchanged, folded or
 * changed), or a changed row by index (an old block only a change row
 * shows). Every line lands somewhere while the document has a row: a
 * blank line goes with the block before it (`blockOfLine`), an unchanged
 * old line with the new line it is, a line no block holds with the
 * nearest one (principle 2: a thread is never dropped). Null only for a
 * document with no rows.
 */
export type LineAnchor = { block: number } | { row: number };

export function lineAnchor(
	doc: Doc,
	sides: Sides,
	oldBlocks: readonly MdBlock[],
	newBlocks: readonly MdBlock[],
	side: "LEFT" | "RIGHT",
	line: number,
): LineAnchor | null {
	if (doc.rows.length === 0) return null;
	const onNew = (n: number): LineAnchor | null =>
		newBlocks.length === 0 ? null : { block: blockOfLine(newBlocks, n) };
	const first = (): LineAnchor => {
		const row = doc.rows[0] as DocRow;
		return row.kind === "same"
			? { block: row.block }
			: row.kind === "fold"
				? { block: row.blocks[0] as number }
				: { row: 0 };
	};
	if (side === "RIGHT") return onNew(line) ?? first();
	const same = sides.same.get(line);
	if (same !== undefined) return onNew(same) ?? first();
	if (oldBlocks.length > 0) {
		const b = blockOfLine(oldBlocks, line);
		const row = doc.rows.findIndex(
			(r) => r.kind === "change" && r.oldBlocks.includes(b),
		);
		if (row >= 0) return { row };
		// An old block no change row shows (its line taken out between
		// blocks): with the new line its first unchanged line became.
		const block = oldBlocks[b] as MdBlock;
		for (let o = block.from; o <= block.to; o++) {
			const n = sides.same.get(o);
			if (n !== undefined) return onNew(n) ?? first();
		}
	}
	// Nothing on the old side says where: the unchanged line before it.
	let before: number | undefined;
	for (const [o, n] of sides.same) {
		if (o < line && (before === undefined || n > before)) before = n;
	}
	return (before === undefined ? null : onNew(before)) ?? first();
}
