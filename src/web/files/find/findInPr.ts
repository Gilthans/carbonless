import type {
	DiffLine,
	DiffSide,
	FileHunks,
	FileView,
} from "../../../shared/types";

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
	if (!term) return [];
	const re = new RegExp(
		term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		matchCase ? "g" : "gi",
	);
	const found: { col: number; len: number }[] = [];
	for (let m = re.exec(text); m; m = re.exec(text)) {
		found.push({ col: m.index, len: m[0].length });
		re.lastIndex = m.index + m[0].length;
	}
	return found;
}

/** One searchable line of a file: its side, number and raw text. */
export interface SourceLine {
	side: DiffSide;
	line: number;
	text: string;
}

/**
 * A file's lines in the order the diff shows them. Without hunks: each
 * cluster's removed lines (LEFT, oldStart + i) then added lines (RIGHT,
 * newStart + i), clusters in file order (a "file" cluster has none).
 * With hunks: for each hunk, first the expanded `context` lines whose newNo
 * lies before it and after the previous hunk (sorted by newNo, first of a
 * duplicate newNo wins, one inside a hunk's new range ignored), then the
 * hunk's lines (del → LEFT:oldNo, add and context → RIGHT:newNo); then the
 * expanded lines after the last hunk.
 */
export function fileLines(
	file: FileView,
	hunks: FileHunks | undefined,
	context: readonly DiffLine[],
): SourceLine[] {
	if (!hunks) {
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
			if (l.kind === "del")
				lines.push({ side: "LEFT", line: l.oldNo as number, text: l.text });
			else lines.push({ side: "RIGHT", line: l.newNo as number, text: l.text });
		}
	});
	return [...lines, ...after];
}

/**
 * The PR's hits in reading order: for each file (in the order given: the
 * tree's), its path's hits, then its old path's, then its lines' (fileLines)
 * in column order. Binary files and submodules have path hits only.
 */
export function findInPr(
	term: string,
	files: readonly FileView[],
	hunksOf: (file: FileView) => FileHunks | undefined,
	contextOf: (file: FileView) => readonly DiffLine[],
	matchCase: boolean,
): Hit[] {
	const hits: Hit[] = [];
	for (const file of files) {
		const index = file.index;
		const push = (side: HitSide, line: number, text: string) => {
			for (const o of occurrences(text, term, matchCase))
				hits.push({ index, side, line, ...o });
		};
		push("path", 0, file.path);
		if (file.oldPath) push("oldPath", 0, file.oldPath);
		if (file.binary || file.submodule) continue;
		for (const l of fileLines(file, hunksOf(file), contextOf(file)))
			push(l.side, l.line, l.text);
	}
	return hits;
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
	const start = openIndex === null ? 0 : Math.max(order.indexOf(openIndex), 0);
	for (let i = 0; i < order.length; i++) {
		const index = order[(start + i) % order.length];
		const hit = hits.find((h) => h.index === index);
		if (hit) return { pos: posOf(hit), shown: false };
	}
	return { pos: posOf(first), shown: false };
}

/**
 * A step: an unshown caret becomes shown where it is; a shown one moves
 * to the next (`1`) or previous (`-1`) hit, wrapping at both ends. Null
 * without hits.
 */
export function stepCaret(
	hits: readonly Hit[],
	caret: Caret | null,
	dir: 1 | -1,
): Caret | null {
	if (!caret || hits.length === 0) return null;
	if (!caret.shown) return { pos: caret.pos, shown: true };
	const at = hitIndex(hits, caret.pos);
	const next =
		at < 0
			? dir === 1
				? 0
				: hits.length - 1
			: (at + dir + hits.length) % hits.length;
	return { pos: posOf(hits[next] as Hit), shown: true };
}
