/**
 * The reviewer's agent over HTTP: its status (polled while the page is
 * visible), its threads, and the writes that ask, reply, resolve and stop.
 * The config routes are machine-wide, not the review's.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	AGENT_POLL_MS,
	type AgentCheck,
	type AgentConfig,
	type AgentMessageRequest,
	type AgentPlacementsAnswer,
	type AgentResolvedRequest,
	type AgentSeenRequest,
	type AgentStatus,
	type AgentThread,
	type OpenAgentThreadRequest,
} from "../../shared/agent";
import { MCP_HARNESSES, type McpHarness } from "../../shared/agentHarnesses";
import {
	AGENT_PLACEMENTS_KEY,
	AGENT_THREADS_KEY,
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

/** Spawns this review's ACP buddy (sets its spawn flag; a joined session leaves). */
export const postAgentStart = async (): Promise<void> => {
	await review<{ ok: true }>("agent/start", json("POST"));
};

/**
 * Detaches the review's agent: a joined session's attachment ends, or the
 * ACP buddy stops and its spawn flag is cleared.
 */
export const postAgentDetach = async (): Promise<void> => {
	await review<{ ok: true }>("agent/detach", json("POST"));
};

/** The access key the setup line carries (null: none needed). */
export const joinSetupQuery = queryOptions({
	queryKey: ["join-setup"],
	queryFn: () => fetchJson<{ key: string | null }>("/api/mcp/setup"),
	staleTime: Number.POSITIVE_INFINITY,
	retry: false,
});

/** The MCP URL of this crb, with its access key when one is needed. */
export const mcpUrl = (origin: string, key: string | null): string =>
	`${origin}/mcp${key ? `?${new URLSearchParams({ key })}` : ""}`;

/** The one-time setup line that adds this crb's /mcp to harness `h` (Other: the URL). */
export function mcpLine(
	h: McpHarness["id"],
	origin: string,
	key: string | null,
): string {
	const harness = MCP_HARNESSES.find((x) => x.id === h) ?? MCP_HARNESSES[0];
	return harness ? harness.line(mcpUrl(origin, key)) : mcpUrl(origin, key);
}

/** The sentence a session is told to join this review. */
export const joinLine = (origin: string, id: string): string =>
	`join the carbonless review at ${origin}/r/${encodeURIComponent(id)}`;

/** The review's agent threads; refetched when the status moves (useAgentSync). */
export const agentThreadsQuery = queryOptions({
	queryKey: AGENT_THREADS_KEY,
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
		queryKey: [
			...AGENT_PLACEMENTS_KEY,
			target,
			revision,
			[...ids].sort().join(","),
		],
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

/** The agent threads' placements in the viewed snapshot, and how they stand. */
export interface AgentPlacementsState {
	/** By thread id; null until they are in, when off, or after a failure. */
	placements: Placements | null;
	/** Asked and on their way (retries included): a spinner, never a result. */
	pending: boolean;
	/** They couldn't be computed (after the retries). */
	error: Error | null;
	/** Asks for them again. */
	retry: () => void;
	/** A retry after the error is under way. */
	retrying: boolean;
}

/**
 * The agent threads' placements in the viewed snapshot (`revision`), by
 * thread id; an answer for another snapshot is dropped (each then shows
 * where it was asked).
 */
export function useAgentPlacementsFor(args: {
	to: RereviewTo | null;
	revision: string | undefined;
	ids: readonly string[];
	enabled: boolean;
}): AgentPlacementsState {
	const { to, revision, ids } = args;
	const on =
		args.enabled && to !== null && revision !== undefined && ids.length > 0;
	const query = useQuery({
		...agentPlacementsQuery(to ?? { patchset: 1 }, revision ?? "", ids),
		enabled: on,
	});
	const { data, error, isFetching, refetch } = query;
	const placements = useMemo(
		() =>
			on && data && data.revision === revision
				? new Map(data.threads.map((t) => [t.id, t.placement]))
				: null,
		[on, data, revision],
	);
	// An answer for another snapshot (the base moved under the session):
	// asked once more, then a failure, never an endless spinner.
	const key = JSON.stringify(query.data ? [revision, data?.revision] : null);
	const mismatch =
		on && data !== undefined && data.revision !== revision && error === null;
	const [askedAgain, setAskedAgain] = useState<string | null>(null);
	useEffect(() => {
		if (!mismatch || isFetching || askedAgain === key) return;
		setAskedAgain(key);
		void refetch();
	}, [mismatch, isFetching, askedAgain, key, refetch]);
	const stale =
		mismatch && askedAgain === key && !isFetching
			? new Error("The placements came for another snapshot of this head")
			: null;
	const failure = on && placements === null ? (error ?? stale) : null;
	return {
		placements,
		pending: on && placements === null && failure === null,
		error: failure,
		retry: () => {
			setAskedAgain(null);
			void refetch();
		},
		retrying: failure !== null && isFetching,
	};
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

/** Marks a conversation seen up to the message `upTo` (a no-op when it already is). */
export const postAgentSeen = (thread: string, upTo: string) =>
	review<AgentThread>(
		`agent/threads/${encodeURIComponent(thread)}/seen`,
		json("POST", { upTo } satisfies AgentSeenRequest),
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
