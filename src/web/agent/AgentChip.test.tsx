// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectLoadingThen, heldJson } from "../../../test/loading";
import {
	AGENT_POLL_MS,
	type AgentStatus,
	type AgentThread,
} from "../../shared/agent";
import type { PrOverview } from "../../shared/types";
import { ApiError, overviewQuery } from "../api";
import { ShortcutsProvider } from "../shortcuts";
import {
	AgentChip,
	agentDot,
	agentInk,
	agentTip,
	CHIP_COLUMN,
	chipOpensDrawer,
} from "./AgentChip";
import {
	AGENT_BUSY_POLL_MS,
	agentPollMs,
	agentStatusQuery,
	agentThreadsQuery,
} from "./api";
import {
	closeReviewDrawer,
	openReviewDrawer,
	useReviewDrawerOpen,
} from "./drawerStore";
import { ReviewConversationDrawer } from "./ReviewConversationDrawer";
import {
	closeAgentSetup,
	resetSetupReturnFocus,
	useAgentSetupOpen,
	useAgentSetupTab,
} from "./setupStore";

const status = (more: Partial<AgentStatus> = {}): AgentStatus => ({
	state: "ready",
	configured: true,
	agent: { name: "Claude Agent", version: "0.100.0" },
	since: "2026-11-07T10:00:00Z",
	waiting: 0,
	connected: true,
	...more,
});

/** A session joined through MCP, as the host's overlay shows it. */
const joined = (more: Partial<AgentStatus> = {}): Partial<AgentStatus> => ({
	state: "ready",
	connected: true,
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
	...more,
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	closeAgentSetup();
	closeReviewDrawer();
	resetSetupReturnFocus();
});

function DrawerState() {
	return (
		<p data-testid="drawer">{useReviewDrawerOpen() ? "open" : "closed"}</p>
	);
}

/** Shows the chip over `s` (no polls: the test sets the answers). */
function chipOver(
	s: AgentStatus,
	fetchMock = vi.fn(),
	threads?: AgentThread[],
) {
	vi.stubGlobal("fetch", fetchMock);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, enabled: false } },
	});
	client.setQueryData(agentStatusQuery.queryKey, s);
	client.setQueryData(overviewQuery.queryKey, { writes: "on" } as PrOverview);
	if (threads) client.setQueryData(agentThreadsQuery.queryKey, { threads });
	function SetupState() {
		const open = useAgentSetupOpen();
		const tab = useAgentSetupTab();
		return <p data-testid="setup">{open ? tab : "closed"}</p>;
	}
	render(
		<QueryClientProvider client={client}>
			<AgentChip />
			<SetupState />
			<DrawerState />
		</QueryClientProvider>,
	);
	return { client, user: userEvent.setup() };
}

/** The review conversation, with `n` messages (the last an answer). */
const review = (n: number, more: Partial<AgentThread> = {}): AgentThread => ({
	id: "R1",
	anchor: { subject: "review" },
	openedBy: "human",
	at: "2026-11-15T10:00:00Z",
	messages: Array.from({ length: n }, (_, i) => ({
		id: `m${i + 1}`,
		by: i % 2 === 0 ? ("human" as const) : ("ai" as const),
		at: "2026-11-15T10:00:00Z",
		text: `message ${i + 1}`,
	})),
	resolved: false,
	waiting: false,
	unread: false,
	...more,
});

/** A thread on code, never counted on the chip. */
const spanThread = (): AgentThread => ({
	...review(3),
	id: "S1",
	anchor: {
		subject: "thread",
		thread: "RT1",
		path: "src/calc.ts",
		commit: "c0",
	},
});

const face = () => screen.getByTestId("agent-chip-face");

/** The chip's accessible name: both its jobs, then the agent's status. */
const named = (rest: string) => `Review conversation · Your agent: ${rest}`;

