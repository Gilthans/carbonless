import { queryOptions } from "@tanstack/react-query";
import type {
	DiffLine,
	FileHunks,
	PrOverview,
	ReviewView,
	SessionInfo,
	StateChange,
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
	} catch {
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
export const fetchOverview = () => request<PrOverview>("/api/overview");
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

export const overviewQuery = queryOptions({
	queryKey: ["overview"],
	queryFn: fetchOverview,
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
