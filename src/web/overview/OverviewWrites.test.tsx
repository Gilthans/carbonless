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
	ThreadUpdate,
} from "../../shared/types";
import { createAppRouter } from "../router";
import { draftsFor } from "../threads/drafts";
import { FADE_MS, threadWritesFor } from "../threads/threadWrites";

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

let posts: { path: string; body: unknown }[];
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
				posts.push({ path, body: JSON.parse(String(init?.body ?? "null")) });
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
								},
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

beforeEach(() => {
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
			within(humans).getByRole("button", { name: "1 resolved" }),
		).toBeInTheDocument();
	});

	it("undoing during the fade keeps the card where it is", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderOverview({}, [thread("a")]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const card = within(humans).getByTestId("thread");
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
		await user.click(within(card).getByRole("button", { name: "Resolve" }));
		const moving = within(card).getByTestId("thread-moving");
		expect(moving).toHaveTextContent("Moving…");
		expect(moving).toHaveAttribute("role", "status");
		expect(moving).toHaveClass("motion-reduce:inline");
	});

	it("has no toggle or reply as of a cutoff", async () => {
		renderOverview({ writes: "as-of", asOf: "2026-01-02T00:00:00Z" }, [
			thread("a"),
		]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const card = within(humans).getByTestId("thread");
		expect(within(card).queryByRole("button", { name: "Resolve" })).toBeNull();
		expect(within(card).queryByRole("button", { name: "Reply" })).toBeNull();
	});
});

describe("replying from an Overview card", () => {
	it("a thread with no replies opens a reply box", async () => {
		const user = userEvent.setup();
		renderOverview({}, [thread("a")]);
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const card = within(humans).getByTestId("thread");
		await user.click(within(card).getByRole("button", { name: "Reply" }));
		expect(
			await within(card).findByRole("textbox", { name: "Reply" }),
		).toBeVisible();
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
		await user.click(within(card).getByRole("button", { name: "Reply" }));
		const box = within(card).getByRole("textbox", { name: "Reply" });
		await user.type(box, "Fixed");
		await user.click(
			within(card)
				.getAllByRole("button", { name: "Reply" })
				.at(-1) as HTMLElement,
		);
		expect(
			await within(who).findByTestId("pending-review-warning"),
		).toBeInTheDocument();
		// The red notice says so, with the link; the draft is kept.
		const notice = await screen.findByTestId("write-failed");
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
		await user.click(within(card).getByRole("button", { name: "Reply" }));
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
