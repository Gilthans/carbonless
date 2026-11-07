import type { RereviewAnswer, Shape } from "../../shared/types";

/**
 * The one-line copy of the patch set graph's cards (the former banner's):
 * what happened between two dots, by shape, and what there is to read once
 * the engine has answered.
 */

/** What the engine found to read, and the reviewed clusters it found gone. */
export type ToRead = RereviewAnswer["toRead"] & { gone?: number };

const plural = (n: number, word: string) =>
	`${n} ${n === 1 ? word : `${word}s`}`;

/** "2 files, 5 clusters to read" or "nothing new". */
function readPart(toRead: ToRead): string {
	if (toRead.clusters === 0 && toRead.files === 0) return "nothing new";
	return `${plural(toRead.files, "file")}, ${plural(toRead.clusters, "cluster")} to read`;
}

const conflictsPart = (shape: Shape) =>
	shape.conflicts.length > 0
		? `, ${plural(shape.conflicts.length, "file")} had conflicts`
		: "";

/** The shape's own words, before what there is to read. */
function whatHappened(shape: Shape, baseBranch?: string): string {
	switch (shape.code) {
		case "S1":
			return `${plural(shape.commits, "new commit")}`;
		case "S3":
			return `Base merged in${conflictsPart(shape)}`;
		case "S4a":
		case "S4b":
		case "S4c":
			return `Rebased${conflictsPart(shape)}`;
		case "S5":
			return "Squashed";
		case "S6":
			return "Head moved back";
		case "S7":
			return baseBranch ? `Retargeted to ${baseBranch}` : "Retargeted";
	}
}

/** The virtual rebase could not be built: the since view shows everything as new. */
const noInterdiff = (shape: Shape) =>
	shape.virtualRebase !== "ok" && shape.virtualRebase !== "conflict";

/**
 * "3 new commits · 2 files, 5 clusters to read", "Rebased, nothing new",
 * "Rebased, 2 files had conflicts · …", "Base merged in, nothing new",
 * "Squashed, nothing new", "Head moved back: 4 reviewed clusters gone",
 * "Retargeted to main · …". With `toRead` null (the engine still
 * computing) the shape's words alone: the caller shows a spinner in the
 * to-read slot.
 */
export function connectorLine(
	shape: Shape,
	toRead: ToRead | null,
	baseBranch?: string,
): string {
	const what = whatHappened(shape, baseBranch);
	if (shape.code === "S6") {
		if (!toRead) return what;
		const gone = toRead.gone ?? 0;
		return gone === 0
			? `${what}, nothing gone`
			: `${what}: ${plural(gone, "reviewed cluster")} gone`;
	}
	const head = noInterdiff(shape) ? `${what}, no interdiff` : what;
	if (!toRead) return head;
	const read = readPart(toRead);
	// "Rebased, nothing new" reads as one clause; a count is a second one.
	if (read === "nothing new" && shape.code !== "S1" && !noInterdiff(shape)) {
		return `${head}, ${read}`;
	}
	return `${head} · ${read}`;
}

/**
 * The dashed connector's color: yellow while there is (or may be)
 * something to read, green when nothing is new, red for conflicts or
 * reviewed work gone.
 */
export function connectorTone(
	shape: Shape,
	toRead: ToRead | null,
): "warn" | "ok" | "bad" {
	if (shape.conflicts.length > 0 || shape.code === "S6") return "bad";
	if (toRead && (toRead.gone ?? 0) > 0) return "bad";
	if (!toRead) return "warn";
	return toRead.clusters === 0 && toRead.files === 0 ? "ok" : "warn";
}

/** A connector's label: the commit count, bare on a phone. */
export const commitsLabel = (commits: number, phone: boolean) =>
	phone ? String(commits) : plural(commits, "commit");
