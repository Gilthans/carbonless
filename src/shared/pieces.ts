import {
	all,
	contains,
	covers,
	fromIndexes,
	type LineRanges,
	normalize,
	size,
	subtract,
	union,
	within,
} from "./lineRanges.js";
import type {
	Cluster,
	ClusterState,
	ClusterView,
	DiffLine,
	SinceMark,
	StateChange,
} from "./types.js";

/**
 * Marks on part of a cluster. The since view can show one cluster of the
 * viewed snapshot as several pieces (runs of its lines with carried lines
 * between them as context); each piece is reviewed on its own, as a
 * cluster is in an ordinary review, and stores a mark on its own lines
 * (`lines-reviewed`, docs/review-data-storage.md). The full diff shows a
 * partly reviewed cluster as mixed. Lines are indexed as in lineRanges.ts.
 */

/** The index of `line` among the cluster's lines in its own diff (the full diff), if it is one. */
export function lineIndex(
	cluster: Pick<
		Cluster,
		"kind" | "oldStart" | "newStart" | "removed" | "added"
	>,
	line: Pick<DiffLine, "kind" | "oldNo" | "newNo">,
): number | undefined {
	if (cluster.kind !== "lines") return undefined;
	const removed = cluster.removed.length;
	if (line.kind === "del" && line.oldNo !== undefined) {
		const i = line.oldNo - cluster.oldStart;
		return i >= 0 && i < removed ? i : undefined;
	}
	if (line.kind === "add" && line.newNo !== undefined) {
		const i = line.newNo - cluster.newStart;
		return i >= 0 && i < cluster.added.length ? removed + i : undefined;
	}
	return undefined;
}

/** What the engine knows of a cluster's lines beyond the since view's hunks. */
export interface PieceFacts {
	/**
	 * The cluster's line `index` is unchanged since a line the reviewer
	 * reviewed on the compared patch set (an added line the same as one a
	 * reviewed cluster added there; a removed base line a reviewed cluster
	 * removed there too). Only such a line no piece shows may join a piece.
	 */
	vouched?: (index: number) => boolean;
	/** A shown removed line may be one of the cluster's removed lines (a base line, not one the compared patch set added). */
	baseLine?: (line: DiffLine) => boolean;
}

/**
 * Which of the cluster's lines each piece owns, given the lines each one
 * shows (`pieces`, in file order; the since view's runs keyed to the
 * cluster). A shown added line is the cluster's line at its new number; a
 * shown removed line that is a base line is a removed line of the cluster
 * with its text (at its own number when that one matches, else the first
 * unclaimed one). A line no piece shows is unchanged since the compared
 * patch set: it joins a piece only when `vouched` (unchanged since a line
 * the reviewer reviewed there), an added one the piece shown before it
 * (the first for those before any), a removed one the first piece; any
 * other stays with no piece, so ticking every piece can't review it
 * (principle 2: it is only for the full diff). A piece that shows none of
 * the cluster's lines owns nothing (null).
 */
export function pieceRanges(
	cluster: Cluster,
	pieces: readonly (readonly DiffLine[])[],
	facts: PieceFacts = {},
): (LineRanges | null)[] {
	if (cluster.kind !== "lines" || cluster.lines === 0) {
		return pieces.map(() => null);
	}
	const vouched = facts.vouched ?? (() => false);
	const baseLine = facts.baseLine ?? (() => true);
	const owner = new Array<number | undefined>(cluster.lines).fill(undefined);
	const removed = cluster.removed;
	const owned = (i: number) => owner[i] !== undefined;
	pieces.forEach((lines, p) => {
		for (const line of lines) {
			let i: number | undefined;
			if (line.kind === "add") i = lineIndex(cluster, line);
			else if (line.kind === "del" && baseLine(line)) {
				const at = lineIndex(cluster, line);
				if (at !== undefined && removed[at] === line.text && !owned(at)) {
					i = at;
				} else {
					const found = removed.findIndex(
						(text, j) => text === line.text && !owned(j),
					);
					i = found >= 0 ? found : undefined;
				}
			}
			if (i !== undefined && owner[i] === undefined) owner[i] = p;
		}
	});
	const shown = new Set(owner.filter((p) => p !== undefined));
	if (shown.size === 0) return pieces.map(() => null);
	const first = Math.min(...shown);
	const indexes = pieces.map((): number[] => []);
	let current = first;
	for (let i = 0; i < owner.length; i++) {
		const p = owner[i];
		if (i >= removed.length && p !== undefined) current = p;
		if (p !== undefined) indexes[p]?.push(i);
		else if (vouched(i)) {
			indexes[i < removed.length ? first : current]?.push(i);
		}
	}
	return indexes.map((list, p) => (shown.has(p) ? fromIndexes(list) : null));
}

