import { type QueryClient, queryOptions } from "@tanstack/react-query";
import {
	COMMENTS_BATCH,
	type CommentsView,
	type DiffLine,
	type EditRequest,
	type FileHunks,
	type NewThreadAnswer,
	type NewThreadRequest,
	type PlacementsAnswer,
	type PrOverview,
	type ReplyRequest,
	type RereviewAnswer,
	type ResolveRequest,
	type ReviewView,
	type SessionInfo,
	type StateChange,
	type ThreadAnchorRef,
	type ThreadComment,
	type ThreadComments,
	type ThreadGone,
	type ThreadsStage,
	type ThreadsView,
	type ThreadUpdate,
	type TimelineView,
	type VerdictAnswer,
	type VerdictFacts,
	type VerdictRequest,
	type WriteError,
} from "../shared/types";

/**
 * A failed API call: the HTTP status, the server's `error` message and, for
 * refused state changes, their cluster `keys`; for refused thread writes,
 * the server's `code` and `url` (WriteError).
 */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly keys?: string[],
		readonly write?: {
			code?: WriteError["code"];
			url?: string;
			/** An edit refused as `changed`: the comment as GitHub has it now. */
			current?: ThreadComment;
		},
	) {
		super(message);
		this.name = "ApiError";
	}
}

const WRITE_CODES: readonly string[] = [
	"pending-review",
	"writes-off",
	"forbidden",
	"gone",
	"invalid",
	"changed",
	"stale",
] satisfies WriteError["code"][];

/** Enough of a ThreadComment to show it (an edit's 409 `current`). */
function isComment(value: unknown): value is ThreadComment {
	if (typeof value !== "object" || value === null) return false;
	const c = value as Partial<ThreadComment>;
	return (
		typeof c.id === "string" &&
		typeof c.body === "string" &&
		typeof c.html === "string"
	);
}

/**
 * The review this page shows (its id, from `/r/<id>`): bound once per page
 * load by the review's route (ReviewRoot), so a request still under way for
 * it can never reach another review. Unbound (component tests), the
 * review routes are asked as `/api/<x>`.
 */
let boundReview: string | null = null;

/**
 * Binds the page to review `id`; false when it already shows another (the
 * caller loads the page anew).
 */
export function bindReview(id: string): boolean {
	boundReview ??= id;
	return boundReview === id;
}

