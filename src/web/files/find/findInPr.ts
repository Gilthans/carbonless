import type {
	DiffLine,
	DiffSide,
	FileHunks,
	FileView,
} from "../../../shared/types";
import { hunkView } from "../whitespace";

/** Where a hit is: a path, an old path, or a line on one side. */
export type HitSide = "path" | "oldPath" | DiffSide;

/** A hit's place: file index, side, line number (0 for a path), UTF-16 column. */
export interface HitPos {
	index: number;
	side: HitSide;
	line: number;
	col: number;
}

export interface Hit extends HitPos {
	/** Matched length in UTF-16 units (the term's, in the original string). */
	len: number;
	/**
	 * On the old side of a whitespace-only pair (Ignore whitespace on): the
	 * pair's new line number. Unified shows the pair as one `~` row with the
	 * new text only, so the hit isn't shown there (shownHits).
	 */
	twin?: number;
}

/**
 * Every occurrence of `term` in `text`, non-overlapping, left to right;
 * case-insensitive unless `matchCase` (a case-insensitive regex over the
 * original string: columns are the original's, never a folded copy's).
 * None for an empty term.
 */
export function occurrences(
	text: string,
	term: string,
	matchCase: boolean,
): { col: number; len: number }[] {
	const re = pattern(term, matchCase);
	const found: { col: number; len: number }[] = [];
	if (!re) return found;
	re.lastIndex = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		found.push({ col: m.index, len: m[0].length });
		re.lastIndex = m.index + m[0].length;
	}
	return found;
}

/** occurrences' pattern: built once per search, not once per line. Null for an empty term. */
function pattern(term: string, matchCase: boolean): RegExp | null {
	if (!term) return null;
	return new RegExp(
		term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		matchCase ? "g" : "gi",
	);
}

/** One searchable line of a file: its side, number and raw text. */
export interface SourceLine {
	side: DiffSide;
	line: number;
	text: string;
	/**
	 * With `pairs` (fileLines), a hunk's line: the hunk's lines and the line
	 * itself, so findInPr can put the hunk's hits in row order (pairedHunk).
	 */
	hunk?: DiffLine[];
	source?: DiffLine;
}

/** A hunk as the unified view renders it, Ignore whitespace on or off (pairedHunk). */
export interface PairedHunk {
	/**
	 * The hunk's lines in the order of the rows shown (hunkView): a
	 * two-sided `~` row's removed line right before its added line, at the
	 * row's place.
	 */
	order: DiffLine[];
	/** A two-sided `~` row's removed line → its added line's number. */
	twins: ReadonlyMap<DiffLine, number>;
}

/**
 * A hunk's rows as the view renders them (hunkView, what HunkRows shows,
 * whose O(n·m) matching is cached per hunk and shared with it), as Find
 * needs them. Kept per hunk: a search per keystroke never pairs it again.
 */
const pairedByHunk = [
	new WeakMap<DiffLine[], PairedHunk>(),
	new WeakMap<DiffLine[], PairedHunk>(),
];
function pairedHunk(lines: DiffLine[], ignoreWhitespace: boolean): PairedHunk {
	const cache = pairedByHunk[ignoreWhitespace ? 1 : 0] as WeakMap<
		DiffLine[],
		PairedHunk
	>;
	let paired = cache.get(lines);
	if (!paired) {
		const order: DiffLine[] = [];
		const twins = new Map<DiffLine, number>();
		for (const run of hunkView(lines, ignoreWhitespace).runs)
			for (const row of run.rows) {
				if (row.kind === "line") order.push(row.line);
				else if (row.del && row.add) {
					order.push(row.del, row.add);
					twins.set(row.del, row.add.newNo as number);
				} else order.push((row.del ?? row.add) as DiffLine);
			}
		paired = { order, twins };
		cache.set(lines, paired);
	}
	return paired;
}

