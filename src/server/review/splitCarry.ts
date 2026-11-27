import {
	type LineRanges,
	normalize,
	size,
	subtract,
} from "../../shared/lineRanges.js";
import type { Cluster, Snapshot } from "../../shared/types.js";
import { type CrbEvent, newEvent, type SplitEntry } from "./events.js";
import { foldProgress, type ProgressState, type StateEntry } from "./fold.js";

/** The lines of `a` that are also in `b`. */
const intersect = (a: LineRanges, b: LineRanges): LineRanges =>
	subtract(a, subtract(a, b));

/**
 * A piece's lines in its whole hunk's line index (`all`), and a set of the
 * hunk's lines as the piece's (`toPiece`): the piece's removed lines sit
 * at `removedAt` among the hunk's removed ones, its added lines at
 * `addedAt` among the hunk's added ones (after the hunk's `removed`
 * removed lines).
 */
function hunkRanges(c: Cluster): {
	all: LineRanges;
	toPiece: (hunk: LineRanges) => LineRanges;
} {
	const split = c.split as NonNullable<Cluster["split"]>;
	const r = c.removed.length;
	const a = c.added.length;
	const removedFrom = split.removedAt;
	const addedFrom = split.removed + split.addedAt;
	const removed: LineRanges = r > 0 ? [[removedFrom, removedFrom + r]] : [];
	const added: LineRanges = a > 0 ? [[addedFrom, addedFrom + a]] : [];
	const moved = (ranges: LineRanges, by: number) =>
		ranges.map(([s, e]): [number, number] => [s + by, e + by]);
	return {
		all: normalize([...removed, ...added]),
		toPiece: (hunk) =>
			normalize([
				...moved(intersect(hunk, removed), -removedFrom),
				...moved(intersect(hunk, added), r - addedFrom),
			]),
	};
}

/**
 * The marks a patch set's states hold on the whole hunks its snapshot now
 * cuts into pieces (Cluster.split, CAR-156), as split carries onto the
 * pieces: one entry for a piece whose hunk holds a whole mark (human or
 * carried), or whose hunk's line marks cover the piece in one state; one
 * per state for a piece they cover in part. Only pieces that hold no
 * state of their own, and only when the hunk's key is no cluster of the
 * snapshot: once written (or once the reviewer marks the piece), a piece
 * is left alone, so this is empty on every later read. Never more than
 * the hunk had: an unmarked hunk, or lines it didn't mark, give nothing.
 * Nothing either for a piece the Markdown block cut made of a CAR-156
 * piece (`split.piece`) that holds a state: those lines read unreviewed.
 * Lines the engine line-carried into the hunk (`linesCarried`) get their
 * own entry, always with the piece's `lines`: the fold keeps them carried.
 */
export function splitCarries(
	snapshot: Snapshot,
	states: ReadonlyMap<string, StateEntry>,
): SplitEntry[] {
	const keys = new Set(
		snapshot.files.flatMap((f) => f.clusters.map((c) => c.key)),
	);
	const entries: SplitEntry[] = [];
	for (const file of snapshot.files) {
		for (const c of file.clusters) {
			const split = c.split;
			if (!split || states.has(c.key) || keys.has(split.key)) continue;
			// The reviewer's own word on the CAR-156 piece the block cut split
			// again (CAR-167), even an untick, outranks the hunk's older mark.
			if (split.piece !== undefined && states.has(split.piece)) continue;
			const origin = states.get(split.key);
			if (!origin) continue;
			if (origin.state !== "unreviewed") {
				entries.push({ key: c.key, fromKey: split.key, state: origin.state });
				continue;
			}
			const { all, toPiece } = hunkRanges(c);
			const engine = origin.linesCarried?.lines ?? [];
			const marks = [
				["reviewed", intersect(origin.lines ?? [], all)],
				["crossed-off", intersect(origin.crossed ?? [], all)],
			] as const;
			for (const [state, marked] of marks) {
				// The reviewer's own lines and the engine's line carry go in
				// separate entries; the carry's always names the piece's lines, so
				// the fold keeps them tagged (CAR-308, principle 2).
				const parts = [
					[subtract(marked, engine), false],
					[intersect(marked, engine), true],
				] as const;
				for (const [from, carried] of parts) {
					if (from.length === 0) continue;
					const lines = toPiece(from);
					entries.push(
						!carried && size(lines) === c.lines
							? { key: c.key, fromKey: split.key, state, from }
							: { key: c.key, fromKey: split.key, state, from, lines },
					);
				}
			}
		}
	}
	return entries;
}

/**
 * The progress `events` fold to, with the split carries onto `snapshot`'s
 * pieces folded in as if written (never written: for a reader that doesn't
 * write, Home). The same as after ReviewService.carrySplits.
 */
export function withSplitCarries(
	events: CrbEvent[],
	snapshot: Snapshot,
	actor: string,
): ProgressState {
	const progress = foldProgress(events);
	const states = progress.statesByRevision.get(snapshot.revision);
	if (!states || states.size === 0) return progress;
	const entries = splitCarries(snapshot, states);
	if (entries.length === 0) return progress;
	let last = 0;
	for (const e of events) if (e.ts > last) last = e.ts;
	return foldProgress([
		...events,
		newEvent(
			"split-carried",
			actor,
			{ patchset: snapshot.revision, states: entries },
			"auto",
			last + 1,
		),
	]);
}
