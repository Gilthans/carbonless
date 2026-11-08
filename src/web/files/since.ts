import {
	crossedCount,
	reviewedCount,
	type SinceUnit,
	sinceUnits,
} from "../../shared/pieces";
import { fileFlags } from "../../shared/progress";
import { overlayCarries } from "../../shared/rereview/overlay";
import type {
	ClusterView,
	FileView,
	Progress,
	RereviewAnswer,
	ReviewView,
} from "../../shared/types";
import { overlayReview, type PendingChange } from "./stateSync";
import type { Unit } from "./unit";

/**
 * The review to show: the engine's provisional carries laid over the
 * served view only while it is no patch set yet (a started one has its
 * marks in the fold, as the server guards too), and the reviewer's pending
 * states over that, so a human mark always wins over a carry (principle 2:
 * an untick the reviewer made never snaps back to the engine's mark).
 */
export function shownView(
	raw: ReviewView,
	answer: RereviewAnswer | null,
	pending: ReadonlyMap<string, PendingChange>,
): ReviewView {
	// A key with a pending change is the reviewer's: no carry lands on it
	// (not even its `carried` tag).
	const theirs =
		answer && pending.size > 0
			? {
					...answer,
					files: answer.files.map((f) => ({
						...f,
						clusters: f.clusters.filter((c) => !pending.has(c.key)),
					})),
				}
			: answer;
	const carried =
		raw.patchset === null && theirs ? overlayCarries(raw, theirs) : raw;
	return overlayReview(carried, pending);
}

/** One cluster of the engine's answer: its kind, and its source for carried and gone. */
export type KindEntry = RereviewAnswer["files"][number]["clusters"][number];

/** What the engine says about one file of the viewed snapshot. */
export interface FileSince {
	/** Each cluster key's entry (gone keys are the compared patch set's). */
	kinds: Map<string, KindEntry>;
	conflict: boolean;
	/**
	 * The file's units (sinceUnits) not marked yet, by kind: what its
	 * header chips count, dropping as pieces are marked; `carried` counts
	 * the view's clusters that carry a mark (the view decides).
	 */
	counts: {
		reworked: number;
		new: number;
		gone: number;
		carried: number;
		reverted: number;
		removed: number;
	};
	/** Its units not marked yet: how many, and their lines. */
	left: { units: number; lines: number };
}

/** The since view's units under the view's marks (sinceUnits). */
export function unitsOf(answer: RereviewAnswer, view: ReviewView): SinceUnit[] {
	const viewFiles = new Map(view.files.map((f) => [f.index, f]));
	return sinceUnits(
		answer.files,
		answer.from,
		(index) => viewFiles.get(index)?.clusters ?? [],
		view.sinceMarks,
	);
}

/** What the engine says, by file index, over the view's files and marks. */
export function sinceByFile(
	answer: RereviewAnswer,
	view: ReviewView,
): Map<number, FileSince> {
	const out = new Map<number, FileSince>();
	const viewFiles = new Map(view.files.map((f) => [f.index, f]));
	for (const file of answer.files) {
		out.set(file.index, {
			kinds: new Map(file.clusters.map((c) => [c.key, c])),
			conflict: file.conflict,
			counts: {
				reworked: 0,
				new: 0,
				gone: 0,
				reverted: 0,
				removed: 0,
				carried:
					viewFiles.get(file.index)?.clusters.filter((c) => c.carried).length ??
					0,
			},
			left: { units: 0, lines: 0 },
		});
	}
	for (const u of unitsOf(answer, view)) {
		const info = out.get(u.index);
		if (!info || u.state !== "unreviewed") continue;
		info.counts[u.kind]++;
		info.left.units++;
		info.left.lines += u.open;
	}
	return out;
}

/** The answer's files past the view's: everything the reviewer saw of them was undone. */
export function goneFiles(
	answer: RereviewAnswer,
	view: ReviewView,
): RereviewAnswer["files"] {
	const indexes = new Set(view.files.map((f) => f.index));
	return answer.files.filter(
		(f) =>
			!indexes.has(f.index) &&
			(f.clusters.some((c) => c.kind === "gone") ||
				(f.pieces?.length ?? 0) > 0),
	);
}

/**
 * How much is still to read in the unit: the since view's units not
 * marked yet (pieces, and the rest of a reworked or new cluster only the
 * full diff shows). Files: those with any.
 */
export function toReadCount(
	since: Map<number, FileSince>,
	_view: ReviewView,
	unit: Unit,
): number {
	let n = 0;
	for (const info of since.values()) {
		const { units, lines } = info.left;
		n +=
			unit === "files" ? (units > 0 ? 1 : 0) : unit === "lines" ? lines : units;
	}
	return n;
}

