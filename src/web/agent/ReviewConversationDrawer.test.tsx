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
import { Profiler, useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inRouter } from "../../../test/in-router";
import { heldJson } from "../../../test/loading";
import type { AgentStatus, AgentThread } from "../../shared/agent";
import type { PrOverview, SessionInfo } from "../../shared/types";
import { overviewQuery, sessionQuery } from "../api";
import { ShortcutsProvider } from "../shortcuts";
import { openSetupOverDrawer, resetAgentChipPress } from "./AgentChip";
import { resetAgentWrites } from "./agentWrites";
import { agentStatusQuery, agentThreadsQuery } from "./api";
import {
	closeReviewDrawer,
	isReviewDrawerOpen,
	openReviewDrawer,
	useReviewDrawerOpen,
} from "./drawerStore";
import { ReviewConversationDrawer } from "./ReviewConversationDrawer";
import { AgentSetupHost } from "./setup/AgentSetup";
import {
	closeAgentSetup,
	resetSetupReturnFocus,
	useAgentSetupOpen,
} from "./setupStore";
import {
	resetAgentDrafts,
	SEEN_AFTER_MS,
	type SendView,
	SendViewHost,
	usePublishSendView,
	useSendView,
} from "./threadAgent";
import { stubIntersection } from "./threadAgentFixtures";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

const status: AgentStatus = {
	state: "ready",
	configured: true,
	agent: { name: "Fake Agent", version: "1" },
	since: "2026-11-15T10:00:00Z",
	waiting: 0,
	connected: true,
};

const review = (more: Partial<AgentThread> = {}): AgentThread => ({
	id: "01jrv000000000000000000000",
	anchor: { subject: "review" },
	openedBy: "human",
	at: "2026-11-15T10:00:00Z",
	messages: [
		{ id: "m1", by: "human", at: "2026-11-15T10:00:00Z", text: "All fine?" },
		{ id: "m2", by: "ai", at: "2026-11-15T10:01:00Z", text: "Mostly." },
		{ id: "m3", by: "human", at: "2026-11-15T10:02:00Z", text: "And now?" },
		{ id: "m4", by: "ai", at: "2026-11-15T10:03:00Z", text: "Now too." },
	],
	resolved: false,
	waiting: false,
	unread: false,
	...more,
});

let posts: { path: string; body: Record<string, unknown> }[];
/** A POST's answer; never answered unless a test says. */
let answer: (path: string, body: Record<string, unknown>) => Promise<Response>;
/** The agent threads read's answer, per call. */
let threadsRead: () => Promise<Response>;

beforeEach(() => {
	posts = [];
	answer = () => new Promise(() => {});
	threadsRead = () => new Promise(() => {});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input, "http://crb");
			const method = init?.method ?? "GET";
			if (method === "GET") {
				if (url.pathname.endsWith("/agent/threads")) return threadsRead();
				return new Promise<Response>(() => {});
			}
			const body = JSON.parse(String(init?.body ?? "null"));
			posts.push({ path: url.pathname, body });
			return answer(url.pathname, body);
		}),
	);
	Element.prototype.scrollIntoView = vi.fn();
	stubIntersection(null);
});

afterEach(() => {
	cleanup();
	closeReviewDrawer();
	closeAgentSetup();
	resetAgentWrites();
	resetAgentDrafts();
	resetAgentChipPress();
	resetSetupReturnFocus();
	vi.unstubAllGlobals();
});

function States() {
	return (
		<>
			<p data-testid="drawer">{useReviewDrawerOpen() ? "open" : "closed"}</p>
			<p data-testid="setup">{useAgentSetupOpen() ? "open" : "closed"}</p>
		</>
	);
}

/** Files changed's comparison, published as the page does (kept while elsewhere). */
function FilesComparison(props: { view: SendView }) {
	const view = useMemo(() => props.view, [props.view]);
	usePublishSendView(view);
	return null;
}

