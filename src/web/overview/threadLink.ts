/** The Overview's search params: `thread`, a card to bring into view (the Final Verdict tab's thread rows). */
export interface OverviewSearch {
	thread?: string;
}

/** Untrusted URL params to OverviewSearch; anything odd is dropped. */
export function parseOverviewSearch(
	raw: Record<string, unknown>,
): OverviewSearch {
	return typeof raw.thread === "string" && raw.thread
		? { thread: raw.thread }
		: {};
}
