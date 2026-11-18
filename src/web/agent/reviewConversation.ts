/**
 * The review conversation: the one agent conversation about the whole
 * review (anchor `{subject: "review"}`, at most one per review, never
 * resolved). It has no code, so it is in no thread list or count; the
 * header chip and its drawer show it.
 */
import { useQuery } from "@tanstack/react-query";
import type { AgentThread } from "../../shared/agent";
import { ApiError, overviewQuery } from "../api";
import { agentThreadsQuery } from "./api";

/** The review conversation in `list`, if it has one. */
export function reviewConversation(
	list: readonly AgentThread[],
): AgentThread | undefined {
	return list.find((t) => t.anchor.subject === "review");
}

/**
 * The review conversation from agentThreadsQuery. `loading` until the
 * answer says whether one exists (and while the overview hasn't said
 * whether the review has an agent): never "no conversation" meanwhile
 * (principle 8). `failed` when the threads couldn't be read: one may
 * exist. A review with no agent (viewer, as-of) has none, and asks nothing.
 */
export function useReviewConversation(): {
	thread: AgentThread | undefined;
	loading: boolean;
	failed: boolean;
} {
	const overview = useQuery({ ...overviewQuery, enabled: false });
	const on = overview.data?.writes === "on";
	const query = useQuery({ ...agentThreadsQuery, enabled: on });
	const list = query.data?.threads;
	if (overview.data === undefined) {
		const failed = overview.isError;
		return { thread: undefined, loading: !failed, failed };
	}
	if (!on) return { thread: undefined, loading: false, failed: false };
	if (list) {
		return { thread: reviewConversation(list), loading: false, failed: false };
	}
	const failed =
		query.isError &&
		!(query.error instanceof ApiError && query.error.status === 404);
	return { thread: undefined, loading: !query.isError, failed };
}
