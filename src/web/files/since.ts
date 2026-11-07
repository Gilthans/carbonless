import type {
	ClusterKind,
	FileView,
	RereviewAnswer,
	ReviewView,
} from "../../shared/types";
import type { Unit } from "./unit";

/** One cluster of the engine's answer: its kind, and its source for carried and gone. */
export type KindEntry = RereviewAnswer["files"][number]["clusters"][number];

/** What the engine says about one file of the viewed snapshot. */
export interface FileSince {
	/** Each cluster key's entry (gone keys are the compared patch set's). */
	kinds: Map<string, KindEntry>;
	conflict: boolean;
	/** `carried` counts the view's clusters that carry a mark (the view decides, not the answer alone). */
	counts: { reworked: number; new: number; gone: number; carried: number };
}

/** What the engine says, by file index, over the view's files. */
export function sinceByFile(
	answer: RereviewAnswer,
	view: ReviewView,
): Map<number, FileSince> {
	const out = new Map<number, FileSince>();
	const viewFiles = new Map(view.files.map((f) => [f.index, f]));
	for (const file of answer.files) {
		const kinds = new Map(file.clusters.map((c) => [c.key, c]));
		const counts = { reworked: 0, new: 0, gone: 0, carried: 0 };
		for (const c of file.clusters) {
			if (c.kind === "reworked") counts.reworked++;
			else if (c.kind === "new") counts.new++;
			else if (c.kind === "gone") counts.gone++;
		}
		counts.carried =
			viewFiles.get(file.index)?.clusters.filter((c) => c.carried).length ?? 0;
		out.set(file.index, { kinds, conflict: file.conflict, counts });
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
		(f) => !indexes.has(f.index) && f.clusters.some((c) => c.kind === "gone"),
	);
}

const needsEyes = (kind: ClusterKind) => kind === "reworked" || kind === "new";

/**
 * How much is still to read in the unit: the view's unreviewed clusters
 * the engine lists as reworked or new (a cluster marked meanwhile is read;
 * one the reviewer unticked is to read again). Files: those with any.
 */
export function toReadCount(
	since: Map<number, FileSince>,
	view: ReviewView,
	unit: Unit,
): number {
	let n = 0;
	for (const file of view.files) {
		const kinds = since.get(file.index)?.kinds;
		if (!kinds) continue;
		let inFile = 0;
		for (const c of file.clusters) {
			const kind = kinds.get(c.key)?.kind;
			if (!kind || !needsEyes(kind) || c.state !== "unreviewed") continue;
			inFile += unit === "lines" ? c.lines : 1;
		}
		n += unit === "files" ? (inFile > 0 ? 1 : 0) : inFile;
	}
	return n;
}

/**
 * The tree's dot for a file in a comparison the engine has answered:
 * "read" when anything in it needs eyes (a reworked, new or gone cluster,
 * a conflict, or any unreviewed cluster), "carried" when every mark
 * carried over; null without an answer for it.
 */
export function eyesOf(
	file: FileView,
	since: FileSince | undefined,
): "read" | "carried" | null {
	if (!since) return null;
	const { counts } = since;
	if (
		since.conflict ||
		counts.reworked > 0 ||
		counts.new > 0 ||
		counts.gone > 0 ||
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
	for (const s of since.values()) {
		if (s.counts.gone > 0 || s.conflict) return false;
	}
	return true;
}

/** How many of the view's clusters carry a mark. */
export const carriedCount = (view: ReviewView): number =>
	view.files.reduce(
		(n, f) => n + f.clusters.filter((c) => c.carried).length,
		0,
	);
