import {
	keepPreviousData,
	type UseQueryResult,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import type { ThreadComments } from "../../shared/types";
import {
	commentsQuery,
	openComments,
	orderComments,
	showCommentsOf,
} from "../api";
import { usePageActive } from "../pageActive";

/**
 * A thread's comments (commentsQuery), for a thread on screen or opened:
 * asked for ahead of the prefetched ones, also when a prefetch already
 * queued it. Waits for a read id (an empty one too). After a new read
 * (a Refresh), the previous read's comments stay shown until its own land.
 */
export function useThreadComments(
	readId: string | undefined,
	threadId: string,
	opts?: { enabled?: boolean },
): UseQueryResult<ThreadComments> {
	const client = useQueryClient();
	const read = readId || undefined;
	const enabled = (opts?.enabled ?? true) && read !== undefined;
	const query = useQuery({
		...commentsQuery(read ?? "", threadId),
		enabled,
		// One thread per hook: the previous data is this thread's, another read's.
		placeholderData: keepPreviousData,
	});
	// A prefetch already on its way doesn't run the query again: say it's opened.
	const waiting =
		enabled && (query.data === undefined || query.isPlaceholderData);
	useEffect(() => {
		if (read !== undefined) showCommentsOf(client, read);
	}, [client, read]);
	useEffect(() => {
		if (waiting && read !== undefined) {
			openComments(client, read, threadId).catch(() => {});
		}
	}, [client, read, threadId, waiting]);
	return query;
}

/**
 * Reads the comments of these threads in the background, in this order
 * (batched, a few requests at a time; commentsQuery), so they are usually
 * in before anyone opens one. Those in already aren't asked for again;
 * those still queued move to this order, ahead of earlier lists. Another
 * read's queue and comments are dropped.
 *
 * The latest list wins over every earlier one, so there is exactly one
 * caller per page (OverviewPage, FilesPage), never one per group or list:
 * it passes the whole list in screen order, the next page appended, and
 * calls again with the new whole list when that order changes (say, the
 * open file first). A hidden kept page (`usePageActive`) asks for
 * nothing, so the page on screen orders the queue; shown again, its list
 * applies again.
 */
export function usePrefetchComments(
	readId: string | undefined,
	threadIds: string[],
): void {
	const client = useQueryClient();
	const active = usePageActive();
	const ids = threadIds.join(",");
	useEffect(() => {
		if (!readId || !active) return;
		showCommentsOf(client, readId);
		// This order wins over earlier ones, also for those already queued.
		orderComments(client, readId, ids.split(",").filter(Boolean));
		for (const id of ids.split(",")) {
			if (id) void client.prefetchQuery(commentsQuery(readId, id, true));
		}
	}, [client, readId, ids, active]);
}
