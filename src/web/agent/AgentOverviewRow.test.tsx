// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus, AgentThread } from "../../shared/agent";
import type { ReviewView, SessionInfo } from "../../shared/types";
import { reviewQuery, sessionQuery } from "../api";
import { AgentOverviewRow } from "./AgentOverviewRow";
import { agentStatusQuery, agentThreadsQuery } from "./api";

const HEAD = "f".repeat(40);
const OLD = "e".repeat(40);

const thread = (id: string, path: string, commit: string): AgentThread => ({
	id,
	anchor: { subject: "file", path, commit },
	openedBy: "human",
	at: "2026-11-07T10:00:00Z",
	messages: [
		{
			id: `${id}m`,
			by: "human",
			at: "2026-11-07T10:00:00Z",
			text: `about ${path}`,
		},
	],
	resolved: false,
	waiting: true,
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("AgentOverviewRow", () => {
	it("counts every thread and lists those on a file gone from the diff, outdated", () => {
		vi.stubGlobal("fetch", vi.fn());
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(agentStatusQuery.queryKey, {
			state: "ready",
			configured: true,
			since: "2026-11-07T10:00:00Z",
			waiting: 2,
		} satisfies AgentStatus);
		client.setQueryData(sessionQuery.queryKey, {
			snapshotHead: HEAD,
		} as SessionInfo);
		client.setQueryData(reviewQuery.queryKey, {
			files: [{ path: "src/kept.ts" }],
		} as ReviewView);
		client.setQueryData(agentThreadsQuery.queryKey, {
			threads: [
				thread("A1", "src/kept.ts", HEAD),
				thread("A2", "src/kept.ts", OLD),
				thread("A3", "src/gone.ts", OLD),
			],
		});
		render(
			<QueryClientProvider client={client}>
				<AgentOverviewRow />
			</QueryClientProvider>,
		);
		expect(screen.getByTestId("agent-overview-counts")).toHaveTextContent(
			"3 open · 3 waiting",
		);
		const gone = screen.getByTestId("agent-overview-gone");
		const cards = within(gone).getAllByTestId("agent-thread");
		expect(cards).toHaveLength(1);
		expect(cards[0]).toHaveTextContent("about src/gone.ts");
		expect(
			within(cards[0] as HTMLElement).getByRole("img", {
				name: "Asked on an earlier version (eeeeeee)",
			}),
		).toBeTruthy();
	});
});
