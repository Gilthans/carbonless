import type { ReviewThread, TimelineReviewItem } from "../../shared/types";

/**
 * How many of the threads a review run's comments are in are resolved:
 * distinct threads, so a thread-starting comment and replies in the same
 * thread count once. Comments whose thread isn't known (not among the
 * threads read) don't count either way. As of a cutoff every thread is
 * unresolved (ReviewThread.resolved).
 */
export function runResolution(
	items: TimelineReviewItem[],
	threads: Map<string, ReviewThread>,
): { resolved: number; total: number } {
	const seen = new Set<string>();
	let resolved = 0;
	for (const item of items) {
		if (item.kind !== "comment" || !item.threadId) continue;
		const thread = threads.get(item.threadId);
		if (!thread || seen.has(thread.id)) continue;
		seen.add(thread.id);
		if (thread.resolved) resolved++;
	}
	return { resolved, total: seen.size };
}
