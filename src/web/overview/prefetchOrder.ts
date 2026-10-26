import type { ReviewThread } from "../../shared/types";

/** What one thread list shows (its listed page) and would show next. */
export interface ShownThreads {
	visible: string[];
	next: string[];
}

/**
 * The order the Overview reads its threads' comments in (usePrefetchComments):
 * what every list shows, then every list's next page, then the rest as
 * listed, so all are usually in before anyone opens one. Only ids of `all`
 * that can be read, each once.
 */
export function prefetchOrder(
	all: Pick<ReviewThread, "id" | "unavailable">[],
	groups: ShownThreads[],
): string[] {
	const readable = new Set(
		all.filter((t) => t.id && !t.unavailable).map((t) => t.id),
	);
	const out = new Set<string>();
	const add = (id: string) => {
		if (readable.has(id)) out.add(id);
	};
	for (const g of groups) g.visible.forEach(add);
	for (const g of groups) g.next.forEach(add);
	for (const t of all) add(t.id);
	return [...out];
}
