import { useQueries } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import type { ThreadsView } from "../../shared/types";
import { THREAD_STAGES, threadsQuery } from "../api";
import { overlayThreads, useThreadWrites } from "./threadWrites";

/**
 * A read's review threads, as far as they have come: every stage is asked
 * for at once and the furthest in is shown (OverviewRead on the server).
 * A resolve or unresolve not yet on GitHub shows as intended
 * (overlayThreads).
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
	const shown = view ?? kept;
	const writes = useThreadWrites();
	const overlaid = useMemo(() => {
		if (!shown) return shown;
		const threads = overlayThreads(shown.threads, writes);
		return threads === shown.threads ? shown : { ...shown, threads };
	}, [shown, writes]);
	return {
		view: overlaid,
		readId: kept ? last.current?.readId : readId,
		error,
		previous: Boolean(kept),
	};
}
