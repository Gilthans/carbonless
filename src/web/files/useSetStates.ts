import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { StateChange } from "../../shared/types";
import { ApiError, postStates, reviewQuery, sessionQuery } from "../api";

export const STALE_MESSAGE = "The review moved to a new snapshot; reloaded.";

export const isStale = (error: unknown) =>
	error instanceof ApiError && error.status === 409;

/**
 * Every cluster state write. The UI shows a state only once the server
 * returns it (no optimistic updates), so nothing looks reviewed before it is
 * stored. Writes run one at a time, in order, so a slower earlier answer
 * can't overwrite a later one in the cache.
 *
 * A review read in flight may have been answered before the write: reads
 * are cancelled when a write is queued and again right before its answer
 * lands (which also covers the reread an earlier failed write started), so
 * no older read can replace that answer.
 *
 * `onStaleChange(true)` on a 409 (the snapshot moved), `(false)` once a write
 * is stored.
 */
export function useSetStates(
	options: { onStaleChange?: (stale: boolean) => void } = {},
) {
	const queryClient = useQueryClient();
	const cancelReviewReads = () =>
		queryClient.cancelQueries({ queryKey: reviewQuery.queryKey });
	return useMutation({
		mutationKey: ["states"],
		scope: { id: "states" },
		onMutate: cancelReviewReads,
		mutationFn: (vars: { revision: string; changes: StateChange[] }) =>
			postStates(vars.revision, vars.changes),
		onSuccess: async (view) => {
			await cancelReviewReads();
			queryClient.setQueryData(reviewQuery.queryKey, view);
			// The first check-off starts patch set 1, which the session reports.
			void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
			options.onStaleChange?.(false);
		},
		onError: (error) => {
			// A batch may have been partly written: reread what the server has.
			void queryClient.invalidateQueries({ queryKey: reviewQuery.queryKey });
			if (isStale(error)) {
				void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
				void queryClient.invalidateQueries({ queryKey: ["hunks"] });
				options.onStaleChange?.(true);
			}
		},
	});
}
