// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heldJson } from "../../../test/loading";
import type { AgentThread } from "../../shared/agent";
import { overviewQuery } from "../api";
import {
	reviewConversation,
	useReviewConversation,
} from "./reviewConversation";

const span: AgentThread = {
	id: "S1",
	anchor: { subject: "file", path: "a.ts", commit: "h" },
	openedBy: "human",
	at: "2026-11-15T10:00:00Z",
	messages: [],
	resolved: false,
	waiting: false,
	unread: false,
};
const onThread: AgentThread = {
	...span,
	id: "C1",
	anchor: { subject: "thread", thread: "RT1", path: "a.ts", commit: "h" },
};
const whole: AgentThread = {
	...span,
	id: "R1",
	anchor: { subject: "review" },
	messages: [
		{ id: "m1", by: "human", at: "2026-11-15T10:00:00Z", text: "all ok?" },
	],
	waiting: true,
};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("reviewConversation", () => {
	it("picks the review thread out of a mixed list", () => {
		expect(reviewConversation([span, onThread, whole])).toBe(whole);
		expect(reviewConversation([span, onThread])).toBeUndefined();
		expect(reviewConversation([])).toBeUndefined();
	});
});

describe("useReviewConversation", () => {
	const wrap = (client: QueryClient) => (p: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client }, p.children);

	it("reports loading, not 'no conversation', until the threads answer", async () => {
		const held = heldJson();
		const fetchMock = vi.fn(() => held.response);
		vi.stubGlobal("fetch", fetchMock);
		const client = new QueryClient();
		client.setQueryData(overviewQuery.queryKey, { writes: "on" } as never);
		const { result } = renderHook(() => useReviewConversation(), {
			wrapper: wrap(client),
		});
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(result.current).toEqual({
			thread: undefined,
			loading: true,
			failed: false,
		});
		held.release({ threads: [span, whole] });
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current).toEqual({
			thread: whole,
			loading: false,
			failed: false,
		});
	});

	it("is loading while the overview hasn't said whether the review has an agent", () => {
		const fetchMock = vi.fn(() => new Promise(() => {}));
		vi.stubGlobal("fetch", fetchMock);
		const { result } = renderHook(() => useReviewConversation(), {
			wrapper: wrap(new QueryClient()),
		});
		expect(result.current.loading).toBe(true);
		expect(result.current.thread).toBeUndefined();
	});

	it("an answer with none is no conversation, no longer loading", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ threads: [span] }), { status: 200 }),
			),
		);
		const client = new QueryClient();
		client.setQueryData(overviewQuery.queryKey, { writes: "on" } as never);
		const { result } = renderHook(() => useReviewConversation(), {
			wrapper: wrap(client),
		});
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current).toEqual({
			thread: undefined,
			loading: false,
			failed: false,
		});
	});

	it("a failed read is failed, never 'no conversation'", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
			),
		);
		const client = new QueryClient();
		client.setQueryData(overviewQuery.queryKey, { writes: "on" } as never);
		const { result } = renderHook(() => useReviewConversation(), {
			wrapper: wrap(client),
		});
		await waitFor(() => expect(result.current.failed).toBe(true));
		expect(result.current.loading).toBe(false);
		expect(result.current.thread).toBeUndefined();
	});

	it("no agent on this review (viewer, as-of): neither loading nor asked", () => {
		const fetchMock = vi.fn(() => new Promise(() => {}));
		vi.stubGlobal("fetch", fetchMock);
		const client = new QueryClient();
		client.setQueryData(overviewQuery.queryKey, { writes: "off" } as never);
		const { result } = renderHook(() => useReviewConversation(), {
			wrapper: wrap(client),
		});
		expect(result.current).toEqual({
			thread: undefined,
			loading: false,
			failed: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