/**
 * A file's lines in the order the diff shows them. Without hunks: none
 * when `clusters` is false (the since view: its lines are only its
 * hunks'), else each cluster's removed lines (LEFT, oldStart + i) then added lines (RIGHT,
 * newStart + i), clusters in file order (a "file" cluster has none).
 * With hunks: for each hunk, first the expanded `context` lines whose newNo
 * lies before it and after the previous hunk (sorted by newNo, first of a
 * duplicate newNo wins, one inside a hunk's new range ignored), then the
 * hunk's lines (del → LEFT:oldNo, add and context → RIGHT:newNo); then the
 * expanded lines after the last hunk. With `pairs` (and hunks), a hunk's
 * line carries its hunk and itself (SourceLine.hunk, .source).
 */
export function fileLines(
	file: FileView,
	hunks: FileHunks | undefined,
	context: readonly DiffLine[],
	pairs = false,
	clusters = true,
): SourceLine[] {
	if (!hunks) {
		if (!clusters) return [];
		return file.clusters.flatMap((c) => [
			...c.removed.map((text, i) => ({
				side: "LEFT" as const,
				line: c.oldStart + i,
				text,
			})),
			...c.added.map((text, i) => ({
				side: "RIGHT" as const,
				line: c.newStart + i,
				text,
			})),
		]);
	}
	const gaps: SourceLine[][] = hunks.hunks.map(() => []);
	const after: SourceLine[] = [];
	const seen = new Set<number>();
	const sorted = context
		.filter((l) => l.newNo !== undefined)
		.sort((a, b) => (a.newNo as number) - (b.newNo as number));
	for (const l of sorted) {
		const no = l.newNo as number;
		if (seen.has(no)) continue;
		seen.add(no);
		if (
			hunks.hunks.some((h) => no >= h.newStart && no < h.newStart + h.newCount)
		)
			continue;
		const next = hunks.hunks.findIndex((h) => h.newStart > no);
		(next < 0 ? after : (gaps[next] as SourceLine[])).push({
			side: "RIGHT",
			line: no,
			text: l.text,
		});
	}
	const lines: SourceLine[] = [];
	hunks.hunks.forEach((h, i) => {
		lines.push(...(gaps[i] as SourceLine[]));
		for (const l of h.lines) {
			const at: SourceLine =
				l.kind === "del"
					? { side: "LEFT", line: l.oldNo as number, text: l.text }
					: { side: "RIGHT", line: l.newNo as number, text: l.text };
			if (pairs) {
				at.hunk = h.lines;
				at.source = l;
			}
			lines.push(at);
		}
	});
	return [...lines, ...after];
}

/**
 * The PR's hits in reading order: for each file (in the order given: the
 * tree's), its path's hits, then its old path's, then its lines' (fileLines)
 * in column order. Binary files and submodules have path hits only. Every
 * line of both sides is searched. With `pairs` (the view is unified: a pair reads together, and with
 * Ignore whitespace on a whitespace-only pair is one row), a whitespace-only
 * pair's old-side hits carry `twin` (shownHits leaves them out), and a
 * hunk's hits are in the order of the rows shown (a `~` row's where it sits
 * on screen; its removed line's hidden hits right before its added
 * line's). A hunk is paired (O(n·m), cached) only once one of its removed
 * lines has a hit: without one, the row order of its hits is the hunk's
 * own (pairRun keeps the added lines in order, and context runs in place).
 */
