import { useRef } from "react";

interface Seen {
	head?: string;
	revision?: string;
	/** The revision shown when the head last changed: the old head's. */
	stale?: string;
}

/**
 * Whether the diff shown (`revision`) is the viewed head's. A Refresh
 * moves the session's head first and the review's revision after it: in
 * between, the old revision's hunks show under the new head. Pure, for
 * tests; `useHeadSure` keeps `seen` across renders.
 */
export function headSure(
	seen: Seen,
	head: string | undefined,
	revision: string | undefined,
): boolean {
	if (head !== seen.head) {
		seen.stale =
			seen.head !== undefined && revision === seen.revision
				? revision
				: undefined;
		seen.head = head;
	}
	seen.revision = revision;
	return (
		head !== undefined && revision !== undefined && revision !== seen.stale
	);
}

export function useHeadSure(
	head: string | undefined,
	revision: string | undefined,
): boolean {
	const seen = useRef<Seen>({});
	return headSure(seen.current, head, revision);
}
