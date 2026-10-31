import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { StateChange } from "../../shared/types";
import { postStates, reviewQuery, sessionQuery } from "../api";
import { unsent, useDrafts, useDraftsDurable } from "../threads/drafts";
import { useThreadWrites } from "../threads/threadWrites";
import { overlayReview, StateSync, type SyncState } from "./stateSync";

export { isStale } from "./stateSync";

export const STALE_MESSAGE = "The review moved to a new snapshot; reloaded.";

const syncs = new WeakMap<QueryClient, StateSync>();

/**
 * The page's one StateSync (stateSync.ts), per query client.
 *
 * The UI owns the review state: every cluster state action shows at once
 * (useReviewView lays the reviewer's intended states over the server's
 * view), and the sync keeps writing the server until it stores them. A
 * failure never rolls a change back; a reload shows what the server stored.
 * This doesn't loosen principle 2: every state still comes from the
 * reviewer's own explicit action, and an unsaved one is flagged (SyncNotices)
 * and guarded on leaving the page (useUnsavedGuard).
 *
 * A review read in flight may have been answered before a write: reads are
 * cancelled right before a write's answer lands, so no older read can
 * replace that answer (intended states stay on top of either).
 */
export function stateSyncFor(queryClient: QueryClient): StateSync {
	let sync = syncs.get(queryClient);
	if (!sync) {
		sync = new StateSync({
			post: postStates,
			stored: async (view) => {
				await queryClient.cancelQueries({ queryKey: reviewQuery.queryKey });
				queryClient.setQueryData(reviewQuery.queryKey, view);
				// The first check-off starts patch set 1, which the session reports.
				void queryClient.invalidateQueries({
					queryKey: sessionQuery.queryKey,
				});
			},
			staled: () => {
				void queryClient.invalidateQueries({ queryKey: reviewQuery.queryKey });
				void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
				void queryClient.invalidateQueries({ queryKey: ["hunks"] });
			},
			// A batch may have been partly written: reread what the server has.
			failed: () => {
				void queryClient.invalidateQueries({ queryKey: reviewQuery.queryKey });
			},
		});
		syncs.set(queryClient, sync);
	}
	return sync;
}

/** The sync's state: what is pending, delayed, failed or stale. */
export function useSyncState(): SyncState {
	const sync = stateSyncFor(useQueryClient());
	return useSyncExternalStore(sync.subscribe, sync.getState, sync.getState);
}

/**
 * Every cluster state write: `save(revision, path, changes)` shows them at
 * once and resolves once stored (see StateSync.apply).
 */
export function useSetStates() {
	const sync = stateSyncFor(useQueryClient());
	return {
		save: (revision: string, path: string, changes: StateChange[]) =>
			sync.apply(revision, path, changes),
		retry: () => sync.retry(),
	};
}

/** The review query, its data as the reviewer intends it (overlayReview). */
export function useReviewView() {
	const review = useQuery(reviewQuery);
	const { pending } = useSyncState();
	const data = useMemo(
		() => review.data && overlayReview(review.data, pending),
		[review.data, pending],
	);
	return { review, data };
}

/**
 * Asks before the page unloads (reload, close, leave) only when leaving
 * would lose something (owner: "refresh should only be dirty if
 * information is lost"):
 * - review states not yet stored: nothing keeps them past the page;
 * - a resolve or unresolve, or a delete (in its undo window or on its
 *   way), not yet on GitHub: nothing resends them (ThreadWritesState.lost);
 * - any write GitHub refused, until a Retry lands or it is dropped (owner:
 *   "Until dropped or succeeded, page should still ask"): kept across a
 *   reload (refusals.ts), but leaving shouldn't pass it by unnoticed;
 * - drafts and their writes (replies, edits, new threads) only while
 *   storage can't keep them (DraftStore.durable): kept, a reload brings
 *   them back and resends what was sent (ThreadWrites.resume).
 */
export function useUnsavedGuard() {
	const states = useSyncState().pending.size > 0;
	const drafts = unsent(useDrafts());
	const durable = useDraftsDurable();
	const { busy, lost } = useThreadWrites();
	const unsaved = states || lost || (!durable && (drafts || busy));
	useEffect(() => {
		if (!unsaved) return;
		const ask = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			// Older browsers ask only when returnValue is set.
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", ask);
		return () => window.removeEventListener("beforeunload", ask);
	}, [unsaved]);
}
