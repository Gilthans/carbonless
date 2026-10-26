import type { FileHunks, ReviewThread } from "../../shared/types";
import { threadOrder } from "./threadPlacement";

/**
 * The order Files changed reads its threads' comments in: the open file's
 * first (`open`, an index into `files`), then the other files in file
 * order; in each file, file comments, then top down (threadOrder, with the
 * file's hunks when `hunksOf` has them). `threads` are those on the viewed
 * head (threadsOnHead); threads on files not shown are left out.
 */
export function filesPrefetchOrder<F extends { path: string }>(
	files: F[],
	threads: ReviewThread[],
	open: number | null,
	hunksOf: (file: F) => FileHunks | null = () => null,
): string[] {
	const byPath = new Map<string, ReviewThread[]>();
	for (const t of threads) {
		if (!t.id || t.unavailable) continue;
		const list = byPath.get(t.path);
		if (list) list.push(t);
		else byPath.set(t.path, [t]);
	}
	const openFile = open === null ? undefined : files[open];
	const order = openFile
		? [openFile, ...files.filter((f) => f !== openFile)]
		: files;
	return order.flatMap((f) => {
		const hunks = hunksOf(f);
		return [...(byPath.get(f.path) ?? [])]
			.sort((a, b) => threadOrder(a, hunks) - threadOrder(b, hunks))
			.map((t) => t.id);
	});
}