function show(
	opts: {
		/** The agent threads as read; undefined: the read is asked (fetch). */
		threads?: AgentThread[];
		filesView?: SendView;
		/** The agent status as read; null: not read yet. */
		status?: AgentStatus | null;
		/** The session's patch sets; null: the session not read yet. */
		session?: Partial<SessionInfo> | null;
		/** The page's agent setup modal too (AgentSetupHost, in a router). */
		setup?: boolean;
	} = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(overviewQuery.queryKey, {
		readId: "r1",
		writes: "on",
		pendingReview: null,
	} as PrOverview);
	if (opts.session !== null) {
		client.setQueryData(sessionQuery.queryKey, {
			viewer: "octo",
			snapshotHead: "h2",
			patchsets: [
				{ number: 1, head: "h1" },
				{ number: 2, head: "h2" },
			],
			...opts.session,
		} as unknown as SessionInfo);
	}
	if (opts.status !== null) {
		client.setQueryData(agentStatusQuery.queryKey, opts.status ?? status);
	}
	if (opts.threads) {
		client.setQueryData(agentThreadsQuery.queryKey, { threads: opts.threads });
	}
	const ui = (review: string) => (
		<QueryClientProvider client={client}>
			<ShortcutsProvider>
				<SendViewHost>
					{opts.filesView && <FilesComparison view={opts.filesView} />}
					<button type="button" data-testid="agent-chip">
						chip
					</button>
					<ReviewConversationDrawer key={review} />
					<States />
					{opts.setup && inRouter(() => <AgentSetupHost />)}
				</SendViewHost>
			</ShortcutsProvider>
		</QueryClientProvider>
	);
	const r = render(ui("RV1"));
	return {
		client,
		user: userEvent.setup(),
		/** The same App on another review (App keys the drawer by it). */
		review: (id: string) => r.rerender(ui(id)),
		unmount: r.unmount,
	};
}

const drawer = () =>
	screen.getByRole("complementary", { name: "Whole review conversation" });
const composer = () => screen.queryByRole("textbox", { name: "Ask agent" });

