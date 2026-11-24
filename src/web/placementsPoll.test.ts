// @vitest-environment jsdom
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ApiError,
	PLACEMENTS_BACKOFF_MAX_MS,
	PLACEMENTS_TRIES,
	patchsetCommitsQuery,
	placementsBackoff,
	placementsPoll,
	placementsQuery,
	REREVIEW_POLL_MS,
	retryPlacements,
} from "./api";

afterEach(() => vi.unstubAllGlobals());

const every = (q: { refetchInterval?: unknown }) =>
	q.refetchInterval as (query: unknown) => number | false;

describe("the placements poll", () => {
	it("runs while pending or while the resolved threads are joining; after an error with backoff, never after a refusal", () => {
		const at = every(placementsQuery("r", { patchset: 2 }));
		const partial = { patchset: 2, threads: [], complete: false };
		const state = (over: Record<string, unknown>) => ({
			state: { errorUpdateCount: 0, error: null, ...over },
		});
		expect(at(state({ status: "success", data: { pending: true } }))).toBe(
			REREVIEW_POLL_MS,
		);
		expect(at(state({ status: "success", data: partial }))).toBe(
			REREVIEW_POLL_MS,
		);
		expect(
			at(state({ status: "success", data: { ...partial, complete: true } })),
		).toBe(false);
		// After a failed round of PLACEMENTS_TRIES (1 s, 2 s apart): 4 s.
		expect(
			at(
				state({
					status: "error",
					data: partial,
					error: new ApiError(500, "boom"),
					errorUpdateCount: 1,
				}),
			),
		).toBe(4000);
		expect(
			at(
				state({
					status: "error",
					data: undefined,
					error: new ApiError(410, "read gone"),
					errorUpdateCount: 1,
				}),
			),
		).toBe(false);
	});

	it("backs off 1 s, 2 s, 4 s … up to 30 s; retries a server or network failure, never a refusal", () => {
		expect([1, 2, 3, 4, 5, 6, 7, 20].map(placementsBackoff)).toEqual([
			1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
		]);
		expect(PLACEMENTS_BACKOFF_MAX_MS).toBe(30_000);
		const err = new ApiError(500, "boom");
		expect(retryPlacements(0, err)).toBe(true);
		expect(retryPlacements(PLACEMENTS_TRIES - 2, err)).toBe(true);
		expect(retryPlacements(PLACEMENTS_TRIES - 1, err)).toBe(false);
		expect(retryPlacements(0, new ApiError(0, "Could not reach"))).toBe(true);
		expect(retryPlacements(0, new ApiError(410, "read gone"))).toBe(false);
		expect(retryPlacements(0, new ApiError(400, "bad"))).toBe(false);
		// The failures in a row (pending answers between them don't end
		// the run) count, and lengthen the wait.
		const failure = (n: number) =>
			Object.assign(new ApiError(500, "boom"), { inARow: n });
		expect(retryPlacements(0, failure(PLACEMENTS_TRIES - 1))).toBe(true);
		expect(retryPlacements(0, failure(PLACEMENTS_TRIES))).toBe(false);
		const after = (n: number) =>
			placementsPoll({ status: "error", error: failure(n), data: undefined });
		expect([1, 3, 4, 5, 6, 7].map(after)).toEqual([
			4000, 4000, 8000, 16000, 30000, 30000,
		]);
	});

	it("fails only after PLACEMENTS_TRIES, then asks again by itself and clears once the server answers", async () => {
		vi.useFakeTimers();
		try {
			let failing = true;
			let asked = 0;
			const shown = {
				readId: "r",
				revision: "rev",
				patchset: 2,
				threads: [],
				complete: true,
			};
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					asked++;
					return failing
						? new Response(JSON.stringify({ error: "boom" }), { status: 500 })
						: new Response(JSON.stringify(shown), { status: 200 });
				}),
			);
			const client = new QueryClient();
			const observer = new QueryObserver(
				client,
				placementsQuery("r", { patchset: 2 }),
			);
			const states: string[] = [];
			const off = observer.subscribe((r) => states.push(r.status));
			await vi.advanceTimersByTimeAsync(0);
			expect(asked).toBe(1);
			expect(observer.getCurrentResult().status).toBe("pending");
			await vi.advanceTimersByTimeAsync(1000);
			expect(asked).toBe(2);
			expect(observer.getCurrentResult().error).toBeNull();
			await vi.advanceTimersByTimeAsync(2000);
			expect(asked).toBe(PLACEMENTS_TRIES);
			expect(observer.getCurrentResult().status).toBe("error");
			// Asked again by itself 4 s later, once (a fourth failure in a
			// row: no tries at once any more).
			await vi.advanceTimersByTimeAsync(4000);
			expect(asked).toBe(PLACEMENTS_TRIES + 1);
			expect(observer.getCurrentResult().status).toBe("error");
			// The server is back: the next ask (8 s on) clears it.
			failing = false;
			await vi.advanceTimersByTimeAsync(7999);
			expect(asked).toBe(PLACEMENTS_TRIES + 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(observer.getCurrentResult().status).toBe("success");
			expect(observer.getCurrentResult().data).toEqual(shown);
			// Once in, never asked again.
			await vi.advanceTimersByTimeAsync(120_000);
			expect(asked).toBe(PLACEMENTS_TRIES + 2);
			off();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the placements it has shown when the server answers pending again", async () => {
		const shown = {
			readId: "r",
			revision: "rev",
			patchset: 2,
			threads: [
				{
					id: "T1",
					placement: { kind: "outside", path: "a", fate: "file-gone" },
				},
			],
			complete: false,
		};
		let answer: unknown = shown;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 })),
		);
		const client = new QueryClient();
		const q = placementsQuery("r", { patchset: 2 });
		expect(await client.fetchQuery(q)).toEqual(shown);
		answer = { pending: true };
		expect(await client.fetchQuery({ ...q, staleTime: 0 })).toEqual(shown);
	});
});

