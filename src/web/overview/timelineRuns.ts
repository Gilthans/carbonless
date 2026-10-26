import type {
	ReviewThread,
	TimelineEvent,
	TimelineReviewItem,
} from "../../shared/types";

/**
 * A stable key per event: its kind, actor and start time, so an event keeps
 * its key (and an opened run stays open) when a newer read inserts others
 * around it. The rare repeat (the same kind, person and time twice) gets a
 * count.
 */
export function eventKeys(events: TimelineEvent[]): [string, TimelineEvent][] {
	const seen = new Map<string, number>();
	return events.map((event) => {
		const at = "from" in event ? event.from : event.at;
		const base = `${event.kind}:${event.actor.login}:${at}`;
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		return [n === 0 ? base : `${base}#${n}`, event];
	});
}

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
