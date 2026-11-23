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
		// The failed rounds in a row lengthen the wait.
		const after = (streak: number) =>
			placementsPoll({
				status: "error",
				error: err,
				data: undefined,
				streak,
			});
		expect([1, 2, 3, 4, 5].map(after)).toEqual([
			4000, 8000, 16000, 30000, 30000,
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
			// Asked again by itself 4 s later: still failing, another round.
			await vi.advanceTimersByTimeAsync(4000 + 1000 + 2000);
			expect(asked).toBe(2 * PLACEMENTS_TRIES);
			expect(observer.getCurrentResult().status).toBe("error");
			// The server is back: the next ask (8 s on) clears it.
			failing = false;
			await vi.advanceTimersByTimeAsync(7999);
			expect(asked).toBe(2 * PLACEMENTS_TRIES);
			await vi.advanceTimersByTimeAsync(1);
			expect(observer.getCurrentResult().status).toBe("success");
			expect(observer.getCurrentResult().data).toEqual(shown);
			// Once in, never asked again.
			await vi.advanceTimersByTimeAsync(120_000);
			expect(asked).toBe(2 * PLACEMENTS_TRIES + 1);
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

describe("the commit-count poll", () => {
	it("stops when the session read fails", () => {
		const at = every(patchsetCommitsQuery(["1 a"]));
		expect(at({ state: { status: "pending", data: undefined } })).toBe(
			REREVIEW_POLL_MS,
		);
		expect(at({ state: { status: "error", data: undefined } })).toBe(false);
	});
});
