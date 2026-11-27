import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoHome } from "../../shared/home";
import {
	askOf,
	homeQuery,
	PROGRESS_ERROR_MS,
	PROGRESS_POLL_MS,
	prefetchRepo,
	repoInterval,
	repoKey,
	repoRefetchInterval,
} from "./homeApi";

afterEach(() => {
	vi.unstubAllGlobals();
});

const answer = (over: Partial<RepoHome> = {}): RepoHome => ({
	repo: "acme/api",
	rows: [],
	refreshedAt: "2026-11-24T12:00:00Z",
	error: null,
	failures: 0,
	...over,
});

describe("a repo's next ask (CAR-290 fix round 1)", () => {
	it("while a first read lands: at once; after a failed ask, PROGRESS_ERROR_MS (never 10 a second)", () => {
		const landing = answer({ complete: false, progress: 2, refreshedAt: null });
		expect(repoRefetchInterval(2, { status: "success", data: landing })).toBe(
			PROGRESS_POLL_MS,
		);
		expect(repoRefetchInterval(2, { status: "error", data: landing })).toBe(
			PROGRESS_ERROR_MS,
		);
		expect(PROGRESS_ERROR_MS).toBeGreaterThanOrEqual(5_000);
		// Whole: refresh.minutes, as before.
		const whole = answer({ complete: true });
		expect(repoRefetchInterval(2, { status: "error", data: whole })).toBe(
			repoInterval(2, whole),
		);
	});

	it("says what the page shows: the batches seen, or a whole list (never cut to a batch)", () => {
		expect(askOf(undefined)).toEqual({});
		expect(askOf(answer({ complete: false, progress: 3 }))).toEqual({
			seen: 3,
		});
		expect(askOf(answer({ complete: true }))).toEqual({ whole: true });
		// An older answer without `complete` is whole.
		expect(askOf(answer())).toEqual({ whole: true });
		// Rows of a first read that failed: not whole, the next read may show batches.
		expect(askOf(answer({ error: "boom", refreshedAt: null }))).toEqual({});
	});
});

describe("a pick's prefetch (CAR-290 fix round 2)", () => {
	it("its fallback after a failed ask still says the list it holds is whole", async () => {
		const client = new QueryClient();
		client.setQueryData(homeQuery.queryKey, {
			viewer: { login: "dan", avatarUrl: "" },
			view: { name: "My PRs", repos: ["acme/web"] },
			configProblems: [],
			viewerError: null,
			refreshMinutes: 2,
			startedRepos: [],
		});
		client.setQueryData(repoKey("acme/web"), answer({ repo: "acme/web" }));
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				urls.push(url);
				return urls.length === 1
					? new Response(JSON.stringify({ error: "Bad gateway" }), {
							status: 502,
						})
					: new Response(JSON.stringify(answer({ repo: "acme/web" })), {
							status: 200,
						});
			}),
		);
		prefetchRepo(client, "acme/web", 2);
		await vi.waitFor(() => expect(urls).toHaveLength(2));
		expect(urls).toEqual([
			"/api/home/repos/acme/web?whole=1",
			"/api/home/repos/acme/web?fresh=1&whole=1",
		]);
		client.clear();
	});
});
