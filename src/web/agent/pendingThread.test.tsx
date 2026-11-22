// @vitest-environment jsdom
import {
	notifyManager,
	QueryClient,
	QueryClientProvider,
	QueryObserver,
	useQuery,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
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
import { threadFocus } from "../files/threadFocus";
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
import {
	cardReplyText,
	resetAgentWrites,
	resetRepliesTyped,
	useUnaskedQuestion,
} from "./agentWrites";
import { agentThreadsQuery } from "./api";
import { spanOfAnchor } from "./askAgentAction";
import { type CommentScope, CommentScopeProvider } from "./commentOnGithub";
import { resetLinkProblems } from "./linkProblems";
import {
	LANDING_MS,
	landingFor,
	type PendingComposers,
	PendingComposersProvider,
	prepareLanding,
	resetHeldComposers,
	resetLanding,
	shownOutsideCard,
	useHeldByCard,
	useLandWhere,
} from "./pendingThread";
import { AgentHandle } from "./ThreadAgentButton";
import {
	setAgentDraft,
	ThreadAgentContext,
	useThreadAgent,
} from "./threadAgent";
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
	resetRepliesTyped();
	threadFocus.reset();
	resetLanding();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
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
	const dirty = useUnaskedQuestion();
	return (
		<>
			<span data-testid="dirty">{String(dirty)}</span>
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

const rect = (top: number) =>
	({
		top,
		bottom: top + 10,
		left: 0,
		right: 0,
		width: 0,
		height: 10,
		x: 0,
		y: top,
		toJSON: () => ({}),
	}) as DOMRect;
/** `el` drawn with its top at `top` in the viewport. */
const placeAt = (el: Element, top: number) => {
	el.getBoundingClientRect = () => rect(top);
};
/** A pending thread of conversation ID drawn at `top` (no section: its tops are the viewport's). */
function pendingBoxAt(top: number): HTMLElement {
	const box = document.createElement("article");
	box.dataset.testid = "new-thread";
	box.dataset.agentThread = ID;
	placeAt(box, top);
	document.body.append(box);
	return box;
}

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

describe("fix round 1", () => {
	const typeComment = async (text: string) => {
		await userEvent.type(
			screen.getByRole("textbox", { name: "Comment" }),
			text,
		);
	};

	it("a follow-up typed in the card's reply box survives Comment and Cancel, and keeps the page dirty meanwhile", async () => {
		show();
		await userEvent.type(
			screen.getByRole("textbox", { name: "Reply to your agent" }),
			"and v3?",
		);
		expect(region("dirty").textContent).toBe("true");
		await pressComment();
		expect(
			screen.queryByRole("textbox", { name: "Reply to your agent" }),
		).toBeNull();
		expect(region("dirty").textContent).toBe("true");
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(
			screen.getByRole("textbox", { name: "Reply to your agent" }),
		).toHaveProperty("value", "and v3?");
		expect(region("dirty").textContent).toBe("true");
	});

	it("posted, that follow-up is in the thread's agent box (its draft), no longer the card's", async () => {
		show();
		await userEvent.type(
			screen.getByRole("textbox", { name: "Reply to your agent" }),
			"and v3?",
		);
		await pressComment();
		await typeComment("Add v3?");
		await userEvent.click(screen.getByTestId("new-thread-post"));
		await vi.waitFor(() =>
			expect(screen.queryByTestId("new-thread")).toBeNull(),
		);
		expect(cardReplyText(ID)).toBe("");
		const { agentDraftText } = await import("./threadAgent");
		expect(agentDraftText("T9")).toBe("and v3?");
	});

	it("posting hands over in one notify: when the draft goes, the thread list's observers already have the thread", async () => {
		show();
		await pressComment();
		await typeComment("Add v3?");
		const writer = threadWritesFor(client);
		const seen: string[][] = [];
		const observer = new QueryObserver<{ threads: ReviewThread[] }>(client, {
			queryKey: THREADS_KEY,
			enabled: false,
		});
		let lastSeen: string[] = [];
		// As React's useQuery hears it: through the notify batch.
		const unsubscribe = observer.subscribe(
			notifyManager.batchCalls((r) => {
				lastSeen = (r.data?.threads ?? []).map((t) => t.id);
			}),
		);
		let hadDraft = true;
		const stop = writer.drafts.subscribe(() => {
			const has = writer.drafts.get().some((d) => d.create !== undefined);
			if (hadDraft && !has) seen.push(lastSeen);
			hadDraft = has;
		});
		await userEvent.click(screen.getByTestId("new-thread-post"));
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toEqual(["T9"]);
		stop();
		unsubscribe();
	});

	it("the posted thread shows where the pending one was: the page scrolls by what moved above it, once", () => {
		const scrollBy = vi.fn();
		vi.stubGlobal("scrollBy", scrollBy);
		function Landed(props: { top: number }) {
			const ref = useRef<HTMLElement>(null);
			useLandWhere(ID, ref);
			return (
				<section
					ref={(el) => {
						if (el) placeAt(el, 0);
					}}
				>
					<article
						ref={(el) => {
							ref.current = el;
							if (el) placeAt(el, props.top);
						}}
					/>
				</section>
			);
		}
		const pending = pendingBoxAt(300);
		prepareLanding(ID);
		expect(document.documentElement.dataset.landing).toBe("");
		pending.remove();
		// Drawn 180px higher (above a thread the pending one was below).
		render(<Landed top={120} />);
		expect(scrollBy).toHaveBeenCalledWith(0, -180);
		expect(document.documentElement.dataset.landing).toBeUndefined();
		// Once: a later mount of the thread doesn't scroll.
		cleanup();
		render(<Landed top={50} />);
		expect(scrollBy).toHaveBeenCalledTimes(1);
	});

	it("scrolled on past it at the handover: what the reader is looking at stays still, not the thread's spot", () => {
		const scrollBy = vi.fn();
		vi.stubGlobal("scrollBy", scrollBy);
		const reading = document.createElement("p");
		placeAt(reading, 400);
		document.body.append(reading);
		const fromPoint = vi.fn(() => reading);
		Object.defineProperty(document, "elementFromPoint", {
			value: fromPoint,
			configurable: true,
		});
		try {
			const pending = pendingBoxAt(-400);
			prepareLanding(ID);
			expect(landingFor(ID)).toMatchObject({ kind: "view", top: 400 });
			pending.remove();
			// The swap above grew the page by 90px: the paragraph moved down.
			placeAt(reading, 490);
			function Landed() {
				const ref = useRef<HTMLElement>(null);
				useLandWhere(ID, ref);
				return <article ref={ref} />;
			}
			render(<Landed />);
			expect(scrollBy).toHaveBeenCalledWith(0, 90);
		} finally {
			Reflect.deleteProperty(document, "elementFromPoint");
		}
	});

	it("below the viewport at the handover: nothing above the reader changes, nothing noted", () => {
		pendingBoxAt(window.innerHeight + 50);
		prepareLanding(ID);
		expect(landingFor(ID)).toBeUndefined();
		expect(document.documentElement.dataset.landing).toBeUndefined();
	});

	it("measured right before the swap, not when posted: what moved meanwhile doesn't count", async () => {
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
						} else if (!String(url).endsWith("/agent/threads")) {
							resolve(new Response("{}", { status: 200 }));
						}
					}),
			),
		);
		show();
		await pressComment();
		const article = screen.getByTestId("new-thread");
		placeAt(article, 100);
		await typeComment("Add v3?");
		await userEvent.click(screen.getByTestId("new-thread-post"));
		// Nothing noted at post.
		expect(landingFor(ID)).toBeUndefined();
		// Something above grew while it was sent.
		placeAt(article, 160);
		await act(async () => release(answer));
		await vi.waitFor(() =>
			expect(screen.queryByTestId("new-thread")).toBeNull(),
		);
		expect(landingFor(ID)).toEqual({ kind: "thread", top: 160 });
	});

	it("a post GitHub refuses notes nothing and leaves the anchoring alone", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) =>
				String(url).endsWith("/api/threads") && init?.method === "POST"
					? new Response(JSON.stringify({ error: "no" }), { status: 422 })
					: new Response("{}", { status: 200 }),
			),
		);
		show();
		await pressComment();
		placeAt(screen.getByTestId("new-thread"), 100);
		await typeComment("Add v3?");
		await userEvent.click(screen.getByTestId("new-thread-post"));
		await vi.waitFor(() =>
			expect(screen.getByTestId("new-thread-error")).toBeTruthy(),
		);
		expect(landingFor(ID)).toBeUndefined();
		expect(document.documentElement.dataset.landing).toBeUndefined();
	});

	it("an answer whose link failed notes nothing", async () => {
		answer = {
			...answer,
			agentThread: undefined,
			agentLinkProblem: { thread: ID, reason: "Taken" },
		};
		show();
		await pressComment();
		placeAt(screen.getByTestId("new-thread"), 100);
		await typeComment("Add v3?");
		await userEvent.click(screen.getByTestId("new-thread-post"));
		await vi.waitFor(() =>
			expect(screen.queryByTestId("new-thread")).toBeNull(),
		);
		expect(landingFor(ID)).toBeUndefined();
		expect(document.documentElement.dataset.landing).toBeUndefined();
	});

	it("a landing nothing takes expires: dropped, never applied late, the anchoring back", () => {
		vi.useFakeTimers();
		try {
			pendingBoxAt(300);
			prepareLanding(ID);
			expect(landingFor(ID)).toEqual({ kind: "thread", top: 300 });
			vi.advanceTimersByTime(LANDING_MS);
			expect(landingFor(ID)).toBeUndefined();
			expect(document.documentElement.dataset.landing).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("a kept follow-up stops counting as unsaved once Resolve hides its box (dropped), or once its conversation is gone", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				String(url).endsWith("/resolved")
					? new Response(JSON.stringify(conversation({ resolved: true })), {
							status: 200,
						})
					: new Response("{}", { status: 200 }),
			),
		);
		show();
		await userEvent.type(
			screen.getByRole("textbox", { name: "Reply to your agent" }),
			"and v3?",
		);
		expect(region("dirty").textContent).toBe("true");
		await userEvent.click(screen.getByTestId("agent-resolve"));
		expect(cardReplyText(ID)).toBe("");
		expect(region("dirty").textContent).toBe("false");
		cleanup();
		resetRepliesTyped();
		show();
		await userEvent.type(
			screen.getByRole("textbox", { name: "Reply to your agent" }),
			"and v3?",
		);
		act(() => client.setQueryData(agentThreadsQuery.queryKey, { threads: [] }));
		await vi.waitFor(() => expect(region("dirty").textContent).toBe("false"));
	});

	it("a follow-up moved onto the posted thread's agent box keeps the page unsaved until cleared there", async () => {
		show();
		await userEvent.type(
			screen.getByRole("textbox", { name: "Reply to your agent" }),
			"and v3?",
		);
		await pressComment();
		await typeComment("Add v3?");
		await userEvent.click(screen.getByTestId("new-thread-post"));
		await vi.waitFor(() =>
			expect(screen.queryByTestId("new-thread")).toBeNull(),
		);
		expect(region("dirty").textContent).toBe("true");
		act(() => setAgentDraft("T9", ""));
		expect(region("dirty").textContent).toBe("false");
	});

	it("a link to the conversation while it is pending finds the pending thread", async () => {
		show();
		await pressComment();
		act(() => {
			threadFocus.request({ id: ID });
		});
		await vi.waitFor(() => expect(threadFocus.get()).toBeNull());
	});

	it("the frame fades from the card's only right after Comment, not when drawn again later", async () => {
		show();
		await pressComment();
		expect(screen.getByTestId("new-thread").className).toContain(
			"frame-from-agent",
		);
		cleanup();
		// The same pending thread drawn again later (the bubble reopened).
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5000);
		show();
		expect(screen.getByTestId("new-thread").className).not.toContain(
			"frame-from-agent",
		);
	});
});

describe("composers a card holds", () => {
	it("one on another head than the card's shows where composers do, held or not: never nowhere", () => {
		const held = () => true;
		const on = (commit: string) => ({
			agentThread: ID,
			span: { ...spanOfAnchor(line), commit },
		});
		expect(shownOutsideCard(on(HEAD), HEAD, held)).toBe(false);
		expect(shownOutsideCard(on("o".repeat(40)), HEAD, held)).toBe(true);
		expect(shownOutsideCard(on(HEAD), HEAD, () => false)).toBe(true);
	});
});
