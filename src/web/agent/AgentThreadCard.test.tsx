// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentActivity,
	AgentStatus,
	AgentThread,
} from "../../shared/agent";
import { AgentThreadCard, activitySummary } from "./AgentThreadCard";
import { resetAgentWrites } from "./agentWrites";
import { agentThreadsQuery } from "./api";
import { closeAgentSetup, useAgentSetupOpen } from "./setupStore";

const status = (more: Partial<AgentStatus> = {}): AgentStatus => ({
	state: "ready",
	configured: true,
	agent: { name: "Claude Agent", version: "0.100.0" },
	since: "2026-11-07T10:00:00Z",
	waiting: 0,
	...more,
});

const thread = (more: Partial<AgentThread> = {}): AgentThread => ({
	id: "T1",
	anchor: {
		subject: "line",
		path: "src/math.js",
		commit: "h",
		side: "RIGHT",
		line: 3,
		startSide: "RIGHT",
		startLine: 3,
	},
	openedBy: "human",
	at: "2026-11-07T10:00:00Z",
	messages: [
		{
			id: "m1",
			by: "human",
			at: "2026-11-07T10:00:00Z",
			text: "Is the loop bound right?",
		},
	],
	resolved: false,
	waiting: true,
	...more,
});

const answered = (more: Partial<AgentThread> = {}) =>
	thread({
		waiting: false,
		messages: [
			...thread().messages,
			{
				id: "m2",
				by: "ai",
				at: "2026-11-07T10:01:00Z",
				text: "No. It **skips** the first element.",
				agent: { name: "Claude Agent", version: "0.100.0" },
				stop: "end_turn",
				activity: [{ kind: "read", title: "Read src/math.js" }],
			},
		],
		...more,
	});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	cleanup();
	resetAgentWrites();
	closeAgentSetup();
	vi.unstubAllGlobals();
});

function SetupProbe() {
	return useAgentSetupOpen() ? <p data-testid="setup-open" /> : null;
}

function show(t: AgentThread, s: AgentStatus | undefined) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, enabled: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AgentThreadCard thread={t} status={s} />
			<SetupProbe />
		</QueryClientProvider>,
	);
}

