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
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suggestionHtml } from "../../../test/fake-gh/scenario";
import type {
	PrOverview,
	ReviewThread,
	SessionInfo,
	ThreadComment,
	ThreadComments,
	ThreadUpdate,
} from "../../shared/types";
import { showCommentsOf } from "../api";
import { Conversation } from "./Conversation";
import { PeopleProvider } from "./people";
import { ResolveButton } from "./ResolveButton";
import { ThreadStatus } from "./ThreadStatus";

const comment = (
	id: string,
	author: string,
	text: string,
	more: Partial<ThreadComment> = {},
): ThreadComment => ({
	id,
	author,
	bot: false,
	avatarUrl: "",
	publishedAt: "2026-01-03T09:00:00Z",
	pending: false,
	html: `<p>${text}</p>`,
	body: text,
	text,
	...more,
});

const thread = (more: Partial<ReviewThread> = {}): ReviewThread => ({
	id: "T1",
	path: "src/cache.ts",
	line: 4,
	currentLine: 4,
	loaded: true,
	excerpt: "First",
	html: "<p>First</p>",
	body: "First",
	createdAt: "2026-01-03T09:00:00Z",
	lastActivityAt: "2026-01-03T11:00:00Z",
	author: "rev1",
	bot: false,
	avatarUrl: "",
	participants: [],
	commentCount: 3,
	hasReply: true,
	outdated: false,
	resolved: false,
	code: null,
	anchor: null,
	attention: [],
	yourTurn: false,
	viewerCan: { reply: true, resolve: true, unresolve: false },
	commit: "",
	subject: "line",
	...more,
});

/** Answers a comments request; each test sets its own. */
let answer: (ids: string[]) => Promise<Response>;
/** Answers a thread write (POST /api/threads/…); 404 unless a test sets it. */
let writeAnswer: (path: string, body: unknown) => Promise<Response>;
let writeCalls: { path: string; body: unknown }[];
let requests: number;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

const serve = (byId: Record<string, Omit<ThreadComments, "threadId">>) => {
	answer = async (ids) =>
		json({
			threads: ids.map((threadId) => ({
				threadId,
				...(byId[threadId] ?? { comments: [] }),
			})),
		});
};

let clients: QueryClient[] = [];

beforeEach(() => {
	requests = 0;
	serve({});
	writeCalls = [];
	writeAnswer = async () => json({ error: "not here" }, 404);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input, "http://crb");
			if (url.pathname.startsWith("/api/threads/")) {
				const body: unknown = JSON.parse(String(init?.body ?? "null"));
				writeCalls.push({ path: url.pathname, body });
				return writeAnswer(url.pathname, body);
			}
			if (url.pathname !== "/api/comments") {
				return json({ error: "not here" }, 404);
			}
			requests++;
			return answer((url.searchParams.get("ids") ?? "").split(","));
		}),
	);
});

afterEach(() => {
	cleanup();
	for (const c of clients) showCommentsOf(c, "");
	clients = [];
	vi.unstubAllGlobals();
});

function renderWith(
	node: ReactNode,
	opts: { writes?: PrOverview["writes"] } = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	clients.push(client);
	if (opts.writes) {
		client.setQueryData(["overview"], {
			readId: "r1",
			writes: opts.writes,
			pendingReview: null,
		} as PrOverview);
		client.setQueryData(["session"], { viewer: "octo" } as SessionInfo);
	}
	return render(
		<QueryClientProvider client={client}>{node}</QueryClientProvider>,
	);
}

const three = {
	comments: [
		comment("c1", "rev1", "First"),
		comment("c2", "lint-bot", "Second", { bot: true }),
		comment("c3", "octo-author", "Third"),
	],
};

