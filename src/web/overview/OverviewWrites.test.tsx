// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import {
	act,
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	PrOverview,
	ReviewThread,
	ReviewView,
	SessionInfo,
	ThreadComment,
	ThreadUpdate,
} from "../../shared/types";
import { createAppRouter } from "../router";
import { draftsFor } from "../threads/drafts";
import {
	DELETE_UNDO_MS,
	FADE_MS,
	threadWritesFor,
} from "../threads/threadWrites";

const info: SessionInfo = {
	pr: {
		owner: "acme",
		repo: "widget",
		number: 12,
		title: "Add widget cache",
		url: "https://github.com/acme/widget/pull/12",
	},
	viewer: "octo",
	snapshotHead: "b".repeat(40),
	currentHead: "b".repeat(40),
	headMoved: false,
	patchset: null,
	asOf: null,
	pinnedHead: null,
};

const overview: PrOverview = {
	title: "Add widget cache",
	number: 12,
	url: "https://github.com/acme/widget/pull/12",
	author: "bob",
	body: "",
	bodyHtml: "",
	isDraft: false,
	state: "OPEN",
	createdAt: "2026-01-01T09:00:00Z",
	updatedAt: "2026-01-05T09:00:00Z",
	baseBranch: "main",
	headBranch: "cache",
	mergeable: "MERGEABLE",
	requestedReviewers: [],
	reviews: [],
	commenters: [],
	humanStarted: false,
	youAuthor: false,
	checks: [],
	readId: "read1",
	fetchedAt: "2026-01-05T12:00:00Z",
	servedAt: "2026-01-05T12:00:01Z",
	writes: "on",
	commentLeft: true,
	pendingReview: null,
};

const thread = (
	id: string,
	more: Partial<ReviewThread> = {},
): ReviewThread => ({
	id,
	loaded: true,
	path: `src/${id}.ts`,
	line: 1,
	currentLine: 1,
	excerpt: id,
	html: `<p>${id}</p>`,
	body: id,
	createdAt: "2026-01-01T09:00:00Z",
	lastActivityAt: "2026-01-01T09:00:00Z",
	author: "rev",
	bot: false,
	avatarUrl: "",
	participants: [],
	commentCount: 1,
	hasReply: false,
	outdated: false,
	resolved: false,
	anchor: null,
	attention: [],
	yourTurn: false,
	viewerCan: { reply: true, resolve: true, unresolve: true },
	commit: "",
	subject: "line",
	code: null,
	...more,
});

const review: ReviewView = {
	revision: "r1",
	patchset: null,
	files: [],
	progress: {
		clusters: { total: 0, reviewed: 0, crossedOff: 0 },
		lines: { total: 0, reviewed: 0, crossedOff: 0 },
		files: { total: 0, reviewed: 0, crossedOff: 0, done: 0 },
	},
};

const update = (threadId: string, resolved: boolean): ThreadUpdate => ({
	threadId,
	resolved,
	commentCount: 1,
	lastActivityAt: "2026-01-01T09:00:00Z",
	attention: [],
	yourTurn: false,
	viewerCan: { reply: true, resolve: !resolved, unresolve: resolved },
	comments: { threadId, comments: [] },
});

let posts: { path: string; body: unknown; method?: string }[];
/** Over every thread's opener in the comments answer. */
let openerMore: Partial<ThreadComment> = {};
/** Comments after the opener, per thread. */
let moreComments: Record<string, ThreadComment[]> = {};
let fetched: string[];
/** Review-state writes made (none may come from a thread write). */
const statePosts = () =>
	fetched.filter((p) => p === "/api/review/states").length;

function renderOverview(
	o: Partial<PrOverview>,
	threads: ReviewThread[],
	writeStatus: (path: string) => { status: number; body: unknown } | null = (
		path,
	) => {
		const id = path.split("/")[3] ?? "";
		const resolved =
			(posts.at(-1)?.body as { resolved?: boolean } | undefined)?.resolved ??
			false;
		return { status: 200, body: update(id, resolved) };
	},
) {
	posts = [];
	fetched = [];
	const routes: Record<string, unknown> = {
		"/api/session": info,
		"/api/overview": { ...overview, ...o },
		"/api/review": review,
		"/api/timeline": { events: [], gaps: [] },
		"/api/threads": { threads, complete: true },
		"/api/comments": { threads: [] },
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input), "http://test").pathname;
			fetched.push(path);
			if (path.startsWith("/api/threads/")) {
				posts.push({
					path,
					body: JSON.parse(String(init?.body ?? "null")),
					...(init?.method === "POST" ? {} : { method: init?.method }),
				});
				const answer = writeStatus(path);
				if (!answer) return new Promise<Response>(() => {});
				return new Response(JSON.stringify(answer.body), {
					status: answer.status,
				});
			}
			if (path === "/api/comments") {
				// Each thread: its opener.
				const ids =
					new URL(String(input), "http://test").searchParams
						.get("ids")
						?.split(",") ?? [];
				return new Response(
					JSON.stringify({
						threads: ids.map((threadId) => ({
							threadId,
							comments: [
								{
									id: `${threadId}-1`,
									author: "rev",
									bot: false,
									publishedAt: "2026-01-01T09:00:00Z",
									pending: false,
									html: "",
									body: threadId,
									text: threadId,
									editedAt: null,
									viewerCan: { update: false, delete: false },
									deleted: false,
									...openerMore,
								},
								...(moreComments[threadId] ?? []),
							],
						})),
					}),
				);
			}
			if (!(path in routes)) return new Response("{}", { status: 404 });
			return new Response(JSON.stringify(routes[path]));
		}),
	);
	vi.stubGlobal("scrollTo", vi.fn());
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={createAppRouter({ initialPath: "/" })} />
		</QueryClientProvider>,
	);
	return client;
}