describe("the placements against the server's failing job (CAR-271)", () => {
	/**
	 * The server as it is: an ask with no job starts one (`pending`); the
	 * job fails `runMs` later; its error is answered to every ask for
	 * `keptMs` (0: once), then the next ask starts it anew.
	 */
	function server(runMs: number, keptMs: number) {
		let job: { failAt: number; failedAt?: number } | null = null;
		const seen = { asks: 0, jobs: 0 };
		const fetch = vi.fn(async () => {
			seen.asks++;
			const now = Date.now();
			if (job?.failedAt !== undefined && now - job.failedAt >= keptMs)
				job = null;
			if (!job) {
				seen.jobs++;
				job = { failAt: now + runMs };
				return new Response(JSON.stringify({ pending: true }), { status: 200 });
			}
			if (now >= job.failAt) {
				job.failedAt ??= now;
				return new Response(JSON.stringify({ error: "git failed" }), {
					status: 500,
				});
			}
			return new Response(JSON.stringify({ pending: true }), { status: 200 });
		});
		return { fetch, seen };
	}

	async function watch(runMs: number, keptMs: number, forMs: number) {
		vi.useFakeTimers();
		const { fetch, seen } = server(runMs, keptMs);
		vi.stubGlobal("fetch", fetch);
		const client = new QueryClient();
		const observer = new QueryObserver(
			client,
			// A key of its own: the failures in a row are kept by key.
			placementsQuery(`r-${runMs}-${keptMs}`, { patchset: 2 }),
		);
		let firstError: number | null = null;
		const start = Date.now();
		const off = observer.subscribe((r) => {
			if (r.status === "error" && firstError === null)
				firstError = Date.now() - start;
		});
		try {
			await vi.advanceTimersByTimeAsync(forMs);
			return { seen, firstError, result: observer.getCurrentResult() };
		} finally {
			off();
			client.clear();
			vi.useRealTimers();
		}
	}

	it("a job that fails, started anew on every ask (pending between failures), still reads as failed after PLACEMENTS_TRIES, and is asked for with backoff", async () => {
		const { seen, firstError } = await watch(1500, 0, 120_000);
		// Failed: the error shows, never a spinner forever.
		expect(firstError).not.toBeNull();
		expect(firstError as unknown as number).toBeLessThan(15_000);
		// Bounded: the backoff (30 s at most between failed jobs) holds the
		// jobs down; without it, one every ~3.5 s (34 in two minutes).
		expect(seen.jobs).toBeLessThanOrEqual(12);
	});

	it("a failed job's error answered for 30 s: three failures read as failed within seconds, a handful of asks, one job per 30 s", async () => {
		const { seen, firstError, result } = await watch(1500, 30_000, 120_000);
		expect(firstError).not.toBeNull();
		expect(firstError as unknown as number).toBeLessThan(6_000);
		expect(seen.jobs).toBeLessThanOrEqual(5);
		expect(seen.asks).toBeLessThanOrEqual(40);
		// Still failing at the end: never an answer made up.
		expect(
			result.data === undefined || "pending" in (result.data as object),
		).toBe(true);
	});
});

describe("the commit-count poll", () => {
	it("stops when the session read fails", () => {
		const at = every(patchsetCommitsQuery(["1 a"]));
		expect(at({ state: { status: "pending", data: undefined } })).toBe(
			REREVIEW_POLL_MS,
		);
		expect(at({ state: { status: "error", data: undefined } })).toBe(false);
	});
});
