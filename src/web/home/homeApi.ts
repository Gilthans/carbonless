import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type {
	AnnotationOp,
	HomeRow,
	HomeView,
	PeopleResult,
	RepoHome,
	SearchResult,
} from "../../shared/home";
import { fetchJson } from "../api";

// Home's calls are never a review's: fetchJson, not api.ts's request()
// (which puts a bound review's id into the path).
const request = fetchJson;

const send = <T>(method: string, path: string, body: unknown) =>
	request<T>(path, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

export const fetchHome = () => request<HomeView>("/api/home");

/** One view repo's rows; `fresh`: read from GitHub now (Refresh, Retry). */
export const fetchRepo = (
	name: string,
	fresh = false,
	signal?: AbortSignal,
) => {
	const [owner = "", repo = ""] = name.split("/");
	return request<RepoHome>(
		`/api/home/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${fresh ? "?fresh=1" : ""}`,
		signal ? { signal } : undefined,
	);
};

/** Where a row's PR is in the API and in the cache. */
export type RowKey = Pick<HomeRow, "owner" | "repo" | "number">;

export const postAnnotation = (row: RowKey, op: AnnotationOp) =>
	send<HomeRow>(
		"POST",
		`/api/home/prs/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.repo)}/${row.number}/annotations`,
		op,
	);

export const putView = (repos: string[]) =>
	send<HomeView>("PUT", "/api/home/view", { repos });

/** `only: "repos"`: the Repos group alone (the view settings' repo input). */
export const fetchSearch = (q: string, signal?: AbortSignal, only?: "repos") =>
	request<SearchResult>(
		`/api/home/search?${new URLSearchParams(only ? { q, only } : { q })}`,
		{ signal },
	);

/** The view: name, repos, viewer, started repos (no rows: repoQuery's). */
export const homeQuery = queryOptions({
	queryKey: ["home", "view"],
	queryFn: fetchHome,
	// A hand edit of the config, a review started elsewhere.
	refetchInterval: 60_000,
	// Back on the page (a phone unlocked): read again once 30 s old. The
	// app's default is off; Home's data goes stale while away.
	staleTime: 30_000,
	refetchOnWindowFocus: true,
});

/** A repo out of the view keeps its rows this long: added back, they show at once. */
export const REPO_GC_MS = 2 * 3_600_000;
/** Failing reads back off, doubling, up to this. */
export const MAX_BACKOFF_MS = 30 * 60_000;

export const repoKey = (name: string) =>
	["home", "repo", name.toLowerCase()] as const;

/**
 * How long until a repo is read again: refresh.minutes, doubled per
 * failed read in a row (the server counts them) up to MAX_BACKOFF_MS.
 */
export function repoInterval(minutes: number, data: RepoHome | undefined) {
	const base = Math.max(1, minutes) * 60_000;
	const failures = data?.failures ?? 0;
	return Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(failures, 10));
}

/**
 * One view repo's rows (owner, 2026-11-01: "Every repo PR list should have
 * its own tanstack query, so it is automatically cached and refreshed"):
 * read again every refresh.minutes and on focus once that old.
 */
export const repoQuery = (name: string, minutes: number) =>
	queryOptions({
		queryKey: repoKey(name),
		queryFn: () => fetchRepo(name),
		staleTime: Math.max(1, minutes) * 60_000,
		gcTime: REPO_GC_MS,
		refetchInterval: (query) => repoInterval(minutes, query.state.data),
		// Back on the page once that old: read again (the app's default is off).
		refetchOnWindowFocus: true,
	});

/**
 * Reads a repo from GitHub now, into its query (Refresh, Retry): a timed
 * read already out is dropped, not joined, so the answer is fresh.
 */
export const refetchRepo = async (client: QueryClient, name: string) => {
	await client.cancelQueries({ queryKey: repoKey(name) });
	return client.fetchQuery({
		queryKey: repoKey(name),
		queryFn: () => fetchRepo(name, true),
		staleTime: 0,
		gcTime: REPO_GC_MS,
	});
};

/** A repo whose reads have all failed: its rows are unknown, not none. */
export const neverRead = (data: RepoHome) =>
	data.error !== null && data.refreshedAt === null;

/** Repos picked in the view settings since their last save, per page. */
const picks = new WeakMap<QueryClient, Set<string>>();
const picksOf = (client: QueryClient) => {
	let set = picks.get(client);
	if (!set) {
		set = new Set();
		picks.set(client, set);
	}
	return set;
};

