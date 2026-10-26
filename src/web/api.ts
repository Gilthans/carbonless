import { type QueryClient, queryOptions } from "@tanstack/react-query";
import {
	COMMENTS_BATCH,
	type CommentsView,
	type DiffLine,
	type FileHunks,
	type PrOverview,
	type ReviewView,
	type SessionInfo,
	type StateChange,
	type ThreadComments,
	type ThreadsStage,
	type ThreadsView,
	type TimelineView,
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

export const fetchComments = (readId: string, ids: string[]) =>
	request<CommentsView>(
		`/api/comments?${new URLSearchParams({ read: readId, ids: ids.join(",") })}`,
	);

/** Comment requests out at once; an opened thread's may take one more. */
const COMMENT_REQUESTS = 2;

interface Wanted {
	readId: string;
	threadId: string;
	/** Opened (someone waits on it), not only prefetched: goes first. */
	opened: boolean;
	done: Promise<ThreadComments>;
	resolve: (comments: ThreadComments) => void;
	reject: (error: unknown) => void;
}

/**
 * Gathers the threads whose comments are asked for in one tick into one
 * request (COMMENTS_BATCH at most), COMMENT_REQUESTS at a time, the rest
 * queued in the order asked. Opened threads go ahead of the queue, on
 * their own, and may take one more request; one asked for again while
 * queued or on its way shares that.
 */
class CommentsBatcher {
	#queue: Wanted[] = [];
	readonly #sent = new Map<string, Promise<ThreadComments>>();
	#out = 0;
	#scheduled = false;

	load(
		readId: string,
		threadId: string,
		opened: boolean,
	): Promise<ThreadComments> {
		const key = `${readId}\n${threadId}`;
		const sent = this.#sent.get(key);
		if (sent) return sent;
		const queued = this.#queue.find(
			(w) => w.readId === readId && w.threadId === threadId,
		);
		if (queued) {
			if (opened && !queued.opened) {
				this.#queue = this.#queue.filter((w) => w !== queued);
				this.#enqueue({ ...queued, opened: true });
			}
			return queued.done;
		}
		let resolve!: Wanted["resolve"];
		let reject!: Wanted["reject"];
		const done = new Promise<ThreadComments>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		this.#enqueue({ readId, threadId, opened, done, resolve, reject });
		return done;
	}

	/** Opened ones after those opened before, ahead of the rest. */
	#enqueue(wanted: Wanted): void {
		const at = wanted.opened
			? this.#queue.findIndex((w) => !w.opened)
			: this.#queue.length;
		this.#queue.splice(at === -1 ? this.#queue.length : at, 0, wanted);
		if (this.#scheduled) return;
		this.#scheduled = true;
		// Whatever else is asked for in this tick joins the request.
		setTimeout(() => {
			this.#scheduled = false;
			this.#flush();
		}, 0);
	}

	#flush(): void {
		for (;;) {
			const head = this.#queue[0];
			if (!head) return;
			if (this.#out >= COMMENT_REQUESTS + (head.opened ? 1 : 0)) return;
			const batch = this.#queue
				.filter((w) => w.readId === head.readId && w.opened === head.opened)
				.slice(0, COMMENTS_BATCH);
			this.#queue = this.#queue.filter((w) => !batch.includes(w));
			this.#send(head.readId, batch);
		}
	}

	#send(readId: string, batch: Wanted[]): void {
		const keys = batch.map((w) => `${readId}\n${w.threadId}`);
		for (const [i, w] of batch.entries()) this.#sent.set(keys[i] ?? "", w.done);
		this.#out++;
		fetchComments(
			readId,
			batch.map((w) => w.threadId),
		)
			.then(
				(view) => {
					const byId = new Map(view.threads.map((t) => [t.threadId, t]));
					for (const w of batch) {
						const found = byId.get(w.threadId);
						// Left out of the answer: an error, never an empty thread.
						if (found) w.resolve(found);
						else w.reject(new ApiError(0, "The thread's comments are missing"));
					}
				},
				(error: unknown) => {
					for (const w of batch) w.reject(error);
				},
			)
			.finally(() => {
				for (const key of keys) this.#sent.delete(key);
				this.#out--;
				this.#flush();
			});
	}
}

const batchers = new WeakMap<QueryClient, CommentsBatcher>();
const batcherOf = (client: QueryClient) => {
	let batcher = batchers.get(client);
	if (!batcher) {
		batcher = new CommentsBatcher();
		batchers.set(client, batcher);
	}
	return batcher;
};

/**
 * A thread someone opened: its comments go ahead of the queue (also when
 * a prefetch already queued them).
 */
export const openComments = (
	client: QueryClient,
	readId: string,
	threadId: string,
) => batcherOf(client).load(readId, threadId, true);

/**
 * Read `readId`'s comments of thread `threadId`, batched with the others
 * asked for (CommentsBatcher): opened by default, `prefetch` to queue in
 * order behind them. A read no longer kept (410) reads the overview again,
 * as threadsQuery does. Kept for good: a read's comments never change.
 */
export const commentsQuery = (
	readId: string,
	threadId: string,
	prefetch = false,
) =>
	queryOptions({
		queryKey: ["comments", readId, threadId],
		queryFn: async ({ client }) => {
			try {
				return await batcherOf(client).load(readId, threadId, !prefetch);
			} catch (error) {
				if (error instanceof ApiError && error.status === 410) {
					void client.invalidateQueries(
						{ queryKey: overviewQuery.queryKey },
						{ cancelRefetch: false },
					);
				}
				throw error;
			}
		},
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
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
