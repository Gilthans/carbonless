import { useQueries } from "@tanstack/react-query";
import { useRef } from "react";
import type { ThreadsView } from "../../shared/types";
import { THREAD_STAGES, threadsQuery } from "../api";

/**
 * A read's review threads, as far as they have come: every stage is asked
 * for at once and the furthest in is shown (OverviewRead on the server).
 */
export function useThreads(readId: string | undefined): {
	view: ThreadsView | undefined;
	/** The read `view` comes from (the previous one while it is kept). */
	readId: string | undefined;
	/** A stage failed and the threads aren't all in. */
	error: Error | null;
	/**
	 * `view` is the previous read's, kept on screen (and in place) until the
	 * new read's summaries land, as after a Refresh.
	 */
	previous: boolean;
} {
	const stages = useQueries({
		queries: THREAD_STAGES.map((stage) => ({
			...threadsQuery(readId ?? "", stage),
			enabled: Boolean(readId),
		})),
	});
	const view = stages.findLast((q) => q.data)?.data;
	const failed = stages.find((q) => q.isError);
	const error = view?.complete ? null : (failed?.error ?? null);
	const last = useRef<{ readId: string; view: ThreadsView } | null>(null);
	if (view && readId) last.current = { readId, view };
	const kept =
		!view && !error && last.current && last.current.readId !== readId
			? last.current.view
			: undefined;
	return {
		view: view ?? kept,
		readId: kept ? last.current?.readId : readId,
		error,
		previous: Boolean(kept),
	};
}
