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
import { type ReactNode, useState } from "react";
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
import { SyncNotices } from "../files/SyncNotices";
import { PageActive } from "../pageActive";
import { Conversation } from "./Conversation";
import { PeopleProvider } from "./people";
import { ResolveButton } from "./ResolveButton";
import { ThreadStatus } from "./ThreadStatus";
import { DELETE_UNDO_MS, FADE_MS, threadWritesFor } from "./threadWrites";

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
	editedAt: null,
	viewerCan: { update: false, delete: false },
	deleted: false,
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
/** Each thread write's HTTP method, in order. */
let writeMethods: string[];
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
	writeMethods = [];
	writeAnswer = async () => json({ error: "not here" }, 404);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input, "http://crb");
			if (url.pathname.startsWith("/api/threads/")) {
				const body: unknown = JSON.parse(String(init?.body ?? "null"));
				writeCalls.push({ path: url.pathname, body });
				writeMethods.push(init?.method ?? "GET");
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

const mine = (id: string, text: string, more: Partial<ThreadComment> = {}) =>
	comment(id, "octo", text, {
		viewerCan: { update: true, delete: true },
		...more,
	});

/** GitHub's answer to a write: the thread with these comments. */
const answerWith = (
	comments: ThreadComment[],
	edited?: ThreadComment,
): ThreadUpdate => ({
	threadId: "T1",
	resolved: false,
	commentCount: comments.length,
	lastActivityAt: "2026-01-03T12:00:00Z",
	attention: [],
	yourTurn: false,
	viewerCan: can(true, true).viewerCan,
	comments: { threadId: "T1", comments },
	...(edited ? { comment: edited } : {}),
});

describe("editing a comment", () => {
	it("offers Edit and Delete only on comments the viewer may change, with writing on", async () => {
		serve({
			T1: {
				comments: [
					comment("c1", "rev1", "Theirs"),
					mine("c2", "Mine"),
					mine("c3", "Edit only", {
						viewerCan: { update: true, delete: false },
					}),
				],
			},
		});
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		const items = await screen.findAllByTestId("thread-comment");
		const [theirs, own, editOnly] = items as [
			HTMLElement,
			HTMLElement,
			HTMLElement,
		];
		expect(within(theirs).queryByTestId("comment-actions")).toBeNull();
		const edit = within(own).getByRole("button", { name: "Edit" });
		const del = within(own).getByRole("button", { name: "Delete" });
		// 40px targets.
		expect(edit).toHaveClass("h-10", "w-10");
		expect(del).toHaveClass("h-10", "w-10");
		expect(
			within(editOnly).getByRole("button", { name: "Edit" }),
		).toBeVisible();
		expect(
			within(editOnly).queryByRole("button", { name: "Delete" }),
		).toBeNull();
	});

	it("offers neither where the session doesn't write (as of a cutoff, as another viewer)", async () => {
		serve({ T1: { comments: [mine("c1", "Mine")] } });
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "as-of",
		});
		await screen.findAllByTestId("thread-comment");
		expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
	});

	it("marks an edited comment, anyone's, with when on hover or focus", async () => {
		serve({
			T1: {
				comments: [
					comment("c1", "rev1", "First", {
						editedAt: "2026-01-03T10:00:00Z",
					}),
					comment("c2", "rev2", "Second"),
				],
			},
		});
		renderWith(<Conversation readId="r1" thread={thread()} />);
		const items = await screen.findAllByTestId("thread-comment");
		const mark = within(items[0] as HTMLElement).getByTestId("comment-edited");
		expect(mark).toHaveTextContent("edited");
		expect(
			within(items[1] as HTMLElement).queryByTestId("comment-edited"),
		).toBeNull();
		mark.focus();
		expect(await screen.findByRole("tooltip")).toHaveTextContent(
			/^Edited 2026/,
		);
	});

	it("edits in place: the Markdown in a textarea, then the new text at once, saving, until GitHub's answer", async () => {
		const own = mine("c2", "Old **text**");
		serve({ T1: { comments: [comment("c1", "rev1", "First"), own] } });
		let land: (() => void) | undefined;
		writeAnswer = (_path, body) =>
			new Promise((resolve) => {
				const edited = mine("c2", "New text", {
					editedAt: "2026-01-03T12:00:00Z",
				});
				land = () =>
					resolve(
						json(answerWith([comment("c1", "rev1", "First"), edited], edited)),
					);
				expect(body).toEqual({
					body: "New text",
					from: "Old **text**",
					force: false,
				});
			});
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		await screen.findAllByTestId("thread-comment");
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		const box = screen.getByRole("textbox", { name: "Edit comment" });
		expect(box).toHaveValue("Old **text**");
		expect(box).toHaveFocus();
		await userEvent.clear(box);
		// Empty text can't be saved: Delete removes a comment.
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		await userEvent.type(box, "New text");
		await userEvent.keyboard("{Control>}{Enter}{/Control}");
		expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull();
		const item = screen.getAllByTestId("thread-comment")[1] as HTMLElement;
		expect(item).toHaveTextContent("New text");
		expect(within(item).getByRole("img", { name: "Saving" })).toBeVisible();
		expect(writeCalls[0]?.path).toBe("/api/threads/T1/comments/c2");
		expect(writeMethods).toEqual(["PATCH"]);
		land?.();
		await waitFor(() =>
			expect(within(item).queryByRole("img", { name: "Saving" })).toBeNull(),
		);
		expect(within(item).getByTestId("comment-edited")).toBeVisible();
		expect(item).toHaveTextContent("New text");
	});

	it("keeps the edit as a draft across closing the thread; Escape asks first when it changed", async () => {
		serve({ T1: { comments: [mine("c1", "Old")] } });
		const r = renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		const client = clients.at(-1) as QueryClient;
		await screen.findAllByTestId("thread-comment");
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		await userEvent.type(
			screen.getByRole("textbox", { name: "Edit comment" }),
			" and more",
		);
		r.unmount();
		render(
			<QueryClientProvider client={client}>
				<Conversation readId="r1" thread={thread()} />
			</QueryClientProvider>,
		);
		const box = await screen.findByRole("textbox", { name: "Edit comment" });
		expect(box).toHaveValue("Old and more");
		const confirm = vi.fn(() => false);
		vi.stubGlobal("confirm", confirm);
		box.focus();
		await userEvent.keyboard("{Escape}");
		expect(confirm).toHaveBeenCalledOnce();
		expect(box).toHaveValue("Old and more");
		confirm.mockReturnValue(true);
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull();
		expect(screen.getByTestId("thread-comment")).toHaveTextContent("Old");
		expect(writeCalls).toHaveLength(0);
	});

	it("Escape with nothing changed just closes", async () => {
		serve({ T1: { comments: [mine("c1", "Old")] } });
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		await screen.findAllByTestId("thread-comment");
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		const confirm = vi.fn(() => false);
		vi.stubGlobal("confirm", confirm);
		await userEvent.keyboard("{Escape}");
		expect(confirm).not.toHaveBeenCalled();
		expect(screen.queryByRole("textbox", { name: "Edit comment" })).toBeNull();
	});

	it("changed on GitHub: the draft back in its editor, a red notice with Show theirs and Save anyway", async () => {
		serve({ T1: { comments: [mine("c1", "Old")] } });
		const theirs = mine("c1", "Theirs");
		writeAnswer = async (_path, body) =>
			(body as { force?: boolean }).force
				? json(answerWith([mine("c1", "Mine")], mine("c1", "Mine")))
				: json({ error: "Changed", code: "changed", current: theirs }, 409);
		renderWith(
			<>
				<Conversation readId="r1" thread={thread()} />
				<SyncNotices />
			</>,
			{ writes: "on" },
		);
		await screen.findAllByTestId("thread-comment");
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		const box = screen.getByRole("textbox", { name: "Edit comment" });
		await userEvent.clear(box);
		await userEvent.type(box, "Mine");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		const notice = await screen.findByTestId("refused-write");
		expect(notice).toHaveTextContent("Edit");
		expect(notice).toHaveTextContent("Changed on GitHub since you opened it");
		expect(
			await screen.findByRole("textbox", { name: "Edit comment" }),
		).toHaveValue("Mine");
		await userEvent.click(
			within(notice).getByRole("button", { name: "Save anyway" }),
		);
		await waitFor(() =>
			expect(screen.queryByTestId("refused-write")).toBeNull(),
		);
		expect(writeCalls.map((c) => c.body)).toEqual([
			{ body: "Mine", from: "Old", force: false },
			{ body: "Mine", from: "Old", force: true },
		]);
		await waitFor(() =>
			expect(screen.getByTestId("thread-comment")).toHaveTextContent("Mine"),
		);
	});

	it("Show theirs shows GitHub's text and keeps the draft in the editor", async () => {
		serve({ T1: { comments: [mine("c1", "Old")] } });
		writeAnswer = async () =>
			json(
				{ error: "Changed", code: "changed", current: mine("c1", "Theirs") },
				409,
			);
		renderWith(
			<>
				<Conversation readId="r1" thread={thread()} />
				<SyncNotices />
			</>,
			{ writes: "on" },
		);
		await screen.findAllByTestId("thread-comment");
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		await userEvent.type(
			screen.getByRole("textbox", { name: "Edit comment" }),
			" mine",
		);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		const notice = await screen.findByTestId("refused-write");
		// GitHub's newer text is on screen above the editor, never saved over unseen.
		const theirs = await screen.findByTestId("edit-theirs");
		expect(within(theirs).getByText("Theirs")).toBeVisible();
		await userEvent.click(
			within(notice).getByRole("button", { name: "Show theirs" }),
		);
		expect(screen.queryByTestId("refused-write")).toBeNull();
		expect(
			within(screen.getByTestId("edit-theirs")).getByText("Theirs"),
		).toBeVisible();
		expect(screen.getByRole("textbox", { name: "Edit comment" })).toHaveValue(
			"Old mine",
		);
		// Typing on from theirs keeps it in view, until Save or Cancel.
		await userEvent.type(
			screen.getByRole("textbox", { name: "Edit comment" }),
			"!",
		);
		expect(
			within(screen.getByTestId("edit-theirs")).getByText("Theirs"),
		).toBeVisible();
		await userEvent.type(
			screen.getByRole("textbox", { name: "Edit comment" }),
			"{Backspace}",
		);
		// Seen: a Save now goes over it, and theirs leaves with the editor.
		writeAnswer = async () =>
			json(answerWith([mine("c1", "Old mine")], mine("c1", "Old mine")));
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(writeCalls.at(-1)?.body).toEqual({
			body: "Old mine",
			from: "Theirs",
			force: false,
		});
		await waitFor(() => expect(screen.queryByTestId("edit-theirs")).toBeNull());
	});

	it("Cancel on a changed edit asks first, like Escape", async () => {
		serve({ T1: { comments: [mine("c1", "Old")] } });
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		await screen.findAllByTestId("thread-comment");
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		const confirm = vi.fn(() => false);
		vi.stubGlobal("confirm", confirm);
		// Unchanged: Cancel just closes.
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(confirm).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Edit" }));
		await userEvent.type(
			screen.getByRole("textbox", { name: "Edit comment" }),
			" more",
		);
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(confirm).toHaveBeenCalledOnce();
		expect(screen.getByRole("textbox", { name: "Edit comment" })).toHaveValue(
			"Old more",
		);
	});

	it("an edit a reload left saving shows as resent from before, with Discard", async () => {
		serve({ T1: { comments: [mine("c1", "Old")] } });
		writeAnswer = () => new Promise(() => {});
		renderWith(
			<>
				<Conversation readId="r1" thread={thread()} />
				<SyncNotices />
			</>,
			{ writes: "on" },
		);
		const client = clients.at(-1) as QueryClient;
		await screen.findAllByTestId("thread-comment");
		act(() => {
			const w = threadWritesFor(client);
			w.drafts.setEdit("T1", "c1", "Old", "Mine");
			w.drafts.markSaving("c1", true);
			w.resume();
		});
		const notice = await screen.findByTestId("write-resumed");
		expect(notice).toHaveTextContent("Edit");
		expect(writeCalls[0]?.body).toEqual({
			body: "Mine",
			from: "Old",
			force: false,
		});
		await userEvent.click(
			within(notice).getByRole("button", { name: "Discard edit" }),
		);
		expect(threadWritesFor(client).drafts.edit("c1")).toBeUndefined();
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

describe("deleting a comment", () => {
	it("Delete asks first: nothing happens until it is confirmed, Cancel focused", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			serve({
				T1: { comments: [comment("c1", "rev1", "First"), mine("c2", "Oops")] },
			});
			renderWith(<Conversation readId="r1" thread={thread()} />, {
				writes: "on",
			});
			await screen.findAllByTestId("thread-comment");
			await user.click(screen.getByRole("button", { name: "Delete" }));
			const dialog = screen.getByRole("alertdialog", {
				name: "Delete this comment?",
			});
			// A reply: no note about [deleted].
			expect(dialog).not.toHaveAccessibleDescription();
			expect(
				within(dialog).getByRole("button", { name: "Cancel" }),
			).toHaveFocus();
			await act(() => vi.advanceTimersByTimeAsync(DELETE_UNDO_MS * 2));
			expect(screen.queryByTestId("comment-deleted-row")).toBeNull();
			expect(screen.getByText("Oops")).toBeInTheDocument();
			expect(writeCalls).toHaveLength(0);
			// Confirmed: the undo window starts.
			await user.click(within(dialog).getByRole("button", { name: "Delete" }));
			expect(screen.queryByRole("alertdialog")).toBeNull();
			const row = screen.getByTestId("comment-deleted-row");
			expect(within(row).getByRole("button", { name: "Undo" })).toHaveFocus();
			expect(writeCalls).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	for (const how of [
		"Cancel",
		"Escape",
		"a click on the backdrop",
		"a press elsewhere",
	] as const) {
		it(`${how} closes the confirmation, sends nothing, and Delete has the focus`, async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			try {
				const user = userEvent.setup({
					advanceTimers: vi.advanceTimersByTime,
				});
				serve({
					T1: {
						comments: [comment("c1", "rev1", "First"), mine("c2", "Oops")],
					},
				});
				renderWith(<Conversation readId="r1" thread={thread()} />, {
					writes: "on",
				});
				await screen.findAllByTestId("thread-comment");
				const del = screen.getByRole("button", { name: "Delete" });
				await user.click(del);
				const dialog = screen.getByRole("alertdialog");
				if (how === "Cancel") {
					await user.click(
						within(dialog).getByRole("button", { name: "Cancel" }),
					);
				} else if (how === "Escape") {
					await user.keyboard("{Escape}");
				} else if (how === "a click on the backdrop") {
					// A modal's backdrop click lands on the dialog itself.
					await user.click(dialog);
				} else {
					fireEvent.pointerDown(screen.getByText("First"));
				}
				expect(screen.queryByRole("alertdialog")).toBeNull();
				expect(del).toHaveFocus();
				await act(() => vi.advanceTimersByTimeAsync(DELETE_UNDO_MS * 2));
				expect(screen.queryByTestId("comment-deleted-row")).toBeNull();
				expect(screen.getByText("Oops")).toBeInTheDocument();
				expect(writeCalls).toHaveLength(0);
			} finally {
				vi.useRealTimers();
			}
		});
	}

	it("an opener followed only by the viewer's pending or sending replies: plain wording (it really goes)", async () => {
		const user = userEvent.setup();
		serve({
			T1: {
				comments: [
					mine("c1", "Mine"),
					mine("c2", "In my review", { pending: true }),
				],
			},
		});
		writeAnswer = () => new Promise(() => {});
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		await screen.findAllByTestId("thread-comment");
		const client = clients.at(-1);
		if (!client) throw new Error("no client");
		act(() => threadWritesFor(client).reply("T1", "On its way"));
		await screen.findByTestId("thread-comment-sending");
		const [del] = screen.getAllByRole("button", { name: "Delete" });
		await user.click(del as HTMLElement);
		const dialog = screen.getByRole("alertdialog", {
			name: "Delete this comment?",
		});
		expect(dialog).not.toHaveAccessibleDescription();
		expect(dialog).not.toHaveTextContent("[deleted]");
	});

	it("a drag from the dialog's text out to the backdrop doesn't cancel", async () => {
		const user = userEvent.setup();
		serve({
			T1: { comments: [comment("c1", "rev1", "First"), mine("c2", "Oops")] },
		});
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		await screen.findAllByTestId("thread-comment");
		await user.click(screen.getByRole("button", { name: "Delete" }));
		const dialog = screen.getByRole("alertdialog");
		// Pressed on the title, released on the backdrop: the click lands on
		// the dialog itself.
		fireEvent.pointerDown(within(dialog).getByText("Delete this comment?"));
		fireEvent.click(dialog);
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
		// Pressed and released on the backdrop: cancelled.
		fireEvent.pointerDown(dialog);
		fireEvent.click(dialog);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("leaving the page cancels the confirmation (no hidden modal left behind)", async () => {
		const user = userEvent.setup();
		serve({
			T1: { comments: [comment("c1", "rev1", "First"), mine("c2", "Oops")] },
		});
		let setActive: (on: boolean) => void = () => {};
		function Kept() {
			const [on, set] = useState(true);
			setActive = set;
			return (
				<PageActive value={on}>
					<Conversation readId="r1" thread={thread()} />
				</PageActive>
			);
		}
		renderWith(<Kept />, { writes: "on" });
		await screen.findAllByTestId("thread-comment");
		await user.click(screen.getByRole("button", { name: "Delete" }));
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
		act(() => setActive(false));
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(document.querySelector("dialog[open]")).toBeNull();
		// Back on the page: it doesn't reopen by itself.
		act(() => setActive(true));
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(screen.getByText("Oops")).toBeInTheDocument();
		expect(writeCalls).toHaveLength(0);
	});

	it("an opener with replies: the confirmation says it stays as [deleted]", async () => {
		const user = userEvent.setup();
		serve({
			T1: { comments: [mine("c1", "Mine"), comment("c2", "rev1", "Reply")] },
		});
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		await screen.findAllByTestId("thread-comment");
		await user.click(screen.getByRole("button", { name: "Delete" }));
		const dialog = screen.getByRole("alertdialog", {
			name: "Delete this comment?",
		});
		expect(dialog).toHaveAccessibleDescription(
			"It stays as [deleted] in the thread.",
		);
	});

	it("focus: the row takes it when the window ends only if Undo had it, and nothing scrolls", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const focus = vi.spyOn(HTMLElement.prototype, "focus");
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			serve({
				T1: {
					comments: [mine("c1", "One"), mine("c2", "Two")],
				},
			});
			writeAnswer = () => new Promise(() => {});
			renderWith(<Conversation readId="r1" thread={thread()} />, {
				writes: "on",
			});
			await screen.findAllByTestId("thread-comment");
			const [d1, d2] = screen.getAllByRole("button", { name: "Delete" });
			await confirmDelete(user, d1 as HTMLElement);
			const [row1] = screen.getAllByTestId("comment-deleted-row");
			// Undo kept the focus: the row takes it when the window ends.
			await act(() => vi.advanceTimersByTimeAsync(DELETE_UNDO_MS));
			expect(row1).toHaveFocus();
			await confirmDelete(user, d2 as HTMLElement);
			// The reviewer moves on: the row leaves the focus where it is.
			const box = screen.getByRole("textbox", { name: "Reply" });
			box.focus();
			await act(() => vi.advanceTimersByTimeAsync(DELETE_UNDO_MS));
			expect(box).toHaveFocus();
			const ours = focus.mock.contexts.filter(
				(el) =>
					el instanceof HTMLElement &&
					(el.dataset.testid === "comment-undo" ||
						el.dataset.testid === "comment-deleted-row"),
			);
			expect(ours.length).toBeGreaterThanOrEqual(3);
			for (const [i, el] of focus.mock.contexts.entries()) {
				if (!ours.includes(el)) continue;
				expect(focus.mock.calls[i]?.[0]).toEqual({ preventScroll: true });
			}
		} finally {
			focus.mockRestore();
			vi.useRealTimers();
		}
	});

	it("collapses at once to Deleted · Undo; Undo within the window sends nothing", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			serve({
				T1: { comments: [comment("c1", "rev1", "First"), mine("c2", "Oops")] },
			});
			renderWith(<Conversation readId="r1" thread={thread()} />, {
				writes: "on",
			});
			await screen.findAllByTestId("thread-comment");
			await confirmDelete(user, screen.getByRole("button", { name: "Delete" }));
			const row = screen.getByTestId("comment-deleted-row");
			expect(row).toHaveTextContent("Deleted");
			// The trash button is gone: Undo has the focus.
			expect(within(row).getByRole("button", { name: "Undo" })).toHaveFocus();
			expect(screen.queryByText("Oops")).toBeNull();
			await act(() => vi.advanceTimersByTimeAsync(DELETE_UNDO_MS - 100));
			await user.click(within(row).getByRole("button", { name: "Undo" }));
			expect(screen.getAllByTestId("thread-comment")[1]).toHaveTextContent(
				"Oops",
			);
			// And back on Delete.
			expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
			await act(() => vi.advanceTimersByTimeAsync(DELETE_UNDO_MS * 2));
			expect(writeCalls).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("after the window the delete goes, and GitHub's answer shows the thread without it", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			const first = comment("c1", "rev1", "First");
			serve({ T1: { comments: [first, mine("c2", "Oops")] } });
			writeAnswer = async () => json(answerWith([first]));
			renderWith(<Conversation readId="r1" thread={thread()} />, {
				writes: "on",
			});
			await screen.findAllByTestId("thread-comment");
			await confirmDelete(user, screen.getByRole("button", { name: "Delete" }));
			await act(() => vi.advanceTimersByTimeAsync(DELETE_UNDO_MS));
			await waitFor(() => expect(writeMethods).toEqual(["DELETE"]));
			expect(writeCalls[0]?.path).toBe("/api/threads/T1/comments/c2");
			await waitFor(() =>
				expect(screen.getAllByTestId("thread-comment")).toHaveLength(1),
			);
			expect(screen.queryByTestId("comment-deleted-row")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('an opener blanked by a delete is a normal comment: "[deleted]" as text, edited, Edit to write it back', async () => {
		const blanked = mine("c1", "[deleted]", {
			deleted: true,
			viewerCan: { update: true, delete: false },
			editedAt: "2026-01-03T10:00:00Z",
		});
		serve({ T1: { comments: [blanked, comment("c2", "rev1", "Reply")] } });
		writeAnswer = (_path, body) => {
			expect(body).toEqual({
				body: "Back again",
				from: "[deleted]",
				force: false,
			});
			const back = mine("c1", "Back again", {
				editedAt: "2026-01-03T12:00:00Z",
			});
			return Promise.resolve(
				json(answerWith([back, comment("c2", "rev1", "Reply")], back)),
			);
		};
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		const [opener] = await screen.findAllByTestId("thread-comment");
		const o = within(opener as HTMLElement);
		expect(o.getByTestId("thread-comment-body")).toHaveTextContent("[deleted]");
		expect(o.queryByTestId("comment-deleted")).toBeNull();
		expect(o.getByTestId("comment-edited")).toBeVisible();
		// Replies follow it: nothing more for Delete to do.
		expect(o.queryByRole("button", { name: "Delete" })).toBeNull();
		await userEvent.click(o.getByRole("button", { name: "Edit" }));
		const box = screen.getByRole("textbox", { name: "Edit comment" });
		expect(box).toHaveValue("[deleted]");
		await userEvent.clear(box);
		await userEvent.type(box, "Back again");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(
				within(
					screen.getAllByTestId("thread-comment")[0] as HTMLElement,
				).queryByRole("img", { name: "Saving" }),
			).toBeNull(),
		);
		expect(writeMethods).toEqual(["PATCH"]);
		expect(screen.getAllByTestId("thread-comment")[0]).toHaveTextContent(
			"Back again",
		);
	});

	it("a sole blanked opener keeps Edit and Delete", async () => {
		serve({
			T1: {
				comments: [
					mine("c1", "[deleted]", {
						deleted: true,
						viewerCan: { update: true, delete: true },
					}),
				],
			},
		});
		renderWith(<Conversation readId="r1" thread={thread()} />, {
			writes: "on",
		});
		const [opener] = await screen.findAllByTestId("thread-comment");
		const o = within(opener as HTMLElement);
		expect(o.getByTestId("thread-comment-body")).toHaveTextContent("[deleted]");
		expect(o.getByRole("button", { name: "Delete" })).toBeVisible();
		expect(o.getByRole("button", { name: "Edit" })).toBeVisible();
	});

	it("deleting sends no body and no JSON content type", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			serve({ T1: { comments: [mine("c1", "Only")] } });
			writeAnswer = async () => json({ threadId: "T1", gone: true });
			renderWith(<Conversation readId="r1" thread={thread()} />, {
				writes: "on",
			});
			await screen.findAllByTestId("thread-comment");
			await confirmDelete(user, screen.getByRole("button", { name: "Delete" }));
			await act(() => vi.advanceTimersByTimeAsync(DELETE_UNDO_MS));
			const fetchMock = vi.mocked(fetch);
			const call = fetchMock.mock.calls.find(
				([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
			);
			const init = call?.[1] as RequestInit | undefined;
			expect(init?.body).toBeUndefined();
			expect(new Headers(init?.headers).get("content-type")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("the thread's last comment deleted: the thread is gone", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			serve({ T1: { comments: [mine("c1", "Only")] } });
			writeAnswer = async () => json({ threadId: "T1", gone: true });
			renderWith(<Conversation readId="r1" thread={thread()} />, {
				writes: "on",
			});
			await screen.findAllByTestId("thread-comment");
			await confirmDelete(user, screen.getByRole("button", { name: "Delete" }));
			await act(() => vi.advanceTimersByTimeAsync(DELETE_UNDO_MS + FADE_MS));
			expect(
				await screen.findByTestId("thread-body-unavailable"),
			).toHaveTextContent("Deleted on GitHub");
		} finally {
			vi.useRealTimers();
		}
	});
});
