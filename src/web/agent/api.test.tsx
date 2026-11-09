// @vitest-environment jsdom
import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_POLL_MS, type AgentStatus } from "../../shared/agent";
import { agentStatusQuery } from "./api";

const status: AgentStatus = {
	state: "ready",
	configured: true,
	since: "2026-11-07T10:00:00Z",
	waiting: 0,
};

let visibility: DocumentVisibilityState = "visible";
const setVisibility = (v: DocumentVisibilityState) => {
	visibility = v;
	document.dispatchEvent(new Event("visibilitychange"));
};

function Poll() {
	useQuery(agentStatusQuery);
	return null;
}

beforeEach(() => {
	vi.useFakeTimers();
	visibility = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visibility,
	);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("the status poll", () => {
	it("keeps polling after an answer lands while the tab is hidden", async () => {
		// The app's own defaults: no refetch on focus.
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, refetchOnWindowFocus: false },
			},
		});
		let hold: (() => void) | undefined;
		const fetchMock = vi.fn(
			() =>
				new Promise<Response>((done) => {
					hold = () => done(new Response(JSON.stringify(status)));
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		render(
			<QueryClientProvider client={client}>
				<Poll />
			</QueryClientProvider>,
		);
		await act(async () => hold?.());
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// A poll goes out, the tab is hidden while it is answered.
		await act(async () => vi.advanceTimersByTimeAsync(AGENT_POLL_MS));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		act(() => setVisibility("hidden"));
		await act(async () => hold?.());
		// Hidden: no poll.
		await act(async () => vi.advanceTimersByTimeAsync(3 * AGENT_POLL_MS));
		const hiddenCalls = fetchMock.mock.calls.length;
		expect(hiddenCalls).toBe(2);
		// Back: polling again.
		act(() => setVisibility("visible"));
		await act(async () => hold?.());
		await act(async () => vi.advanceTimersByTimeAsync(2 * AGENT_POLL_MS));
		await act(async () => hold?.());
		expect(fetchMock.mock.calls.length).toBeGreaterThan(hiddenCalls);
	});
});
