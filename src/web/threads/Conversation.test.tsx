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
	ReviewThread,
	ThreadComment,
	ThreadComments,
} from "../../shared/types";
import { showCommentsOf } from "../api";
import { Conversation } from "./Conversation";
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
	commentCount: 3,
	hasReply: true,
	outdated: false,
	resolved: false,
	code: null,
	anchor: null,
	attention: [],
	yourTurn: false,
	viewerCan: { reply: false, resolve: false, unresolve: false },
	commit: "",
	subject: "line",
	...more,
});

/** Answers a comments request; each test sets its own. */
let answer: (ids: string[]) => Promise<Response>;
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
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			const url = new URL(input, "http://crb");
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

function renderWith(node: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	clients.push(client);
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
