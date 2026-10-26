import type { ReviewThread } from "../../shared/types";

/**
 * The order Files changed reads its threads' comments in: the open file's
 * first (`open`, an index into `files`), then the other files in file
 * order; in each file, file comments, then top down. `threads` are those on
 * the viewed head (threadsOnHead); threads on files not shown are left out.
 */
export function filesPrefetchOrder(
	files: { path: string }[],
	threads: ReviewThread[],
	open: number | null,
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
	return order.flatMap((f) =>
		[...(byPath.get(f.path) ?? [])]
			.sort((a, b) => (a.anchor?.line ?? 0) - (b.anchor?.line ?? 0))
			.map((t) => t.id),
	);
}
