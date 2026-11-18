// @vitest-environment jsdom
import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentAnchor,
	type AgentThread,
	isSpanThread,
} from "../../shared/agent";
import type {
	NewThreadAnswer,
	PrOverview,
	ReviewThread,
	SessionInfo,
} from "../../shared/types";
import { overviewQuery, sessionQuery } from "../api";
import { useDrafts } from "../threads/drafts";
import { NewThread } from "../threads/NewThread";
import {
	newThreadItems,
	resetComposers,
	targetOf,
	useComposers,
} from "../threads/newThreads";
import { threadWritesFor } from "../threads/threadWrites";
import { AgentThreadCard } from "./AgentThreadCard";
import { type CommentScope, CommentScopeProvider } from "./agentComment";
import { resetAgentWrites } from "./agentWrites";
import { agentThreadsQuery } from "./api";
import { spanOfAnchor } from "./askAgentAction";
import { resetLinkProblems } from "./linkProblems";
import {
	type PendingComposers,
	PendingComposersProvider,
	resetHeldComposers,
	useHeldByCard,
} from "./pendingThread";
import { AgentHandle } from "./ThreadAgentButton";
import { ThreadAgentContext, useThreadAgent } from "./threadAgent";
import { reviewThread, stubIntersection } from "./threadAgentFixtures";

const HEAD = "h".repeat(40);
const ID = "01k9e6m2q8x4v7c3n5b0h1j2t6";
const line: AgentAnchor = {
	subject: "line",
	path: "src/math.js",
	commit: HEAD,
	side: "RIGHT",
	line: 3,
	startSide: "RIGHT",
	startLine: 3,
};
const conversation = (more: Partial<AgentThread> = {}): AgentThread => ({
	id: ID,
	anchor: line,
	openedBy: "human",
	at: "2026-11-07T10:00:00Z",
	messages: [
		{
			id: "m1",
			by: "human",
			at: "2026-11-07T10:00:00Z",
			text: "Why <b>so</b>?",
		},
		{
			id: "m2",
			by: "ai",
			at: "2026-11-07T10:01:00Z",
			text: "It adds v1 and v2.",
		},
	],
	resolved: false,
	waiting: false,
	unread: false,
	...more,
});

const SCOPE: CommentScope = { headSure: true, inDiff: () => true };
const THREADS_KEY = ["threads", "r1"];

let client: QueryClient;
let answer: NewThreadAnswer;
let posted: unknown[];

beforeEach(() => {
	stubIntersection(false);
	posted = [];
	answer = {
		thread: reviewThread({ id: "T9", path: "src/math.js", line: 3 }),
		comments: { threadId: "T9", comments: [] },
		agentThread: ID,
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (String(url).endsWith("/api/threads") && init?.method === "POST") {
				posted.push(JSON.parse(String(init.body)));
				return new Response(JSON.stringify(answer), { status: 200 });
			}
			// The agent threads read again after a post: held, so what shows
			// is what the post's answer did to them.
			if (String(url).endsWith("/agent/threads")) return new Promise(() => {});
			return new Response("{}", { status: 200 });
		}),
	);
});
afterEach(() => {
	cleanup();
	resetComposers();
	resetHeldComposers();
	resetAgentWrites();
	resetLinkProblems();
	vi.unstubAllGlobals();
});

/** A GitHub thread's agent handle, as its card has it. */
function GithubThread(props: { thread: ReviewThread }) {
	const agent = useThreadAgent(props.thread);
	return (
		<article data-testid="files-thread" data-thread={props.thread.id}>
			<ThreadAgentContext.Provider value={agent}>
				<AgentHandle />
			</ThreadAgentContext.Provider>
		</article>
	);
}

/**
 * A line as Files changed shows it: GitHub's threads, the composers on it
 * (less those a card holds, as NewThreadRow), then its agent cards.
 */
