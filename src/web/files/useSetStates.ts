import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ReviewView, StateChange } from "../../shared/types";
import {
	CURRENT_REVIEW,
	postStates,
	REVIEW_KEY,
	type ReviewTarget,
	reviewQuery,
	sessionQuery,
} from "../api";
import { viewSaverFor } from "../home/viewSaver";
import { unsent, useDrafts, useDraftsDurable } from "../threads/drafts";
import { useThreadWrites } from "../threads/threadWrites";
import { useVerdictDraft, verdictDraftFor } from "../verdict/verdictDraft";
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
				await queryClient.cancelQueries({ queryKey: REVIEW_KEY });
				// The session's own review is the written snapshot's now (a
				// first mark on a viewed head started its patch set); so is any
				// other read of that snapshot (the viewed head's), at once.
				queryClient.setQueryData(reviewQuery().queryKey, view);
				queryClient.setQueriesData<ReviewView>(
					{
						queryKey: REVIEW_KEY,
						predicate: (q) =>
							(q.state.data as ReviewView | undefined)?.revision ===
							view.revision,
					},
					view,
				);
				// The first check-off starts a patch set, which the session
				// reports; the carries follow the marks.
				void queryClient.invalidateQueries({
					queryKey: sessionQuery.queryKey,
				});
				void queryClient.invalidateQueries({ queryKey: ["rereview"] });
			},
			staled: () => {
				void queryClient.invalidateQueries({ queryKey: REVIEW_KEY });
				void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
				void queryClient.invalidateQueries({ queryKey: ["hunks"] });
				void queryClient.invalidateQueries({ queryKey: ["rereview"] });
			},
			// A batch may have been partly written: reread what the server has.
			failed: () => {
				void queryClient.invalidateQueries({ queryKey: REVIEW_KEY });
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

/**
 * The review query of `target` (the session's own by default), its data as
 * the reviewer intends it (overlayReview).
 */
export function useReviewView(target: ReviewTarget = CURRENT_REVIEW) {
	const review = useQuery(reviewQuery(target));
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
 * - Home's view list not yet saved (viewSaverFor), for the same reason;
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
	// The verdict's message and a verdict on its way, kept like the drafts.
	const verdict = useVerdictDraft();
	const verdictDurable = verdictDraftFor(useQueryClient()).durable();
	const verdictUnsaved =
		!verdictDurable &&
		(verdict.text.trim() !== "" || verdict.sending !== undefined);
	// Home's view list not yet saved: nothing sends it after the page.
	const saver = viewSaverFor(useQueryClient());
	const view =
		useSyncExternalStore(saver.subscribe, saver.snapshot).intended !== null;
	const unsaved =
		states || view || lost || verdictUnsaved || (!durable && (drafts || busy));
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