/** The cluster's marks by line: reviewed and crossed off (all of a whole mark). */
export function marksOf(cluster: ClusterView): {
	reviewed: LineRanges;
	crossed: LineRanges;
} {
	const n = cluster.lines;
	const crossed = normalize(cluster.crossedLines ?? []);
	if (cluster.state === "crossed-off") return { reviewed: [], crossed: all(n) };
	if (cluster.state === "reviewed") {
		return { reviewed: subtract(all(n), crossed), crossed };
	}
	return { reviewed: normalize(cluster.reviewedLines ?? []), crossed };
}

/** The cluster's reviewed lines. */
export const reviewedLines = (cluster: ClusterView): LineRanges =>
	marksOf(cluster).reviewed;

/** How many of the cluster's lines are reviewed (all, some, or none). */
export const reviewedCount = (cluster: ClusterView): number =>
	size(reviewedLines(cluster));

/** How many of the cluster's lines are crossed off. */
export const crossedCount = (cluster: ClusterView): number =>
	size(marksOf(cluster).crossed);

/** Marked one piece at a time and not finished: the full diff's mixed box. */
export const partlyMarked = (cluster: ClusterView): boolean =>
	cluster.state === "unreviewed" &&
	((cluster.reviewedLines?.length ?? 0) > 0 ||
		(cluster.crossedLines?.length ?? 0) > 0);

/** A piece's state: reviewed or crossed off when every line it owns is, else unreviewed. */
export function pieceState(
	cluster: ClusterView,
	piece: LineRanges,
): ClusterState {
	const { reviewed, crossed } = marksOf(cluster);
	if (contains(reviewed, piece)) return "reviewed";
	if (contains(crossed, piece)) return "crossed-off";
	return "unreviewed";
}

/**
 * The change that leaves the cluster with exactly these lines reviewed
 * and crossed off: a whole mark when one covers every line (or none is
 * marked), else unreviewed with its lines.
 */
export function changeFor(
	cluster: Cluster,
	reviewed: LineRanges,
	crossed: LineRanges = [],
): StateChange {
	const r = normalize(reviewed);
	const c = subtract(normalize(crossed), r);
	const key = cluster.key;
	if (covers(r, cluster.lines)) return { key, state: "reviewed" };
	if (covers(c, cluster.lines)) return { key, state: "crossed-off" };
	if (r.length === 0 && c.length === 0) return { key, state: "unreviewed" };
	return {
		key,
		state: "unreviewed",
		...(r.length > 0 ? { reviewedLines: r } : {}),
		...(c.length > 0 ? { crossedLines: c } : {}),
	};
}

/**
 * The checkbox's change: the whole cluster without a piece (reviewed from
 * unreviewed or mixed, unreviewed from reviewed, a crossed-off one undone
 * to unreviewed); with one, that piece's lines alone (reviewed from
 * unreviewed, unreviewed from reviewed or crossed off), the rest as they are.
 */
export function toggleChange(
	cluster: ClusterView,
	piece?: LineRanges,
): StateChange {
	if (!piece) {
		return {
			key: cluster.key,
			state: cluster.state === "unreviewed" ? "reviewed" : "unreviewed",
		};
	}
	const { reviewed, crossed } = marksOf(cluster);
	return pieceState(cluster, piece) === "unreviewed"
		? changeFor(cluster, union(reviewed, piece), subtract(crossed, piece))
		: changeFor(cluster, subtract(reviewed, piece), subtract(crossed, piece));
}

/**
 * The cross-off toggle's change: the whole cluster without a piece; with
 * one, its lines crossed off, or back to unreviewed when they are.
 */
export function crossOffChange(
	cluster: ClusterView,
	piece?: LineRanges,
): StateChange {
	if (!piece) {
		return {
			key: cluster.key,
			state: cluster.state === "crossed-off" ? "unreviewed" : "crossed-off",
		};
	}
	const { reviewed, crossed } = marksOf(cluster);
	return pieceState(cluster, piece) === "crossed-off"
		? changeFor(cluster, reviewed, subtract(crossed, piece))
		: changeFor(cluster, subtract(reviewed, piece), union(crossed, piece));
}

