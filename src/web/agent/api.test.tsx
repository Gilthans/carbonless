// @vitest-environment jsdom
import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_POLL_MS, type AgentStatus } from "../../shared/agent";
import {
	AGENT_HIDDEN_POLL_MS,
	agentStatusQuery,
	answerJoin,
	joinLine,
	mcpAddLine,
	shellWord,
} from "./api";

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
		// Hidden: the slow poll only (a join request still reaches the tab).
		// Its interval runs from the answer read while hidden.
		await act(async () =>
			vi.advanceTimersByTimeAsync(AGENT_HIDDEN_POLL_MS - 1),
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(fetchMock).toHaveBeenCalledTimes(3);
		await act(async () => hold?.());
		const hiddenCalls = fetchMock.mock.calls.length;
		// Back: polling again.
		act(() => setVisibility("visible"));
		await act(async () => hold?.());
		await act(async () => vi.advanceTimersByTimeAsync(2 * AGENT_POLL_MS));
		await act(async () => hold?.());
		expect(fetchMock.mock.calls.length).toBeGreaterThan(hiddenCalls);
	});
});

describe("answering a join request", () => {
	const answer = (status: number, body: unknown) => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify(body), { status }),
		);
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	};

	it("posts the answer to the request", async () => {
		const fetchMock = answer(200, { ok: true });
		expect(await answerJoin("01abc", true)).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/agent/join/01abc",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ approve: true }),
			}),
		);
	});

	it("a 409 is an answer: stale (another tab), or elsewhere with the port", async () => {
		answer(409, { error: "already answered", code: "stale-join" });
		expect(await answerJoin("01abc", false)).toEqual({
			ok: false,
			code: "stale-join",
		});
		answer(409, { error: "Another server", code: "elsewhere", port: 4748 });
		expect(await answerJoin("01abc", true)).toEqual({
			ok: false,
			code: "elsewhere",
			port: 4748,
			error: "Another server",
		});
	});

	it("another failure throws", async () => {
		answer(400, { error: "approve must be true or false" });
		await expect(answerJoin("01abc", true)).rejects.toThrow(
			"approve must be true or false",
		);
	});
});

describe("the join lines", () => {
	it("the setup line quotes the URL for the shell (zsh globs an unquoted ?)", () => {
		expect(mcpAddLine("http://100.1.2.3:4747", "k3y")).toBe(
			'claude mcp add --transport http crb "http://100.1.2.3:4747/mcp?key=k3y"',
		);
		expect(mcpAddLine("http://127.0.0.1:4747", null)).toBe(
			'claude mcp add --transport http crb "http://127.0.0.1:4747/mcp"',
		);
	});

	it("a key with shell characters is encoded in the URL and can't break out", () => {
		const line = mcpAddLine("http://h:1", `a"$(rm -rf ~)\`'b`);
		expect(line).toBe(
			`claude mcp add --transport http crb "http://h:1/mcp?key=a%22%24%28rm+-rf+%7E%29%60%27b"`,
		);
	});

	it("shellWord single-quotes anything that would expand in double quotes", () => {
		expect(shellWord("plain?x=1&y")).toBe('"plain?x=1&y"');
		expect(shellWord("a$b")).toBe("'a$b'");
		expect(shellWord("it's `x`")).toBe("'it'\\''s `x`'");
		expect(shellWord('say "hi"!')).toBe(`'say "hi"!'`);
	});

	it("the join line names the review's link", () => {
		expect(joinLine("http://h:4747", "k3f9x2m8")).toBe(
			"join the carbonless review at http://h:4747/r/k3f9x2m8",
		);
		expect(joinLine("http://h:4747", "a/../b")).toBe(
			"join the carbonless review at http://h:4747/r/a%2F..%2Fb",
		);
	});
});
