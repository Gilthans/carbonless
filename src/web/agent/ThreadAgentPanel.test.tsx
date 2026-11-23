// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentThread } from "../../shared/agent";
import type { PrOverview, ReviewThread, SessionInfo } from "../../shared/types";
import { overviewQuery, sessionQuery, showCommentsOf } from "../api";
import { ThreadActions } from "../threads/Conversation";
import { ThreadStatus } from "../threads/ThreadStatus";
import { resetAgentWrites } from "./agentWrites";
import { agentStatusQuery, agentThreadsQuery } from "./api";
import {
	requestConversationOpen,
	resetConversationLanding,
} from "./conversationLinks";
import { AgentCover } from "./ThreadAgentPanel";
import {
	resetAgentDrafts,
	SEEN_AFTER_MS,
	type SendView,
	SendViewProvider,
	ThreadAgentContext,
	useThreadAgent,
} from "./threadAgent";
import {
	conversation,
	reviewThread,
	stubIntersection,
} from "./threadAgentFixtures";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

let calls: { method: string; path: string; body: unknown }[];
/** Answers a POST; never answered unless a test says. */
let answer: (path: string, body: unknown) => Promise<Response>;
/** Answers a GET; never answered unless a test says. */
let read: (path: string) => Promise<Response>;

beforeEach(() => {
	calls = [];
	answer = () => new Promise(() => {});
	read = () => new Promise(() => {});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input, "http://crb");
			const method = init?.method ?? "GET";
			if (method === "GET") return read(url.pathname);
			const body: unknown = JSON.parse(String(init?.body ?? "null"));
			calls.push({ method, path: url.pathname, body });
			return answer(url.pathname, body);
		}),
	);
});