export function findInPr(
	term: string,
	files: readonly FileView[],
	hunksOf: (file: FileView) => FileHunks | undefined,
	contextOf: (file: FileView) => readonly DiffLine[],
	matchCase: boolean,
	pairs: boolean,
	/** A file without hunks yet is searched in its clusters (fileLines). */
	clusters: boolean,
	/**
	 * The view's Ignore whitespace: its `~` rows (twins) exist only with it
	 * on, and the rows (hunkView) differ with it, on or off.
	 */
	ignoreWhitespace: boolean,
): Hit[] {
	const hits: Hit[] = [];
	const re = pattern(term, matchCase);
	if (!re) return hits;
	for (const file of files) {
		const index = file.index;
		// occurrences' loop, inline: no array or closure per line.
		const push = (
			side: HitSide,
			line: number,
			text: string,
			into: Hit[] = hits,
		) => {
			re.lastIndex = 0;
			for (let m = re.exec(text); m; m = re.exec(text)) {
				const len = m[0].length;
				into.push({ index, side, line, col: m.index, len });
				re.lastIndex = m.index + len;
			}
		};
		push("path", 0, file.path);
		if (file.oldPath) push("oldPath", 0, file.oldPath);
		if (file.binary || file.submodule) continue;
		// With `pairs`, a hunk's hits wait for its end: each line's, and
		// whether a removed line has any (then the hunk is paired).
		let hunk: DiffLine[] | undefined;
		let byLine: Map<DiffLine, Hit[]> | null = null;
		let seen: DiffLine[] = [];
		let delHit = false;
		const flush = () => {
			if (!byLine || !hunk) return;
			emitHunk(
				hits,
				seen,
				byLine,
				delHit ? pairedHunk(hunk, ignoreWhitespace) : null,
			);
			byLine = null;
		};
		for (const l of fileLines(
			file,
			hunksOf(file),
			contextOf(file),
			pairs,
			clusters,
		)) {
			if (l.hunk !== hunk) {
				flush();
				hunk = l.hunk;
				if (hunk) {
					byLine = new Map();
					seen = [];
					delHit = false;
				}
			}
			if (!hunk || !byLine || !l.source) {
				push(l.side, l.line, l.text);
				continue;
			}
			const found: Hit[] = [];
			push(l.side, l.line, l.text, found);
			if (found.length === 0) continue;
			byLine.set(l.source, found);
			seen.push(l.source);
			if (l.source.kind === "del") delHit = true;
		}
		flush();
	}
	return hits;
}

/**
 * A held hunk's hits into `out`: in its rows' order (`paired`), else in
 * hunk order (`seen`, the lines with hits). Then, so a hit is never lost
 * should the rows ever miss a line, every line's hits not yet emitted, in
 * hunk order. Empties `byLine`.
 */
export function emitHunk(
	out: Hit[],
	seen: readonly DiffLine[],
	byLine: Map<DiffLine, Hit[]>,
	paired: PairedHunk | null,
): void {
	const emit = (l: DiffLine) => {
		const found = byLine.get(l);
		if (!found) return;
		byLine.delete(l);
		const twin = paired?.twins.get(l);
		for (const h of found) {
			if (twin !== undefined) h.twin = twin;
			out.push(h);
		}
	};
	if (paired) for (const l of paired.order) emit(l);
	for (const l of seen) emit(l);
}

/**
 * The hits the view shows, the ones "n of N" counts and steps through:
 * side by side, all of them (both texts of a pair show); unified, all but
 * a whitespace-only pair's old side (its `~` row shows the new text only,
 * owner 2026-11-10: count the pair once). The same array when none is
 * left out.
 */
export function shownHits(all: readonly Hit[], unified: boolean): Hit[] {
	if (!unified || !all.some((h) => h.twin !== undefined)) return all as Hit[];
	return all.filter((h) => h.twin === undefined);
}

/**
 * Where a caret goes when its hit stops being shown (the view or Ignore
 * whitespace changed): a pair's old-side hit → the same row's shown hit of
 * the same occurrence order, else the row's first; else the first shown
 * hit after it in `all` (wrapping). Null when `pos` isn't in `all` either
 * (a hit that is gone, not hidden).
 */
export function hiddenHitMoved(
	all: readonly Hit[],
	shown: readonly Hit[],
	pos: HitPos,
): { pos: HitPos; sameRow: boolean } | null {
	const at = hitIndex(all, pos);
	if (at < 0 || shown.length === 0) return null;
	const hit = all[at] as Hit;
	if (hit.twin !== undefined) {
		const twin = hit.twin;
		const nth = all
			.filter(
				(h) =>
					h.index === hit.index && h.side === hit.side && h.line === hit.line,
			)
			.indexOf(hit);
		const row = shown.filter(
			(h) => h.index === hit.index && h.side === "RIGHT" && h.line === twin,
		);
		const same = row[nth] ?? row[0];
		if (same) return { pos: posOf(same), sameRow: true };
	}
	const key = (h: HitPos) => `${h.index}:${h.side}:${h.line}:${h.col}`;
	const isShown = new Set(shown.map(key));
	for (let i = 1; i <= all.length; i++) {
		const next = all[(at + i) % all.length] as Hit;
		if (isShown.has(key(next))) return { pos: posOf(next), sameRow: false };
	}
	return null;
}