/** Opens a card's one "Show more": the whole thread, box and Resolve. */
async function openCard(
	user: ReturnType<typeof userEvent.setup>,
	card: HTMLElement,
) {
	const more = within(card).getByTestId("thread-more");
	if (more.getAttribute("aria-expanded") !== "true") await user.click(more);
}

beforeEach(() => {
	openerMore = {};
	moreComments = {};
	try {
		localStorage.clear();
	} catch {}
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("resolving from an Overview card", () => {
	it("fades in place with the toggle still there, then moves to the other list", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderOverview({}, [thread("a"), thread("b")]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const open = within(humans).getByRole("list", {
			name: "Unresolved threads",
		});
		const [card] = within(open).getAllByTestId("thread");
		if (!card) throw new Error("no card");
		// Closed, the card has no Resolve: it is inside Show more.
		expect(within(card).queryByRole("button", { name: "Resolve" })).toBeNull();
		await openCard(user, card);
		await user.click(within(card).getByRole("button", { name: "Resolve" }));
		// Flipped at once, in place, fading.
		expect(card).toHaveAttribute("data-fading", "true");
		expect(card).toHaveClass("thread-fading");
		expect(within(card).getByTestId("thread-head")).toHaveTextContent(
			/^Resolved thread/,
		);
		expect(
			within(card).getByRole("button", { name: "Unresolve" }),
		).toBeVisible();
		expect(within(open).getAllByTestId("thread")).toHaveLength(2);
		expect(posts).toEqual([
			{ path: "/api/threads/a/resolved", body: { resolved: true } },
		]);
		// Principle 2: a GitHub action on a thread, never a review mark.
		expect(statePosts()).toBe(0);
		await act(() => vi.advanceTimersByTimeAsync(FADE_MS));
		await waitFor(() =>
			expect(within(humans).getAllByTestId("thread")).toHaveLength(1),
		);
		expect(
			within(humans).getByRole("radio", { name: "1 resolved" }),
		).toBeInTheDocument();
	});

	it("undoing during the fade keeps the card where it is", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderOverview({}, [thread("a")]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const card = within(humans).getByTestId("thread");
		await openCard(user, card);
		await user.click(within(card).getByRole("button", { name: "Resolve" }));
		await act(() => vi.advanceTimersByTimeAsync(FADE_MS / 2));
		await user.click(within(card).getByRole("button", { name: "Unresolve" }));
		expect(card).not.toHaveAttribute("data-fading");
		await act(() => vi.advanceTimersByTimeAsync(FADE_MS * 2));
		expect(
			within(humans).getByRole("list", { name: "Unresolved threads" }),
		).toContainElement(card);
		expect(within(card).getByTestId("thread-head")).toHaveTextContent(
			/^Unresolved thread/,
		);
		// Both went to GitHub, in order.
		await waitFor(() =>
			expect(posts.map((p) => p.body)).toEqual([
				{ resolved: true },
				{ resolved: false },
			]),
		);
	});

	it("says Moving… while it fades (the still state with reduced motion)", async () => {
		const user = userEvent.setup();
		renderOverview({}, [thread("a")]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const card = within(humans).getByTestId("thread");
		await openCard(user, card);
		await user.click(within(card).getByRole("button", { name: "Resolve" }));
		const moving = within(card).getByTestId("thread-moving");
		expect(moving).toHaveTextContent("Moving…");
		expect(moving).toHaveAttribute("role", "status");
		expect(moving).toHaveClass("motion-reduce:inline");
	});

	it("switching lists ends the fade: the card is in its new list at once, both ways", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderOverview({}, [thread("a"), thread("b")]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const [card] = within(humans).getAllByTestId("thread");
		if (!card) throw new Error("no card");
		await openCard(user, card);
		await user.click(within(card).getByRole("button", { name: "Resolve" }));
		expect(card).toHaveAttribute("data-fading", "true");
		await user.click(
			within(humans).getByRole("radio", { name: /^\d+ resolved$/ }),
		);
		const done = within(humans).getByRole("list", { name: "Resolved threads" });
		const [moved] = within(done).getAllByTestId("thread");
		expect(moved).toHaveTextContent("src/a.ts");
		expect(moved).not.toHaveAttribute("data-fading");
		expect(moved).not.toHaveClass("thread-fading");
		// And back: unresolved there, it is in Unresolved at once.
		await openCard(user, moved as HTMLElement);
		await user.click(
			within(moved as HTMLElement).getByRole("button", { name: "Unresolve" }),
		);
		expect(moved).toHaveAttribute("data-fading", "true");
		await user.click(
			within(humans).getByRole("radio", { name: /^\d+ unresolved$/ }),
		);
		const open = within(humans).getByRole("list", {
			name: "Unresolved threads",
		});
		const cards = within(open).getAllByTestId("thread");
		expect(cards).toHaveLength(2);
		for (const c of cards) expect(c).not.toHaveAttribute("data-fading");
		// The writes themselves are untouched.
		await waitFor(() =>
			expect(posts.map((p) => p.body)).toEqual([
				{ resolved: true },
				{ resolved: false },
			]),
		);
	});

	it("leaving Drafts ends the fade too", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		const client = renderOverview({}, [thread("a"), thread("b")]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		act(() => draftsFor(client).setText("b", "Half a thought"));
		await user.click(await within(humans).findByTestId("drafts-filter"));
		const list = within(humans).getByRole("list", {
			name: "Threads with a draft",
		});
		const card = within(list).getByTestId("thread");
		await user.click(within(card).getByRole("button", { name: "Resolve" }));
		await user.click(
			within(humans).getByRole("radio", { name: /^\d+ resolved$/ }),
		);
		const done = within(humans).getByRole("list", { name: "Resolved threads" });
		const moved = within(done).getByTestId("thread");
		expect(moved).toHaveTextContent("src/b.ts");
		expect(moved).not.toHaveAttribute("data-fading");
	});

	it("has no toggle or reply as of a cutoff", async () => {
		renderOverview({ writes: "as-of", asOf: "2026-01-02T00:00:00Z" }, [
			thread("a"),
		]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const card = within(humans).getByTestId("thread");
		// Nothing more to show: no toggle, no box, no Resolve.
		expect(within(card).queryByTestId("thread-more")).toBeNull();
		expect(within(card).queryByRole("button", { name: "Resolve" })).toBeNull();
		expect(within(card).queryByRole("button", { name: "Reply" })).toBeNull();
	});
});

describe("replying from an Overview card", () => {
	it("a thread with nothing more to read: the toggle says Reply, opens the box and Resolve, then Hide", async () => {
		const user = userEvent.setup();
		renderOverview({}, [thread("a")]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const card = within(humans).getByTestId("thread");
		const more = within(card).getByTestId("thread-more");
		expect(more).toHaveAccessibleName("Reply");
		// Its own row, centred in the card.
		const row = within(card).getByTestId("thread-more-row");
		expect(row).toHaveClass("flex", "justify-center");
		expect(row).toContainElement(more);
		expect(row.children).toHaveLength(1);
		expect(more).toHaveTextContent(/^Reply$/);
		expect(within(card).queryByRole("textbox", { name: "Reply" })).toBeNull();
		await user.click(more);
		expect(
			await within(card).findByRole("textbox", { name: "Reply" }),
		).toBeVisible();
		expect(within(card).getByRole("button", { name: "Resolve" })).toBeVisible();
		expect(within(card).queryByTestId("thread-replies")).toBeNull();
		expect(more).toHaveAccessibleName("Hide");
		await user.click(more);
		expect(within(card).queryByRole("textbox", { name: "Reply" })).toBeNull();
	});

	it("one Show more for the whole thread: it counts the replies and opens to all of them, then the box", async () => {
		const user = userEvent.setup();
		renderOverview({}, [thread("a", { commentCount: 4, hasReply: true })]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const card = within(humans).getByTestId("thread");
		const more = within(card).getByTestId("thread-more");
		expect(more).toHaveAccessibleName("Show more, 3 replies");
		expect(more).toHaveTextContent("Show more·3 replies");
		// No separate replies toggle.
		expect(within(card).getAllByRole("button", { expanded: false })).toEqual([
			more,
		]);
		await user.click(more);
		const replies = within(card).getByTestId("thread-replies");
		const box = within(card).getByTestId("thread-actions");
		// Replies first, then the box and Resolve, then the toggle.
		expect(
			replies.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			box.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("a thread the viewer may resolve but not reply to still opens to Resolve", async () => {
		const user = userEvent.setup();
		renderOverview({}, [
			thread("a", {
				viewerCan: { reply: false, resolve: true, unresolve: false },
			}),
		]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const card = within(humans).getByTestId("thread");
		// Nothing to read or reply: the toggle says what it opens to.
		expect(within(card).getByTestId("thread-more")).toHaveAccessibleName(
			"Resolve",
		);
		await openCard(user, card);
		expect(within(card).getByTestId("thread-more")).toHaveAccessibleName(
			"Hide",
		);
		expect(within(card).getByTestId("resolve-button")).toBeVisible();
		expect(within(card).queryByRole("textbox", { name: "Reply" })).toBeNull();
	});

	it("counts a reply on its way: Show more, not Reply", async () => {
		const client = renderOverview({}, [thread("a")], () => null);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const more = within(humans).getByTestId("thread-more");
		expect(more).toHaveAccessibleName("Reply");
		act(() => threadWritesFor(client).reply("a", "Fixed"));
		await waitFor(() =>
			expect(more).toHaveAccessibleName("Show more, 1 reply"),
		);
	});

	it("a thread with a draft opens on it", async () => {
		localStorage.setItem(
			"crb:drafts:acme/widget#12",
			JSON.stringify([{ threadId: "a", text: "Kept" }]),
		);
		renderOverview({}, [thread("a"), thread("b")]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const [a, b] = within(humans).getAllByTestId("thread");
		if (!a || !b) throw new Error("no cards");
		expect(within(a).getByTestId("thread-more")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(within(b).getByTestId("thread-more")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});
});

describe("the Drafts filter", () => {
	it("shows with its count when a thread has a draft, and lists those threads", async () => {
		const user = userEvent.setup();
		const client = renderOverview({}, [thread("a"), thread("b")]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		expect(within(humans).queryByTestId("drafts-filter")).toBeNull();
		act(() => draftsFor(client).setText("b", "Half a thought"));
		const chip = await within(humans).findByTestId("drafts-filter");
		expect(chip).toHaveTextContent("1 draft");
		expect(chip).toHaveAttribute("aria-pressed", "false");
		await user.click(chip);
		const list = within(humans).getByRole("list", {
			name: "Threads with a draft",
		});
		const cards = within(list).getAllByTestId("thread");
		expect(cards).toHaveLength(1);
		expect(cards[0]).toHaveTextContent("src/b.ts");
		// Its box shows the draft.
		expect(within(list).getByRole("textbox", { name: "Reply" })).toHaveValue(
			"Half a thought",
		);
		// Cleared: the filter goes, the open threads show again.
		act(() => draftsFor(client).setText("b", ""));
		await waitFor(() =>
			expect(within(humans).queryByTestId("drafts-filter")).toBeNull(),
		);
		expect(
			within(humans).getByRole("list", { name: "Unresolved threads" }),
		).toBeInTheDocument();
	});

	it("on, neither side of the two-way choice is chosen; choosing one leaves it", async () => {
		const user = userEvent.setup();
		const client = renderOverview({}, [
			thread("a"),
			thread("b"),
			thread("c", { resolved: true }),
		]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		act(() => draftsFor(client).setText("b", "Half a thought"));
		const chip = await within(humans).findByTestId("drafts-filter");
		const open = within(humans).getByRole("radio", { name: "2 unresolved" });
		const done = within(humans).getByRole("radio", { name: "1 resolved" });
		for (const side of [done, open]) {
			await user.click(chip);
			expect(chip).toHaveAttribute("aria-pressed", "true");
			expect(open).not.toBeChecked();
			expect(done).not.toBeChecked();
			await user.click(side);
			expect(chip).toHaveAttribute("aria-pressed", "false");
			expect(side).toBeChecked();
			expect(
				within(humans).getByRole("list", {
					name: side === open ? "Unresolved threads" : "Resolved threads",
				}),
			).toBeInTheDocument();
		}
	});

	it("once the drafts run out it stays on Unresolved, and either side works", async () => {
		const user = userEvent.setup();
		const client = renderOverview({}, [
			thread("a"),
			thread("b"),
			thread("c", { resolved: true }),
		]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		act(() => draftsFor(client).setText("b", "Half a thought"));
		await user.click(await within(humans).findByTestId("drafts-filter"));
		act(() => draftsFor(client).setText("b", ""));
		await waitFor(() =>
			expect(within(humans).queryByTestId("drafts-filter")).toBeNull(),
		);
		const open = within(humans).getByRole("radio", { name: "2 unresolved" });
		const done = within(humans).getByRole("radio", { name: "1 resolved" });
		expect(open).toBeChecked();
		// A new draft later doesn't bring the Drafts list back.
		act(() => draftsFor(client).setText("a", "Another thought"));
		const chip = await within(humans).findByTestId("drafts-filter");
		expect(chip).toHaveAttribute("aria-pressed", "false");
		expect(open).toBeChecked();
		expect(
			within(humans).getByRole("list", { name: "Unresolved threads" }),
		).toBeInTheDocument();
		// Run out again: both sides answer at once.
		await user.click(chip);
		act(() => draftsFor(client).setText("a", ""));
		await waitFor(() =>
			expect(within(humans).queryByTestId("drafts-filter")).toBeNull(),
		);
		await user.click(done);
		expect(done).toBeChecked();
		expect(
			within(humans).getByRole("list", { name: "Resolved threads" }),
		).toBeInTheDocument();
		await user.click(open);
		expect(open).toBeChecked();
		expect(
			within(humans).getByRole("list", { name: "Unresolved threads" }),
		).toBeInTheDocument();
	});

	it("lists a draft whose thread isn't listed, with its text, Copy and Discard", async () => {
		const user = userEvent.setup();
		const client = renderOverview({}, [thread("a")]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		act(() => draftsFor(client).setText("gone", "Written to a deleted thread"));
		const chip = await within(humans).findByTestId("drafts-filter");
		expect(chip).toHaveTextContent("1 draft");
		await user.click(chip);
		const orphan = within(humans).getByTestId("orphan-draft");
		expect(orphan).toHaveTextContent("Written to a deleted thread");
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		await user.click(within(orphan).getByRole("button", { name: "Copy" }));
		expect(writeText).toHaveBeenCalledWith("Written to a deleted thread");
		await user.click(within(orphan).getByRole("button", { name: "Discard" }));
		expect(draftsFor(client).get()).toEqual([]);
		await waitFor(() =>
			expect(within(humans).queryByTestId("drafts-filter")).toBeNull(),
		);
	});

	it("lists drafts as such where the session doesn't write (no box to show them)", async () => {
		const user = userEvent.setup();
		const client = renderOverview(
			{ writes: "as-of", asOf: "2026-01-02T00:00:00Z" },
			[thread("a")],
		);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		act(() => draftsFor(client).setText("a", "From a live session"));
		await user.click(await within(humans).findByTestId("drafts-filter"));
		expect(within(humans).getByTestId("orphan-draft")).toHaveTextContent(
			"From a live session",
		);
	});

	it("counts a reply sent but not yet confirmed", async () => {
		const client = renderOverview({}, [thread("a")], () => null);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		act(() => threadWritesFor(client).reply("a", "Fixed"));
		expect(
			await within(humans).findByTestId("drafts-filter"),
		).toHaveTextContent("1 draft");
	});
});

describe("WriteWarnings in who's on it", () => {
	it("warns of a pending review on GitHub, with its link", async () => {
		renderOverview(
			{
				pendingReview: { url: "https://github.com/acme/widget/pull/12/files" },
			},
			[thread("a")],
		);
		const who = await screen.findByRole("region", { name: "Who's on it" });
		const warning = within(who).getByTestId("pending-review-warning");
		expect(warning).toHaveTextContent(
			"Pending review on GitHub: replies can't be posted until it's submitted or discarded",
		);
		expect(
			within(warning).getByRole("link", { name: "Open on GitHub" }),
		).toHaveAttribute("href", "https://github.com/acme/widget/pull/12/files");
	});

	it("warns once a reply is refused for a pending review", async () => {
		const user = userEvent.setup();
		renderOverview({}, [thread("a")], () => ({
			status: 409,
			body: {
				error: "user_id can only have one pending review per pull request",
				code: "pending-review",
				url: "https://github.com/acme/widget/pull/12/files",
			},
		}));
		const who = await screen.findByRole("region", { name: "Who's on it" });
		expect(within(who).queryByTestId("pending-review-warning")).toBeNull();
		const card = screen.getByTestId("thread");
		await openCard(user, card);
		const box = within(card).getByRole("textbox", { name: "Reply" });
		await user.type(box, "Fixed");
		await user.click(within(card).getByRole("button", { name: "Reply" }));
		expect(
			await within(who).findByTestId("pending-review-warning"),
		).toBeInTheDocument();
		// Listed as refused, with the link; the draft is kept.
		const notice = await screen.findByTestId("refused-write");
		expect(notice).toHaveTextContent(
			"A pending review on GitHub blocks replies",
		);
		expect(
			within(notice).getByRole("link", { name: "Open on GitHub" }),
		).toHaveAttribute("href", "https://github.com/acme/widget/pull/12/files");
		expect(box).toHaveValue("Fixed");
		expect(posts).toHaveLength(1);
	});

	it("a newly posted reply clears the pending-review warning", async () => {
		const user = userEvent.setup();
		renderOverview(
			{
				pendingReview: { url: "https://github.com/acme/widget/pull/12/files" },
			},
			[thread("a")],
			() => ({ status: 200, body: update("a", false) }),
		);
		const who = await screen.findByRole("region", { name: "Who's on it" });
		expect(within(who).getByTestId("pending-review-warning")).toBeVisible();
		const card = screen.getByTestId("thread");
		await openCard(user, card);
		await user.type(
			within(card).getByRole("textbox", { name: "Reply" }),
			"Done",
		);
		await user.keyboard("{Control>}{Enter}{/Control}");
		await waitFor(() =>
			expect(within(who).queryByTestId("pending-review-warning")).toBeNull(),
		);
	});

	it("says what the viewer can't do in this repo", async () => {
		renderOverview({}, [
			thread("a", {
				viewerCan: { reply: false, resolve: false, unresolve: false },
			}),
		]);
		const who = await screen.findByRole("region", { name: "Who's on it" });
		const warning = await within(who).findByTestId("permission-warning");
		expect(warning).toHaveTextContent("You can't reply in this repo");
		expect(warning).toHaveTextContent("You can't resolve threads in this repo");
	});

	it("only what is disallowed", async () => {
		renderOverview({}, [
			thread("a", {
				viewerCan: { reply: true, resolve: false, unresolve: false },
			}),
		]);
		const who = await screen.findByRole("region", { name: "Who's on it" });
		const warning = await within(who).findByTestId("permission-warning");
		expect(warning).not.toHaveTextContent("You can't reply");
		expect(warning).toHaveTextContent("You can't resolve threads in this repo");
	});

	it("checks resolve on open threads and unresolve on resolved ones, as GitHub gives them", async () => {
		renderOverview({}, [
			thread("a", {
				viewerCan: { reply: true, resolve: true, unresolve: false },
			}),
			thread("b", {
				resolved: true,
				viewerCan: { reply: true, resolve: false, unresolve: true },
			}),
		]);
		const who = await screen.findByRole("region", { name: "Who's on it" });
		await screen.findAllByTestId("thread");
		expect(within(who).queryByTestId("permission-warning")).toBeNull();
	});

	it("warns when a resolved thread can't be unresolved", async () => {
		renderOverview({}, [
			thread("b", {
				resolved: true,
				viewerCan: { reply: true, resolve: false, unresolve: false },
			}),
		]);
		const who = await screen.findByRole("region", { name: "Who's on it" });
		expect(
			await within(who).findByTestId("permission-warning"),
		).toHaveTextContent("You can't resolve threads in this repo");
	});

	it("no warning while a resolve is on its way", async () => {
		const user = userEvent.setup();
		renderOverview(
			{},
			[
				thread("a", {
					viewerCan: { reply: true, resolve: true, unresolve: false },
				}),
			],
			() => null,
		);
		const who = await screen.findByRole("region", { name: "Who's on it" });
		const card = screen.getByTestId("thread");
		await openCard(user, card);
		await user.click(within(card).getByRole("button", { name: "Resolve" }));
		expect(within(card).getByTestId("thread-head")).toHaveTextContent(
			/^Resolved thread/,
		);
		expect(within(who).queryByTestId("permission-warning")).toBeNull();
	});

	it("nothing when the session doesn't write", async () => {
		renderOverview(
			{
				writes: "viewer",
				pendingReview: { url: "https://github.com/acme/widget/pull/12/files" },
			},
			[
				thread("a", {
					viewerCan: { reply: false, resolve: false, unresolve: false },
				}),
			],
		);
		const who = await screen.findByRole("region", { name: "Who's on it" });
		await screen.findByTestId("thread");
		expect(within(who).queryByRole("alert")).toBeNull();
	});
});

/** Delete, then Delete again in the confirmation it opens. */
async function confirmDelete(
	user: ReturnType<typeof userEvent.setup>,
	button: HTMLElement,
) {
	await user.click(button);
	const dialog = screen.getByRole("alertdialog", {
		name: "Delete this comment?",
	});
	await user.click(within(dialog).getByRole("button", { name: "Delete" }));
}

describe("editing and deleting from an Overview card", () => {
	const own = (
		threadId: string,
		body: string,
		more: Partial<ThreadComment> = {},
	) =>
		({
			id: `${threadId}-1`,
			author: "octo",
			bot: false,
			avatarUrl: "",
			publishedAt: "2026-01-01T09:00:00Z",
			pending: false,
			html: `<p>${body}</p>`,
			body,
			text: body,
			editedAt: null,
			viewerCan: { update: true, delete: true },
			deleted: false,
			...more,
		}) satisfies ThreadComment;

	const answer = (
		threadId: string,
		comments: ThreadComment[],
		comment?: ThreadComment,
	) => ({
		status: 200,
		body: {
			...update(threadId, false),
			commentCount: comments.length,
			comments: { threadId, comments },
			...(comment ? { comment } : {}),
		} satisfies ThreadUpdate,
	});

	it("edits the opener inside Show more: the new text at once, then GitHub's, marked edited", async () => {
		const user = userEvent.setup();
		openerMore = { author: "octo", viewerCan: { update: true, delete: true } };
		// GitHub doesn't answer yet: the edit stays on its way.
		renderOverview({}, [thread("a", { author: "octo" })], () => null);
		const card = await screen.findByTestId("thread");
		// Closed: no Edit (it's inside Show more).
		expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
		await openCard(user, card);
		await user.click(await within(card).findByRole("button", { name: "Edit" }));
		const box = within(card).getByRole("textbox", { name: "Edit comment" });
		expect(box).toHaveValue("a");
		await user.clear(box);
		await user.type(box, "Better words");
		await user.click(within(card).getByRole("button", { name: "Save" }));
		expect(within(card).getByTestId("thread-body")).toHaveTextContent(
			"Better words",
		);
		expect(within(card).getByRole("img", { name: "Saving" })).toBeVisible();
		expect(posts).toEqual([
			{
				path: "/api/threads/a/comments/a-1",
				body: { body: "Better words", from: "a", force: false },
				method: "PATCH",
			},
		]);
		expect(statePosts()).toBe(0);
	});

	it("GitHub's answer to an opener edit becomes the card's text", async () => {
		const user = userEvent.setup();
		openerMore = { author: "octo", viewerCan: { update: true, delete: true } };
		const edited = own("a", "Better words", {
			editedAt: "2026-01-05T12:00:00Z",
		});
		renderOverview({}, [thread("a", { author: "octo" })], () =>
			answer("a", [edited], edited),
		);
		const card = await screen.findByTestId("thread");
		await openCard(user, card);
		await user.click(await within(card).findByRole("button", { name: "Edit" }));
		const box = within(card).getByRole("textbox", { name: "Edit comment" });
		await user.clear(box);
		await user.type(box, "Better words{Control>}{Enter}{/Control}");
		await waitFor(() =>
			expect(within(card).queryByRole("img", { name: "Saving" })).toBeNull(),
		);
		expect(within(card).getByTestId("thread-body")).toHaveTextContent(
			"Better words",
		);
		expect(within(card).getByTestId("comment-edited")).toBeVisible();
	});

	it("an opener edit draft opens its card, is listed in Drafts, and leaving doesn't ask (it's kept)", async () => {
		const user = userEvent.setup();
		openerMore = { author: "octo", viewerCan: { update: true, delete: true } };
		const client = renderOverview({}, [
			thread("a", { author: "octo" }),
			thread("b"),
		]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		act(() => draftsFor(client).setEdit("a", "a-1", "a", "a, reworded"));
		const chip = await within(humans).findByTestId("drafts-filter");
		expect(chip).toHaveTextContent("1 draft");
		await user.click(chip);
		const list = within(humans).getByRole("list", {
			name: "Threads with a draft",
		});
		expect(
			await within(list).findByRole("textbox", { name: "Edit comment" }),
		).toHaveValue("a, reworded");
		// The session's PR binds the drafts to storage: a reload keeps it.
		await waitFor(() => expect(draftsFor(client).durable()).toBe(true));
		const ask = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(ask);
		expect(ask.defaultPrevented).toBe(false);
	});

	it("deleting the only comment: Deleted · Undo, then sent; the card fades and leaves", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		openerMore = { author: "octo", viewerCan: { update: true, delete: true } };
		renderOverview({}, [thread("a", { author: "octo" }), thread("b")], () => ({
			status: 200,
			body: { threadId: "a", gone: true },
		}));
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const [card] = within(humans).getAllByTestId("thread");
		if (!card) throw new Error("no card");
		await openCard(user, card);
		await confirmDelete(
			user,
			await within(card).findByRole("button", { name: "Delete" }),
		);
		const row = within(card).getByTestId("comment-deleted-row");
		// Undo first: nothing is sent.
		await user.click(within(row).getByRole("button", { name: "Undo" }));
		await act(() => vi.advanceTimersByTimeAsync(DELETE_UNDO_MS * 2));
		expect(posts).toEqual([]);
		await confirmDelete(
			user,
			within(card).getByRole("button", { name: "Delete" }),
		);
		await act(() => vi.advanceTimersByTimeAsync(DELETE_UNDO_MS));
		await waitFor(() =>
			expect(posts).toEqual([
				{ path: "/api/threads/a/comments/a-1", body: null, method: "DELETE" },
			]),
		);
		await waitFor(() => expect(card).toHaveAttribute("data-fading", "true"));
		// Fading out, it stays deleted: the comment never shows again.
		expect(within(card).getByTestId("comment-deleted-row")).toBeVisible();
		expect(within(card).queryByTestId("thread-body")).toBeNull();
		expect(within(card).queryByRole("button", { name: "Undo" })).toBeNull();
		await act(() => vi.advanceTimersByTimeAsync(FADE_MS));
		await waitFor(() =>
			expect(within(humans).getAllByTestId("thread")).toHaveLength(1),
		);
		expect(statePosts()).toBe(0);
	});

	it("a card fading out as deleted leaves at once when the list is switched", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		openerMore = { author: "octo", viewerCan: { update: true, delete: true } };
		renderOverview({}, [thread("a", { author: "octo" }), thread("b")], () => ({
			status: 200,
			body: { threadId: "a", gone: true },
		}));
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const [card] = within(humans).getAllByTestId("thread");
		if (!card) throw new Error("no card");
		await openCard(user, card);
		await confirmDelete(
			user,
			await within(card).findByRole("button", { name: "Delete" }),
		);
		await act(() => vi.advanceTimersByTimeAsync(DELETE_UNDO_MS));
		await waitFor(() => expect(card).toHaveAttribute("data-fading", "true"));
		await user.click(
			within(humans).getByRole("radio", { name: /^\d+ resolved$/ }),
		);
		await user.click(
			within(humans).getByRole("radio", { name: /^\d+ unresolved$/ }),
		);
		const cards = within(humans).getAllByTestId("thread");
		expect(cards).toHaveLength(1);
		expect(cards[0]).toHaveTextContent("src/b.ts");
		expect(
			within(humans).getByRole("radio", { name: "1 unresolved" }),
		).toBeChecked();
	});

	it("changed on GitHub: the opener's newer text shows above the editor", async () => {
		const user = userEvent.setup();
		openerMore = { author: "octo", viewerCan: { update: true, delete: true } };
		renderOverview({}, [thread("a", { author: "octo" })], () => ({
			status: 409,
			body: {
				error: "Changed",
				code: "changed",
				current: own("a", "Their newer words"),
			},
		}));
		const card = await screen.findByTestId("thread");
		await openCard(user, card);
		await user.click(await within(card).findByRole("button", { name: "Edit" }));
		await user.type(
			within(card).getByRole("textbox", { name: "Edit comment" }),
			" mine",
		);
		await user.click(within(card).getByRole("button", { name: "Save" }));
		const notice = await screen.findByTestId("refused-write");
		await user.click(
			within(notice).getByRole("button", { name: "Show theirs" }),
		);
		expect(
			within(within(card).getByTestId("edit-theirs")).getByText(
				"Their newer words",
			),
		).toBeVisible();
		expect(
			within(card).getByRole("textbox", { name: "Edit comment" }),
		).toHaveValue("a mine");
	});

	it("Undo on a collapsed card never leaves a focus grab for later", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		openerMore = { author: "octo", viewerCan: { update: true, delete: true } };
		renderOverview({}, [thread("a", { author: "octo" })], () => null);
		const card = await screen.findByTestId("thread");
		await openCard(user, card);
		await confirmDelete(
			user,
			await within(card).findByRole("button", { name: "Delete" }),
		);
		// Collapsed, the Deleted row stays; Undo there.
		await user.click(within(card).getByTestId("thread-more"));
		await user.click(within(card).getByRole("button", { name: "Undo" }));
		await act(() => vi.advanceTimersByTimeAsync(100));
		const more = within(card).getByTestId("thread-more");
		await user.click(more);
		expect(
			await within(card).findByRole("button", { name: "Delete" }),
		).not.toHaveFocus();
		expect(more).toHaveFocus();
	});

	it("an opener blanked by a delete shows as a normal comment, with Edit", async () => {
		const user = userEvent.setup();
		openerMore = {
			author: "octo",
			body: "[deleted]",
			deleted: true,
			viewerCan: { update: true, delete: false },
		};
		moreComments = {
			a: [
				{
					...own("a", "A reply"),
					id: "a-2",
					author: "rev",
					viewerCan: { update: false, delete: false },
				},
			],
		};
		renderOverview({}, [
			thread("a", {
				author: "octo",
				body: "[deleted]",
				html: "<p>[deleted]</p>",
				commentCount: 2,
			}),
		]);
		const card = await screen.findByTestId("thread");
		expect(within(card).getByTestId("thread-body")).toHaveTextContent(
			"[deleted]",
		);
		expect(within(card).queryByTestId("comment-deleted")).toBeNull();
		await openCard(user, card);
		await within(card).findByText("A reply");
		expect(
			await within(card).findByRole("button", { name: "Edit" }),
		).toBeVisible();
		expect(within(card).queryByRole("button", { name: "Delete" })).toBeNull();
	});
});
