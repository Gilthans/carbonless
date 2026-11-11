import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { patchsetCommitsQuery, placementsQuery, REREVIEW_POLL_MS } from "./api";

afterEach(() => vi.unstubAllGlobals());

const every = (q: { refetchInterval?: unknown }) =>
	q.refetchInterval as (query: unknown) => number | false;

describe("the placements poll", () => {
	it("runs while pending or while the resolved threads are joining, and never after an error", () => {
		const at = every(placementsQuery("r", { patchset: 2 }));
		const partial = { patchset: 2, threads: [], complete: false };
		expect(at({ state: { status: "success", data: { pending: true } } })).toBe(
			REREVIEW_POLL_MS,
		);
		expect(at({ state: { status: "success", data: partial } })).toBe(
			REREVIEW_POLL_MS,
		);
		expect(
			at({
				state: { status: "success", data: { ...partial, complete: true } },
			}),
		).toBe(false);
		expect(at({ state: { status: "error", data: partial } })).toBe(false);
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