function Line() {
	const threads =
		useQuery<{ threads: ReviewThread[] }>({
			queryKey: THREADS_KEY,
			queryFn: () =>
				client.getQueryData<{ threads: ReviewThread[] }>(THREADS_KEY) ?? {
					threads: [],
				},
			enabled: false,
		}).data?.threads ?? [];
	const agent = useQuery({ ...agentThreadsQuery, enabled: false }).data
		?.threads;
	const held = useHeldByCard();
	const items = newThreadItems(useDrafts(), useComposers()).filter(
		(i) => !held(i),
	);
	return (
		<>
			<div data-testid="threads">
				{threads.map((t) => (
					<GithubThread key={t.id} thread={t} />
				))}
			</div>
			<div data-testid="composers">
				{items.map((i) => (
					<NewThread key={i.clientId} item={i} quote="total" />
				))}
			</div>
			<div data-testid="cards">
				{(agent ?? [])
					.filter(isSpanThread)
					.filter((t) => t.anchor.subject !== "thread")
					.map((t) => (
						<AgentThreadCard key={t.id} thread={t} status={undefined} />
					))}
			</div>
		</>
	);
}

function show(c: AgentThread = conversation()) {
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, enabled: false, staleTime: Infinity },
		},
	});
	client.setQueryData(overviewQuery.queryKey, {
		writes: "on",
		commentLeft: true,
	} as PrOverview);
	client.setQueryData(sessionQuery.queryKey, {
		viewer: "dan",
		snapshotHead: HEAD,
		head: null,
		patchsets: [],
	} as unknown as SessionInfo);
	client.setQueryData(agentThreadsQuery.queryKey, { threads: [c] });
	client.setQueryData(THREADS_KEY, { threads: [] });
	const diff: PendingComposers = {
		head: HEAD,
		quote: () => "total",
	};
	render(
		<QueryClientProvider client={client}>
			<CommentScopeProvider value={SCOPE}>
				<PendingComposersProvider value={diff}>
					<Line />
				</PendingComposersProvider>
			</CommentScopeProvider>
		</QueryClientProvider>,
	);
}

const region = (id: string) => screen.getByTestId(id);
const pressComment = () =>
	userEvent.click(screen.getByRole("button", { name: "Comment on GitHub" }));

