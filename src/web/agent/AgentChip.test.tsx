// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus } from "../../shared/agent";
import type { PrOverview } from "../../shared/types";
import { overviewQuery } from "../api";
import { AgentChip, agentDot, agentTip } from "./AgentChip";
import { agentStatusQuery, agentThreadsQuery } from "./api";

const status = (more: Partial<AgentStatus> = {}): AgentStatus => ({
	state: "ready",
	configured: true,
	agent: { name: "Claude Agent", version: "0.100.0" },
	since: "2026-11-07T10:00:00Z",
	waiting: 0,
	...more,
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("the agent chip", () => {
	it.each<[string, Partial<AgentStatus>, string, string]>([
		[
			"off",
			{ state: "off", configured: false, agent: undefined },
			"bg-unreviewed",
			"No agent · set one up",
		],
		[
			"starting",
			{ state: "starting" },
			"bg-warn",
			"Claude Agent 0.100.0 · starting",
		],
		["ready", {}, "bg-ok", "Claude Agent 0.100.0"],
		[
			"busy",
			{ state: "busy", waiting: 1 },
			"bg-warn",
			"Claude Agent 0.100.0 · answering 1 thread",
		],
		[
			"error",
			{ state: "error", error: "exited with code 70: boom" },
			"bg-bad",
			"exited with code 70: boom",
		],
		[
			"a bad config",
			{ state: "off", configured: false, error: "agent.command: not a string" },
			"bg-bad",
			"agent.command: not a string",
		],
		[
			"elsewhere",
			{ state: "elsewhere", elsewhere: 4748 },
			"bg-unreviewed",
			"answered by the server on :4748",
		],
	])("%s", (_name, more, dot, tip) => {
		expect(agentDot(status(more))).toBe(dot);
		expect(agentTip(status(more))).toBe(tip);
	});

	it("is not there without an agent (--viewer, --as-of), and asks nothing", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const client = new QueryClient();
		client.setQueryData(overviewQuery.queryKey, {
			writes: "viewer",
		} as PrOverview);
		render(
			<QueryClientProvider client={client}>
				<AgentChip />
			</QueryClientProvider>,
		);
		expect(screen.queryByTestId("agent-chip")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reads the threads again when the status moves, not on a routine poll", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, enabled: false } },
		});
		client.setQueryData(agentStatusQuery.queryKey, status());
		client.setQueryData(overviewQuery.queryKey, {
			writes: "on",
		} as PrOverview);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(status()))),
		);
		render(
			<QueryClientProvider client={client}>
				<AgentChip />
			</QueryClientProvider>,
		);
		const chip = screen.getByTestId("agent-chip");
		expect(chip).toHaveAccessibleName("Your agent: Claude Agent 0.100.0");
		expect(chip).not.toHaveAttribute("aria-busy");
		// The same answer again: nothing.
		await act(async () =>
			client.setQueryData(agentStatusQuery.queryKey, status()),
		);
		expect(invalidate).not.toHaveBeenCalled();
		// The query's notifications are batched on a timer: each step waits
		// for the chip to show it.
		const set = async (s: AgentStatus) => {
			await act(async () => client.setQueryData(agentStatusQuery.queryKey, s));
			await waitFor(() => expect(chip).toHaveAttribute("data-state", s.state));
		};
		await set(
			status({
				state: "busy",
				answering: { thread: "T1", text: "a", activity: [] },
			}),
		);
		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
		// More text on the same turn: nothing more.
		await set(
			status({
				state: "busy",
				answering: { thread: "T1", text: "ab", activity: [] },
			}),
		);
		await set(status());
		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: agentThreadsQuery.queryKey,
			exact: true,
		});
	});
});
