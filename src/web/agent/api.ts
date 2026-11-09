/**
 * The reviewer's agent over HTTP: its status (polled while the page is
 * visible), its threads, and the writes that ask, reply, resolve and stop.
 * The config routes are machine-wide, not the review's.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	AGENT_POLL_MS,
	type AgentCheck,
	type AgentConfig,
	type AgentMessageRequest,
	type AgentPlacementsAnswer,
	type AgentResolvedRequest,
	type AgentStatus,
	type AgentThread,
	type OpenAgentThreadRequest,
} from "../../shared/agent";
import {
	ApiError,
	fetchJson,
	overviewQuery,
	type RereviewTo,
	reviewApiPath,
} from "../api";
import type { Placements } from "../files/threadPlacement";

const json = (method: string, body?: unknown): RequestInit => ({
	method,
	headers: body === undefined ? {} : { "content-type": "application/json" },
	body: body === undefined ? undefined : JSON.stringify(body),
});

/** A route of the bound review: `/api/r/<id>/agent…`. */
const review = <T>(path: string, init?: RequestInit) =>
	fetchJson<T>(reviewApiPath(`/api/${path}`), init);

/**
 * Whether this review has an agent: a session that writes (not --viewer,
 * not --as-of), once the overview says so. The agent's routes aren't asked
 * before, or at all without one (they would only answer 404).
 */
export function useAgentOn(): boolean {
	return useQuery({ ...overviewQuery, enabled: false }).data?.writes === "on";
}

export const fetchAgentStatus = () => review<AgentStatus>("agent");

/** While the agent starts or answers: often enough for its text to stream. */
export const AGENT_BUSY_POLL_MS = 1000;

/**
 * How often the status is read: every AGENT_POLL_MS, every
 * AGENT_BUSY_POLL_MS while the agent starts or answers (its text streams
 * through the status), and not at all on a review with no agent (404).
 * Hidden tabs skip the ticks (refetchIntervalInBackground), never the
 * interval itself: an answer landing while hidden must not stop the poll.
 */
export function agentPollMs(
	status: AgentStatus | undefined,
	error: unknown,
): number | false {
	if (error instanceof ApiError && error.status === 404) return false;
	return status?.state === "busy" || status?.state === "starting"
		? AGENT_BUSY_POLL_MS
		: AGENT_POLL_MS;
}

/**
 * The agent's status, polled (agentPollMs) while the page is visible and
 * read again when it comes back. A routine poll shows no spinner anywhere:
 * only a changed answer moves the chip's dot.
 */
export const agentStatusQuery = queryOptions({
	queryKey: ["agent"],
	queryFn: fetchAgentStatus,
	refetchInterval: (query) => agentPollMs(query.state.data, query.state.error),
	refetchIntervalInBackground: false,
	refetchOnWindowFocus: true,
	retry: false,
	staleTime: AGENT_BUSY_POLL_MS,
});

/** The review's agent threads; refetched when the status moves (useAgentSync). */
export const agentThreadsQuery = queryOptions({
	queryKey: ["agent", "threads"],
	queryFn: () => review<{ threads: AgentThread[] }>("agent/threads"),
	staleTime: Number.POSITIVE_INFINITY,
	// A review with no agent (--viewer, --as-of) answers 404: no threads.
	retry: false,
});

/**
 * The agent threads `ids` placed into a patch set or a head (GET
 * /agent/placements), for the snapshot `revision` being viewed: a new
 * snapshot of the same head (the base moved) asks again. Its own key,
 * outside ["agent"], so a status refetch never retraces them; a new
 * thread asks again with the last answer for this snapshot kept meanwhile
 * (the new one is on the viewed head, placed as asked). A failure is
 * retried (useAgentPlacementsFor drops an answer for another snapshot).
 */
export const agentPlacementsQuery = (
	to: RereviewTo,
	revision: string,
	ids: readonly string[],
) => {
	const target = "patchset" in to ? `ps:${to.patchset}` : `head:${to.head}`;
	return queryOptions({
		queryKey: ["agent-placements", target, revision, [...ids].sort().join(",")],
		queryFn: () =>
			review<AgentPlacementsAnswer>(
				`agent/placements?${new URLSearchParams(
					"patchset" in to ? { ps: String(to.patchset) } : { head: to.head },
				)}`,
			),
		staleTime: Number.POSITIVE_INFINITY,
		// Another snapshot's placements never stand in: their lines are its own.
		placeholderData: (previous, query) =>
			query?.queryKey[1] === target && query.queryKey[2] === revision
				? previous
				: undefined,
		retry: 3,
		retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
	});
};

/**
 * The agent threads' placements in the viewed snapshot (`revision`), by
 * thread id; null until they are in, when off, or when the answer is
 * another snapshot's (then each shows where it was asked).
 */
export function useAgentPlacementsFor(args: {
	to: RereviewTo | null;
	revision: string | undefined;
	ids: readonly string[];
	enabled: boolean;
}): Placements | null {
	const { to, revision, ids } = args;
	const on =
		args.enabled && to !== null && revision !== undefined && ids.length > 0;
	const { data } = useQuery({
		...agentPlacementsQuery(to ?? { patchset: 1 }, revision ?? "", ids),
		enabled: on,
	});
	return useMemo(
		() =>
			on && data && data.revision === revision
				? new Map(data.threads.map((t) => [t.id, t.placement]))
				: null,
		[on, data, revision],
	);
}

export const postAgentThread = (req: OpenAgentThreadRequest) =>
	review<AgentThread>("agent/threads", json("POST", req));

export const postAgentMessage = (thread: string, req: AgentMessageRequest) =>
	review<AgentThread>(
		`agent/threads/${encodeURIComponent(thread)}/messages`,
		json("POST", req),
	);

export const postAgentResolved = (thread: string, resolved: boolean) =>
	review<AgentThread>(
		`agent/threads/${encodeURIComponent(thread)}/resolved`,
		json("POST", { resolved } satisfies AgentResolvedRequest),
	);

export const postAgentCancel = async (): Promise<void> => {
	await review<{ ok: true }>("agent/cancel", json("POST"));
};

/** The machine's agent as config.json has it, and what's wrong with it. */
export const agentConfigQuery = queryOptions({
	queryKey: ["agent-config"],
	queryFn: () =>
		fetchJson<{ agent: AgentConfig | null; problems: string[] }>(
			"/api/config/agent",
		),
	staleTime: 0,
	retry: false,
});

/** Writes (or, with null, removes) the machine's agent in config.json. */
export const putAgentConfig = (agent: AgentConfig | null) =>
	fetchJson<{ agent: AgentConfig | null }>(
		"/api/config/agent",
		json("PUT", agent),
	);

/** Runs the command once through `initialize`: its name and version, or why not. */
export const checkAgentConfig = (agent: AgentConfig) =>
	fetchJson<AgentCheck>("/api/config/agent/check", json("POST", agent));

/** The thread in the cached list: replaced in place, or added. */
export function withThread(
	list: { threads: AgentThread[] } | undefined,
	thread: AgentThread,
): { threads: AgentThread[] } {
	const threads = list?.threads ?? [];
	return threads.some((t) => t.id === thread.id)
		? { threads: threads.map((t) => (t.id === thread.id ? thread : t)) }
		: { threads: [...threads, thread] };
}