/** `/api/<x>` of the bound review: `/api/r/<id>/<x>`. */
export const reviewApiPath = (path: string): string =>
	boundReview === null
		? path
		: path.replace(/^\/api\//, `/api/r/${encodeURIComponent(boundReview)}/`);

/** A request to the review's API (`/api/<x>`, see reviewApiPath). */
const request = <T>(path: string, init?: RequestInit): Promise<T> =>
	fetchJson<T>(reviewApiPath(path), init);

/**
 * GETs (or `init`s) `path` and returns its JSON; an ApiError for a failure,
 * with the server's message.
 */
export async function fetchJson<T>(
	path: string,
	init?: RequestInit,
): Promise<T> {
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
		const { error, keys, code, url, current } = (body ?? {}) as {
			error?: unknown;
			keys?: unknown;
			code?: unknown;
			url?: unknown;
			current?: unknown;
		};
		throw new ApiError(
			response.status,
			typeof error === "string" ? error : `Request failed: ${response.status}`,
			Array.isArray(keys) && keys.every((k) => typeof k === "string")
				? keys
				: undefined,
			typeof code === "string" && WRITE_CODES.includes(code)
				? {
						code: code as WriteError["code"],
						...(typeof url === "string" ? { url } : {}),
						...(isComment(current) ? { current } : {}),
					}
				: undefined,
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
/**
 * Which review to read: the session's own (the latest patch set, or the
 * snapshot before any), an earlier patch set's as reviewed (read-only), or
 * the snapshot of a head viewed before it is a patch set (files/comparison.ts).
 */
export type ReviewTarget =
	| { kind: "current" }
	| { kind: "patchset"; number: number }
	| { kind: "head"; oid: string };

export const CURRENT_REVIEW: ReviewTarget = { kind: "current" };

const reviewPath = (target: ReviewTarget) =>
	target.kind === "current"
		? "/api/review"
		: `/api/review?${new URLSearchParams(
				target.kind === "patchset"
					? { patchset: String(target.number) }
					: { head: target.oid },
			)}`;

export const fetchReview = (target: ReviewTarget = CURRENT_REVIEW) =>
	request<ReviewView>(reviewPath(target));

/** With `from`, the since view's hunks: the interdiff from patch set `from`. */
export const fetchHunks = (revision: string, index: number, from?: number) =>
	request<FileHunks>(
		`/api/files/${index}/hunks?${new URLSearchParams({
			revision,
			...(from === undefined ? {} : { from: String(from) }),
		})}`,
	);

/** The engine's answer for patch set `from` to a patch set or a head (RereviewAnswer). */
export const fetchRereview = (from: number, to: RereviewTo) =>
	request<RereviewAnswer | { pending: true }>(
		`/api/rereview?${new URLSearchParams({
			from: String(from),
			...("patchset" in to ? { to: String(to.patchset) } : { head: to.head }),
		})}`,
	);

export type RereviewTo = { patchset: number } | { head: string };

/** Every unresolved thread of read `readId` placed into a patch set or a head. */
export const fetchPlacements = (readId: string, to: RereviewTo) =>
	request<PlacementsAnswer | { pending: true }>(
		`/api/placements?${new URLSearchParams({
			read: readId,
			...("patchset" in to ? { ps: String(to.patchset) } : { head: to.head }),
		})}`,
	);

/** The reviewer places a thread on lines of their latest patch set. */
export const postPlacement = (
	threadId: string,
	patchset: number,
	anchor: ThreadAnchorRef,
) =>
	post<PlacementsAnswer["threads"][number]>(
		`/api/threads/${encodeURIComponent(threadId)}/placement`,
		{ patchset, anchor },
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

/** Posts a reply to GitHub now (REST, never into a pending review). */
export const postReply = (threadId: string, req: ReplyRequest) =>
	post<ThreadUpdate>(
		`/api/threads/${encodeURIComponent(threadId)}/replies`,
		req,
	);

/** Starts a thread on GitHub (REST, never into a pending review). */
export const postThread = (req: NewThreadRequest) =>
	post<NewThreadAnswer>("/api/threads", req);

/** Resolves or unresolves the thread on GitHub. */
export const postResolved = (threadId: string, req: ResolveRequest) =>
	post<ThreadUpdate>(
		`/api/threads/${encodeURIComponent(threadId)}/resolved`,
		req,
	);

const commentPath = (threadId: string, commentId: string) =>
	`/api/threads/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(commentId)}`;

/** Edits the viewer's comment on GitHub (409 `changed` if it changed there since `from`). */
export const patchComment = (
	threadId: string,
	commentId: string,
	req: EditRequest,
) =>
	request<ThreadUpdate>(commentPath(threadId, commentId), {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(req),
	});

/**
 * Deletes the viewer's comment on GitHub; a thread's opener with replies
 * after it is blanked to "[deleted]" instead (the server decides).
 */
export const deleteComment = (threadId: string, commentId: string) =>
	request<ThreadUpdate | ThreadGone>(commentPath(threadId, commentId), {
		method: "DELETE",
	});

/** Submits the reviewer's verdict to GitHub: one review (Final Verdict). */
export const postVerdict = (req: VerdictRequest) =>
	post<VerdictAnswer>("/api/verdict", req);

export const fetchVerdict = () => request<VerdictFacts>("/api/verdict");

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
 * The patch sets' commit counts (`SessionInfo.patchsets[].commits`), which
 * the server counts in the background: the session read again every
 * REREVIEW_POLL_MS until every count is in, under its own key, so the
 * polls never touch the session the page runs on (the graph merges them).
 */
export const patchsetCommitsQuery = (missing: string[]) =>
	queryOptions({
		// By the counts still missing: a newly started patch set asks anew.
		queryKey: ["patchset-commits", ...missing],
		queryFn: async () => {
			const info = await fetchSession();
			return Object.fromEntries(
				info.patchsets.map((p) => [`${p.number} ${p.head}`, p.commits]),
			) as Record<string, SessionInfo["patchsets"][number]["commits"]>;
		},
		staleTime: Number.POSITIVE_INFINITY,
		refetchInterval: (query) => {
			const data = query.state.data;
			// Asked again only while a count is still being made: one that
			// failed for good, or a patch set no longer there, stops it.
			return !data || missing.some((k) => data[k] === null)
				? REREVIEW_POLL_MS
				: false;
		},
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
/** A read's comments no one shows are kept this long (a newer read drops them at once). */
const COMMENTS_KEPT_MS = 60 * 60_000;

interface Wanted {
	readId: string;
	threadId: string;
	/** Opened (someone waits on it), not only prefetched: goes first. */
	opened: boolean;
	done: Promise<ThreadComments>;
	resolve: (comments: ThreadComments) => void;
	reject: (error: unknown) => void;
}

const keyOf = (readId: string, threadId: string) => `${readId}\n${threadId}`;

/**
 * Gathers the threads whose comments are asked for in one tick into one
 * request (COMMENTS_BATCH at most), COMMENT_REQUESTS at a time, the rest
 * queued: opened threads ahead, on their own (they may take one more
 * request), then prefetched ones in the latest order asked for (`order`).
 * One asked for again while queued or on its way shares that. A read gone
 * (410), or superseded by a newer one, sends nothing more.
 */
class CommentsBatcher {
	#queue: Wanted[] = [];
	readonly #sent = new Map<string, Promise<ThreadComments>>();
	/** Prefetch order: the latest `order` call first, by position in it. */
	readonly #rank = new Map<string, { call: number; at: number }>();
	#calls = 0;
	/** Reads the server no longer keeps, with the error it said so with. */
	readonly #gone = new Map<string, unknown>();
	#current: string | undefined;
	#out = 0;
	#scheduled = false;

	load(
		readId: string,
		threadId: string,
		opened: boolean,
	): Promise<ThreadComments> {
		if (this.#gone.has(readId)) return Promise.reject(this.#gone.get(readId));
		const sent = this.#sent.get(keyOf(readId, threadId));
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

	/**
	 * Prefetched threads of `readId` go in this order, ahead of those
	 * ordered before (also those already queued).
	 */
	order(readId: string, threadIds: string[]): void {
		const call = ++this.#calls;
		threadIds.forEach((id, at) => {
			this.#rank.set(keyOf(readId, id), { call, at });
		});
	}

	/**
	 * `readId` is the read shown now: the queue of any other is dropped
	 * (each rejected), and so are its comments in `client`.
	 */
	show(client: QueryClient, readId: string): void {
		if (this.#current === readId) return;
		this.#current = readId;
		const stale = this.#queue.filter((w) => w.readId !== readId);
		this.#queue = this.#queue.filter((w) => w.readId === readId);
		// Not a 410: the overview is already the newer read.
		const error = new Error("A newer read is shown");
		for (const w of stale) w.reject(error);
		for (const key of [...this.#rank.keys()]) {
			if (!key.startsWith(`${readId}\n`)) this.#rank.delete(key);
		}
		for (const gone of [...this.#gone.keys()]) {
			if (gone !== readId) this.#gone.delete(gone);
		}
		client.removeQueries({
			queryKey: ["comments"],
			predicate: (q) => q.queryKey[1] !== readId,
		});
	}

	/** Opened ones after those opened before, ahead of the rest. */
	#enqueue(wanted: Wanted): void {
		const at = wanted.opened
			? this.#queue.findIndex((w) => !w.opened)
			: this.#queue.length;
		this.#queue.splice(at === -1 ? this.#queue.length : at, 0, wanted);
		this.#schedule();
	}

	#schedule(): void {
		if (this.#scheduled) return;
		this.#scheduled = true;
		// Whatever else is asked for in this tick joins the request.
		setTimeout(() => {
			this.#scheduled = false;
			this.#flush();
		}, 0);
	}

	/** Prefetched ones by the latest order asked for; unordered ones last. */
	#sortPrefetched(): void {
		const rank = (w: Wanted) =>
			this.#rank.get(keyOf(w.readId, w.threadId)) ?? {
				call: 0,
				at: Number.POSITIVE_INFINITY,
			};
		const opened = this.#queue.filter((w) => w.opened);
		const rest = this.#queue
			.filter((w) => !w.opened)
			.sort((a, b) => {
				const ra = rank(a);
				const rb = rank(b);
				return rb.call - ra.call || ra.at - rb.at;
			});
		this.#queue = [...opened, ...rest];
	}

	#flush(): void {
		this.#sortPrefetched();
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
		const keys = batch.map((w) => keyOf(readId, w.threadId));
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
						else
							w.reject(new ApiError(502, "The thread's comments are missing"));
					}
				},
				(error: unknown) => {
					for (const w of batch) w.reject(error);
					// The whole read is gone: nothing queued for it is sent.
					if (error instanceof ApiError && error.status === 410) {
						this.#gone.set(readId, error);
						const queued = this.#queue.filter((w) => w.readId === readId);
						this.#queue = this.#queue.filter((w) => w.readId !== readId);
						for (const w of queued) w.reject(error);
					}
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
 * Prefetches go in this order, ahead of those ordered before, also those
 * already queued (the open file first, say).
 */
export const orderComments = (
	client: QueryClient,
	readId: string,
	threadIds: string[],
) => batcherOf(client).order(readId, threadIds);

/**
 * `readId` is the read on screen: another read's queued comment requests
 * are dropped, and its comments with them.
 */
export const showCommentsOf = (client: QueryClient, readId: string) =>
	batcherOf(client).show(client, readId);

/**
 * Read `readId`'s comments of thread `threadId`, batched with the others
 * asked for (CommentsBatcher): opened by default, `prefetch` to queue in
 * order behind them. A read no longer kept (410) reads the overview again,
 * as threadsQuery does. A read's comments never change; kept an hour with
 * no one showing them, and dropped once a newer read is shown.
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
		gcTime: COMMENTS_KEPT_MS,
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

/**
 * What GitHub says about merging, for the Final Verdict tab: read the first
 * time something shows it (never on first open), again on Refresh and once
 * a verdict lands.
 */
export const verdictQuery = queryOptions({
	queryKey: ["verdict"],
	queryFn: fetchVerdict,
	staleTime: Number.POSITIVE_INFINITY,
	// What changed since the reviewer's verdict comes from the engine:
	// asked again while it computes (the server keeps its GitHub read).
	refetchInterval: (query) =>
		query.state.data?.since?.changes.status === "pending"
			? REREVIEW_POLL_MS
			: false,
});

/** Every review query's key starts with this (invalidate them all at once). */
export const REVIEW_KEY = ["review"] as const;

/**
 * The review to show: the session's own (key `["review"]`, which a stored
 * write replaces at once), an earlier patch set's, or a viewed head's.
 */
export const reviewQuery = (target: ReviewTarget = CURRENT_REVIEW) =>
	queryOptions({
		queryKey:
			target.kind === "current"
				? [...REVIEW_KEY]
				: target.kind === "patchset"
					? [...REVIEW_KEY, "ps", target.number]
					: [...REVIEW_KEY, "head", target.oid],
		queryFn: () => fetchReview(target),
	});

export const hunksQuery = (revision: string, index: number, from?: number) =>
	queryOptions({
		queryKey: ["hunks", revision, index, from ?? null],
		queryFn: () => fetchHunks(revision, index, from),
		// A revision's hunks never change.
		staleTime: Number.POSITIVE_INFINITY,
	});

/** How often the page asks again while the engine is still computing. */
export const REREVIEW_POLL_MS = 2000;

/**
 * The engine's answer for patch set `from` to `to`: polled every
 * REREVIEW_POLL_MS while `pending`, then kept (a mark on the compared
 * patch set invalidates it: the carries follow the marks).
 */
export const rereviewQuery = (from: number, to: RereviewTo) =>
	queryOptions({
		queryKey: [
			"rereview",
			from,
			...("patchset" in to ? ["ps", to.patchset] : ["head", to.head]),
		],
		queryFn: () => fetchRereview(from, to),
		staleTime: Number.POSITIVE_INFINITY,
		refetchInterval: (query) =>
			query.state.data && "pending" in query.state.data
				? REREVIEW_POLL_MS
				: false,
	});

/**
 * The threads' placements in a snapshot for one read: polled every
 * REREVIEW_POLL_MS while `pending`, then kept (a placement write updates
 * it; a new read is another key).
 */
export const placementsQuery = (readId: string, to: RereviewTo) =>
	queryOptions({
		queryKey: [
			"placements",
			readId,
			...("patchset" in to ? ["ps", to.patchset] : ["head", to.head]),
		],
		queryFn: () => fetchPlacements(readId, to),
		staleTime: Number.POSITIVE_INFINITY,
		// Asked again while pending, and while the resolved threads are
		// still joining (the unresolved ones are in already).
		refetchInterval: (query) =>
			query.state.data &&
			("pending" in query.state.data || query.state.data.complete === false)
				? REREVIEW_POLL_MS
				: false,
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