/**
 * The stepped caret as the hits now stand: kept while its hit is shown,
 * moved (hiddenHitMoved) when only hidden; null when its hit is gone. A
 * move on the same row keeps whether it was shown (the reviewer is looking
 * at that row); a move elsewhere is unshown, so the next step goes to it
 * rather than past it, and it pins nothing open.
 */
export function keptCaret(
	all: readonly Hit[],
	shown: readonly Hit[],
	caret: Caret,
): Caret | null {
	return caretMove(all, shown, caret)?.caret ?? null;
}

/**
 * keptCaret, and whether the move sticks (owner, 2026-11-10: you stay on
 * the line you were looking at): only a move onto the same row does; a
 * move off it (a term whose whitespace differs between the sides) doesn't,
 * so the pair's old side is current again once it shows.
 */
export function caretMove(
	all: readonly Hit[],
	shown: readonly Hit[],
	caret: Caret,
): { caret: Caret; sticks: boolean } | null {
	if (hitIndex(shown, caret.pos) >= 0) return { caret, sticks: false };
	const moved = hiddenHitMoved(all, shown, caret.pos);
	if (!moved) return null;
	return {
		caret: { pos: moved.pos, shown: moved.sameRow && caret.shown },
		sticks: moved.sameRow,
	};
}

export const samePos = (a: HitPos, b: HitPos): boolean =>
	a.index === b.index &&
	a.side === b.side &&
	a.line === b.line &&
	a.col === b.col;

/** The hit's place in `hits`, -1 when it isn't one. */
export function hitIndex(hits: readonly Hit[], pos: HitPos): number {
	return hits.findIndex((h) => samePos(h, pos));
}

/** Hits per file index (files with none are absent). */
export function countsByFile(
	hits: readonly Hit[],
): ReadonlyMap<number, number> {
	const counts = new Map<number, number>();
	for (const h of hits) counts.set(h.index, (counts.get(h.index) ?? 0) + 1);
	return counts;
}

/** The current hit and whether a step has shown it (scrolled to it). */
export interface Caret {
	pos: HitPos;
	shown: boolean;
}

const posOf = (h: Hit): HitPos => ({
	index: h.index,
	side: h.side,
	line: h.line,
	col: h.col,
});

/**
 * The caret after the term changes: the first hit in file `openIndex`, else
 * the first hit in a file after it in `order` (file indexes in tree order),
 * wrapping, else the PR's first hit; unshown. Null without hits.
 */
export function caretAfterTyping(
	hits: readonly Hit[],
	order: readonly number[],
	openIndex: number | null,
): Caret | null {
	const first = hits[0];
	if (!first) return null;
	// Each file's first hit, in one pass.
	const firstOf = new Map<number, Hit>();
	for (const h of hits) if (!firstOf.has(h.index)) firstOf.set(h.index, h);
	const start = openIndex === null ? 0 : Math.max(order.indexOf(openIndex), 0);
	for (let i = 0; i < order.length; i++) {
		const hit = firstOf.get(order[(start + i) % order.length] as number);
		if (hit) return { pos: posOf(hit), shown: false };
	}
	return { pos: posOf(first), shown: false };
}

/**
 * A step: an unshown caret becomes shown where it is, unless the reviewer
 * already sees its hit (`seen`); a shown (or seen) one moves to the next
 * (`1`) or previous (`-1`) hit, wrapping at both ends. Null without hits.
 */
export function stepCaret(
	hits: readonly Hit[],
	caret: Caret | null,
	dir: 1 | -1,
	seen = false,
): Caret | null {
	if (!caret || hits.length === 0) return null;
	if (!caret.shown && !seen) return { pos: caret.pos, shown: true };
	const at = hitIndex(hits, caret.pos);
	const next =
		at < 0
			? dir === 1
				? 0
				: hits.length - 1
			: (at + dir + hits.length) % hits.length;
	return { pos: posOf(hits[next] as Hit), shown: true };
}
