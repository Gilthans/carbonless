import type { FileView } from "../../../shared/types";
import type { FindMark } from "../../code/Invisibles";
import { type Hit, type HitPos, samePos } from "./findInPr";

const ARROW = " → ";

/** The path as the header and the tree show it: `old → new` for a rename. */
export const displayPath = (
	file: Pick<FileView, "path" | "oldPath">,
): string => (file.oldPath ? `${file.oldPath}${ARROW}${file.path}` : file.path);

/** The file's hits on one path, shifted by `shift` and cut to [lo, hi) of the path. */
function marksOn(
	file: FileView,
	hits: readonly Hit[],
	side: "path" | "oldPath",
	caret: HitPos | null,
	shift: number,
	lo = 0,
): FindMark[] {
	return hits
		.filter((h) => h.index === file.index && h.side === side && h.col >= lo)
		.map((h) => ({
			from: h.col - lo + shift,
			to: h.col - lo + shift + h.len,
			current: caret !== null && samePos(h, caret),
		}));
}

const nameStart = (path: string) => path.lastIndexOf("/") + 1;

/** Marks over displayPath(file) from the file's path and old-path hits; `caret` paints the current one. */
export function headerPathMarks(
	file: FileView,
	hits: readonly Hit[],
	caret: HitPos | null,
): FindMark[] {
	const shift = file.oldPath ? file.oldPath.length + ARROW.length : 0;
	return [
		...marksOn(file, hits, "oldPath", caret, 0),
		...marksOn(file, hits, "path", caret, shift),
	];
}

/** Marks over the file's name (its last path segment) from its `path` hits that fall inside the name. */
export function nameMarks(
	file: FileView,
	hits: readonly Hit[],
	caret: HitPos | null,
): FindMark[] {
	return marksOn(file, hits, "path", caret, 0, nameStart(file.path));
}

/** Marks over a moved entry's old name from the file's `oldPath` hits inside it. */
export function oldNameMarks(
	file: FileView,
	hits: readonly Hit[],
	caret: HitPos | null,
): FindMark[] {
	return marksOn(
		file,
		hits,
		"oldPath",
		caret,
		0,
		nameStart(file.oldPath ?? ""),
	);
}