/**
 * A stored or requested partial mark as the cluster can take it: null
 * when any range lies past its lines, or it has none (a file-level
 * cluster): such a mark covers nothing (principle 2: fail closed).
 */
export function fitRanges(
	cluster: Pick<Cluster, "kind" | "lines">,
	ranges: LineRanges,
): LineRanges | null {
	if (cluster.kind !== "lines" || !within(ranges, cluster.lines)) return null;
	return normalize(ranges);
}

/**
 * A hunk's lines in runs: context runs, and runs of changed lines with one
 * cluster key (or none). A changed run is never merged into context, so
 * an unkeyed removal shows, and is marked, as a piece of its own.
 */
export function lineRuns(
	lines: readonly DiffLine[],
): { key?: string; change: boolean; lines: DiffLine[] }[] {
	const out: { key?: string; change: boolean; lines: DiffLine[] }[] = [];
	for (const line of lines) {
		const change = line.kind !== "context";
		const key = change ? line.clusterKey : undefined;
		const last = out.at(-1);
		if (last && last.change === change && last.key === key) {
			last.lines.push(line);
		} else {
			out.push({
				...(key === undefined ? {} : { key }),
				change,
				lines: [line],
			});
		}
	}
	return out;
}

/**
 * The line cluster of the viewed snapshot at a place between its new lines
 * `p` and `p + 1` (where the since view shows a removal): one whose added
 * lines include `p + 1`, else `p`, else a pure deletion sitting after `p`.
 */
export function clusterAt(
	clusters: readonly Cluster[],
	p: number,
): Cluster | undefined {
	const lines = clusters.filter((c) => c.kind === "lines");
	const holds = (n: number) =>
		lines.find(
			(c) => c.newCount > 0 && c.newStart <= n && n < c.newStart + c.newCount,
		);
	return (
		holds(p + 1) ??
		holds(p) ??
		lines.find((c) => c.newCount === 0 && c.newStart === p)
	);
}

/**
 * One piece of the since view: a run of changed lines (`hunk`, `line`: its
 * first line). Of a cluster of the viewed snapshot (`key`), it owns `owns`
 * of its lines (pieceRanges) and is marked as part of it. One that owns
 * none of them (`owns` null: lines the compared patch set had that are
 * gone, or restored base lines) is marked on its own lines, `old` and
 * `new` (line numbers, half-open ranges, the since view's sides), and is
 * `reverted` when the viewed snapshot's diff doesn't touch its place (back
 * to the base's content), else `removed`. A cluster's own piece that shows
 * only removals is `removed` too.
 */
export interface SincePiece {
	hunk: number;
	line: number;
	key?: string;
	owns: LineRanges | null;
	old: LineRanges;
	new: LineRanges;
	kind?: "reverted" | "removed";
}

/** The since view's pieces of a file, from its hunks and the viewed snapshot's clusters. */
export function sincePieces(
	hunks: readonly { newStart: number; lines: readonly DiffLine[] }[],
	clusters: readonly Cluster[],
	facts: (cluster: Cluster) => PieceFacts = () => ({}),
): SincePiece[] {
	const byKey = new Map(clusters.map((c) => [c.key, c]));
	const out: SincePiece[] = [];
	const ofKey = new Map<string, { piece: SincePiece; lines: DiffLine[] }[]>();
	hunks.forEach((hunk, h) => {
		let at = 0;
		let before = hunk.newStart - 1;
		for (const run of lineRuns(hunk.lines)) {
			const first = run.lines[0];
			if (run.change && first) {
				const piece: SincePiece = {
					hunk: h,
					line: at,
					...(run.key === undefined ? {} : { key: run.key }),
					owns: null,
					old: fromIndexes(
						run.lines.flatMap((l) =>
							l.kind === "del" && l.oldNo ? [l.oldNo] : [],
						),
					),
					new: fromIndexes(
						run.lines.flatMap((l) =>
							l.kind === "add" && l.newNo ? [l.newNo] : [],
						),
					),
				};
				out.push(piece);
				if (run.key !== undefined && byKey.has(run.key)) {
					const list = ofKey.get(run.key) ?? [];
					list.push({ piece, lines: run.lines });
					ofKey.set(run.key, list);
				}
				const firstAdd = run.lines.find((l) => l.newNo !== undefined)?.newNo;
				const place = firstAdd !== undefined ? firstAdd - 1 : before;
				piece.kind =
					(run.key !== undefined && byKey.has(run.key)) ||
					clusterAt(clusters, place)
						? "removed"
						: "reverted";
			}
			for (const l of run.lines) if (l.newNo !== undefined) before = l.newNo;
			at += run.lines.length;
		}
	});
	for (const [key, list] of ofKey) {
		const cluster = byKey.get(key) as Cluster;
		const ranges = pieceRanges(
			cluster,
			list.map((x) => x.lines),
			facts(cluster),
		);
		list.forEach((x, i) => {
			x.piece.owns = ranges[i] ?? null;
		});
	}
	// A cluster's own piece is chipped only when it shows nothing but
	// removals (the author took lines out there): "removed".
	for (const piece of out) {
		if (!piece.owns) continue;
		if (piece.new.length === 0) piece.kind = "removed";
		else delete piece.kind;
	}
	return out;
}

