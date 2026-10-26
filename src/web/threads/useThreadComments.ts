import {
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

/**
 * A thread's comments (commentsQuery), for a thread on screen or opened:
 * asked for ahead of the prefetched ones, also when a prefetch already
 * queued it. Waits for a read id.
 */
export function useThreadComments(
	readId: string | undefined,
	threadId: string,
	opts?: { enabled?: boolean },
): UseQueryResult<ThreadComments> {
	const client = useQueryClient();
	const enabled = (opts?.enabled ?? true) && readId !== undefined;
	const query = useQuery({ ...commentsQuery(readId ?? "", threadId), enabled });
	// A prefetch already on its way doesn't run the query again: say it's opened.
	const waiting = enabled && query.data === undefined;
	useEffect(() => {
		if (readId !== undefined) showCommentsOf(client, readId);
	}, [client, readId]);
	useEffect(() => {
		if (waiting && readId !== undefined) {
			openComments(client, readId, threadId).catch(() => {});
		}
	}, [client, readId, threadId, waiting]);
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
 * open file first).
 */
export function usePrefetchComments(
	readId: string | undefined,
	threadIds: string[],
): void {
	const client = useQueryClient();
	const ids = threadIds.join(",");
	useEffect(() => {
		if (readId === undefined) return;
		showCommentsOf(client, readId);
		// This order wins over earlier ones, also for those already queued.
		orderComments(client, readId, ids.split(",").filter(Boolean));
		for (const id of ids.split(",")) {
			if (id) void client.prefetchQuery(commentsQuery(readId, id, true));
		}
	}, [client, readId, ids]);
}