describe("the chip's tap", () => {
	it.each<[string, Partial<AgentStatus>, AgentThread[]]>([
		["a spawned agent, ready", { state: "ready", spawned: true }, []],
		[
			"an agent starting",
			{ state: "starting", spawned: true, connected: false },
			[],
		],
		["an agent busy", { state: "busy", waiting: 1 }, []],
		[
			"an agent whose last turn failed, still connected",
			{ state: "error", spawned: true, error: "Rate limited; retry later" },
			[],
		],
		["an agent reconnecting", { state: "reconnecting", connected: false }, []],
		[
			"another server answering",
			{ state: "elsewhere", elsewhere: 4747, connected: false },
			[],
		],
		[
			"spawned, the runner not up yet",
			{ state: "off", spawned: true, agent: undefined, connected: false },
			[],
		],
		[
			"a joined session, nothing configured",
			{ ...joined(), configured: false },
			[],
		],
		[
			"a joined session reconnecting",
			joined({ state: "reconnecting", configured: false }),
			[],
		],
	])("%s: toggles the drawer, never the setup", async (_n, more, threads) => {
		const { user } = chipOver(status(more), vi.fn(), threads);
		const chip = screen.getByTestId("agent-chip");
		expect(chip).toHaveAttribute("aria-controls", "review-conversation");
		expect(chip).toHaveAttribute("aria-expanded", "false");
		expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
		await user.click(chip);
		expect(screen.getByTestId("drawer")).toHaveTextContent("open");
		expect(chip).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
		await user.click(chip);
		expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
		expect(chip).toHaveAttribute("aria-expanded", "false");
	});

	it.each<[string, Partial<AgentStatus>]>([
		[
			"an agent configured, none spawned or joined",
			{ state: "off", agent: undefined, connected: false },
		],
		[
			"an agent that crashed",
			{
				state: "error",
				spawned: true,
				error: "exited with code 70",
				connected: false,
			},
		],
		[
			"an agent with an error, not connected",
			{ state: "ready", error: "the agent exited", connected: false },
		],
		[
			"spawned, nothing configured",
			{
				state: "off",
				configured: false,
				spawned: true,
				agent: undefined,
				connected: false,
			},
		],
	])(
		"no agent connected, %s: opens the drawer with the agent setup over it; the setup closed, the drawer stays",
		async (_n, more) => {
			const { user } = chipOver(status(more), vi.fn(), [
				review(2, { unread: true }),
			]);
			const chip = screen.getByTestId("agent-chip");
			expect(chip).toHaveAttribute("aria-expanded", "false");
			expect(chip).toHaveAttribute("aria-controls", "review-conversation");
			expect(face().className).not.toContain("bg-agent");
			await user.click(chip);
			expect(screen.getByTestId("setup")).not.toHaveTextContent("closed");
			expect(screen.getByTestId("drawer")).toHaveTextContent("open");
			expect(chip).toHaveAttribute("aria-expanded", "true");
			act(() => closeAgentSetup());
			expect(screen.getByTestId("setup")).toHaveTextContent("closed");
			expect(screen.getByTestId("drawer")).toHaveTextContent("open");
			// Open: the chip closes it, no setup.
			await user.click(chip);
			expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
			expect(screen.getByTestId("setup")).toHaveTextContent("closed");
		},
	);

	const left = {
		name: "old session",
		machine: "devbox",
		why: "detached" as const,
		at: "2026-11-10T09:00:00Z",
	};
	it.each<[string, AgentStatus | undefined, boolean]>([
		["no status", undefined, false],
		["off, configured", status({ state: "off", connected: false }), false],
		[
			"off, configured, spawned",
			status({ state: "off", spawned: true, connected: false }),
			true,
		],
		[
			"off, nothing configured, spawned",
			status({
				state: "off",
				configured: false,
				spawned: true,
				connected: false,
			}),
			false,
		],
		["starting", status({ state: "starting", connected: false }), true],
		["ready, connected", status(), true],
		["ready, not connected", status({ connected: false }), false],
		["busy", status({ state: "busy" }), true],
		["reconnecting", status({ state: "reconnecting", connected: false }), true],
		[
			"elsewhere",
			status({ state: "elsewhere", elsewhere: 4747, connected: false }),
			true,
		],
		[
			"elsewhere with an error",
			status({
				state: "elsewhere",
				elsewhere: 4747,
				error: "boom",
				connected: false,
			}),
			false,
		],
		["error, connected (a failed turn)", status({ state: "error" }), true],
		[
			"error, not connected (crashed)",
			status({ state: "error", connected: false }),
			false,
		],
		[
			"an error, not connected",
			status({ error: "boom", connected: false }),
			false,
		],
		["joined", status(joined({ configured: false })), true],
		["joined, a session left before", status(joined({ left })), true],
		[
			"a session left, none joined",
			status({ state: "off", connected: false, left }),
			false,
		],
		[
			"a session asking to join, none joined",
			status({
				state: "off",
				connected: false,
				joinRequest: {
					name: "s",
					machine: "devbox",
					id: "j1",
					at: "2026-11-10T09:00:00Z",
				},
			}),
			false,
		],
	])("chipOpensDrawer, %s: %s", (_n, s, drawer) => {
		expect(chipOpensDrawer(s)).toBe(drawer);
	});

	it.each<[string, AgentThread[]]>([
		["no conversation", [spanThread()]],
		["a review conversation already there", [review(2, { unread: true })]],
	])(
		"nothing set up, %s: opens the drawer and the agent setup over it",
		async (_n, threads) => {
			const { user } = chipOver(
				status({
					state: "off",
					configured: false,
					agent: undefined,
					connected: false,
				}),
				vi.fn(),
				threads,
			);
			const chip = screen.getByTestId("agent-chip");
			expect(chip).toHaveAttribute("aria-expanded", "false");
			await user.click(chip);
			expect(screen.getByTestId("setup")).not.toHaveTextContent("closed");
			expect(screen.getByTestId("drawer")).toHaveTextContent("open");
		},
	);

	it.each<[string, AgentStatus, string]>([
		["an agent ready", status(), "closed"],
		[
			"nothing set up",
			status({
				state: "off",
				configured: false,
				agent: undefined,
				connected: false,
			}),
			"invite",
		],
		[
			"an agent configured, none spawned",
			status({ state: "off", connected: false }),
			"invite",
		],
		[
			"an agent that crashed",
			status({ state: "error", spawned: true, connected: false }),
			"invite",
		],
	])(
		"tapped before the first status read, %s: nothing while it is read, then the drawer, the setup over it with no agent connected",
		async (_n, answer, setup) => {
			const held = heldJson();
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string) =>
					String(input).includes("agent/threads")
						? new Response(JSON.stringify({ threads: [] }))
						: held.response,
				),
			);
			const client = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			});
			client.setQueryData(overviewQuery.queryKey, {
				writes: "on",
			} as PrOverview);
			client.setQueryData(agentThreadsQuery.queryKey, { threads: [] });
			function SetupState() {
				const open = useAgentSetupOpen();
				const tab = useAgentSetupTab();
				return <p data-testid="setup">{open ? tab : "closed"}</p>;
			}
			render(
				<QueryClientProvider client={client}>
					<AgentChip />
					<SetupState />
					<DrawerState />
				</QueryClientProvider>,
			);
			const user = userEvent.setup();
			const chip = screen.getByTestId("agent-chip");
			expect(chip).toHaveAttribute("aria-busy", "true");
			// Every state seen: the drawer never shows without the setup it opens with.
			const seen = new Set<string>();
			const watch = new MutationObserver(() =>
				seen.add(
					`${screen.getByTestId("drawer").textContent}|${screen.getByTestId("setup").textContent}`,
				),
			);
			for (const id of ["drawer", "setup"]) {
				watch.observe(screen.getByTestId(id), {
					childList: true,
					characterData: true,
					subtree: true,
				});
			}
			await user.click(chip);
			// Held: neither opens before the status says which.
			expect(screen.getByTestId("setup")).toHaveTextContent("closed");
			expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
			expect(chip).not.toHaveAttribute("aria-expanded");
			await act(async () => held.release(answer));
			await waitFor(() =>
				expect(screen.getByTestId("setup")).toHaveTextContent(setup),
			);
			await waitFor(() =>
				expect(screen.getByTestId("drawer")).toHaveTextContent("open"),
			);
			watch.disconnect();
			if (setup !== "closed") expect(seen.has("open|closed")).toBe(false);
		},
	);

	/** The chip with its first status read held. */
	function heldChip() {
		const held = heldJson();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) =>
				String(input).includes("agent/threads")
					? new Response(JSON.stringify({ threads: [] }))
					: held.response,
			),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(overviewQuery.queryKey, { writes: "on" } as PrOverview);
		client.setQueryData(agentThreadsQuery.queryKey, { threads: [] });
		function SetupState() {
			return (
				<p data-testid="setup">{useAgentSetupOpen() ? "open" : "closed"}</p>
			);
		}
		render(
			<QueryClientProvider client={client}>
				<AgentChip />
				<SetupState />
				<DrawerState />
			</QueryClientProvider>,
		);
		return { held, client, user: userEvent.setup() };
	}

	it.each<[string, AgentStatus]>([
		["an agent ready", status()],
		[
			"nothing set up",
			status({
				state: "off",
				configured: false,
				agent: undefined,
				connected: false,
			}),
		],
		[
			"an agent configured, none spawned",
			status({ state: "off", connected: false }),
		],
		[
			"an agent that crashed",
			status({ state: "error", spawned: true, connected: false }),
		],
	])(
		"tapped twice while the status is read, %s: the second cancels the first, nothing opens",
		async (_n, answer) => {
			const { held, user } = heldChip();
			const chip = screen.getByTestId("agent-chip");
			await user.click(chip);
			await user.click(chip);
			await act(async () => held.release(answer));
			await waitFor(() => expect(chip).not.toHaveAttribute("aria-busy"));
			expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
			expect(screen.getByTestId("setup")).toHaveTextContent("closed");
		},
	);

	it("Shift+A before the first status read, nothing set up: held like a tap, then the drawer and the setup over it", async () => {
		const held = heldJson();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) =>
				String(input).includes("agent/threads")
					? new Response(JSON.stringify({ threads: [review(2)] }))
					: held.response,
			),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(overviewQuery.queryKey, { writes: "on" } as PrOverview);
		client.setQueryData(agentThreadsQuery.queryKey, { threads: [review(2)] });
		function SetupState() {
			return (
				<p data-testid="setup">{useAgentSetupOpen() ? "open" : "closed"}</p>
			);
		}
		render(
			<QueryClientProvider client={client}>
				<ShortcutsProvider>
					<AgentChip />
					<ReviewConversationDrawer />
					<SetupState />
					<DrawerState />
				</ShortcutsProvider>
			</QueryClientProvider>,
		);
		const user = userEvent.setup();
		await user.keyboard("{Shift>}A{/Shift}");
		expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
		await act(async () =>
			held.release(
				status({
					state: "off",
					configured: false,
					agent: undefined,
					connected: false,
				}),
			),
		);
		await waitFor(() =>
			expect(screen.getByTestId("setup")).toHaveTextContent("open"),
		);
		expect(screen.getByTestId("drawer")).toHaveTextContent("open");
	});

	it("open while the joined session leaves: still pressed, the tap closes it, no setup; the next opens both", async () => {
		const { client, user } = chipOver(status(joined({ configured: false })));
		const chip = screen.getByTestId("agent-chip");
		await user.click(chip);
		expect(screen.getByTestId("drawer")).toHaveTextContent("open");
		act(() =>
			client.setQueryData(
				agentStatusQuery.queryKey,
				status({
					state: "off",
					configured: false,
					agent: undefined,
					connected: false,
				}),
			),
		);
		await waitFor(() => expect(chip).toHaveAttribute("data-state", "off"));
		expect(chip).toHaveAttribute("aria-expanded", "true");
		expect(chip).toHaveAttribute("aria-controls", "review-conversation");
		expect(face().className).toContain("bg-agent");
		await user.click(chip);
		expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
		// Closed, with no agent: the next tap opens it with the setup over it.
		expect(chip).toHaveAttribute("aria-expanded", "false");
		await user.click(chip);
		expect(screen.getByTestId("setup")).not.toHaveTextContent("closed");
		expect(screen.getByTestId("drawer")).toHaveTextContent("open");
	});

	it("an early tap is replayed as an open: a drawer opened meanwhile stays open", async () => {
		const { held } = heldChip();
		await userEvent.click(screen.getByTestId("agent-chip"));
		act(() => openReviewDrawer());
		await act(async () => held.release(status()));
		await waitFor(() =>
			expect(screen.getByTestId("agent-chip")).not.toHaveAttribute("aria-busy"),
		);
		expect(screen.getByTestId("drawer")).toHaveTextContent("open");
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
	});

	it("an early tap, then the chip leaves (another review): nothing opens later", async () => {
		const { held } = heldChip();
		await userEvent.click(screen.getByTestId("agent-chip"));
		cleanup();
		const { held: again } = heldChip();
		held.release(status());
		await act(async () =>
			again.release(
				status({
					state: "off",
					configured: false,
					agent: undefined,
					connected: false,
				}),
			),
		);
		await waitFor(() =>
			expect(screen.getByTestId("agent-chip")).not.toHaveAttribute("aria-busy"),
		);
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
		expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
	});

	it("an early tap, then a failed status read: a later read opens no setup", async () => {
		const { held, client } = heldChip();
		await userEvent.click(screen.getByTestId("agent-chip"));
		await act(async () => held.release({ error: "down" }, 500));
		await waitFor(() =>
			expect(screen.getByTestId("agent-chip")).not.toHaveAttribute("aria-busy"),
		);
		// A later poll says nothing is set up: the tap is long spent.
		await act(async () =>
			client.setQueryData(
				agentStatusQuery.queryKey,
				status({
					state: "off",
					configured: false,
					agent: undefined,
					connected: false,
				}),
			),
		);
		await waitFor(() =>
			expect(screen.getByTestId("agent-chip")).toHaveAttribute(
				"data-state",
				"off",
			),
		);
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
	});

	it("pressed while the drawer is open: the agent wash inside agent-edge", async () => {
		const { user } = chipOver(status(), vi.fn(), []);
		expect(face().className).toContain("border-line-strong");
		expect(face().className).toContain("bg-raised");
		expect(face().className).not.toContain("bg-agent");
		await user.click(screen.getByTestId("agent-chip"));
		expect(face().className).toContain("border-agent-edge");
		expect(face().className).toContain("bg-agent");
		expect(face().className).not.toContain("bg-raised");
		// Closed from elsewhere (the drawer's ×): not pressed.
		act(() => closeReviewDrawer());
		expect(face().className).not.toContain("bg-agent");
		expect(screen.getByTestId("agent-chip")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});

	it("every face not pressed highlights on hover, a joined session's too", async () => {
		chipOver(status(), vi.fn(), []);
		expect(face().className).toContain("group-hover:bg-overlay");
		cleanup();
		const { user } = chipOver(status(joined()), vi.fn(), []);
		expect(face().className).toContain("border-agent-edge");
		expect(face().className).toContain("group-hover:bg-overlay");
		// Pressed keeps its wash.
		await user.click(screen.getByTestId("agent-chip"));
		expect(face().className).not.toContain("group-hover:bg-overlay");
	});

	it("the face is 32px in a 40px tap target", () => {
		chipOver(status(), vi.fn(), []);
		expect(screen.getByTestId("agent-chip").className).toContain("h-10 w-10");
		expect(face().className).toContain("h-8 w-8");
	});
});