describe("ReviewConversationDrawer", () => {
	it("closed: nothing drawn", () => {
		show({ threads: [] });
		expect(screen.queryByTestId("review-conversation")).toBeNull();
	});

	it("while the threads are read: a spinner, never the empty composer", async () => {
		const held = heldJson();
		threadsRead = () => held.response;
		openReviewDrawer();
		show();
		const d = drawer();
		expect(d).toHaveAttribute("id", "review-conversation");
		const busy = within(d).getByTestId("review-conversation-loading");
		expect(busy).toHaveAttribute("aria-busy", "true");
		expect(composer()).toBeNull();
		expect(within(d).queryByRole("alert")).toBeNull();
		await act(async () => held.release({ threads: [review()] }));
		await waitFor(() => expect(composer()).toBeInTheDocument());
		expect(within(d).queryByTestId("review-conversation-loading")).toBeNull();
		expect(within(d).getAllByTestId("agent-message-ai")).toHaveLength(2);
	});

	it("a failed threads read: an error with Retry, neither the spinner nor the empty composer", async () => {
		threadsRead = async () => json({ error: "boom" }, 500);
		openReviewDrawer();
		show();
		const alert = await within(drawer()).findByRole("alert");
		expect(alert).toHaveTextContent(/couldn't read/i);
		expect(
			within(drawer()).queryByTestId("review-conversation-loading"),
		).toBeNull();
		expect(composer()).toBeNull();
		// Retry reads them again.
		threadsRead = async () => json({ threads: [] });
		await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(composer()).toBeInTheDocument());
		expect(within(drawer()).queryByRole("alert")).toBeNull();
	});

	it("an empty conversation: just the composer, focused", () => {
		openReviewDrawer();
		show({ threads: [] });
		expect(composer()).toHaveFocus();
		expect(composer()).toHaveAttribute("placeholder", "Ask agent…");
		expect(within(drawer()).queryByTestId("agent-message-human")).toBeNull();
		expect(
			within(drawer()).queryByTestId("review-conversation-count"),
		).toBeNull();
	});

	it("a ```comment block in an answer is a read-only quote with Copy: nowhere to post from the whole review (CAR-83)", () => {
		openReviewDrawer();
		const t = review();
		show({
			threads: [
				{
					...t,
					messages: [
						...t.messages.slice(0, 3),
						{
							id: "m4",
							by: "ai",
							at: "2026-11-15T10:03:00Z",
							text: "Ask:\n\n```comment\nWhy one retry?\n```",
						},
					],
				},
			],
		});
		const block = within(drawer()).getByTestId("agent-comment");
		expect(block).toHaveTextContent("Why one retry?");
		expect(
			within(block).getByRole("button", { name: "Copy comment" }),
		).toBeInTheDocument();
		expect(within(block).queryByRole("textbox")).toBeNull();
		expect(
			within(drawer()).queryByRole("button", { name: "Add review comment" }),
		).toBeNull();
	});

	it("with unread answers: the new rule above the first, scrolled to it", () => {
		openReviewDrawer();
		show({ threads: [review({ unread: true, seenUpTo: "m2" })] });
		const rule = within(drawer()).getByTestId("agent-new-divider");
		// The rule sits right above the first unseen answer.
		expect(rule.nextElementSibling).toHaveAttribute("data-message-id", "m4");
		expect(rule.scrollIntoView).toHaveBeenCalled();
		expect(
			within(drawer()).getByTestId("review-conversation-count"),
		).toHaveTextContent("4");
	});

	it("the status button opens the agent modal", async () => {
		openReviewDrawer();
		const { user } = show({ threads: [review()] });
		const button = within(drawer()).getByRole("button", {
			name: "Agent status",
		});
		await user.click(button);
		expect(screen.getByTestId("setup")).toHaveTextContent("open");
	});

	it("on a phone: full screen, and the status button opens the agent modal over it, which stays open", async () => {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: false,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		openReviewDrawer();
		const { user } = show({ threads: [review()] });
		const d = screen.getByRole("dialog", { name: "Whole review conversation" });
		expect(d).toHaveAttribute("data-mode", "phone");
		expect(d).toHaveAttribute("aria-modal", "true");
		// Focus stays inside: Tab from the last control comes back to the first.
		const send = within(d).getByRole("button", { name: "Send to agent" });
		within(d).getByRole("textbox", { name: "Ask agent" }).focus();
		await user.type(within(d).getByRole("textbox", { name: "Ask agent" }), "x");
		send.focus();
		await user.tab();
		expect(d.contains(document.activeElement)).toBe(true);
		within(d).getByRole("button", { name: "Agent status" }).focus();
		await user.tab({ shift: true });
		expect(d.contains(document.activeElement)).toBe(true);
		await user.click(within(d).getByRole("button", { name: "Agent status" }));
		expect(screen.getByTestId("setup")).toHaveTextContent("open");
		expect(screen.getByTestId("drawer")).toHaveTextContent("open");
		act(() => closeAgentSetup());
		expect(
			screen.getByRole("dialog", { name: "Whole review conversation" }),
		).toBeVisible();
	});

	it("overlaid, it follows the header on scroll without re-rendering (its top set on the element)", async () => {
		// A desktop narrower than the push breakpoint: overlaid.
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query.includes("640px"),
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
			f(0);
			return 1;
		});
		const header = document.createElement("header");
		header.setAttribute("data-app-header", "");
		let bottom = 135;
		header.getBoundingClientRect = () => new DOMRect(0, 0, 800, bottom);
		document.body.append(header);
		try {
			openReviewDrawer();
			const client = new QueryClient();
			client.setQueryData(overviewQuery.queryKey, {
				writes: "on",
			} as PrOverview);
			client.setQueryData(sessionQuery.queryKey, {
				viewer: "octo",
				patchsets: [],
			} as unknown as SessionInfo);
			client.setQueryData(agentStatusQuery.queryKey, status);
			client.setQueryData(agentThreadsQuery.queryKey, {
				threads: [review()],
			});
			let commits = 0;
			render(
				<QueryClientProvider client={client}>
					<Profiler id="drawer" onRender={() => commits++}>
						<ReviewConversationDrawer />
					</Profiler>
				</QueryClientProvider>,
			);
			const d = screen.getByTestId("review-conversation");
			expect(d).toHaveAttribute("data-mode", "overlay");
			expect(d.style.top).toBe("135px");
			const before = commits;
			bottom = 45;
			await act(async () => window.dispatchEvent(new Event("scroll")));
			expect(d.style.top).toBe("45px");
			expect(commits).toBe(before);
		} finally {
			header.remove();
		}
	});

	it("Escape and the close button close it; focus goes back to the chip", async () => {
		openReviewDrawer();
		const { user } = show({ threads: [] });
		expect(composer()).toHaveFocus();
		await user.keyboard("{Escape}");
		expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
		expect(screen.getByTestId("agent-chip")).toHaveFocus();
		act(() => openReviewDrawer());
		await user.click(within(drawer()).getByRole("button", { name: "Close" }));
		expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
		expect(screen.getByTestId("agent-chip")).toHaveFocus();
	});

	it("never outlives its review: leaving it (unmount) or another review closes it", () => {
		openReviewDrawer();
		const first = show({ threads: [] });
		first.review("RV2");
		expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
		expect(screen.queryByTestId("review-conversation")).toBeNull();
		act(() => openReviewDrawer());
		first.unmount();
		expect(isReviewDrawerOpen()).toBe(false);
	});

	it("Shift+A closes it from inside, focus back on the chip", async () => {
		openReviewDrawer();
		const { user } = show({ threads: [review()] });
		expect(drawer()).toHaveFocus();
		await user.keyboard("{Shift>}A{/Shift}");
		expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
		expect(screen.getByTestId("agent-chip")).toHaveFocus();
	});

	it("nothing set up, a review conversation already there: Shift+A opens the drawer and the setup over it", async () => {
		const { user } = show({
			threads: [review({ unread: true })],
			status: {
				...status,
				state: "off",
				configured: false,
				agent: undefined,
				connected: false,
			},
		});
		await user.keyboard("{Shift>}A{/Shift}");
		expect(screen.getByTestId("setup")).toHaveTextContent("open");
		expect(screen.getByTestId("drawer")).toHaveTextContent("open");
		act(() => closeAgentSetup());
		expect(screen.getByTestId("drawer")).toHaveTextContent("open");
	});

	it.each<[string, Partial<AgentStatus>]>([
		["configured, none spawned or joined", { state: "off", connected: false }],
		[
			"configured, crashed",
			{ state: "error", spawned: true, connected: false },
		],
		[
			"configured, an error, none live",
			{ error: "the agent exited", connected: false },
		],
	])(
		"no agent connected (%s): Shift+A opens the drawer and the setup over it",
		async (_n, more) => {
			const { user } = show({
				threads: [review({ unread: true })],
				status: { ...status, ...more },
			});
			await user.keyboard("{Shift>}A{/Shift}");
			expect(screen.getByTestId("setup")).toHaveTextContent("open");
			expect(screen.getByTestId("drawer")).toHaveTextContent("open");
		},
	);

	it.each<[string, Partial<AgentStatus>]>([
		["starting", { state: "starting", spawned: true, connected: false }],
		["reconnecting", { state: "reconnecting", connected: false }],
		[
			"a failed turn, still connected",
			{ state: "error", error: "Rate limited; retry later" },
		],
		[
			"a joined session",
			{
				configured: false,
				via: "mcp",
				joined: {
					name: "carbonless · main",
					machine: "devbox",
					since: "2026-11-10T10:00:00Z",
				},
			},
		],
	])("an agent connected (%s): Shift+A opens the drawer", async (_n, more) => {
		const { user } = show({
			threads: [review()],
			status: { ...status, ...more },
		});
		await user.keyboard("{Shift>}A{/Shift}");
		expect(screen.getByTestId("drawer")).toHaveTextContent("open");
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
	});

	it("open while the agent has gone (nothing set up now): Shift+A closes it, no setup", async () => {
		openReviewDrawer();
		const { user } = show({
			threads: [review()],
			status: {
				...status,
				state: "off",
				configured: false,
				agent: undefined,
				connected: false,
			},
		});
		expect(drawer()).toHaveFocus();
		await user.keyboard("{Shift>}A{/Shift}");
		expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
		expect(screen.getByTestId("agent-chip")).toHaveFocus();
	});

	it("Shift+A before the first status read opens nothing (the chip acts once it lands)", async () => {
		const { user } = show({ threads: [review()], status: null });
		await user.keyboard("{Shift>}A{/Shift}");
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
		expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
	});

	it("Retry on a failed read shows it is reading again: the spinner in the alert's place", async () => {
		threadsRead = async () => json({ error: "boom" }, 500);
		openReviewDrawer();
		const { user } = show();
		const alert = await within(drawer()).findByRole("alert");
		const held = heldJson();
		threadsRead = () => held.response;
		await user.click(within(alert).getByRole("button", { name: "Retry" }));
		expect(
			within(drawer()).getByTestId("review-conversation-loading"),
		).toHaveAttribute("aria-busy", "true");
		expect(within(drawer()).queryByRole("alert")).toBeNull();
		await act(async () => held.release({ threads: [] }));
		await waitFor(() => expect(composer()).toBeInTheDocument());
	});

	it("a question asked from the Overview carries Files changed's comparison", async () => {
		openReviewDrawer();
		const filesView: SendView = {
			target: { patchset: 1 },
			from: { branch: true },
		};
		const { user } = show({ threads: [], filesView });
		await user.type(composer() as HTMLElement, "Anything off?");
		await user.keyboard("{Control>}{Enter}{/Control}");
		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toMatch(/\/agent\/threads$/);
		expect(posts[0]?.body).toMatchObject({
			review: true,
			text: "Anything off?",
			view: filesView,
		});
	});

	it("Files changed's published comparison is the drawer's only: a card elsewhere still sends the latest patch set", () => {
		function CardView() {
			return <p data-testid="card-view">{JSON.stringify(useSendView())}</p>;
		}
		const client = new QueryClient();
		client.setQueryData(sessionQuery.queryKey, {
			viewer: "octo",
			snapshotHead: "h2",
			patchsets: [
				{ number: 1, head: "h1" },
				{ number: 2, head: "h2" },
			],
		} as unknown as SessionInfo);
		render(
			<QueryClientProvider client={client}>
				<SendViewHost>
					<FilesComparison
						view={{ target: { patchset: 1 }, from: { branch: true } }}
					/>
					<CardView />
				</SendViewHost>
			</QueryClientProvider>,
		);
		expect(
			JSON.parse(screen.getByTestId("card-view").textContent ?? ""),
		).toEqual({ target: { patchset: 2 }, from: { branch: true } });
	});

	it("a follow-up goes to the conversation as a message", async () => {
		openReviewDrawer();
		const { user } = show({ threads: [review()] });
		await user.type(composer() as HTMLElement, "More?");
		await user.click(screen.getByRole("button", { name: "Send to agent" }));
		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toMatch(
			/\/agent\/threads\/01jrv000000000000000000000\/messages$/,
		);
		expect(composer()).toHaveValue("");
	});

	it("a refused send: its text once, with Retry; Retry sends it once, and it lands once", async () => {
		openReviewDrawer();
		answer = async () => json({ error: "Too many questions" }, 422);
		const { user } = show({ threads: [] });
		await user.type(composer() as HTMLElement, "Were they resolved?");
		await user.keyboard("{Control>}{Enter}{/Control}");
		const alert = await within(drawer()).findByRole("alert");
		expect(alert).toHaveTextContent("Too many questions");
		// Shown once: in the refused message, not back in the box.
		expect(within(drawer()).getAllByText("Were they resolved?")).toHaveLength(
			1,
		);
		expect(composer()).toHaveValue("");
		const clientId = posts[0]?.body.clientId;
		const landed = review({
			messages: [
				{
					id: "m1",
					by: "human",
					at: "2026-11-15T10:00:00Z",
					text: "Were they resolved?",
				},
			],
			waiting: true,
		});
		answer = async () => json(landed);
		await user.click(within(alert).getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(within(drawer()).queryByRole("alert")).toBeNull(),
		);
		expect(posts).toHaveLength(2);
		expect(posts[1]?.body.clientId).toBe(clientId);
		await waitFor(() =>
			expect(within(drawer()).queryByTestId("agent-reply-pending")).toBeNull(),
		);
		expect(within(drawer()).getAllByText("Were they resolved?")).toHaveLength(
			1,
		);
		expect(within(drawer()).getAllByTestId("agent-message-human")).toHaveLength(
			1,
		);
	});
});