describe("AgentThreadCard", () => {
	it("waiting: a yellow dot, no reply yet, named by the agent", () => {
		show(thread(), status());
		const card = screen.getByTestId("agent-thread");
		expect(card.getAttribute("aria-label")).toBe("Agent thread, waiting");
		expect(within(card).getByTestId("agent-waiting").textContent).toContain(
			"waiting for an agent",
		);
		expect(within(card).getByText("Is the loop bound right?")).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Set up an agent" }),
		).toBeNull();
		expect(screen.queryByTestId("agent-answering")).toBeNull();
		expect(card.textContent).toContain("Claude Agent");
	});

	it("waiting with no agent set up: the row opens the setup", async () => {
		show(
			thread(),
			status({ state: "off", configured: false, agent: undefined }),
		);
		expect(screen.getByTestId("agent-thread").textContent).toContain("Agent");
		await userEvent.click(
			screen.getByRole("button", { name: "Set up an agent" }),
		);
		expect(screen.getByTestId("setup-open")).toBeTruthy();
	});

	it("answering: a spinner, the streamed text as Markdown, the activity, Stop", async () => {
		const activity: AgentActivity[] = [
			{ kind: "read", title: "Read src/math.js", decision: "allowed" },
			{ kind: "read", title: "Read README.md" },
			{ kind: "execute", title: "node -e …", decision: "allowed" },
			{ kind: "edit", title: "Edit src/math.js" },
			{ kind: "fetch", title: "Fetch docs" },
			{ kind: "switch_mode", title: "Enter plan mode", decision: "rejected" },
		];
		show(
			thread(),
			status({
				state: "busy",
				answering: { thread: "T1", text: "No. The loop **starts**", activity },
			}),
		);
		const card = screen.getByTestId("agent-thread");
		expect(card.getAttribute("aria-label")).toBe("Agent thread, answering");
		const row = within(card).getByTestId("agent-answering");
		expect(within(row).getByRole("status", { name: "Answering" })).toBeTruthy();
		expect(row.querySelector("strong")?.textContent).toBe("starts");
		expect(screen.queryByTestId("agent-waiting")).toBeNull();
		const line = within(card).getByTestId("agent-activity");
		expect(line.textContent).toContain(
			"read 2 files · ran 1 command · edited 1 file · used 2 tools",
		);
		await userEvent.click(within(line).getByText(/read 2 files/));
		expect(line.textContent).toContain("Enter plan mode");
		expect(within(line).getByText("rejected")).toBeTruthy();
		await userEvent.click(screen.getByTestId("agent-stop"));
		await waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/agent/cancel",
				expect.objectContaining({ method: "POST" }),
			),
		);
	});

	it("another thread's answer leaves this one waiting", () => {
		show(
			thread(),
			status({
				state: "busy",
				answering: { thread: "T9", text: "x", activity: [] },
			}),
		);
		expect(screen.getByTestId("agent-waiting")).toBeTruthy();
		expect(screen.queryByTestId("agent-stop")).toBeNull();
	});

	it("answered: the reply as Markdown in the agent tint, its activity, a reply box", () => {
		show(answered(), status());
		const card = screen.getByTestId("agent-thread");
		expect(card.getAttribute("aria-label")).toBe("Agent thread, answered");
		const reply = within(card).getByTestId("agent-message-ai");
		expect(reply.className).toContain("bg-agent");
		expect(reply.querySelector("strong")?.textContent).toBe("skips");
		expect(within(card).getByTestId("agent-message-human").className).toMatch(
			/bg-person-\d/,
		);
		expect(within(card).getByTestId("agent-activity").textContent).toContain(
			"read 1 file",
		);
		expect(
			within(card).getByRole("textbox", { name: "Reply to your agent" }),
		).toBeTruthy();
		expect(within(card).getByTestId("agent-resolve").textContent).toBe(
			"Resolve",
		);
		expect(screen.queryByTestId("agent-stop-chip")).toBeNull();
	});

	it("resolved: Unresolve, and no reply box", async () => {
		show(answered({ resolved: true }), status());
		const card = screen.getByTestId("agent-thread");
		expect(card.getAttribute("aria-label")).toBe("Agent thread, resolved");
		expect(
			within(card).queryByRole("textbox", { name: "Reply to your agent" }),
		).toBeNull();
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(answered()), { status: 200 }),
		);
		await userEvent.click(within(card).getByTestId("agent-resolve"));
		expect(within(card).getByTestId("agent-resolve").textContent).toBe(
			"Unresolve",
		);
		await waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/agent/threads/T1/resolved",
				expect.objectContaining({ body: JSON.stringify({ resolved: false }) }),
			),
		);
	});

	it("Resolve is off while its write is out", async () => {
		let release = () => {};
		fetchMock.mockImplementationOnce(
			() =>
				new Promise<Response>((done) => {
					release = () =>
						done(new Response(JSON.stringify(answered({ resolved: true }))));
				}),
		);
		show(answered(), status());
		const button = screen.getByTestId("agent-resolve");
		await userEvent.click(button);
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute("aria-busy", "true");
		release();
		await waitFor(() => expect(button).toBeEnabled());
	});

	it("a failed reply names the agent's reason: in its chip, and in place of an empty text", () => {
		const t = answered();
		const last = t.messages[1];
		if (last) {
			last.text = "";
			last.stop = "error";
			last.error = "Internal error: Rate limited";
		}
		show(t, status());
		const chip = screen.getByTestId("agent-stop-chip");
		expect(chip.textContent).toBe("failed");
		expect(chip).toHaveAccessibleName(
			"The agent stopped with an error: Internal error: Rate limited",
		);
		expect(screen.getByTestId("agent-message-error")).toHaveTextContent(
			"Internal error: Rate limited",
		);
	});

	describe("from the turn's end until its reply is read", () => {
		const turn = {
			thread: "T1",
			text: "No. It **skips**",
			activity: [],
			asked: "m1",
		};
		const busy = status({ state: "busy", answering: turn });
		const ready = status();
		const reply = answered({
			messages: [
				...thread().messages,
				{
					id: "m2",
					by: "ai",
					at: "2026-11-07T10:01:00Z",
					text: "No. It **skips** the first element.",
					agent: { name: "Claude Agent", version: "0.100.0" },
					stop: "end_turn",
					replyTo: "m1",
				},
			],
		});
		function mount() {
			const client = new QueryClient({
				defaultOptions: { queries: { retry: false, enabled: false } },
			});
			const view = (t: AgentThread, s: AgentStatus) => (
				<QueryClientProvider client={client}>
					<AgentThreadCard thread={t} status={s} />
				</QueryClientProvider>
			);
			const r = render(view(thread(), busy));
			return {
				client,
				rerender: (t: AgentThread, s: AgentStatus) => r.rerender(view(t, s)),
			};
		}
		const streamed = () =>
			screen.queryByTestId("agent-answering")?.textContent ?? "";

		it("the streamed text stays and waiting never shows; then the reply, once", () => {
			const { client, rerender } = mount();
			expect(streamed()).toContain("No. It skips");
			// The status has dropped the turn; the threads aren't read yet.
			rerender(thread(), ready);
			expect(streamed()).toContain("No. It skips");
			expect(screen.queryByTestId("agent-waiting")).toBeNull();
			expect(screen.getByTestId("agent-thread")).toHaveAttribute(
				"aria-label",
				"Agent thread, answering",
			);
			// The read lands with the reply: shown once, the stream gone.
			client.setQueryData(agentThreadsQuery.queryKey, { threads: [reply] });
			rerender(reply, ready);
			expect(screen.queryByTestId("agent-answering")).toBeNull();
			expect(screen.getAllByTestId("agent-message-ai")).toHaveLength(1);
			expect(screen.queryByTestId("agent-waiting")).toBeNull();
		});

		it("a status that still has the turn while the thread holds its reply shows it once", () => {
			const { rerender } = mount();
			rerender(reply, busy);
			expect(screen.queryByTestId("agent-answering")).toBeNull();
			expect(screen.getAllByTestId("agent-message-ai")).toHaveLength(1);
		});

		it("a turn that lands nothing lets go at the next threads read, or a restart", () => {
			const { client, rerender } = mount();
			rerender(thread(), ready);
			expect(streamed()).toContain("No. It skips");
			client.setQueryData(agentThreadsQuery.queryKey, { threads: [thread()] });
			rerender(thread(), ready);
			expect(screen.queryByTestId("agent-answering")).toBeNull();
			expect(screen.getByTestId("agent-waiting")).toBeTruthy();

			cleanup();
			const again = mount();
			again.rerender(thread(), status({ state: "starting" }));
			expect(screen.queryByTestId("agent-answering")).toBeNull();
			expect(screen.getByTestId("agent-waiting")).toBeTruthy();
		});
	});

	it("a stopped or truncated reply says so", () => {
		const t = answered();
		const last = t.messages[1];
		if (last) {
			last.stop = "cancelled";
			last.truncated = true;
		}
		show(t, status());
		const chip = screen.getByTestId("agent-stop-chip");
		expect(chip.textContent).toBe("stopped");
		// Its reason is a tooltip and its name, not a bare title.
		expect(chip).not.toHaveAttribute("title");
		expect(chip).toHaveAccessibleName("Stopped before it finished");
		expect(screen.getByTestId("agent-truncated-chip")).toBeTruthy();
	});
});

describe("activitySummary", () => {
	it("counts files read, commands run, files edited and tools used", () => {
		expect(activitySummary([])).toBe("");
		expect(
			activitySummary([
				{ kind: "read", title: "a" },
				{ kind: "search", title: "b" },
				{ kind: "delete", title: "c" },
				{ kind: "move", title: "d" },
				{ kind: "execute", title: "e" },
				{ kind: "execute", title: "f" },
			]),
		).toBe("read 1 file · ran 2 commands · edited 2 files · used 1 tool");
	});
});
