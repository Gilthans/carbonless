import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentThread } from "../../shared/agent";
import type { CodeSpan } from "../files/selectionActions";
import { RETRY_DELAYS_MS } from "../files/stateSync";
import {
	askAgent,
	dropAgentWrite,
	getAgentWrites,
	replyAgent,
	resetAgentWrites,
	retryAgentWrite,
} from "./agentWrites";
import { agentStatusQuery, agentThreadsQuery } from "./api";
import {
	getAgentComposers,
	openAgentComposer,
	resetAgentComposers,
} from "./askAgentAction";

const span: CodeSpan = {
	path: "src/a.ts",
	commit: "h",
	subject: "line",
	startSide: "RIGHT",
	startLine: 3,
	side: "RIGHT",
	line: 3,
};

const thread = (id: string, text: string): AgentThread => ({
	id,
	anchor: {
		subject: "line",
		path: "src/a.ts",
		commit: "h",
		side: "RIGHT",
		line: 3,
		startSide: "RIGHT",
		startLine: 3,
	},
	openedBy: "human",
	at: "2026-11-07T10:00:00Z",
	messages: [{ id: "m1", by: "human", at: "2026-11-07T10:00:00Z", text }],
	resolved: false,
	waiting: true,
	unread: false,
});

const answer = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

let fetchMock: ReturnType<typeof vi.fn>;
let client: QueryClient;

beforeEach(() => {
	vi.useFakeTimers();
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	client = new QueryClient();
});

afterEach(() => {
	resetAgentWrites();
	resetAgentComposers();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const bodies = () =>
	fetchMock.mock.calls.map(([url, init]) => ({
		url,
		method: (init as RequestInit).method,
		body: JSON.parse(String((init as RequestInit).body ?? "null")),
	}));

describe("agent writes", () => {
	it("one press is one POST; success lists the thread and closes the composer", async () => {
		fetchMock.mockResolvedValue(answer(200, thread("T1", "why?")));
		const id = openAgentComposer(span);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		askAgent(client, span, "why?", id);
		// A second press while it is out sends nothing.
		askAgent(client, span, "why?", id);
		expect(getAgentWrites().pending.get(id)).toMatchObject({
			text: "why?",
			retrying: false,
		});
		await vi.runAllTimersAsync();
		expect(bodies()).toEqual([
			{
				url: "/api/agent/threads",
				method: "POST",
				body: {
					clientId: id,
					text: "why?",
					span: {
						subject: "line",
						path: "src/a.ts",
						commit: "h",
						side: "RIGHT",
						line: 3,
						startSide: "RIGHT",
						startLine: 3,
					},
				},
			},
		]);
		expect(client.getQueryData(agentThreadsQuery.queryKey)).toEqual({
			threads: [thread("T1", "why?")],
		});
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: agentStatusQuery.queryKey,
		});
		expect(getAgentWrites().pending.size).toBe(0);
		expect(getAgentComposers()).toEqual([]);
	});

	it("a 503 is sent again with the same clientId until it lands", async () => {
		fetchMock
			.mockResolvedValueOnce(answer(503, { error: "busy" }))
			.mockRejectedValueOnce(new TypeError("network"))
			.mockResolvedValue(answer(200, thread("T1", "why?")));
		askAgent(client, span, "why?", "c1");
		await vi.advanceTimersByTimeAsync(0);
		expect(getAgentWrites().pending.get("c1")).toMatchObject({
			retrying: true,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] ?? 0);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1] ?? 0);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(new Set(bodies().map((b) => b.body.clientId))).toEqual(
			new Set(["c1"]),
		);
		expect(getAgentWrites().pending.size).toBe(0);
		expect(client.getQueryData(agentThreadsQuery.queryKey)).toEqual({
			threads: [thread("T1", "why?")],
		});
	});

	it("a 400 lands as an inline error and is not sent again by itself", async () => {
		fetchMock.mockResolvedValue(answer(400, { error: "text is too long" }));
		askAgent(client, span, "x", "c1");
		await vi.runAllTimersAsync();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const item = getAgentWrites().pending.get("c1");
		expect(item?.error?.message).toBe("text is too long");
		expect(item?.retrying).toBe(false);
		// Retry sends it once more; drop forgets it.
		fetchMock.mockResolvedValue(answer(200, thread("T1", "x")));
		retryAgentWrite(client, "c1");
		await vi.runAllTimersAsync();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(getAgentWrites().pending.size).toBe(0);
	});

	it("a reply goes to its thread and replaces it in the list", async () => {
		client.setQueryData(agentThreadsQuery.queryKey, {
			threads: [thread("T1", "why?"), thread("T2", "and?")],
		});
		const replied = { ...thread("T1", "why?"), waiting: true };
		replied.messages = [
			...replied.messages,
			{ id: "m2", by: "human", at: "2026-11-07T10:01:00Z", text: "more" },
		];
		fetchMock.mockResolvedValue(answer(200, replied));
		replyAgent(client, "T1", "more", "r1");
		await vi.runAllTimersAsync();
		expect(bodies()).toEqual([
			{
				url: "/api/agent/threads/T1/messages",
				method: "POST",
				body: { clientId: "r1", text: "more" },
			},
		]);
		expect(
			client.getQueryData(agentThreadsQuery.queryKey)?.threads.map((t) => t.id),
		).toEqual(["T1", "T2"]);
		expect(
			client.getQueryData(agentThreadsQuery.queryKey)?.threads[0]?.messages,
		).toHaveLength(2);
	});

	it("drop stops a waiting retry", async () => {
		fetchMock.mockResolvedValue(answer(502, {}));
		askAgent(client, span, "x", "c1");
		await vi.advanceTimersByTimeAsync(0);
		dropAgentWrite("c1");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(getAgentWrites().pending.size).toBe(0);
	});
});
