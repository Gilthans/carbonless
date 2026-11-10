/**
 * The reviewer's agent over HTTP: its status (polled while the page is
 * visible), its threads, and the writes that ask, reply, resolve and stop.
 * The config routes are machine-wide, not the review's.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useRef, useSyncExternalStore } from "react";
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
import { ApiError, fetchJson, overviewQuery, reviewApiPath } from "../api";

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
 * AGENT_BUSY_POLL_MS while the ACP agent starts or answers (its text
 * streams through the status; a joined session's doesn't), and not at all
 * on a review with no agent (404).
 */
export function agentPollMs(
	status: AgentStatus | undefined,
	error: unknown,
): number | false {
	if (error instanceof ApiError && error.status === 404) return false;
	return status?.via !== "mcp" &&
		(status?.state === "busy" || status?.state === "starting")
		? AGENT_BUSY_POLL_MS
		: AGENT_POLL_MS;
}

/**
 * The agent's status, polled (agentPollMs) while the page is visible and
 * read again when it comes back. A routine poll shows no spinner anywhere:
 * only a changed answer moves the chip's dot. Hidden tabs skip the ticks
 * (refetchIntervalInBackground), never the interval itself: an answer
 * landing while hidden must not stop the poll. A hidden tab polls only
 * useHiddenJoinPoll's light route.
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

/** A hidden tab's join poll. */
export const AGENT_HIDDEN_POLL_MS = 15_000;

/** What the hidden tab's poll answers: a pending request, the last leave. */
export type JoinPoll = Pick<AgentStatus, "joinRequest" | "left">;

/**
 * `GET /api/r/<id>/agent/join`: a pure lookup on the server (it never
 * opens the review, counts as a use, or wakes its agent).
 */
export const joinPollQuery = queryOptions({
	queryKey: ["agent-join"],
	queryFn: () => review<JoinPoll>("agent/join"),
	refetchInterval: AGENT_HIDDEN_POLL_MS,
	refetchIntervalInBackground: true,
	refetchOnWindowFocus: false,
	retry: false,
	staleTime: 0,
});

const subscribeVisibility = (onChange: () => void) => {
	document.addEventListener("visibilitychange", onChange);
	return () => document.removeEventListener("visibilitychange", onChange);
};
const hiddenNow = () => document.visibilityState === "hidden";

/** Whether the tab is hidden, kept current. */
export function useTabHidden(): boolean {
	return useSyncExternalStore(subscribeVisibility, hiddenNow, () => false);
}

/**
 * While the tab is hidden (and the review has an agent): whether a session
 * asks to join, read every AGENT_HIDDEN_POLL_MS from the light route.
 * `undefined` while visible, or before its first answer since hidden.
 */
export function useHiddenJoinPoll(on: boolean): JoinPoll | undefined {
	const hidden = useTabHidden();
	const poll = useQuery({ ...joinPollQuery, enabled: on && hidden });
	// When this hidden spell began, noted in the render that sees the tab
	// hide: an answer from an earlier spell never counts, not even for that
	// render.
	const since = useRef<number | null>(null);
	if (!hidden) since.current = null;
	else if (since.current === null) since.current = Date.now();
	return on && hidden && poll.dataUpdatedAt >= (since.current ?? 0)
		? poll.data
		: undefined;
}

/** What an Approve or Deny of a join request came to. */
export type JoinAnswer =
	| { ok: true }
	/** Already answered (another tab), replaced or expired. */
	| { ok: false; code: "stale-join" }
	/** Another crb server holds the review's agent. */
	| { ok: false; code: "elsewhere"; port?: number; error: string };

/** Approves or denies join request `request`; a 409 is an answer, not a throw. */
export async function answerJoin(
	request: string,
	approve: boolean,
): Promise<JoinAnswer> {
	let response: Response;
	try {
		response = await fetch(
			reviewApiPath(`/api/agent/join/${encodeURIComponent(request)}`),
			json("POST", { approve }),
		);
	} catch {
		throw new ApiError(0, "Could not reach carbonless. Is crb still running?");
	}
	if (response.ok) return { ok: true };
	const body = (await response.json().catch(() => null)) as {
		error?: unknown;
		code?: unknown;
		port?: unknown;
	} | null;
	const error =
		typeof body?.error === "string"
			? body.error
			: `Request failed: ${response.status}`;
	if (response.status === 409 && body?.code === "elsewhere") {
		return {
			ok: false,
			code: "elsewhere",
			error,
			...(typeof body.port === "number" ? { port: body.port } : {}),
		};
	}
	if (response.status === 409) return { ok: false, code: "stale-join" };
	throw new ApiError(response.status, error);
}

/** Ends the joined session's attachment (the reviewer's Disconnect). */
export const postAgentDisconnect = async (): Promise<void> => {
	await review<{ ok: true }>("agent/disconnect", json("POST"));
};

/** Turns the ACP buddy on again after a join turned it off. */
export const postAgentStart = async (): Promise<void> => {
	await review<{ ok: true }>("agent/start", json("POST"));
};

/** The access key the setup line carries (null: none needed). */
export const joinSetupQuery = queryOptions({
	queryKey: ["join-setup"],
	queryFn: () => fetchJson<{ key: string | null }>("/api/mcp/setup"),
	staleTime: Number.POSITIVE_INFINITY,
	retry: false,
});

/**
 * A word quoted for a POSIX shell (and zsh, where an unquoted `?` globs):
 * in double quotes when nothing there expands, else in single quotes.
 */
export function shellWord(word: string): string {
	if (!/[$`"\\!\n]/.test(word)) return `"${word}"`;
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The one-time setup line: adds this crb's /mcp to Claude Code. */
export function mcpAddLine(origin: string, key: string | null): string {
	const url = `${origin}/mcp${key ? `?${new URLSearchParams({ key })}` : ""}`;
	return `claude mcp add --scope user --transport http crb ${shellWord(url)}`;
}

/** The sentence a session is told to join this review. */
export const joinLine = (origin: string, id: string): string =>
	`join the carbonless review at ${origin}/r/${encodeURIComponent(id)}`;

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