describe("the agent setup over the drawer (CAR-210)", () => {
	const none: AgentStatus = {
		...status,
		state: "off",
		agent: undefined,
		connected: false,
	};
	const setupDialog = () => screen.getByTestId("agent-setup");

	it.each<[string, AgentThread[]]>([
		["an empty conversation", []],
		["a conversation there", [review()]],
	])(
		"no agent connected, %s: Shift+A opens both, focus in the setup; Escape closes the setup alone, focus into the drawer's composer; a second Escape closes the drawer",
		async (_n, threads) => {
			const { user } = show({ threads, status: none, setup: true });
			await user.keyboard("{Shift>}A{/Shift}");
			expect(screen.getByTestId("drawer")).toHaveTextContent("open");
			expect(screen.getByTestId("setup")).toHaveTextContent("open");
			expect(drawer()).toBeVisible();
			await waitFor(() =>
				expect(setupDialog().contains(document.activeElement)).toBe(true),
			);
			await user.keyboard("{Escape}");
			expect(screen.getByTestId("setup")).toHaveTextContent("closed");
			expect(screen.getByTestId("drawer")).toHaveTextContent("open");
			expect(composer()).toHaveFocus();
			await user.keyboard("{Escape}");
			expect(screen.getByTestId("drawer")).toHaveTextContent("closed");
			expect(screen.getByTestId("agent-chip")).toHaveFocus();
		},
	);

	it("closed, the setup leaves focus in the composer through a send (no jump to the panel)", async () => {
		const { user } = show({ threads: [], status: none, setup: true });
		await user.keyboard("{Shift>}A{/Shift}");
		await user.keyboard("{Escape}");
		expect(composer()).toHaveFocus();
		await user.type(composer() as HTMLElement, "Ready?");
		await user.keyboard("{Control>}{Enter}{/Control}");
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]?.path).toMatch(/\/agent\/threads$/);
		expect(composer()).toHaveValue("");
		expect(composer()).toHaveFocus();
	});

	it("an unread answer under the setup is not marked seen; once the setup closes, it is", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		stubIntersection(true);
		try {
			openReviewDrawer();
			openSetupOverDrawer();
			show({
				threads: [review({ unread: true, seenUpTo: "m2" })],
				status: none,
				setup: true,
			});
			await act(async () => {
				vi.advanceTimersByTime(SEEN_AFTER_MS * 3);
			});
			const seen = () => posts.filter((p) => p.path.endsWith("/seen"));
			expect(seen()).toHaveLength(0);
			act(() => closeAgentSetup());
			await act(async () => {
				vi.advanceTimersByTime(SEEN_AFTER_MS);
			});
			expect(seen()).toHaveLength(1);
			expect(seen()[0]?.body).toEqual({ upTo: "m4" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("the setup's Close leaves the drawer open, focus in its composer", async () => {
		const { user } = show({ threads: [], status: none, setup: true });
		await user.keyboard("{Shift>}A{/Shift}");
		await user.click(
			within(setupDialog()).getAllByRole("button", {
				name: "Close",
			})[0] as HTMLElement,
		);
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
		expect(screen.getByTestId("drawer")).toHaveTextContent("open");
		expect(composer()).toHaveFocus();
	});

	it("an agent connected: Shift+A opens the drawer alone", async () => {
		const { user } = show({ threads: [], setup: true });
		await user.keyboard("{Shift>}A{/Shift}");
		expect(screen.getByTestId("drawer")).toHaveTextContent("open");
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
		expect(composer()).toHaveFocus();
	});

	it("the status button: the setup over the drawer, closed back onto the button", async () => {
		openReviewDrawer();
		const { user } = show({ threads: [review()], setup: true });
		const button = within(drawer()).getByRole("button", {
			name: "Agent status",
		});
		await user.click(button);
		expect(screen.getByTestId("setup")).toHaveTextContent("open");
		await user.keyboard("{Escape}");
		expect(screen.getByTestId("setup")).toHaveTextContent("closed");
		expect(screen.getByTestId("drawer")).toHaveTextContent("open");
		expect(button).toHaveFocus();
	});
});

describe("the review conversation's one-tap questions (CAR-203)", () => {
	const chips = () =>
		within(drawer())
			.queryAllByTestId("agent-quick-question")
			.map((b) => b.textContent);
	const firstReview = {
		snapshotHead: "h1",
		head: null,
		patchsets: [{ number: 1, head: "h1" }],
	} as unknown as SessionInfo;
	const reReview = {
		snapshotHead: "h2",
		head: null,
		patchsets: [
			{ number: 1, head: "h1" },
			{ number: 2, head: "h2" },
		],
	} as unknown as SessionInfo;

	it("looking at PS1: the new PR questions", () => {
		openReviewDrawer();
		show({ threads: [], session: firstReview });
		expect(chips()).toEqual([
			"Please summarize the changes",
			"Please highlight all decisions made in code that I might object to",
			"Please highlight all code that can't be tested directly",
		]);
	});

	it("before any patch set: the new PR questions", () => {
		openReviewDrawer();
		show({
			threads: [],
			session: { snapshotHead: "h1", head: null, patchsets: [] },
		});
		expect(chips()).toContain("Please summarize the changes");
	});

	it("looking at PS2: the re-review questions, also after the first message", () => {
		openReviewDrawer();
		show({ threads: [review()], session: reReview });
		expect(chips()).toEqual([
			"Please summarize what changed",
			"Please confirm all comments I wrote have been addressed and highlight those that haven't",
			"Please highlight any change that isn't related to a comment I've made",
		]);
	});

	it("Files changed looking at PS1 of two: the new PR questions; at the head after PS1: the re-review's", () => {
		openReviewDrawer();
		show({
			threads: [],
			session: reReview,
			filesView: { target: { patchset: 1 }, from: { branch: true } },
		});
		expect(chips()).toContain("Please summarize the changes");
		cleanup();
		openReviewDrawer();
		show({
			threads: [],
			session: firstReview,
			filesView: { target: { head: "h2" }, from: { patchset: 1 } },
		});
		expect(chips()).toContain("Please summarize what changed");
	});

	it("while the patch set looked at is unknown (no session yet): a spinner in their place, neither list", async () => {
		openReviewDrawer();
		const { client } = show({ threads: [], session: null });
		const busy = within(drawer()).getByTestId("agent-quick-questions-loading");
		expect(busy).toHaveAttribute("aria-busy", "true");
		expect(
			within(busy).getByRole("status", { name: "Loading suggested questions" }),
		).toBeInTheDocument();
		expect(chips()).toEqual([]);
		act(() => client.setQueryData(sessionQuery.queryKey, firstReview));
		await waitFor(() =>
			expect(chips()).toContain("Please summarize the changes"),
		);
		expect(
			within(drawer()).queryByTestId("agent-quick-questions-loading"),
		).toBeNull();
	});

	it("a tap fills an empty box, appends to a typed one, focuses it with the caret at the end, and sends nothing", async () => {
		openReviewDrawer();
		const { user } = show({ threads: [], session: firstReview });
		const box = composer() as HTMLTextAreaElement;
		await user.click(
			within(drawer()).getByRole("button", {
				name: "Please summarize the changes",
			}),
		);
		expect(box).toHaveValue("Please summarize the changes");
		expect(box).toHaveFocus();
		expect(box.selectionStart).toBe(box.value.length);
		await user.clear(box);
		await user.type(box, "Hi.  ");
		await user.click(
			within(drawer()).getByRole("button", {
				name: "Please highlight all code that can't be tested directly",
			}),
		);
		expect(box).toHaveValue(
			"Hi.\nPlease highlight all code that can't be tested directly",
		);
		expect(box).toHaveFocus();
		expect(box.selectionEnd).toBe(box.value.length);
		expect(posts).toEqual([]);
	});

	it("no agent connected: the questions still show and fill the box", async () => {
		openReviewDrawer();
		const { user } = show({
			threads: [],
			session: firstReview,
			status: { ...status, state: "off", connected: false } as AgentStatus,
		});
		await user.click(
			within(drawer()).getByRole("button", {
				name: "Please summarize the changes",
			}),
		);
		expect(composer()).toHaveValue("Please summarize the changes");
		expect(posts).toEqual([]);
	});
});