let clients: QueryClient[] = [];
afterEach(() => {
	cleanup();
	for (const c of clients) showCommentsOf(c, "");
	clients = [];
	resetAgentWrites();
	resetAgentDrafts();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** A thread card as the pages build one: header, covered comments, composer row. */
function Card(props: { thread: ReviewThread }) {
	const { thread } = props;
	const agent = useThreadAgent(thread);
	return (
		<ThreadAgentContext.Provider value={agent}>
			<article data-testid="card">
				<header data-testid="card-header">
					<ThreadStatus
						thread={thread}
						onCounter={agent?.open ? agent.close : undefined}
					/>
				</header>
				<AgentCover>
					<p data-testid="comments">The thread's comments</p>
				</AgentCover>
				<ThreadActions thread={thread} />
			</article>
		</ThreadAgentContext.Provider>
	);
}

function show(
	thread: ReviewThread,
	/** null: not read yet (agentThreadsQuery asks). */
	threads: AgentThread[] | null,
	opts: { view?: SendView } = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	clients.push(client);
	client.setQueryData(overviewQuery.queryKey, {
		readId: "r1",
		writes: "on",
		pendingReview: null,
	} as PrOverview);
	client.setQueryData(sessionQuery.queryKey, {
		viewer: "octo",
		snapshotHead: "h2",
		patchsets: [
			{ number: 1, head: "h1" },
			{ number: 2, head: "h2" },
		],
	} as unknown as SessionInfo);
	if (threads) client.setQueryData(agentThreadsQuery.queryKey, { threads });
	client.setQueryData(agentStatusQuery.queryKey, {
		state: "ready",
		configured: true,
		since: "2026-11-11T10:00:00Z",
		waiting: 0,
	});
	const ui = (t: ReviewThread) => (
		<QueryClientProvider client={client}>
			{opts.view ? (
				<SendViewProvider value={opts.view}>
					<Card thread={t} />
				</SendViewProvider>
			) : (
				<Card thread={t} />
			)}
		</QueryClientProvider>
	);
	const r = render(ui(thread));
	return {
		client,
		rerender: (t: ReviewThread) => r.rerender(ui(t)),
	};
}

const panel = () => screen.getByTestId("thread-agent-panel");
const isOpen = () => panel().getAttribute("data-open") === "true";
const agentButton = () =>
	screen.getByRole("button", { name: /agent message|Ask agent/ });

describe("ThreadAgentPanel", () => {
	it("opens scrolled to its end", async () => {
		show(reviewThread(), [conversation()]);
		expect(isOpen()).toBe(false);
		await userEvent.click(agentButton());
		expect(isOpen()).toBe(true);
		const scroller = within(panel()).getByTestId("thread-agent-scroll");
		// Reversed: its start is the latest message, scrollTop 0 its end.
		expect(scroller.className).toContain("flex-col-reverse");
		expect(scroller.scrollTop).toBe(0);
		expect(within(panel()).getByText("Only here.")).toBeInTheDocument();
		// The composer takes the focus.
		expect(screen.getByRole("textbox", { name: "Ask agent" })).toHaveFocus();
	});

	it("while its read is out or failed, a spinner or the error, never an empty conversation (CAR-124)", async () => {
		// The first read fails: the button's alert, which opens the panel and reads again.
		let release: (r: Response) => void = () => {};
		read = (path) =>
			path.endsWith("/agent/threads")
				? new Promise<Response>((r) => {
						release = r;
					})
				: new Promise(() => {});
		show(reviewThread(), null);
		await act(async () => release(json({ error: "boom" }, 500)));
		const failedButton = await screen.findByRole("button", {
			name: "Agent messages couldn't load",
		});
		await userEvent.click(failedButton);
		expect(isOpen()).toBe(true);
		// The read again is held: the spinner in the panel, no messages, no error.
		const loading = within(panel()).getByTestId("thread-agent-panel-loading");
		expect(loading).toHaveAttribute("aria-busy", "true");
		expect(
			within(loading).getByRole("status", { name: "Loading agent messages" }),
		).toBeInTheDocument();
		expect(within(panel()).queryByRole("alert")).toBeNull();
		// It fails again: the error with Retry, no spinner.
		await act(async () => release(json({ error: "boom" }, 500)));
		const failed = within(panel()).getByRole("alert");
		expect(failed).toHaveTextContent("Agent messages couldn't load");
		expect(
			within(panel()).queryByTestId("thread-agent-panel-loading"),
		).toBeNull();
		// Retry: the spinner, then the conversation.
		await userEvent.click(
			within(failed).getByRole("button", { name: "Retry" }),
		);
		expect(
			within(panel()).getByTestId("thread-agent-panel-loading"),
		).toBeInTheDocument();
		await act(async () => release(json({ threads: [conversation()] })));
		expect(await within(panel()).findByText("Only here.")).toBeInTheDocument();
		expect(
			within(panel()).queryByTestId("thread-agent-panel-loading"),
		).toBeNull();
		expect(within(panel()).queryByRole("alert")).toBeNull();
	});

	it("an answer with no conversation for the thread: the empty panel, no spinner or error", async () => {
		show(reviewThread(), []);
		await userEvent.click(agentButton());
		expect(isOpen()).toBe(true);
		expect(
			within(panel()).queryByTestId("thread-agent-panel-loading"),
		).toBeNull();
		expect(within(panel()).queryByRole("alert")).toBeNull();
	});

	it("the strip, the comment counter and the agent button each close it", async () => {
		show(reviewThread(), [conversation()]);
		await userEvent.click(agentButton());
		await userEvent.click(
			screen.getByRole("button", { name: "Back to the thread" }),
		);
		expect(isOpen()).toBe(false);
		expect(agentButton()).toHaveFocus();
		await userEvent.click(agentButton());
		await userEvent.click(screen.getByRole("button", { name: "3 comments" }));
		expect(isOpen()).toBe(false);
		await userEvent.click(agentButton());
		await userEvent.click(
			screen.getByRole("button", { name: "4 agent messages: hide" }),
		);
		expect(isOpen()).toBe(false);
		expect(screen.queryByRole("button", { name: "Back to the thread" })).toBe(
			null,
		);
		// Closed, the counter is no button.
		expect(screen.queryByRole("button", { name: "3 comments" })).toBeNull();
	});

	// A guard against the panel's own timer coming back, not a reproduction: it passes on the old code too.
	it("closing, the panel goes and the cover gives up its height in one render (CAR-206)", () => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame"],
		});
		show(reviewThread(), [conversation()]);
		const cover = screen.getByTestId("agent-cover");
		const tall = () => cover.className.includes("min-h-64");
		const drawn = () => !panel().className.split(" ").includes("hidden");
		fireEvent.click(agentButton());
		act(() => vi.advanceTimersToNextTimer());
		expect(isOpen()).toBe(true);
		expect([drawn(), tall()]).toEqual([true, true]);
		fireEvent.click(agentButton());
		expect(isOpen()).toBe(false);
		// Through the slide out, timer by timer: never one without the other.
		for (let i = 0; i < 5 && vi.getTimerCount() > 0; i++) {
			expect(tall()).toBe(drawn());
			act(() => vi.advanceTimersToNextTimer());
		}
		expect([drawn(), tall()]).toEqual([false, false]);
	});

	it("Ask agent has no Write / Preview: the box goes back to Write", async () => {
		show(reviewThread(), [conversation()]);
		await userEvent.type(
			screen.getByRole("textbox", { name: "Reply" }),
			"**hi**",
		);
		await userEvent.click(screen.getByRole("button", { name: "Preview" }));
		expect(screen.getByTestId("comment-preview")).toBeInTheDocument();
		await userEvent.click(agentButton());
		const ask = screen.getByRole("textbox", { name: "Ask agent" });
		await userEvent.type(ask, "why?");
		expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
		expect(screen.queryByTestId("comment-preview")).toBeNull();
		// Open, it is as tall as the reply's (toggle over Send), and as wide:
		// the toggle's slot stays, unseen. No jump either way.
		expect(ask.className).toContain("min-h-[84px]");
		expect(screen.getByTestId("preview-toggle")).not.toBeVisible();
		// Back to the reply: in Write, not the Preview it left.
		await userEvent.click(agentButton());
		const reply = screen.getByRole("textbox", { name: "Reply" });
		expect(reply).toHaveValue("**hi**");
		expect(screen.queryByTestId("comment-preview")).toBeNull();
		expect(screen.getByRole("button", { name: "Write" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	it("placeholder reads Ask agent… when open and Reply… when closed", async () => {
		show(reviewThread(), [conversation()]);
		expect(screen.getByRole("textbox", { name: "Reply" })).toHaveAttribute(
			"placeholder",
			"Reply…",
		);
		await userEvent.click(agentButton());
		expect(screen.getByRole("textbox", { name: "Ask agent" })).toHaveAttribute(
			"placeholder",
			"Ask agent…",
		);
		await userEvent.click(agentButton());
		expect(screen.getByRole("textbox", { name: "Reply" })).toHaveAttribute(
			"placeholder",
			"Reply…",
		);
	});

	it("the card header and the composer row are outside the panel", async () => {
		show(reviewThread(), [conversation()]);
		await userEvent.click(agentButton());
		const p = panel();
		expect(p.contains(screen.getByTestId("card-header"))).toBe(false);
		expect(p.contains(screen.getByTestId("thread-actions"))).toBe(false);
		// Inside the comments' box, which grows to give it room.
		const cover = screen.getByTestId("agent-cover");
		expect(cover.contains(p)).toBe(true);
		expect(cover.contains(screen.getByTestId("comments"))).toBe(true);
	});

	it("a 'new' divider above the first unseen message", async () => {
		show(reviewThread(), [conversation({ unread: true, seenUpTo: "m3" })]);
		await userEvent.click(agentButton());
		const divider = within(panel()).getByRole("separator", { name: "new" });
		expect(divider.nextElementSibling).toHaveTextContent("Only here.");
		expect(within(panel()).getAllByRole("separator")).toHaveLength(1);
	});

	it("writes one seen when an unseen agent message is visible, none when nothing is unseen", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		stubIntersection(true);
		answer = async (path) =>
			path.endsWith("/seen")
				? json(conversation({ unread: false, seenUpTo: "m4" }))
				: new Promise(() => {});
		show(reviewThread(), [conversation({ unread: true, seenUpTo: "m2" })]);
		fireEvent.click(agentButton());
		await act(async () => {
			vi.advanceTimersByTime(SEEN_AFTER_MS - 1);
		});
		// Not yet: it is in view for a second first.
		expect(calls).toEqual([]);
		await act(async () => {
			vi.advanceTimersByTime(1);
		});
		expect(calls.filter((c) => c.path.endsWith("/seen"))).toEqual([
			{
				method: "POST",
				path: "/api/agent/threads/A1/seen",
				body: { upTo: "m4" },
			},
		]);
		// Seen now: nothing more however long it stays open.
		await act(async () => {
			vi.advanceTimersByTime(SEEN_AFTER_MS * 3);
		});
		expect(calls.filter((c) => c.path.endsWith("/seen"))).toHaveLength(1);
		cleanup();
		calls = [];
		show(reviewThread(), [conversation()]);
		fireEvent.click(agentButton());
		await act(async () => {
			vi.advanceTimersByTime(SEEN_AFTER_MS * 3);
		});
		expect(calls).toEqual([]);
	});

	it("Resolve By Agent Suggestion shows on the latest suggesting message of an unresolved thread, resolves the GitHub thread on press (the same write as Resolve) and hides once resolved; absent on an orphan", async () => {
		const suggesting = conversation({
			messages: conversation().messages.map((m) =>
				m.by === "ai" ? { ...m, suggests: "resolve" as const } : m,
			),
		});
		const { rerender } = show(reviewThread(), [suggesting]);
		await userEvent.click(agentButton());
		const buttons = within(panel()).getAllByRole("button", {
			name: "Resolve By Agent Suggestion",
		});
		expect(buttons).toHaveLength(1);
		// Under the latest suggesting message, in ok.
		expect(buttons[0]?.closest("[data-message]")).toHaveAttribute(
			"data-message",
			"m4",
		);
		expect(buttons[0]?.className).toContain("text-ok");
		// Inside the suggesting reply's own surface, not an earlier one.
		const replies = within(panel()).getAllByTestId("agent-message-ai");
		const inside = replies.filter((r) => r.contains(buttons[0] as HTMLElement));
		expect(inside).toHaveLength(1);
		expect(replies.length).toBeGreaterThan(1);
		expect(inside[0]).toBe(replies[replies.length - 1]);
		// The agent's railed box, as on the card (CAR-270).
		for (const r of replies)
			expect(r.className).toContain("border-l-agent-ink");
		// Nothing is written until a human presses it.
		expect(calls).toEqual([]);
		await userEvent.click(buttons[0] as HTMLElement);
		expect(calls).toEqual([
			{
				method: "POST",
				path: "/api/threads/RT1/resolved",
				body: { resolved: true },
			},
		]);
		rerender(reviewThread({ resolved: true }));
		await userEvent.click(agentButton());
		expect(
			screen.queryByRole("button", { name: "Resolve By Agent Suggestion" }),
		).toBeNull();
		cleanup();
		show(reviewThread(), [{ ...suggesting, orphaned: true }]);
		// An orphan is a span thread: this card has no conversation.
		await userEvent.click(agentButton());
		expect(
			screen.queryByRole("button", { name: "Resolve By Agent Suggestion" }),
		).toBeNull();
	});

	it("Resolve gets the ok ring while a suggestion stands", () => {
		show(reviewThread(), [conversation()]);
		expect(
			screen.getByRole("button", { name: "Resolve" }).className,
		).not.toContain("ring-ok");
		cleanup();
		const suggesting = conversation();
		const last = suggesting.messages[3];
		if (last) last.suggests = "resolve";
		show(reviewThread(), [suggesting]);
		expect(screen.getByRole("button", { name: "Resolve" }).className).toContain(
			"ring-ok",
		);
	});

	it.each([
		["before its observer reports", null],
		["while its observer says it is off-screen", false],
	] as const)("writes no seen for an open panel %s", async (_, inView) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		stubIntersection(inView);
		show(reviewThread(), [conversation({ unread: true, seenUpTo: "m2" })]);
		fireEvent.click(agentButton());
		await act(async () => {
			vi.advanceTimersByTime(SEEN_AFTER_MS * 3);
		});
		expect(calls.filter((c) => c.path.endsWith("/seen"))).toEqual([]);
	});

	it("a later answer that doesn't suggest resolving retracts the suggestion: no button, no ring; a failed or stopped one, or a question, doesn't", async () => {
		const base = conversation().messages;
		const suggested = (more: AgentThread["messages"]) =>
			conversation({
				messages: [
					...base.slice(0, 3),
					{ ...(base[3] as AgentMessage), suggests: "resolve" },
					...more,
				],
				seenUpTo: more.at(-1)?.id ?? "m4",
			});
		const resolve = () => screen.getByRole("button", { name: "Resolve" });
		const suggestion = () =>
			within(panel()).queryAllByRole("button", {
				name: "Resolve By Agent Suggestion",
			});
		// Regressed: the latest answer no longer suggests it.
		show(reviewThread(), [
			suggested([
				{ id: "m5", by: "human", at: "2026-11-11T10:04:00Z", text: "Now?" },
				{
					id: "m6",
					by: "ai",
					at: "2026-11-11T10:05:00Z",
					text: "Regressed, not resolved.",
					stop: "end_turn",
				},
			]),
		]);
		await userEvent.click(agentButton());
		expect(suggestion()).toHaveLength(0);
		expect(resolve().className).not.toContain("ring-ok");
		// A failed answer, a stopped one and a question alone leave it standing.
		for (const more of [
			[
				{ id: "m5", by: "human", at: "2026-11-11T10:04:00Z", text: "Now?" },
				{
					id: "m6",
					by: "ai",
					at: "2026-11-11T10:05:00Z",
					text: "",
					stop: "error",
					error: "boom",
				},
			],
			[
				{ id: "m5", by: "human", at: "2026-11-11T10:04:00Z", text: "Now?" },
				{
					id: "m6",
					by: "ai",
					at: "2026-11-11T10:05:00Z",
					text: "Let me",
					stop: "cancelled",
				},
			],
			[{ id: "m5", by: "human", at: "2026-11-11T10:04:00Z", text: "Now?" }],
		] as AgentThread["messages"][]) {
			cleanup();
			show(reviewThread(), [suggested(more)]);
			await userEvent.click(agentButton());
			const buttons = suggestion();
			expect(buttons).toHaveLength(1);
			expect(buttons[0]?.closest("[data-message]")).toHaveAttribute(
				"data-message",
				"m4",
			);
			expect(resolve().className).toContain("ring-ok");
		}
	});

	it("sending posts the current view", async () => {
		show(reviewThread(), []);
		await userEvent.click(agentButton());
		await userEvent.type(
			screen.getByRole("textbox", { name: "Ask agent" }),
			"Fixed here?",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Send to agent" }),
		);
		expect(calls).toEqual([
			{
				method: "POST",
				path: "/api/agent/threads",
				body: {
					clientId: expect.any(String),
					text: "Fixed here?",
					thread: "RT1",
					// The Overview's: the latest patch set against the branch.
					view: { target: { patchset: 2 }, from: { branch: true } },
				},
			},
		]);
		// Sent: the box is empty, the question shows as on its way.
		expect(screen.getByRole("textbox", { name: "Ask agent" })).toHaveValue("");
		expect(within(panel()).getByText("Fixed here?")).toBeInTheDocument();
		cleanup();
		calls = [];
		show(reviewThread(), [conversation()], {
			view: { target: { patchset: 1 }, from: { patchset: 0 } } as SendView,
		});
		await userEvent.click(agentButton());
		await userEvent.type(
			screen.getByRole("textbox", { name: "Ask agent" }),
			"And there?{Control>}{Enter}{/Control}",
		);
		expect(calls).toEqual([
			{
				method: "POST",
				path: "/api/agent/threads/A1/messages",
				body: {
					clientId: expect.any(String),
					text: "And there?",
					view: { target: { patchset: 1 }, from: { patchset: 0 } },
				},
			},
		]);
	});

	it("while the GitHub thread is resolved the conversation folds with it, stays readable and hides its composer", async () => {
		const { rerender } = show(reviewThread(), [conversation()]);
		await userEvent.click(agentButton());
		expect(isOpen()).toBe(true);
		rerender(reviewThread({ resolved: true }));
		expect(isOpen()).toBe(false);
		// Still readable: it opens, with no composer.
		await userEvent.click(agentButton());
		expect(within(panel()).getByText("Only here.")).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: "Ask agent" })).toBeNull();
		expect(screen.getByRole("button", { name: "Unresolve" })).toBeVisible();
		// Unresolving opens both again.
		await userEvent.click(agentButton());
		rerender(reviewThread({ resolved: true }));
		rerender(reviewThread());
		expect(isOpen()).toBe(false);
		await userEvent.click(agentButton());
		rerender(reviewThread({ resolved: true }));
		expect(isOpen()).toBe(false);
		rerender(reviewThread());
		expect(isOpen()).toBe(true);
		expect(screen.getByRole("textbox", { name: "Ask agent" })).toBeEnabled();
	});

	it("while GitHub can't be read it stays readable, its composer off; a 502 on send shows why", async () => {
		show(reviewThread(), [conversation({ githubUnknown: true })]);
		await userEvent.click(agentButton());
		expect(within(panel()).getByText("Only here.")).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Ask agent" })).toBeDisabled();
		cleanup();
		answer = async () => json({ error: "GitHub couldn't be read" }, 502);
		show(reviewThread(), [conversation()]);
		await userEvent.click(agentButton());
		await userEvent.type(
			screen.getByRole("textbox", { name: "Ask agent" }),
			"Still?",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Send to agent" }),
		);
		expect(
			await within(panel()).findByText("GitHub couldn't be read"),
		).toBeInTheDocument();
		expect(within(panel()).getByText("Still?")).toBeInTheDocument();
		expect(calls).toHaveLength(1);
	});

	it("the card's context value is stable while nothing it holds changes", () => {
		const client = new QueryClient();
		clients.push(client);
		client.setQueryData(overviewQuery.queryKey, { writes: "on" } as PrOverview);
		client.setQueryData(agentThreadsQuery.queryKey, {
			threads: [conversation()],
		});
		const t = reviewThread();
		const { result, rerender } = renderHook(
			() => useThreadAgent(t, { onToggle: () => {} }),
			{
				wrapper: ({ children }) => (
					<QueryClientProvider client={client}>{children}</QueryClientProvider>
				),
			},
		);
		const first = result.current;
		expect(first).not.toBeNull();
		rerender();
		expect(result.current).toBe(first);
		act(() => first?.toggle());
		expect(result.current).not.toBe(first);
		expect(result.current?.open).toBe(true);
	});

	it("a link to the conversation opens its panel (CAR-80)", () => {
		const client = new QueryClient();
		clients.push(client);
		client.setQueryData(overviewQuery.queryKey, { writes: "on" } as PrOverview);
		const id = "01k9e6m2q8x4v7c3n5b0h1j2aa";
		client.setQueryData(agentThreadsQuery.queryKey, {
			threads: [conversation({ id })],
		});
		const t = reviewThread();
		const { result } = renderHook(() => useThreadAgent(t), {
			wrapper: ({ children }) => (
				<QueryClientProvider client={client}>{children}</QueryClientProvider>
			),
		});
		expect(result.current?.open).toBe(false);
		act(() => requestConversationOpen("01k9e6m2q8x4v7c3n5b0h1j2bb"));
		expect(result.current?.open).toBe(false);
		act(() => requestConversationOpen(id));
		expect(result.current?.open).toBe(true);
		resetConversationLanding();
	});
});