describe("the chip's unread count", () => {
	it("no badge without a conversation, an empty one, or one all seen: never the total", () => {
		chipOver(status(), vi.fn(), [{ ...spanThread(), unread: true }]);
		expect(screen.queryByTestId("agent-chip-count")).toBeNull();
		expect(screen.getByTestId("agent-chip")).toHaveAccessibleName(
			named("Claude Agent 0.100.0"),
		);
		cleanup();
		chipOver(status(), vi.fn(), [review(0)]);
		expect(screen.queryByTestId("agent-chip-count")).toBeNull();
		expect(screen.getByTestId("agent-chip")).not.toHaveTextContent("0");
		cleanup();
		// Six messages, all seen: nothing.
		chipOver(status(), vi.fn(), [review(6, { seenUpTo: "m6" })]);
		expect(screen.queryByTestId("agent-chip-count")).toBeNull();
		expect(screen.getByTestId("agent-chip")).toHaveAccessibleName(
			named("Claude Agent 0.100.0"),
		);
		expect(screen.queryByTestId("agent-chip-unread")).toBeNull();
	});

	it("the unseen answers' number on the lower right; code threads aren't counted", () => {
		// m1–m6, answers m2, m4, m6; seen up to m2: two unseen answers.
		chipOver(status(), vi.fn(), [
			{ ...spanThread(), unread: true },
			review(6, { unread: true, seenUpTo: "m2" }),
		]);
		const badge = screen.getByTestId("agent-chip-count");
		expect(badge).toHaveTextContent(/^2$/);
		expect(badge.className).toContain("-bottom-");
		expect(badge.className).toContain("-right-");
		expect(badge.className).toContain("bg-agent");
		expect(badge.className).toContain("text-agent-ink");
		expect(badge.className).toContain("border-agent-edge");
		expect(screen.getByTestId("agent-chip")).toHaveAccessibleName(
			named("Claude Agent 0.100.0 · 2 unread"),
		);
		// No separate dot: the number says unread.
		expect(screen.queryByTestId("agent-chip-unread")).toBeNull();
	});

	it("seen: the number goes", async () => {
		const { client } = chipOver(status(), vi.fn(), [
			review(4, { unread: true }),
		]);
		expect(screen.getByTestId("agent-chip-count")).toHaveTextContent(/^2$/);
		act(() =>
			client.setQueryData(agentThreadsQuery.queryKey, {
				threads: [review(4, { unread: false, seenUpTo: "m4" })],
			}),
		);
		await waitFor(() =>
			expect(screen.queryByTestId("agent-chip-count")).toBeNull(),
		);
		expect(screen.getByTestId("agent-chip")).toHaveAccessibleName(
			named("Claude Agent 0.100.0"),
		);
	});

	it("a joined session: the plug alone with nothing unread, inside the badge before the number with some", () => {
		chipOver(status(joined()), vi.fn(), [review(3)]);
		expect(screen.getByTestId("agent-chip-plug")).toBeInTheDocument();
		expect(screen.queryByTestId("agent-chip-count")).toBeNull();
		cleanup();
		chipOver(status(joined()), vi.fn(), [review(4, { unread: true })]);
		const badge = screen.getByTestId("agent-chip-count");
		expect(badge).toHaveTextContent(/^2$/);
		const plug = within(badge).getByTestId("agent-chip-plug");
		// Before the number.
		expect(badge.firstElementChild).toBe(plug);
		expect(screen.getAllByTestId("agent-chip-plug")).toHaveLength(1);
	});

	it("while the agent threads are read: no badge and no 0; then the unread count", async () => {
		const held = heldJson();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/agent/threads")) return held.response;
				throw new Error(`unexpected ${url}`);
			}),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(agentStatusQuery.queryKey, status());
		client.setQueryData(overviewQuery.queryKey, { writes: "on" } as PrOverview);
		render(
			<QueryClientProvider client={client}>
				<AgentChip />
			</QueryClientProvider>,
		);
		const chip = screen.getByTestId("agent-chip");
		await waitFor(() =>
			expect(client.isFetching({ queryKey: agentThreadsQuery.queryKey })).toBe(
				1,
			),
		);
		expect(screen.queryByTestId("agent-chip-count")).toBeNull();
		expect(chip).not.toHaveTextContent("0");
		expect(chip).toHaveAccessibleName(named("Claude Agent 0.100.0"));
		held.release({ threads: [review(2, { unread: true })] });
		await waitFor(() =>
			expect(screen.getByTestId("agent-chip-count")).toHaveTextContent("1"),
		);
	});
});

