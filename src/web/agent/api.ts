/**
 * The reviewer's agent over HTTP: its status (polled while the page is
 * visible), its threads, and the writes that ask, reply, resolve and stop.
 * The config routes are machine-wide, not the review's.
 */
import { queryOptions } from "@tanstack/react-query";
import {
	AGENT_POLL_MS,
	type AgentCheck,
	type AgentConfig,
	type AgentMessageRequest,
	type AgentResolvedRequest,
	type AgentStatus,
	type AgentThread,
	type OpenAgentThreadRequest,
} from "../../shared/agent";
import { ApiError, fetchJson, reviewApiPath } from "../api";

const json = (method: string, body?: unknown): RequestInit => ({
	method,
	headers: body === undefined ? {} : { "content-type": "application/json" },
	body: body === undefined ? undefined : JSON.stringify(body),
});

/** A route of the bound review: `/api/r/<id>/agent…`. */
const review = <T>(path: string, init?: RequestInit) =>
	fetchJson<T>(reviewApiPath(`/api/${path}`), init);

export const fetchAgentStatus = () => review<AgentStatus>("agent");

/**
 * The agent's status, every AGENT_POLL_MS while the page is visible and
 * never in the background. A routine poll shows no spinner anywhere: only a
 * changed answer moves the chip's dot.
 */
export const agentStatusQuery = queryOptions({
	queryKey: ["agent"],
	queryFn: fetchAgentStatus,
	refetchInterval: (query) =>
		// No agent on this review (--viewer, --as-of): nothing to poll.
		query.state.error instanceof ApiError && query.state.error.status === 404
			? false
			: typeof document === "undefined" ||
					document.visibilityState === "visible"
				? AGENT_POLL_MS
				: false,
	refetchIntervalInBackground: false,
	retry: false,
	staleTime: AGENT_POLL_MS,
});

/** The review's agent threads; refetched when the status moves (useAgentSync). */
export const agentThreadsQuery = queryOptions({
	queryKey: ["agent", "threads"],
	queryFn: () => review<{ threads: AgentThread[] }>("agent/threads"),
	staleTime: Number.POSITIVE_INFINITY,
	// A review with no agent (--viewer, --as-of) answers 404: no threads.
	retry: false,
});

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
