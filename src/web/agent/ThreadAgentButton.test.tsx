// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentThread } from "../../shared/agent";
import type { PrOverview, ReviewThread } from "../../shared/types";
import { overviewQuery } from "../api";
import { agentThreadsQuery } from "./api";
import { ThreadAgentButton } from "./ThreadAgentButton";
import { conversation, reviewThread } from "./threadAgentFixtures";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function show(
	props: {
		thread?: ReviewThread;
		conversation?: AgentThread;
		open?: boolean;
	},
	opts: {
		writes?: PrOverview["writes"];
		threads?: AgentThread[] | null;
		fetch?: () => Promise<Response>;
	} = {},
) {
	const fetchMock = vi.fn(opts.fetch ?? (() => new Promise(() => {})));
	vi.stubGlobal("fetch", fetchMock);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(overviewQuery.queryKey, {
		writes: opts.writes ?? "on",
	} as PrOverview);
	if (opts.threads !== null) {
		client.setQueryData(agentThreadsQuery.queryKey, {
			threads: opts.threads ?? [],
		});
	}
	const onToggle = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<ThreadAgentButton
				thread={props.thread ?? reviewThread()}
				conversation={props.conversation}
				open={props.open ?? false}
				onToggle={onToggle}
			/>
		</QueryClientProvider>,
	);
	return Object.assign(onToggle, { fetchMock });
}

describe("ThreadAgentButton", () => {
	it("dashed sparkle named Ask agent with no conversation", () => {
		const onToggle = show({});
		const button = screen.getByRole("button", { name: "Ask agent" });
		expect(button.className).toContain("border-dashed");
		expect(button.textContent).toBe("");
		button.click();
		expect(onToggle).toHaveBeenCalledOnce();
	});

	it("count and accessible name with a conversation; accent dot and ', 1 new' when unread", () => {
		show({ conversation: conversation() });
		const button = screen.getByRole("button", { name: "4 agent messages" });
		expect(button).toHaveTextContent("4");
		expect(button.className).not.toContain("border-dashed");
		expect(screen.queryByTestId("agent-unread-dot")).toBeNull();
		cleanup();
		show({ conversation: conversation({ unread: true, seenUpTo: "m3" }) });
		expect(
			screen.getByRole("button", { name: "4 agent messages, 1 new" }),
		).toBeInTheDocument();
		expect(screen.getByTestId("agent-unread-dot").className).toContain(
			"bg-accent",
		);
	});

	it.each([
		["an id-less thread", reviewThread({ id: "" }), "on" as const],
		[
			"a deleted thread",
			reviewThread({ unavailable: "deleted" }),
			"on" as const,
		],
		["--viewer", reviewThread(), "viewer" as const],
		["--as-of", reviewThread(), "as-of" as const],
	])("absent for %s", (_, thread, writes) => {
		show({ thread }, { writes });
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("pressed state when open", () => {
		show({ conversation: conversation(), open: true });
		const button = screen.getByRole("button", {
			name: "4 agent messages: hide",
		});
		expect(button).toHaveAttribute("aria-pressed", "true");
		cleanup();
		show({ conversation: conversation() });
		expect(
			screen.getByRole("button", { name: "4 agent messages" }),
		).toHaveAttribute("aria-pressed", "false");
	});

	it("a spinner in its place while the agent threads load, never Ask agent", () => {
		show({}, { threads: null });
		expect(screen.queryByRole("button", { name: "Ask agent" })).toBeNull();
		expect(
			screen.getByRole("status", { name: "Loading agent messages" }),
		).toBeInTheDocument();
	});

	it("an alert, not Ask agent, when the agent threads couldn't be read; pressing opens and reads them again", async () => {
		const onToggle = show(
			{},
			{
				threads: null,
				fetch: async () =>
					new Response(JSON.stringify({ error: "broke" }), { status: 502 }),
			},
		);
		const button = await screen.findByRole("button", {
			name: "Agent messages couldn't load",
		});
		expect(screen.queryByRole("button", { name: "Ask agent" })).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
		expect(button.className).toContain("text-bad");
		const reads = onToggle.fetchMock.mock.calls.length;
		button.click();
		expect(onToggle).toHaveBeenCalledOnce();
		await waitFor(() =>
			expect(onToggle.fetchMock.mock.calls.length).toBeGreaterThan(reads),
		);
	});

	it("Ask agent when the review has no agent threads to read (404)", async () => {
		show(
			{},
			{
				threads: null,
				fetch: async () =>
					new Response(JSON.stringify({ error: "no agent" }), {
						status: 404,
					}),
			},
		);
		expect(
			await screen.findByRole("button", { name: "Ask agent" }),
		).toBeInTheDocument();
	});
});