/** The key a since mark's change goes by (never a cluster key: those are hex). */
export const sinceMarkKey = (since: number, path: string) =>
	`since:${since}:${path}`;

type Sides = { old: LineRanges; new: LineRanges };
const NONE: Sides = { old: [], new: [] };
const holds = (sides: Sides, piece: Sides) =>
	contains(sides.old, piece.old) && contains(sides.new, piece.new);
const plus = (a: Sides, b: Sides): Sides => ({
	old: union(a.old, b.old),
	new: union(a.new, b.new),
});
const minus = (a: Sides, b: Sides): Sides => ({
	old: subtract(a.old, b.old),
	new: subtract(a.new, b.new),
});

/** The comparison's mark on file `path`, if any. */
const markOf = (
	marks: readonly SinceMark[] | undefined,
	since: number,
	path: string,
) => marks?.find((m) => m.since === since && m.path === path);

/** A since-only piece's state: reviewed or crossed off when the mark holds all its lines. */
export function sinceOnlyState(
	marks: readonly SinceMark[] | undefined,
	since: number,
	path: string,
	piece: Sides,
): ClusterState {
	const mark = markOf(marks, since, path);
	if (!mark) return "unreviewed";
	if (holds(mark.reviewed, piece)) return "reviewed";
	if (holds(mark.crossed, piece)) return "crossed-off";
	return "unreviewed";
}

/**
 * The change that ticks a since-only piece (`cross`: crosses it off), or
 * undoes its mark: the file's whole mark with the piece's lines moved.
 */
export function sinceToggleChange(
	marks: readonly SinceMark[] | undefined,
	since: number,
	path: string,
	piece: Sides,
	cross = false,
): StateChange {
	const mark = markOf(marks, since, path);
	const reviewed = mark?.reviewed ?? NONE;
	const crossed = mark?.crossed ?? NONE;
	const now = sinceOnlyState(marks, since, path, piece);
	const target: ClusterState = cross
		? now === "crossed-off"
			? "unreviewed"
			: "crossed-off"
		: now === "unreviewed"
			? "reviewed"
			: "unreviewed";
	const next: SinceMark = {
		since,
		path,
		reviewed:
			target === "reviewed" ? plus(reviewed, piece) : minus(reviewed, piece),
		crossed:
			target === "crossed-off" ? plus(crossed, piece) : minus(crossed, piece),
	};
	return { key: sinceMarkKey(since, path), state: target, sinceMark: next };
}

/**
 * A cluster marked one piece at a time, as the views show it: reviewed or
 * crossed off when one mark covers every line, reviewed with its crossed
 * lines when every line is marked (done with lines reviewed: counted as
 * reviewed, as a file is), else unreviewed with its marked lines; null
 * when a range lies past its lines (the marks cover nothing: fail closed).
 * A line marked both ways counts reviewed.
 */
export function viewOfLines(
	cluster: Cluster,
	reviewedRanges: LineRanges,
	crossedRanges: LineRanges,
): ClusterView | null {
	const reviewed = fitRanges(cluster, reviewedRanges);
	const crossed = fitRanges(cluster, crossedRanges);
	if (!reviewed || !crossed) return null;
	const x = subtract(crossed, reviewed);
	const done = covers(union(reviewed, x), cluster.lines);
	if (done && x.length === 0) return { ...cluster, state: "reviewed" };
	if (done && reviewed.length === 0)
		return { ...cluster, state: "crossed-off" };
	if (done) return { ...cluster, state: "reviewed", crossedLines: x };
	return {
		...cluster,
		state: "unreviewed",
		...(reviewed.length > 0 ? { reviewedLines: reviewed } : {}),
		...(x.length > 0 ? { crossedLines: x } : {}),
	};
}
