// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectLoadingThen, heldJson } from "../../../test/loading";
import { AGENT_POLL_MS, type AgentStatus } from "../../shared/agent";
import type { PrOverview } from "../../shared/types";
import { ApiError, overviewQuery } from "../api";
import { AgentChip, agentDot, agentTip, chipPopover } from "./AgentChip";
import {
	AGENT_BUSY_POLL_MS,
	agentPollMs,
	agentStatusQuery,
	agentThreadsQuery,
} from "./api";
import {
	closeAgentSetup,
	useAgentSetupOpen,
	useAgentSetupTab,
} from "./setupStore";

const status = (more: Partial<AgentStatus> = {}): AgentStatus => ({
	state: "ready",
	configured: true,
	agent: { name: "Claude Agent", version: "0.100.0" },
	since: "2026-11-07T10:00:00Z",
	waiting: 0,
	...more,
});

/** A session joined through MCP, as the host's overlay shows it. */
const joined = (more: Partial<AgentStatus> = {}): Partial<AgentStatus> => ({
	state: "ready",
	via: "mcp",
	agent: {
		name: "carbonless · main",
		version: "Claude Code 2.1",
		via: "mcp",
		machine: "devbox",
	},
	joined: {
		name: "carbonless · main",
		machine: "devbox",
		harness: "Claude Code 2.1",
		since: "2026-11-10T10:00:00Z",
	},
	acpOff: true,
	...more,
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	closeAgentSetup();
});

/**
 * A fetch for the chip's writes: `{ok: true}` to a POST, `after` to the
 * status read again once one lands.
 */
const routed = (after: AgentStatus) =>
	vi.fn(async (_url: string, init?: RequestInit) =>
		init?.method === "POST"
			? new Response(JSON.stringify({ ok: true }))
			: new Response(JSON.stringify(after)),
	);

/** The writes sent. */
const posts = (fetchMock: ReturnType<typeof vi.fn>) =>
	fetchMock.mock.calls.filter(
		([, init]) => (init as RequestInit | undefined)?.method === "POST",
	);

/** Shows the chip over `s` (no polls: the test sets the answers). */
function chipOver(s: AgentStatus, fetchMock = vi.fn()) {
	vi.stubGlobal("fetch", fetchMock);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, enabled: false } },
	});
	client.setQueryData(agentStatusQuery.queryKey, s);
	client.setQueryData(overviewQuery.queryKey, { writes: "on" } as PrOverview);
	function SetupState() {
		const open = useAgentSetupOpen();
		const tab = useAgentSetupTab();
		return <p data-testid="setup">{open ? tab : "closed"}</p>;
	}
	render(
		<QueryClientProvider client={client}>
			<AgentChip />
			<SetupState />
		</QueryClientProvider>,
	);
	return { client, user: userEvent.setup() };
}

describe("the chip with a joined session", () => {
	it("shows the plug badge and the session's name; its popover has the machine, presence and Disconnect", async () => {
		const fetchMock = routed(
			status({
				state: "off",
				acpOff: true,
				agent: undefined,
				left: {
					name: "carbonless · main",
					machine: "devbox",
					why: "disconnected",
					at: "2026-11-10T10:05:00Z",
				},
			}),
		);
		const { user } = chipOver(status(joined()), fetchMock);
		const chip = screen.getByTestId("agent-chip");
		expect(chip).toHaveAttribute("data-via", "mcp");
		expect(screen.getByTestId("agent-chip-plug")).toBeInTheDocument();
		expect(chip).toHaveTextContent("carbonless · main");
		expect(chip).toHaveAccessibleName(
			"Your agent: carbonless · main · listening",
		);
		expect(chip).toHaveAttribute("aria-expanded", "false");
		await user.click(chip);
		expect(chip).toHaveAttribute("aria-expanded", "true");
		const pop = screen.getByTestId("agent-popover");
		expect(within(pop).getByTestId("agent-pop-name")).toHaveTextContent(
			"carbonless · main",
		);
		expect(pop).toHaveTextContent("devbox · Claude Code 2.1");
		expect(within(pop).getByTestId("agent-pop-presence")).toHaveTextContent(
			"listening",
		);
		expect(within(pop).getByRole("time")).toBeInTheDocument();
		expect(within(pop).queryByTestId("agent-start")).toBeNull();
		await user.click(within(pop).getByTestId("agent-disconnect"));
		await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/agent/disconnect",
			expect.objectContaining({ method: "POST" }),
		);
		// Closed, and read again: nothing joined.
		await waitFor(() => expect(chip).not.toHaveAttribute("data-via"));
		expect(screen.queryByTestId("agent-pop-name")).toBeNull();
		expect(posts(fetchMock)).toHaveLength(1);
		// The setup didn't open.
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
	});

	it("a session's name with markup shows as text", () => {
		const name = '<img src=x onerror="alert(1)">';
		chipOver(
			status(
				joined({
					agent: { name, version: "", via: "mcp", machine: "m" },
					joined: { name, machine: "m", since: "2026-11-10T10:00:00Z" },
				}),
			),
		);
		const chip = screen.getByTestId("agent-chip");
		expect(chip.querySelector("img")).toBeNull();
		expect(chip).toHaveTextContent(name);
	});
});