describe("Conversation", () => {
	it("shows every comment, oldest first, with its author and time", async () => {
		serve({ T1: three });
		renderWith(<Conversation readId="r1" thread={thread()} />);
		const items = await screen.findAllByTestId("thread-comment");
		expect(items.map((i) => i.textContent)).toEqual([
			expect.stringContaining("First"),
			expect.stringContaining("Second"),
			expect.stringContaining("Third"),
		]);
		expect(items[0]).toHaveTextContent("rev1");
		expect(items[2]).toHaveTextContent("octo-author");
		expect(items[0]?.querySelector("time")).toHaveAttribute(
			"dateTime",
			"2026-01-03T09:00:00Z",
		);
		// A bot's comment carries the bot icon.
		expect(
			within(items[1] as HTMLElement).getByRole("img", { name: "bot" }),
		).toBeInTheDocument();
		expect(
			within(items[0] as HTMLElement).queryByRole("img", { name: "bot" }),
		).toBeNull();
	});

	it("leaves out the opening comment with skipFirst", async () => {
		serve({ T1: three });
		renderWith(<Conversation readId="r1" thread={thread()} skipFirst />);
		const items = await screen.findAllByTestId("thread-comment");
		expect(items).toHaveLength(2);
		expect(items[0]).toHaveTextContent("Second");
	});

	it("draws a suggested change in a reply", async () => {
		const removed = ["  return 1;"];
		const added = ["  return 2;"];
		serve({
			T1: {
				comments: [
					comment("c1", "rev1", "First"),
					comment("c2", "rev2", "Try", {
						html: `<p dir="auto">Try</p>\n${suggestionHtml(removed, added)}`,
						body: `Try\r\n\`\`\`suggestion\r\n${added.join("\r\n")}\r\n\`\`\``,
					}),
				],
			},
		});
		renderWith(<Conversation readId="r1" thread={thread()} skipFirst />);
		const figure = await screen.findByRole("figure", {
			name: "Suggested change",
		});
		const lines = within(figure).getAllByTestId("suggestion-line");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toHaveTextContent("return 2;");
	});

	it("marks the viewer's pending comment", async () => {
		serve({
			T1: {
				comments: [
					comment("c1", "rev1", "First"),
					comment("c2", "Octo_Cat", "Draft", {
						pending: true,
						publishedAt: null,
					}),
				],
			},
		});
		renderWith(<Conversation readId="r1" thread={thread()} />);
		const items = await screen.findAllByTestId("thread-comment");
		expect(
			within(items[1] as HTMLElement).getByRole("img", {
				name: "Pending, only you see it",
			}),
		).toBeInTheDocument();
		expect(
			within(items[0] as HTMLElement).queryByRole("img", {
				name: "Pending, only you see it",
			}),
		).toBeNull();
	});

	it("shows a spinner while the comments load, then the comments", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		answer = async (ids) => {
			await gate;
			return json({ threads: ids.map((threadId) => ({ threadId, ...three })) });
		};
		renderWith(<Conversation readId="r1" thread={thread()} />);
		expect(
			await screen.findByRole("status", { name: "Loading comments" }),
		).toBeInTheDocument();
		expect(screen.queryAllByTestId("thread-comment")).toHaveLength(0);
		release();
		expect(await screen.findAllByTestId("thread-comment")).toHaveLength(3);
		expect(
			screen.queryByRole("status", { name: "Loading comments" }),
		).toBeNull();
	});

	it("offers Retry when the comments can't be read, and reads them again", async () => {
		answer = async () => json({ error: "gh failed" }, 502);
		renderWith(<Conversation readId="r1" thread={thread()} />);
		const retry = await screen.findByRole("button", { name: "Retry" });
		expect(screen.queryAllByTestId("thread-comment")).toHaveLength(0);
		serve({ T1: three });
		const before = requests;
		await userEvent.setup().click(retry);
		expect(await screen.findAllByTestId("thread-comment")).toHaveLength(3);
		expect(requests).toBeGreaterThan(before);
	});

	it("flags comments that couldn't be loaded", async () => {
		serve({
			T1: {
				comments: [comment("c1", "rev1", "First"), comment("c3", "rev1", "x")],
				missing: 1,
			},
		});
		renderWith(<Conversation readId="r1" thread={thread()} />);
		expect(
			await screen.findByRole("img", { name: "1 comment couldn't be loaded" }),
		).toBeInTheDocument();
	});

	it("says a thread deleted since it was listed is deleted, never spins", async () => {
		serve({ T1: { comments: [], unavailable: "deleted" } });
		renderWith(<Conversation readId="r1" thread={thread()} />);
		expect(await screen.findByText("Deleted on GitHub")).toBeInTheDocument();
		expect(
			screen.queryByRole("status", { name: "Loading comments" }),
		).toBeNull();
	});

	it("asks for nothing when the thread's text will never come", async () => {
		renderWith(
			<Conversation
				readId="r1"
				thread={thread({ id: "", unavailable: "unreadable" })}
			/>,
		);
		expect(
			await screen.findByText("Couldn't be read from GitHub"),
		).toBeInTheDocument();
		await new Promise((r) => setTimeout(r, 30));
		expect(requests).toBe(0);
	});
});