/**
 * A repo picked into the view settings' draft starts its read now, into
 * the query Home will show it from (owner, 2026-11-02: "by the time I hit
 * save it could be ready or almost ready"). Nothing shows until it's
 * saved: Home observes only the view's repos. A plain ask, so the
 * server's period and backoff hold; picked again, it asks again (the
 * server's cache answers inside its period). If its read fails and the
 * repo was saved meanwhile, that failure is never its answer: it reads
 * again, fresh, in the same fetch.
 */
export function prefetchRepo(
	client: QueryClient,
	name: string,
	minutes: number,
) {
	const key = name.toLowerCase();
	picksOf(client).add(key);
	const saved = () =>
		client.getQueryData(homeQuery.queryKey)?.view.repos.includes(key) ?? false;
	void client.prefetchQuery({
		...repoQuery(name, minutes),
		staleTime: 0,
		queryFn: async ({ signal }) => {
			try {
				const answer = await fetchRepo(name, false, signal);
				return neverRead(answer) && saved()
					? fetchRepo(name, true, signal)
					: answer;
			} catch (error) {
				if (saved() && !signal.aborted) return fetchRepo(name, true, signal);
				throw error;
			}
		},
	});
}

/** Whether `name` is picked and not yet settled by a save (tests). */
export const isPicked = (client: QueryClient, name: string) =>
	picksOf(client).has(name.toLowerCase());

/**
 * Forgets a pick (removed from the draft, the settings cancelled): a later
 * save of that repo reads it like any added repo, never trusting a pick
 * it didn't make. Its cached answer stays.
 */
export function dropPick(client: QueryClient, name: string) {
	picksOf(client).delete(name.toLowerCase());
}

/**
 * A repo a save just added: true when it was picked (prefetchRepo), and
 * then its pick's read is its answer (joined while out, used once in). A
 * pick that failed is read again now, fresh, from no data: a failed
 * prefetch never stands as the saved repo's answer, nor shows meanwhile.
 * False: never picked, the caller reads it.
 */
export function settlePick(client: QueryClient, name: string): boolean {
	const key = name.toLowerCase();
	if (!picksOf(client).delete(key)) return false;
	const state = client.getQueryState<RepoHome>(repoKey(key));
	if (!state) return false;
	if (state.fetchStatus === "fetching") return true;
	if (state.status === "error" || (state.data && neverRead(state.data))) {
		void client.resetQueries({ queryKey: repoKey(key), exact: true });
		// Synchronously out, before Home's own ask can start a plain one.
		client
			.fetchQuery({
				queryKey: repoKey(key),
				queryFn: () => fetchRepo(key, true),
				staleTime: 0,
				gcTime: REPO_GC_MS,
			})
			.catch(() => {});
	}
	return true;
}

export const searchQuery = (q: string, only?: "repos") =>
	queryOptions({
		queryKey: ["home-search", q, only ?? "all"],
		queryFn: ({ signal }) => fetchSearch(q, signal, only),
		// A GitHub search still running: ask again shortly.
		refetchInterval: (query) => (query.state.data?.pending ? 700 : false),
		staleTime: 30_000,
	});

/** Who the waiting-on input suggests for `q` (GitHub's users from 2 characters). */
export const peopleQuery = (q: string) =>
	queryOptions({
		queryKey: ["home-people", q],
		queryFn: ({ signal }) =>
			request<PeopleResult>(`/api/home/people?${new URLSearchParams({ q })}`, {
				signal,
			}),
		// The org members or GitHub's search still coming: ask again shortly.
		refetchInterval: (query) => (query.state.data?.pending ? 700 : false),
		staleTime: 30_000,
	});

const sameRow = (a: RowKey, b: RowKey) =>
	a.number === b.number &&
	a.owner.toLowerCase() === b.owner.toLowerCase() &&
	a.repo.toLowerCase() === b.repo.toLowerCase();

/** Puts a row the server answered in place of its old self, in its repo's rows. */
export function setRow(client: QueryClient, row: HomeRow) {
	client.setQueryData<RepoHome>(repoKey(`${row.owner}/${row.repo}`), (repo) =>
		repo
			? { ...repo, rows: repo.rows.map((r) => (sameRow(r, row) ? row : r)) }
			: repo,
	);
}

/** Where a PR opens: the server resolves or creates its review. */
export const prPath = (row: RowKey) =>
	`/pr/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.repo)}/${row.number}`;

/** Leaves Home for `path` (`/pr/...` shows the PR loading, then its review). */
export const goTo = (path: string) => {
	window.location.assign(path);
};