describe("the chip with the ACP buddy off", () => {
	it("Start shows with a config, and posts; the join line opens the setup's Join tab", async () => {
		const off = status({ state: "off", acpOff: true, agent: undefined });
		const fetchMock = routed(off);
		const { user } = chipOver(off, fetchMock);
		const chip = screen.getByTestId("agent-chip");
		expect(screen.queryByTestId("agent-chip-plug")).toBeNull();
		await user.click(chip);
		const pop = screen.getByTestId("agent-popover");
		await user.click(within(pop).getByTestId("agent-start"));
		await waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/agent/start",
				expect.objectContaining({ method: "POST" }),
			),
		);
		await waitFor(() => expect(chip).toHaveAttribute("aria-expanded", "false"));
		await user.click(chip);
		await user.click(
			within(screen.getByTestId("agent-popover")).getByTestId(
				"agent-join-setup",
			),
		);
		expect(screen.getByTestId("setup")).toHaveTextContent("join");
	});

	it("Start and Disconnect: two presses before a re-render post once", async () => {
		const releases: Array<() => void> = [];
		const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
			init?.method === "POST"
				? new Promise<Response>((done) => {
						releases.push(() =>
							done(new Response(JSON.stringify({ ok: true }))),
						);
					})
				: Promise.resolve(new Response(JSON.stringify(status()))),
		);
		for (const [s, button] of [
			[status({ state: "off", acpOff: true, agent: undefined }), "agent-start"],
			[status(joined()), "agent-disconnect"],
		] as const) {
			fetchMock.mockClear();
			const { user } = chipOver(s, fetchMock);
			await user.click(screen.getByTestId("agent-chip"));
			const press = within(screen.getByTestId("agent-popover")).getByTestId(
				button,
			);
			act(() => {
				fireEvent.click(press);
				fireEvent.click(press);
			});
			await waitFor(() => expect(posts(fetchMock).length).toBeGreaterThan(0));
			expect(posts(fetchMock)).toHaveLength(1);
			await act(async () => releases.shift()?.());
			cleanup();
		}
	});

	it("no Start without a config", async () => {
		const { user } = chipOver(
			status({
				state: "off",
				configured: false,
				acpOff: true,
				agent: undefined,
			}),
		);
		await user.click(screen.getByTestId("agent-chip"));
		const pop = screen.getByTestId("agent-popover");
		expect(within(pop).queryByTestId("agent-start")).toBeNull();
		expect(within(pop).getByTestId("agent-join-setup")).toBeInTheDocument();
	});

	it("with ACP on and nothing joined the chip opens the setup, no popover", async () => {
		expect(chipPopover(status())).toBe(false);
		expect(chipPopover(status({ acpOff: true }))).toBe(true);
		expect(chipPopover(status(joined({ acpOff: undefined })))).toBe(true);
		const { user } = chipOver(status());
		const chip = screen.getByTestId("agent-chip");
		expect(chip).not.toHaveAttribute("aria-expanded");
		await user.click(chip);
		expect(screen.queryByTestId("agent-popover")).toBeNull();
		expect(screen.getByTestId("setup")).toHaveTextContent("launch");
	});
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
			"reconnecting (an ACP name)",
			{ state: "reconnecting" },
			"bg-warn",
			"Claude Agent 0.100.0 · reconnecting",
		],
		[
			"a joined session listening",
			joined(),
			"bg-ok",
			"carbonless · main · listening",
		],
		[
			"a joined session answering",
			joined({ state: "busy" }),
			"bg-warn",
			"carbonless · main · answering",
		],
		[
			"a joined session reconnecting",
			joined({ state: "reconnecting" }),
			"bg-warn",
			"carbonless · main · reconnecting",
		],
		[
			"off after a join, with a config",
			{ state: "off", acpOff: true, agent: undefined },
			"bg-unreviewed",
			"Agent off · start it",
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

	it("its first read shows a spinner, never a dot; then the status's dot", async () => {
		const held = heldJson();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/agent")) return held.response;
				throw new Error(`unexpected ${url}`);
			}),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(overviewQuery.queryKey, {
			writes: "on",
		} as PrOverview);
		render(
			<QueryClientProvider client={client}>
				<AgentChip />
			</QueryClientProvider>,
		);
		await expectLoadingThen({
			loading: () => screen.queryByTestId("agent-chip-loading"),
			empty: [() => screen.queryByTestId("agent-chip-dot")],
			release: () => held.release(status()),
			result: () => screen.queryByTestId("agent-chip-dot"),
		});
		expect(screen.getByTestId("agent-chip-dot").className).toContain("bg-ok");
		expect(screen.getByTestId("agent-chip")).not.toHaveAttribute("aria-busy");
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
		// A whole turn between two polls: ready again, but since it moved.
		await set(status({ since: "2026-11-07T10:05:00Z" }));
		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: agentThreadsQuery.queryKey,
			exact: true,
		});
	});
});

describe("the status poll", () => {
	it("is every 5 s, every second while starting or answering, never without an agent", () => {
		const s = (state: AgentStatus["state"]) => status({ state });
		expect(agentPollMs(s("ready"), null)).toBe(AGENT_POLL_MS);
		expect(agentPollMs(s("off"), null)).toBe(AGENT_POLL_MS);
		expect(agentPollMs(undefined, null)).toBe(AGENT_POLL_MS);
		expect(agentPollMs(s("busy"), null)).toBe(AGENT_BUSY_POLL_MS);
		expect(agentPollMs(s("starting"), null)).toBe(AGENT_BUSY_POLL_MS);
		expect(agentPollMs(undefined, new ApiError(404, "no agent"))).toBe(false);
		// Another failure (the server restarting) keeps polling.
		expect(agentPollMs(undefined, new ApiError(0, "gone"))).toBe(AGENT_POLL_MS);
		// A joined session's answer doesn't stream: no fast poll.
		expect(agentPollMs(status({ state: "busy", via: "mcp" }), null)).toBe(
			AGENT_POLL_MS,
		);
	});
});