describe("Comment turns the agent card into the thread it will be", () => {
	it("in the card's place: one pending thread holding the composer and the conversation's messages; no card, no second composer", async () => {
		show();
		expect(within(region("cards")).getByTestId("agent-thread")).toBeTruthy();
		await pressComment();
		expect(screen.queryByTestId("agent-thread")).toBeNull();
		expect(screen.getAllByTestId("new-thread")).toHaveLength(1);
		expect(region("composers").childElementCount).toBe(0);
		const pending = within(region("cards")).getByTestId("new-thread");
		const box = within(pending).getByRole("textbox", { name: "Comment" });
		expect(document.activeElement).toBe(box);
		// The conversation as the thread's agent conversation: its handle
		// and panel, open, with the history (as text: no markup from it).
		const panel = within(pending).getByTestId("thread-agent-panel");
		expect(panel.getAttribute("data-open")).toBe("true");
		expect(
			within(panel)
				.getAllByTestId("agent-message-human")
				.map((m) => m.textContent),
		).toEqual(["Why <b>so</b>?"]);
		expect(panel.querySelector("b")).toBeNull();
		expect(within(panel).getByTestId("agent-message-ai").textContent).toContain(
			"It adds v1 and v2.",
		);
		expect(
			within(pending)
				.getByTestId("thread-agent-button")
				.getAttribute("aria-pressed"),
		).toBe("true");
		// No switch to the agent, nor a mark: the conversation is attached.
		expect(within(pending).queryByTestId("new-thread-agent")).toBeNull();
		expect(within(pending).queryByRole("img", { name: /agent/ })).toBeNull();
	});

	it("its handle folds the panel away and back, the composer always in reach", async () => {
		show();
		await pressComment();
		const pending = screen.getByTestId("new-thread");
		await userEvent.click(within(pending).getByTestId("thread-agent-button"));
		expect(
			within(pending)
				.getByTestId("thread-agent-panel")
				.getAttribute("data-open"),
		).toBe("false");
		expect(
			within(pending)
				.getByTestId("thread-agent-button")
				.getAttribute("aria-label"),
		).toBe("2 agent messages");
		await userEvent.click(within(pending).getByTestId("thread-agent-button"));
		expect(
			within(pending)
				.getByTestId("thread-agent-panel")
				.getAttribute("data-open"),
		).toBe("true");
	});

	it("Cancel: back to the plain card, the conversation untouched", async () => {
		show();
		await pressComment();
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByTestId("new-thread")).toBeNull();
		const card = within(region("cards")).getByTestId("agent-thread");
		expect(within(card).getByTestId("agent-message-ai").textContent).toContain(
			"It adds v1 and v2.",
		);
		expect(
			client.getQueryData(agentThreadsQuery.queryKey)?.threads[0]?.anchor,
		).toEqual(line);
	});

	it("posted: one GitHub thread with the conversation behind its agent button; no card, no composer", async () => {
		show();
		await pressComment();
		await userEvent.type(
			screen.getByRole("textbox", { name: "Comment" }),
			"Shouldn't it add v3?",
		);
		await userEvent.click(screen.getByTestId("new-thread-post"));
		await vi.waitFor(() =>
			expect(
				within(region("threads")).getAllByTestId("files-thread"),
			).toHaveLength(1),
		);
		expect(posted).toMatchObject([
			{ body: "Shouldn't it add v3?", agentThread: ID },
		]);
		expect(screen.queryByTestId("new-thread")).toBeNull();
		expect(screen.queryByTestId("agent-thread")).toBeNull();
		// The conversation is the thread's at once, before it is read again.
		expect(
			client.getQueryData(agentThreadsQuery.queryKey)?.threads[0]?.anchor,
		).toMatchObject({ subject: "thread", thread: "T9", path: "src/math.js" });
		expect(
			within(region("threads"))
				.getByTestId("thread-agent-button")
				.getAttribute("aria-label"),
		).toBe("2 agent messages");
	});

	it("while it is sent: the comment shows where it was written, the panel folded, the conversation still on its handle", async () => {
		let release: (a: NewThreadAnswer) => void = () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(url: string, init?: RequestInit) =>
					new Promise<Response>((resolve) => {
						if (
							String(url).endsWith("/api/threads") &&
							init?.method === "POST"
						) {
							release = (a) =>
								resolve(new Response(JSON.stringify(a), { status: 200 }));
						} else resolve(new Response("{}", { status: 200 }));
					}),
			),
		);
		show();
		await pressComment();
		await userEvent.type(
			screen.getByRole("textbox", { name: "Comment" }),
			"On its way",
		);
		await userEvent.click(screen.getByTestId("new-thread-post"));
		const pending = within(region("cards")).getByTestId("new-thread");
		expect(
			within(pending).getByTestId("new-thread-sending").textContent,
		).toContain("On its way");
		expect(
			within(pending)
				.getByTestId("thread-agent-panel")
				.getAttribute("data-open"),
		).toBe("false");
		expect(within(pending).getByTestId("thread-agent-button")).toBeTruthy();
		await act(async () => release(answer));
		await vi.waitFor(() =>
			expect(screen.queryByTestId("new-thread")).toBeNull(),
		);
		expect(within(region("threads")).getByTestId("files-thread")).toBeTruthy();
	});

	it("a composer already typed on the span is the one in the card, its text kept; never a second box", async () => {
		show();
		const writer = threadWritesFor(client);
		act(() =>
			writer.drafts.setNew("typed1", targetOf(spanOfAnchor(line)), "Half done"),
		);
		expect(
			within(region("composers")).getAllByTestId("new-thread"),
		).toHaveLength(1);
		await pressComment();
		expect(screen.getAllByTestId("new-thread")).toHaveLength(1);
		expect(
			within(region("cards")).getByRole("textbox", { name: "Comment" }),
		).toHaveProperty("value", "Half done");
	});

	it("a head move that drops the link: a plain composer again, and the card is back", async () => {
		show();
		const writer = threadWritesFor(client);
		await pressComment();
		await userEvent.type(screen.getByRole("textbox", { name: "Comment" }), "x");
		const [id] = writer.drafts
			.get()
			.flatMap((d) => (d.create ? [d.create.clientId] : []));
		act(() => writer.drafts.retarget(id ?? "", "n".repeat(40)));
		expect(within(region("cards")).getByTestId("agent-thread")).toBeTruthy();
		expect(within(region("cards")).queryByTestId("new-thread")).toBeNull();
	});

	it("where Comment isn't offered (no diff around it), the card stays a card and the composer shows as its own", async () => {
		show(conversation({ orphaned: true }));
		const writer = threadWritesFor(client);
		act(() =>
			writer.drafts.setNew("c1", targetOf(spanOfAnchor(line), ID), "typed"),
		);
		expect(within(region("cards")).getByTestId("agent-thread")).toBeTruthy();
		expect(within(region("composers")).getByTestId("new-thread")).toBeTruthy();
	});
});
