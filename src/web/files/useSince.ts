import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type {
	RereviewAnswer,
	ReviewView,
	SessionInfo,
} from "../../shared/types";
import { type RereviewTo, rereviewQuery } from "../api";
import type { Comparison } from "./comparison";
import { type FileSince, shownView, sinceByFile } from "./since";
import type { PendingChange } from "./stateSync";

export interface SinceView {
	/** The comparison base's patch set: the since view; null for the full diff. */
	since: number | null;
	/** The patch set the engine compares from (the since one, or the latest for a viewed head). */
	from: number | null;
	/** Whether the engine is asked at all for this comparison. */
	asked: boolean;
	answer: RereviewAnswer | null;
	/** Asked and not answered yet (a spinner in every slot that waits on it). */
	pending: boolean;
	error: Error | null;
	/**
	 * The review to show: the served one with the engine's provisional
	 * carries over a viewed head that is no patch set yet, and the
	 * reviewer's pending states over that (shownView).
	 */
	shown: ReviewView | undefined;
	/** What the engine says per file index, once answered. */
	byFile: Map<number, FileSince> | null;
}

/**
 * The engine's answer for the comparison (rereviewQuery, polled while
 * pending): asked when the comparison base is a patch set (the since
 * view) or the head is viewed (its provisional carries, from the latest
 * patch set). The viewed head's review gets the carries laid over it as
 * soon as the answer is in, whether or not the server already did.
 */
export function useSince(
	comparison: Comparison,
	session: SessionInfo | undefined,
	/** The review as served (no pending states on it). */
	raw: ReviewView | undefined,
	pendingStates: ReadonlyMap<string, PendingChange>,
): SinceView {
	const latest = session?.patchsets.at(-1)?.number ?? null;
	const { viewing, base } = comparison;
	const since = base.kind === "patchset" ? base.number : null;
	const from = since ?? (viewing?.kind === "head" ? latest : null);
	const to: RereviewTo | null =
		viewing === null
			? null
			: viewing.kind === "head"
				? { head: viewing.oid }
				: { patchset: viewing.number };
	const asked =
		from !== null && to !== null && !("patchset" in to && to.patchset <= from);
	const query = useQuery({
		...rereviewQuery(from ?? 1, to ?? { patchset: 1 }),
		enabled: asked,
	});
	const answer =
		asked && query.data && !("pending" in query.data) ? query.data : null;
	const error = asked ? (query.error ?? null) : null;
	const pending = asked && answer === null && error === null;
	const overlay = viewing?.kind === "head";
	const shown = useMemo(
		() =>
			raw ? shownView(raw, overlay ? answer : null, pendingStates) : undefined,
		[raw, answer, overlay, pendingStates],
	);
	const byFile = useMemo(
		() => (answer && shown ? sinceByFile(answer, shown) : null),
		[answer, shown],
	);
	return { since, from, asked, answer, pending, error, shown, byFile };
}
