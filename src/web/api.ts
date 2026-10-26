import { queryOptions } from "@tanstack/react-query";
import type {
	DiffLine,
	FileHunks,
	PrOverview,
	ReviewView,
	SessionInfo,
	StateChange,
	ThreadsStage,
	ThreadsView,
	TimelineView,
} from "../shared/types";

/** A failed API call: the HTTP status and the server's `error` message. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, init);
	} catch (error) {
		// Cancelled (a Refresh supersedes a re-read): not a lost server.
		if (init?.signal?.aborted) throw error;
		throw new ApiError(0, "Could not reach carbonless. Is crb still running?");
	}
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const error = (body as { error?: unknown } | null)?.error;
		throw new ApiError(
			response.status,
			typeof error === "string" ? error : `Request failed: ${response.status}`,
		);
	}
	return body as T;
}

const post = <T>(path: string, body?: unknown) =>
	request<T>(path, {
		method: "POST",
		headers: body === undefined ? {} : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

export const fetchSession = () => request<SessionInfo>("/api/session");
/**
 * The server's last overview read, or with `maxAge` (ms) one read from
 * GitHub at most that long ago.
 */
export const fetchOverview = (maxAge?: number, signal?: AbortSignal) =>
	request<PrOverview>(
		maxAge === undefined
			? "/api/overview"
			: `/api/overview?${new URLSearchParams({ maxAge: String(maxAge) })}`,
		{ signal },
	);
export const fetchReview = () => request<ReviewView>("/api/review");

export const fetchHunks = (revision: string, index: number) =>
	request<FileHunks>(
		`/api/files/${index}/hunks?${new URLSearchParams({ revision })}`,
	);

export const fetchContext = (
	revision: string,
	index: number,
	from: number,
	to: number,
) =>
	request<DiffLine[]>(
		`/api/files/${index}/context?${new URLSearchParams({
			revision,
			newFrom: String(from),
			newTo: String(to),
		})}`,
	);

/**
 * `revision` must be the ReviewView.revision the changes were made on: the
 * server answers 409 `stale` when the snapshot has moved since.
 */
export const postStates = (revision: string, changes: StateChange[]) =>
	post<ReviewView>("/api/review/states", { revision, changes });

export const postRefresh = () => post<SessionInfo>("/api/refresh");
export const fetchHead = () => request<SessionInfo>("/api/head");

/**
 * Session and overview change only through Refresh (and the head check,
 * which writes its own answer), and each overview read costs several gh
 * calls, so neither refetches on remount or tab switches.
 */
export const sessionQuery = queryOptions({
	queryKey: ["session"],
	queryFn: fetchSession,
	staleTime: Number.POSITIVE_INFINITY,
});

/**
 * The head check: polled every 5 minutes and on window focus, and each answer
 * is the new session info, so it goes straight into the session cache (the
 * banner reads it from there).
 */
export const headQuery = queryOptions({
	queryKey: ["head"],
	queryFn: async ({ client }) => {
		const info = await fetchHead();
		client.setQueryData(sessionQuery.queryKey, info);
		return info;
	},
	// Focus switching must not spam gh.
	staleTime: 30_000,
	refetchInterval: 300_000,
	refetchOnWindowFocus: true,
});

/**
 * The overview as the server last read it from GitHub (fast: it keeps it),
 * without its review threads (threadsQuery). Its age is `servedAt -
 * fetchedAt`, both the server's clock; see revalidateOverviewQuery.
 */
export const overviewQuery = queryOptions({
	queryKey: ["overview"],
	queryFn: ({ signal }) => fetchOverview(undefined, signal),
	staleTime: Number.POSITIVE_INFINITY,
});

/** How old a read is, by the server's clock (never the browser's). */
export const overviewAge = (o: Pick<PrOverview, "fetchedAt" | "servedAt">) =>
	Date.parse(o.servedAt) - Date.parse(o.fetchedAt);

/** An overview read longer ago than this is read again on load (not as of a cutoff). */
export const OVERVIEW_FRESH_MS = 15_000;

