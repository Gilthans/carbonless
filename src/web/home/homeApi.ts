import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type {
	AnnotationOp,
	HomeRow,
	HomeView,
	SearchResult,
} from "../../shared/home";
import { ApiError } from "../api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, init);
	} catch (error) {
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

const send = <T>(method: string, path: string, body: unknown) =>
	request<T>(path, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

export const fetchHome = () => request<HomeView>("/api/home");
/** Refreshes from GitHub (joins one in flight) and answers the new view. */
export const postHomeRefresh = () =>
	request<HomeView>("/api/home/refresh", { method: "POST" });

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

export const fetchSearch = (q: string, signal?: AbortSignal) =>
	request<SearchResult>(`/api/home/search?${new URLSearchParams({ q })}`, {
		signal,
	});

export const homeQuery = queryOptions({
	queryKey: ["home"],
	queryFn: fetchHome,
	// The server refreshes on its own: pick up what it found (and snoozes
	// whose date has passed) while the page stays open.
	refetchInterval: 60_000,
});

export const searchQuery = (q: string) =>
	queryOptions({
		queryKey: ["home-search", q],
		queryFn: ({ signal }) => fetchSearch(q, signal),
		// A GitHub search still running: ask again shortly.
		refetchInterval: (query) => (query.state.data?.pending ? 700 : false),
		staleTime: 30_000,
	});

const sameRow = (a: RowKey, b: RowKey) =>
	a.number === b.number &&
	a.owner.toLowerCase() === b.owner.toLowerCase() &&
	a.repo.toLowerCase() === b.repo.toLowerCase();

/** Puts a row the server answered in place of its old self, in its section. */
export function setRow(client: QueryClient, row: HomeRow) {
	client.setQueryData<HomeView>(homeQuery.queryKey, (view) =>
		view
			? {
					...view,
					sections: view.sections.map((s) => ({
						...s,
						rows: s.rows.map((r) => (sameRow(r, row) ? row : r)),
					})),
				}
			: view,
	);
}

/** Where a PR opens: the server resolves or creates its review. */
export const prPath = (row: RowKey) =>
	`/pr/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.repo)}/${row.number}`;

/** Leaves the page (a server route: `/pr/...` redirects to the review). */
export const goTo = (path: string) => {
	window.location.assign(path);
};