describe("Conversation across reads", () => {
	it("a read gone (410) spins until the new read comes, with no dead Retry", async () => {
		answer = async () => json({ error: "read gone" }, 410);
		renderWith(<Conversation readId="r1" thread={thread()} />);
		await waitFor(() => expect(requests).toBeGreaterThan(0));
		await new Promise((r) => setTimeout(r, 30));
		expect(
			screen.getByRole("status", { name: "Loading comments" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	});

	it("the spinner names itself in a tooltip", async () => {
		answer = () => new Promise(() => {});
		renderWith(<Conversation readId="r1" thread={thread()} />);
		const spinner = await screen.findByRole("status", {
			name: "Loading comments",
		});
		await userEvent.setup().hover(spinner);
		await waitFor(() =>
			expect(
				screen.getByText("Loading comments", { selector: "[role=tooltip]" }),
			).toBeVisible(),
		);
	});

	it("a comment with no text says so instead of an empty box", async () => {
		serve({
			T1: {
				comments: [comment("c1", "rev1", "", { html: "", body: "", text: "" })],
			},
		});
		renderWith(<Conversation readId="r1" thread={thread()} />);
		const item = await screen.findByTestId("thread-comment");
		expect(within(item).getByText("No text")).toHaveClass("text-muted");
	});
});

describe("ThreadStatus", () => {
	it("shows the comment count", () => {
		renderWith(<ThreadStatus thread={thread()} />);
		const count = screen.getByRole("img", { name: "3 comments" });
		expect(count).toHaveTextContent("3");
	});

	it("shows the your-turn dot only when it's the viewer's turn", () => {
		const { unmount } = renderWith(<ThreadStatus thread={thread()} />);
		expect(screen.queryByRole("img", { name: "Your turn" })).toBeNull();
		unmount();
		renderWith(
			<ThreadStatus
				thread={thread({ yourTurn: true, attention: ["Octo_Cat"] })}
			/>,
		);
		const dot = screen.getByRole("img", { name: "Your turn" });
		expect(dot.querySelector(".bg-warn")).not.toBeNull();
	});

	it("marks a resolved thread, with no dot", () => {
		renderWith(
			<ThreadStatus thread={thread({ resolved: true, yourTurn: true })} />,
		);
		const mark = screen.getByRole("img", { name: "Resolved" });
		expect(mark).toHaveClass("text-ok");
		expect(screen.queryByRole("img", { name: "Your turn" })).toBeNull();
	});

	it("shows no resolved mark on an unresolved thread", async () => {
		renderWith(<ThreadStatus thread={thread()} />);
		expect(screen.queryByRole("img", { name: "Resolved" })).toBeNull();
		// The tooltip says it, for touch and keyboard too.
		const count = screen.getByRole("img", { name: "3 comments" });
		count.focus();
		await waitFor(() =>
			expect(
				screen.getByText("3 comments", { selector: "[role=tooltip]" }),
			).toBeVisible(),
		);
	});
});

const can = (reply: boolean, resolve: boolean, unresolve = resolve) => ({
	viewerCan: { reply, resolve, unresolve },
});

describe("replying", () => {
	it("shows a reply box under the comments when writing is on", async () => {
		serve({ T1: three });
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		await screen.findAllByTestId("thread-comment");
		const box = screen.getByRole("textbox", { name: "Reply" });
		expect(box).toHaveAttribute("rows", "1");
		const send = screen.getByRole("button", { name: "Reply" });
		expect(send).toBeDisabled();
		await userEvent.click(box);
		expect(box).toHaveAttribute("rows", "3");
		// Whitespace alone can't be sent.
		await userEvent.type(box, "   ");
		expect(send).toBeDisabled();
	});

	it.each([
		["as of a cutoff", "as-of" as const, thread()],
		["as another viewer", "viewer" as const, thread()],
		["where GitHub says no", "on" as const, thread(can(false, true))],
	])("has no box %s", async (_, writes, t) => {
		serve({ T1: three });
		renderWith(<Conversation readId="r1" thread={t} />, { writes });
		await screen.findAllByTestId("thread-comment");
		expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
	});

	it("sends on Ctrl+Enter: the reply shows at once, sending, and the box clears; GitHub's answer replaces it", async () => {
		serve({ T1: three });
		let land: (() => void) | undefined;
		const posted = comment("c4", "octo", "Done, thanks");
		writeAnswer = (_path, body) =>
			new Promise((resolve) => {
				land = () =>
					resolve(
						json({
							threadId: "T1",
							resolved: false,
							commentCount: 4,
							lastActivityAt: "2026-01-03T12:00:00Z",
							attention: ["rev1"],
							yourTurn: false,
							viewerCan: can(true, true).viewerCan,
							comments: {
								threadId: "T1",
								comments: [...three.comments, posted],
							},
							comment: posted,
						} satisfies ThreadUpdate),
					);
				expect(body).toMatchObject({ body: "Done, thanks", retry: false });
			});
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		await screen.findAllByTestId("thread-comment");
		const box = screen.getByRole("textbox", { name: "Reply" });
		await userEvent.type(box, "Done, thanks");
		await userEvent.keyboard("{Control>}{Enter}{/Control}");
		expect(box).toHaveValue("");
		const sending = await screen.findByTestId("thread-comment-sending");
		expect(sending).toHaveTextContent("octo");
		expect(sending).toHaveTextContent("Done, thanks");
		expect(
			within(sending).getByRole("img", { name: "Sending" }),
		).toBeInTheDocument();
		expect(writeCalls[0]?.path).toBe("/api/threads/T1/replies");
		land?.();
		await waitFor(() =>
			expect(screen.queryByTestId("thread-comment-sending")).toBeNull(),
		);
		const items = screen.getAllByTestId("thread-comment");
		expect(items).toHaveLength(4);
		expect(items[3]).toHaveTextContent("Done, thanks");
	});

	it("Escape leaves the box and keeps the draft, also across closing the thread", async () => {
		serve({ T1: three });
		const { unmount, client } = (() => {
			const r = renderWith(<Conversation readId="r1" thread={thread()} />, {
				writes: "on",
			});
			return { unmount: r.unmount, client: clients.at(-1) };
		})();
		await screen.findAllByTestId("thread-comment");
		const box = screen.getByRole("textbox", { name: "Reply" });
		await userEvent.type(box, "Half a thought");
		await userEvent.keyboard("{Escape}");
		expect(box).not.toHaveFocus();
		expect(box).toHaveValue("Half a thought");
		unmount();
		if (!client) throw new Error("no client");
		render(
			<QueryClientProvider client={client}>
				<Conversation readId="r1" thread={thread()} />
			</QueryClientProvider>,
		);
		expect(await screen.findByRole("textbox", { name: "Reply" })).toHaveValue(
			"Half a thought",
		);
	});

	it("a refused reply puts its text back into the box", async () => {
		serve({ T1: three });
		writeAnswer = async () =>
			json({ error: "The thread is gone", code: "gone" }, 404);
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		await screen.findAllByTestId("thread-comment");
		const box = screen.getByRole("textbox", { name: "Reply" });
		await userEvent.type(box, "Fixed");
		await userEvent.click(screen.getByRole("button", { name: "Reply" }));
		await waitFor(() => expect(box).toHaveValue("Fixed"));
		expect(screen.queryByTestId("thread-comment-sending")).toBeNull();
		expect(writeCalls).toHaveLength(1);
	});

	it("keeps the box while the comments load", () => {
		answer = () => new Promise(() => {});
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		expect(screen.getByTestId("comments-loading")).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Reply" })).toBeInTheDocument();
	});
});

describe("ResolveButton", () => {
	it("resolves an open thread and flips at once; unresolves a resolved one", async () => {
		writeAnswer = () => new Promise(() => {});
		const onToggle = vi.fn();
		const { rerender } = renderWith(
			<ResolveButton thread={thread()} onToggle={onToggle} />,
			{ writes: "on" },
		);
		await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
		expect(onToggle).toHaveBeenCalledWith(true);
		expect(writeCalls).toEqual([
			{ path: "/api/threads/T1/resolved", body: { resolved: true } },
		]);
		rerender(
			<QueryClientProvider client={clients.at(-1) as QueryClient}>
				<ResolveButton thread={thread({ resolved: true })} />
			</QueryClientProvider>,
		);
		expect(screen.getByRole("button", { name: "Unresolve" })).toBeVisible();
	});

	it.each([
		["as of a cutoff", "as-of" as const, thread()],
		["as another viewer", "viewer" as const, thread()],
		["where GitHub says no", "on" as const, thread(can(true, false))],
	])("is hidden %s", (_, writes, t) => {
		renderWith(<ResolveButton thread={t} />, { writes });
		expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
	});

	it("sits beside the reply box, a 40px button with its name in text", async () => {
		serve({ T1: three });
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		const actions = await screen.findByTestId("thread-actions");
		const button = within(actions).getByRole("button", { name: "Resolve" });
		expect(button).toHaveTextContent("Resolve");
		expect(button.className).toContain("h-10");
		expect(
			within(actions).getByRole("textbox", { name: "Reply" }),
		).toBeInTheDocument();
	});

	it("shows where the viewer may resolve but not reply", async () => {
		serve({ T1: three });
		renderWith(<Conversation readId="r1" thread={thread(can(false, true))} />, {
			writes: "on",
		});
		await screen.findAllByTestId("thread-comment");
		expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
		expect(screen.getByRole("button", { name: "Resolve" })).toBeVisible();
	});
});

describe("avatars and tints", () => {
	const url = "https://avatars.githubusercontent.com/u/1?s=40";

	it("shows GitHub's avatar beside the author, decorative and lazy; an initial without one", async () => {
		serve({
			T1: {
				comments: [
					comment("c1", "rev1", "First", { avatarUrl: url }),
					comment("c2", "octo-author", "Second"),
				],
			},
		});
		renderWith(<Conversation readId="r1" thread={thread()} />);
		const [first, second] = await screen.findAllByTestId("thread-comment");
		if (!first || !second) throw new Error("no comments");
		const img = within(first).getByTestId("avatar");
		expect(img).toHaveAttribute("src", url);
		expect(img).toHaveAttribute("alt", "");
		expect(img).toHaveAttribute("loading", "lazy");
		expect(img).toHaveAttribute("width", "20");
		const fallback = within(second).getByTestId("avatar-fallback");
		expect(fallback).toHaveAttribute("data-initial", "O");
		expect(fallback).toHaveAttribute("aria-hidden", "true");
	});

	it("falls back to the initial on the person's tint when the image fails", async () => {
		serve({
			T1: { comments: [comment("c1", "rev1", "First", { avatarUrl: url })] },
		});
		renderWith(<Conversation readId="r1" thread={thread()} />);
		const img = await screen.findByTestId("avatar");
		img.dispatchEvent(new Event("error"));
		const fallback = await screen.findByTestId("avatar-fallback");
		expect(fallback).toHaveAttribute("data-initial", "R");
		const body = screen.getByTestId("thread-comment-body");
		expect(fallback.dataset.tint).toBe(body.dataset.tint);
	});

	it("tints each comment by its author, the same across the PR's threads", async () => {
		serve({ T1: three });
		const participants = (logins: string[]) =>
			logins.map((login, i) => ({
				login,
				avatarUrl: "",
				at: `2026-01-0${i + 1}T00:00:00Z`,
			}));
		const all = [
			thread({ id: "T0", participants: participants(["octo-author"]) }),
			thread({
				participants: participants(["rev1", "lint-bot", "octo-author"]),
			}),
		];
		renderWith(
			<PeopleProvider threads={all}>
				<Conversation readId="r1" thread={thread()} />
			</PeopleProvider>,
		);
		await screen.findAllByTestId("thread-comment");
		const tints = screen
			.getAllByTestId("thread-comment-body")
			.map((b) => b.dataset.tint);
		// octo-author spoke first in the PR (in T0), then rev1, then lint-bot.
		expect(tints).toEqual(["1", "2", "0"]);
		expect(
			screen.getAllByTestId("thread-comment-body")[2]?.className,
		).toContain("bg-person-1");
	});
});