describe("the chip without an agent host (as of a cutoff, another reviewer's view)", () => {
	it("as of a cutoff: no chip to tap, the drawer never opens, nothing asked", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, enabled: false } },
		});
		client.setQueryData(agentStatusQuery.queryKey, status());
		client.setQueryData(overviewQuery.queryKey, { writes: "on" } as PrOverview);
		client.setQueryData(agentThreadsQuery.queryKey, { threads: [review(2)] });
		render(
			<QueryClientProvider client={client}>
				<span data-testid="column" className={CHIP_COLUMN}>
					<AgentChip asOf />
				</span>
				<DrawerState />
			</QueryClientProvider>,
		);
		// The column keeps its 40px, empty.
		expect(screen.getByTestId("column").className).toContain("w-10");
		expect(screen.queryByTestId("agent-chip")).toBeNull();
		await userEvent.setup().click(screen.getByTestId("column"));
		expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("the chip with a joined session", () => {
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
		// The name is in the tooltip and the accessible name, as text.
		expect(chip).toHaveAccessibleName(named(`${name} · listening`));
	});
});

describe("the agent chip", () => {
	it.each<[string, Partial<AgentStatus>, string, string]>([
		[
			"off",
			{ state: "off", configured: false, agent: undefined, connected: false },
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
			"spawned, the runner not up yet",
			{ state: "off", spawned: true, agent: undefined },
			"bg-warn",
			"Starting",
		],
		[
			"spawned with no agent configured",
			{ state: "off", spawned: true, configured: false, agent: undefined },
			"bg-bad",
			"No agent configured",
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
			"off, with a config",
			{ state: "off", agent: undefined },
			"bg-unreviewed",
			"No agent · spawn or invite",
		],
		[
			"elsewhere",
			{ state: "elsewhere", elsewhere: 4748 },
			"bg-unreviewed",
			"answered by the server on :4748",
		],
	])("%s", (_name, more, dot, tip) => {
		expect(agentDot(status(more))).toBe(dot);
		// The chip's icon takes the dot's colour, as text.
		expect(agentInk(status(more))).toBe(dot.replace("bg-", "text-"));
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

	it("its first read shows a spinner in the icon's place, never the icon; then the icon in the status's colour", async () => {
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
			empty: [() => screen.queryByTestId("agent-chip-icon")],
			release: () => held.release(status()),
			result: () => screen.queryByTestId("agent-chip-icon"),
		});
		expect(screen.getByTestId("agent-chip-icon").className).toContain(
			"text-ok",
		);
		// The icon alone: the name only in the tooltip and the name.
		expect(screen.getByTestId("agent-chip")).not.toHaveTextContent(
			"Claude Agent",
		);
		expect(screen.getByTestId("agent-chip")).not.toHaveAttribute("aria-busy");
	});

	it("keeps its place, spinning, until the overview says whether there is an agent; none as of a cutoff", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const client = new QueryClient();
		const view = render(
			<QueryClientProvider client={client}>
				<AgentChip />
			</QueryClientProvider>,
		);
		const pending = screen.getByTestId("agent-chip-pending");
		expect(pending).toHaveAttribute("aria-hidden", "true");
		expect(pending).toHaveAttribute("data-chip-space");
		expect(screen.queryByTestId("agent-chip")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		view.rerender(
			<QueryClientProvider client={client}>
				<AgentChip asOf />
			</QueryClientProvider>,
		);
		expect(screen.queryByTestId("agent-chip-pending")).toBeNull();
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
		expect(chip).toHaveAccessibleName(named("Claude Agent 0.100.0"));
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

	it("on a server showing elsewhere, reads the threads again when the stored threads move, though nothing else does (CAR-187)", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, enabled: false } },
		});
		// The holder took the question and answered it between two polls:
		// state, since and waiting read as before; only the threads moved.
		const there = (threadsRev: string) =>
			status({
				state: "elsewhere",
				elsewhere: 4748,
				agent: undefined,
				threadsRev,
			});
		client.setQueryData(agentStatusQuery.queryKey, there("3.a"));
		client.setQueryData(overviewQuery.queryKey, {
			writes: "on",
		} as PrOverview);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(there("3.a")))),
		);
		render(
			<QueryClientProvider client={client}>
				<AgentChip />
			</QueryClientProvider>,
		);
		expect(screen.getByTestId("agent-chip")).toHaveAttribute(
			"data-state",
			"elsewhere",
		);
		await act(async () =>
			client.setQueryData(agentStatusQuery.queryKey, there("3.a")),
		);
		expect(invalidate).not.toHaveBeenCalled();
		await act(async () =>
			client.setQueryData(agentStatusQuery.queryKey, there("4.b")),
		);
		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: agentThreadsQuery.queryKey,
				exact: true,
			}),
		);
		expect(invalidate).toHaveBeenCalledTimes(1);
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
