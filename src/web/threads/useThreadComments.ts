import {
	type UseQueryResult,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import type { ThreadComments } from "../../shared/types";
import { commentsQuery, openComments } from "../api";

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
		if (waiting && readId !== undefined) {
			openComments(client, readId, threadId).catch(() => {});
		}
	}, [client, readId, threadId, waiting]);
	return query;
}

/**
 * Reads the comments of these threads in the background, in this order
 * (batched, a few requests at a time; commentsQuery), so they are usually
 * in before anyone opens one. Those in already aren't asked for again.
 */
export function usePrefetchComments(
	readId: string | undefined,
	threadIds: string[],
): void {
	const client = useQueryClient();
	const ids = threadIds.join(",");
	useEffect(() => {
		if (readId === undefined) return;
		for (const id of ids.split(",")) {
			if (id) void client.prefetchQuery(commentsQuery(readId, id, true));
		}
	}, [client, readId, ids]);
}
