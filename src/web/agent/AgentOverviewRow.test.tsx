// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectLoadingThen, heldJson } from "../../../test/loading";
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
		client.setQueryData(reviewQuery().queryKey, {
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

	const client = () => {
		const c = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		c.setQueryData(agentStatusQuery.queryKey, {
			state: "ready",
			configured: true,
			since: "2026-11-07T10:00:00Z",
			waiting: 1,
		} satisfies AgentStatus);
		c.setQueryData(sessionQuery.queryKey, {
			snapshotHead: HEAD,
		} as SessionInfo);
		return c;
	};
	const mount = (c: QueryClient) =>
		render(
			<QueryClientProvider client={c}>
				<AgentOverviewRow />
			</QueryClientProvider>,
		);

	it("a skeleton while the threads load, never a 0; then the counts", async () => {
		const held = heldJson();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/agent/threads")) return held.response;
				throw new Error(`unexpected ${url}`);
			}),
		);
		mount(client());
		await expectLoadingThen({
			loading: () => screen.queryByTestId("agent-overview-loading"),
			empty: [() => screen.queryByTestId("agent-overview-counts")],
			release: () =>
				held.release({ threads: [thread("A1", "src/kept.ts", HEAD)] }),
			result: () => screen.queryByTestId("agent-overview-counts"),
		});
		expect(screen.getByTestId("agent-overview-counts")).toHaveTextContent(
			"1 open · 1 waiting",
		);
	});

	it("a spinner while the files load for a thread on an earlier head; then its card", async () => {
		const held = heldJson();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/review")) return held.response;
				throw new Error(`unexpected ${url}`);
			}),
		);
		const c = client();
		c.setQueryData(agentThreadsQuery.queryKey, {
			threads: [thread("A3", "src/gone.ts", OLD)],
		});
		mount(c);
		await expectLoadingThen({
			loading: () => screen.queryByRole("status", { name: "Loading files" }),
			release: () => held.release({ files: [{ path: "src/kept.ts" }] }),
			result: () => screen.queryByTestId("agent-overview-gone"),
		});
	});

	it("files that fail to load say so, never as if no thread were on a gone file", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "git broke" }), { status: 500 }),
			),
		);
		const c = client();
		c.setQueryData(agentThreadsQuery.queryKey, {
			threads: [thread("A3", "src/gone.ts", OLD)],
		});
		mount(c);
		const alert = await screen.findByTestId("agent-overview-gone-error");
		expect(alert).toHaveAttribute("role", "alert");
		expect(alert).toHaveTextContent("git broke");
		expect(screen.queryByTestId("agent-overview-gone")).toBeNull();
		expect(screen.queryByRole("status", { name: "Loading files" })).toBeNull();
		expect(screen.getByTestId("agent-overview-counts")).toHaveTextContent(
			"1 open · 1 waiting",
		);
	});
});
