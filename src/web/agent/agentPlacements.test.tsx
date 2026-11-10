// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPlacementsAnswer } from "../../shared/agent";
import type { RereviewTo } from "../api";
import { useAgentPlacementsFor } from "./api";

const HEAD = "a".repeat(40);
const placed = (line: number) => ({
	kind: "placed" as const,
	anchor: {
		path: "a.ts",
		startSide: "RIGHT" as const,
		startLine: line,
		side: "RIGHT" as const,
		line,
	},
	changed: false as const,
});
const answer = (revision: string, line: number): AgentPlacementsAnswer => ({
	revision,
	threads: [{ id: "A1", placement: placed(line) }],
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function mount(
	respond: (n: number) => Response | Promise<Response>,
	first: { revision: string },
) {
	let calls = 0;
	const fetchMock = vi.fn(async () => respond(++calls));
	vi.stubGlobal("fetch", fetchMock);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const to: RereviewTo = { head: HEAD };
	const hook = renderHook(
		(p: { revision: string }) =>
			useAgentPlacementsFor({
				to,
				revision: p.revision,
				ids: ["A1"],
				enabled: true,
			}),
		{ wrapper, initialProps: first },
	);
	return { hook, fetchMock };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

describe("useAgentPlacementsFor", () => {
	it("a new snapshot of the same head (the base moved, a Refresh) asks again, and never uses the old answer meanwhile", async () => {
		let release: (r: Response) => void = () => {};
		const { hook, fetchMock } = mount(
			(n) =>
				n === 1
					? json(answer("r1", 5))
					: new Promise<Response>((r) => {
							release = r;
						}),
			{ revision: "r1" },
		);
		await waitFor(() =>
			expect(hook.result.current.placements?.get("A1")).toEqual(placed(5)),
		);
		hook.rerender({ revision: "r2" });
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		// Held: r1's placements are not r2's.
		expect(hook.result.current.placements).toBeNull();
		release(json(answer("r2", 7)));
		await waitFor(() =>
			expect(hook.result.current.placements?.get("A1")).toEqual(placed(7)),
		);
	});

	it("an answer for another snapshot than the viewed one is dropped: asked once more, then a failure (never an endless spinner)", async () => {
		const { hook, fetchMock } = mount(() => json(answer("other", 5)), {
			revision: "r1",
		});
		await waitFor(() => expect(hook.result.current.error).not.toBeNull());
		expect(hook.result.current.pending).toBe(false);
		expect(hook.result.current.placements).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("a second ask that answers the viewed snapshot is used", async () => {
		const { hook, fetchMock } = mount(
			(n) => json(answer(n === 1 ? "other" : "r1", 5)),
			{ revision: "r1" },
		);
		await waitFor(() =>
			expect(hook.result.current.placements?.get("A1")).toEqual(placed(5)),
		);
		expect(hook.result.current.error).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("a transient failure is retried, not left outdated until a reload", async () => {
		const { hook, fetchMock } = mount(
			(n) => (n === 1 ? json({ error: "boom" }, 500) : json(answer("r1", 5))),
			{ revision: "r1" },
		);
		await waitFor(
			() =>
				expect(hook.result.current.placements?.get("A1")).toEqual(placed(5)),
			{ timeout: 5000 },
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("useAgentPlacementsFor's state", () => {
	it("pending while the answer is on its way (never a result), then the placements", async () => {
		let release: (r: Response) => void = () => {};
		const { hook } = mount(
			() =>
				new Promise<Response>((r) => {
					release = r;
				}),
			{ revision: "r1" },
		);
		await waitFor(() => expect(hook.result.current.pending).toBe(true));
		expect(hook.result.current.placements).toBeNull();
		expect(hook.result.current.error).toBeNull();
		release(json(answer("r1", 5)));
		await waitFor(() => expect(hook.result.current.pending).toBe(false));
		expect(hook.result.current.placements?.get("A1")).toEqual(placed(5));
	});

	it("a failure that outlasts the retries is an error (not pending), with a retry that asks again", async () => {
		let fail = true;
		const { hook, fetchMock } = mount(
			() => (fail ? json({ error: "boom" }, 500) : json(answer("r1", 5))),
			{ revision: "r1" },
		);
		await waitFor(() => expect(hook.result.current.error).not.toBeNull(), {
			timeout: 10_000,
		});
		expect(hook.result.current.pending).toBe(false);
		expect(hook.result.current.placements).toBeNull();
		const asked = fetchMock.mock.calls.length;
		fail = false;
		hook.result.current.retry();
		await waitFor(() =>
			expect(hook.result.current.placements?.get("A1")).toEqual(placed(5)),
		);
		expect(fetchMock.mock.calls.length).toBeGreaterThan(asked);
	}, 20_000);
});