/** The stages the page asks for at once; it shows the furthest in. */
export const THREAD_STAGES: ThreadsStage[] = [
	"summary",
	"first",
	"firstCode",
	"full",
];

export const fetchThreads = (
	readId: string,
	stage: ThreadsStage,
	signal?: AbortSignal,
) =>
	request<ThreadsView>(
		`/api/threads?${new URLSearchParams({ read: readId, stage })}`,
		{ signal },
	);

/**
 * Read `readId`'s review threads once `stage` is in. A read the server no
 * longer keeps (410) reads the overview again, so the page moves to a
 * kept one.
 */
export const threadsQuery = (readId: string, stage: ThreadsStage) =>
	queryOptions({
		queryKey: ["threads", readId, stage],
		queryFn: async ({ client, signal }) => {
			try {
				return await fetchThreads(readId, stage, signal);
			} catch (error) {
				if (error instanceof ApiError && error.status === 410) {
					void client.invalidateQueries({ queryKey: overviewQuery.queryKey });
				}
				throw error;
			}
		},
		staleTime: Number.POSITIVE_INFINITY,
	});

export const fetchTimeline = (readId: string, signal?: AbortSignal) =>
	request<TimelineView>(
		`/api/timeline?${new URLSearchParams({ read: readId })}`,
		{ signal },
	);

/**
 * Read `readId`'s timeline (its own read on the server, alongside the
 * threads). A read no longer kept (410) reads the overview again.
 */
export const timelineQuery = (readId: string) =>
	queryOptions({
		queryKey: ["timeline", readId],
		queryFn: async ({ client, signal }) => {
			try {
				return await fetchTimeline(readId, signal);
			} catch (error) {
				if (error instanceof ApiError && error.status === 410) {
					void client.invalidateQueries({ queryKey: overviewQuery.queryKey });
				}
				throw error;
			}
		},
		staleTime: Number.POSITIVE_INFINITY,
	});

/**
 * Brings the overview read at `fetchedAt` up to date: asks for one read at
 * most `maxAge` ago (the server reads GitHub again if its own is older),
 * waits for all its threads, then puts both in the cache at once, so the
 * page swaps from the old read to the new one whole. The timeline isn't
 * waited for: its own query reads the new read's, keeping the old one on
 * screen meanwhile. Keyed by the read it replaces, so it runs once per
 * read; its own key is apart from the overview's so a Refresh doesn't
 * rerun it, and a Refresh cancels it.
 */
export const revalidateOverviewQuery = (fetchedAt: string, maxAge: number) =>
	queryOptions({
		queryKey: ["overview-revalidate", fetchedAt, maxAge],
		queryFn: async ({ client, signal }) => {
			const fresh = await fetchOverview(maxAge, signal);
			const threads = await fetchThreads(fresh.readId, "full", signal);
			// A Refresh may have brought a newer one meanwhile: keep that.
			const shown = client.getQueryData(overviewQuery.queryKey);
			if (
				!shown ||
				!(Date.parse(shown.fetchedAt) > Date.parse(fresh.fetchedAt))
			) {
				client.setQueryData(
					threadsQuery(fresh.readId, "full").queryKey,
					threads,
				);
				client.setQueryData(overviewQuery.queryKey, fresh);
			}
			return fresh.fetchedAt;
		},
		staleTime: Number.POSITIVE_INFINITY,
	});

export const reviewQuery = queryOptions({
	queryKey: ["review"],
	queryFn: fetchReview,
});

export const hunksQuery = (revision: string, index: number) =>
	queryOptions({
		queryKey: ["hunks", revision, index],
		queryFn: () => fetchHunks(revision, index),
		// A revision's hunks never change.
		staleTime: Number.POSITIVE_INFINITY,
	});

export const contextQuery = (
	revision: string,
	index: number,
	from: number,
	to: number,
) =>
	queryOptions({
		queryKey: ["context", revision, index, from, to],
		queryFn: () => fetchContext(revision, index, from, to),
		staleTime: Number.POSITIVE_INFINITY,
	});