/**
 * The full diff's "to read" (it counts the snapshot's clusters): the
 * view's clusters the engine lists as reworked or new, not reviewed or
 * crossed off yet, in the unit (lines: the ones not marked).
 */
export function toReadClusters(
	answer: RereviewAnswer,
	view: ReviewView,
	unit: Unit,
): number {
	const kinds = new Map(
		answer.files.flatMap((f) => f.clusters.map((c) => [c.key, c.kind])),
	);
	let n = 0;
	for (const file of view.files) {
		let inFile = 0;
		for (const c of file.clusters) {
			const kind = kinds.get(c.key);
			if ((kind !== "reworked" && kind !== "new") || c.state !== "unreviewed") {
				continue;
			}
			inFile +=
				unit === "lines" ? c.lines - reviewedCount(c) - crossedCount(c) : 1;
		}
		n += unit === "files" ? (inFile > 0 ? 1 : 0) : inFile;
	}
	return n;
}

/**
 * The since view's progress (owner: "the progress bar should also be
 * related to the current view"): its units in the clusters unit, their
 * shown lines in lines, the files with any in files.
 */
export function sinceProgress(units: readonly SinceUnit[]): Progress {
	const clusters = { total: 0, reviewed: 0, crossedOff: 0 };
	const lines = { total: 0, reviewed: 0, crossedOff: 0 };
	const byFile = new Map<number, SinceUnit[]>();
	for (const u of units) {
		clusters.total++;
		lines.total += u.lines;
		if (u.state === "reviewed") {
			clusters.reviewed++;
			lines.reviewed += u.lines;
		} else if (u.state === "crossed-off") {
			clusters.crossedOff++;
			lines.crossedOff += u.lines;
		}
		byFile.set(u.index, [...(byFile.get(u.index) ?? []), u]);
	}
	const files = { total: 0, reviewed: 0, crossedOff: 0, done: 0 };
	for (const list of byFile.values()) {
		files.total++;
		const done = list.every((u) => u.state !== "unreviewed");
		if (done) files.done++;
		if (list.every((u) => u.state === "crossed-off")) files.crossedOff++;
		else if (done) files.reviewed++;
	}
	return { clusters, lines, files };
}

/**
 * The file as the since view counts it (its header meter and sentence):
 * one cluster per unit, with the unit's lines and state.
 */
export function unitsFile(
	file: FileView,
	units: readonly SinceUnit[],
): FileView {
	const clusters: ClusterView[] = units.map((u, i) => ({
		key: `unit:${i}`,
		kind: "lines",
		oldStart: 0,
		oldCount: 0,
		newStart: 0,
		newCount: 0,
		removed: [],
		added: [],
		lines: u.lines,
		state: u.state,
	}));
	return { ...file, clusters, ...fileFlags(clusters) };
}

/** The connector's "to read" for the comparison on screen: its units not marked yet. */
export function liveToRead(
	since: Map<number, FileSince>,
): RereviewAnswer["toRead"] & { gone: number } {
	let files = 0;
	let clusters = 0;
	let gone = 0;
	for (const info of since.values()) {
		if (info.left.units > 0 || info.conflict) files++;
		clusters += info.left.units;
		gone += info.counts.gone;
	}
	return { files, clusters, gone };
}

/**
 * The tree's dot for a file in a comparison the engine has answered:
 * "read" when anything in it needs eyes (a unit not marked, a conflict, or
 * any unreviewed cluster), "carried" when every mark carried over; null
 * without an answer for it.
 */
export function eyesOf(
	file: FileView,
	since: FileSince | undefined,
): "read" | "carried" | null {
	if (!since) return null;
	if (
		since.conflict ||
		since.left.units > 0 ||
		file.clusters.some((c) => c.state === "unreviewed")
	) {
		return "read";
	}
	return "carried";
}

/** Everything is carried: nothing to read and nothing gone, anywhere. */
export function nothingSince(
	answer: RereviewAnswer,
	since: Map<number, FileSince>,
): boolean {
	if (answer.toRead.clusters > 0 || answer.toRead.files > 0) return false;
	if (answer.files.some((f) => f.clusters.some((c) => c.kind === "gone"))) {
		return false;
	}
	for (const s of since.values()) if (s.conflict) return false;
	return true;
}

/** How many of the view's clusters carry a mark. */
export const carriedCount = (view: ReviewView): number =>
	view.files.reduce(
		(n, f) => n + f.clusters.filter((c) => c.carried).length,
		0,
	);
