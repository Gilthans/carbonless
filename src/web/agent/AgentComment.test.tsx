// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentMessage,
	AgentPlacementsAnswer,
	AgentThread,
} from "../../shared/agent";
import type {
	NewThreadAnswer,
	PrOverview,
	SessionInfo,
} from "../../shared/types";
import { overviewQuery, sessionQuery } from "../api";
import { AgentComment } from "./AgentComment";
import { LINES_GONE, resetAgentComments, THREAD_GONE } from "./agentComments";
import { agentThreadsQuery } from "./api";

const HEAD = "b".repeat(40);
const OLD = "a".repeat(40);
const T = "01k9e6m2q8x4v7c3n5b0h1j2t6";
const M = "01k9e6m2q8x4v7c3n5b0h1j2t7";
const CLIENT_ID = `ag.${T}.${M}.0`;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

let calls: { method: string; path: string; body: unknown }[];
/** Answers a request; a GET's placements by default. */
let answer: (method: string, path: string, body: unknown) => Promise<Response>;
let placements: () => Promise<Response>;

beforeEach(() => {
	calls = [];
	placements = async () => json({ revision: "r", threads: [] });
	answer = () => new Promise(() => {});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input, "http://crb");
			const method = init?.method ?? "GET";
			const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
			calls.push({ method, path: url.pathname + url.search, body });
			if (method === "GET" && url.pathname.endsWith("/agent/placements")) {
				return placements();
			}
			return answer(method, url.pathname, body);
		}),
	);
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	resetAgentComments();
	localStorage.clear();
	vi.unstubAllGlobals();
});

const message = (more: Partial<AgentMessage> = {}): AgentMessage => ({
	id: M,
	by: "ai",
	at: "2026-11-16T10:01:00.000Z",
	text: "```comment\nWhy one retry?\n```",
	...more,
});

const lineThread = (more: Partial<AgentThread> = {}): AgentThread => ({
	id: T,
	anchor: {
		subject: "line",
		path: "src/x.ts",
		commit: HEAD,
		side: "RIGHT",
		line: 44,
		startSide: "RIGHT",
		startLine: 41,
	},
	openedBy: "human",
	at: "2026-11-16T10:00:00.000Z",
	messages: [message()],
	resolved: false,
	waiting: false,
	unread: false,
	...more,
});

function show(
	text: string,
	thread: AgentThread = lineThread(),
	msg: AgentMessage = thread.messages[0] ?? message(),
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(overviewQuery.queryKey, {
		readId: "r1",
		writes: "on",
		pendingReview: null,
	} as PrOverview);
	client.setQueryData(sessionQuery.queryKey, {
		viewer: "octo",
		snapshotHead: HEAD,
		pr: { url: "https://github.com/o/r/pull/1" },
	} as unknown as SessionInfo);
	client.setQueryData(agentThreadsQuery.queryKey, { threads: [thread] });
	const view = render(
		<QueryClientProvider client={client}>
			<AgentComment text={text} block={0} at={{ thread, message: msg }} />
		</QueryClientProvider>,
	);
	return { client, view };
}

/** The box, in Write (it opens in Preview: switched first). */
const box = () => {
	const write = screen.queryByRole("button", { name: "Write" });
	if (write?.getAttribute("aria-pressed") === "false") fireEvent.click(write);
	return screen.getByRole("textbox", { name: "Review comment" });
};
const button = () => screen.getByRole("button", { name: "Add review comment" });

const newThreadAnswer = (body: string): NewThreadAnswer =>
	({
		thread: { id: "PRRT_9", path: "src/x.ts" },
		comments: {
			threadId: "PRRT_9",
			comments: [{ id: "PRRC_9", body, publishedAt: "2026-11-16T10:05:00Z" }],
		},
		url: "https://github.com/o/r/pull/1#discussion_r9",
	}) as unknown as NewThreadAnswer;

describe("AgentComment: the box", () => {
	it("opens in Preview: the agent's markdown rendered, Write shows the raw text", async () => {
		const user = userEvent.setup();
		show("**Why** one retry?\n\n- a\n- b");
		const preview = screen.getByTestId("comment-preview");
		expect(within(preview).getByText("Why").tagName).toBe("STRONG");
		expect(within(preview).getAllByRole("listitem")).toHaveLength(2);
		expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(
			screen.queryByRole("textbox", { name: "Review comment" }),
		).toBeNull();
		await user.click(screen.getByRole("button", { name: "Write" }));
		const text = screen.getByRole("textbox", { name: "Review comment" });
		expect(text).toHaveProperty("value", "**Why** one retry?\n\n- a\n- b");
		expect(text).toHaveFocus();
		await user.type(text, "\n- c");
		await user.click(screen.getByRole("button", { name: "Preview" }));
		expect(
			within(screen.getByTestId("comment-preview")).getAllByRole("listitem"),
		).toHaveLength(3);
	});

	it("posts from Preview: the text as edited", async () => {
		const user = userEvent.setup();
		answer = () => new Promise(() => {});
		show("Why one retry?");
		await user.type(box(), " Really?");
		await user.click(screen.getByRole("button", { name: "Preview" }));
		await user.click(button());
		const post = await vi.waitFor(() => {
			const p = calls.find((c) => c.path.endsWith("/threads"));
			if (!p) throw new Error("not posted yet");
			return p;
		});
		expect(post.body).toMatchObject({ body: "Why one retry? Really?" });
	});

	it("shows the agent's raw text as the textarea's value, never as HTML", () => {
		const hostile = '<img src=x onerror="window.pwned = 5">';
		const { view } = show(hostile);
		// Preview: sanitized (no handler, no http image).
		expect(screen.getByTestId("comment-preview").innerHTML).not.toMatch(
			/onerror/,
		);
		expect(view.container.querySelector("img")).toBeNull();
		expect(box()).toHaveProperty("value", hostile);
		expect(view.container.querySelector("img")).toBeNull();
		expect((window as { pwned?: number }).pwned).toBeUndefined();
	});

	it("keeps an edit as a draft across a reload; the reset icon shows only once it differs", async () => {
		const user = userEvent.setup();
		show("Why one retry?");
		expect(
			screen.queryByRole("button", { name: "Back to the agent's text" }),
		).toBeNull();
		await user.type(box(), " Really?");
		expect(box()).toHaveProperty("value", "Why one retry? Really?");
		cleanup();
		resetAgentComments();
		show("Why one retry?");
		expect(box()).toHaveProperty("value", "Why one retry? Really?");
		await user.click(
			screen.getByRole("button", { name: "Back to the agent's text" }),
		);
		expect(box()).toHaveProperty("value", "Why one retry?");
		expect(
			screen.queryByRole("button", { name: "Back to the agent's text" }),
		).toBeNull();
	});

	it("an empty box can't be sent", async () => {
		const user = userEvent.setup();
		show("x");
		await user.clear(box());
		expect(button()).toHaveAttribute("aria-disabled", "true");
		await user.click(button());
		expect(calls.filter((c) => c.method === "POST")).toEqual([]);
	});
});

describe("AgentComment: posting", () => {
	it("posts the box's text as a new thread on the conversation's lines, as a retry under the block's id; then Posted with a link", async () => {
		const user = userEvent.setup();
		answer = async (_m, path, body) =>
			path.endsWith("/threads")
				? json(newThreadAnswer((body as { body: string }).body))
				: json(
						lineThread({
							messages: [
								message({
									posted: [
										{
											block: 0,
											url: "https://github.com/o/r/pull/1#discussion_r9",
											at: "2026-11-16T10:05:00.000Z",
											text: "Why one retry? Really?",
										},
									],
								}),
							],
						}),
					);
		show("Why one retry?");
		await user.type(box(), " Really?");
		await user.click(button());
		const post = await vi.waitFor(() => {
			const p = calls.find((c) => c.path.endsWith("/threads"));
			if (!p) throw new Error("not posted yet");
			return p;
		});
		expect(post.body).toMatchObject({
			clientId: CLIENT_ID,
			body: "Why one retry? Really?",
			retry: true,
			path: "src/x.ts",
			commit: HEAD,
			subject: "line",
			startLine: 41,
			line: 44,
			side: "RIGHT",
		});
		const posted = await screen.findByText("Posted");
		expect(posted).toBeTruthy();
		const link = screen.getByRole("link", { name: "Open on GitHub" });
		expect(link.getAttribute("href")).toBe(
			"https://github.com/o/r/pull/1#discussion_r9",
		);
		expect(
			calls.find((c) => c.path.endsWith(`/agent/threads/${T}/posted`))?.body,
		).toEqual({
			message: M,
			block: 0,
			github: {
				thread: "PRRT_9",
				comment: "PRRC_9",
				url: "https://github.com/o/r/pull/1#discussion_r9",
			},
			text: "Why one retry? Really?",
		});
		expect(screen.queryByRole("textbox")).toBeNull();
		// One press, one post.
		expect(calls.filter((c) => c.path.endsWith("/threads"))).toHaveLength(1);
	});

	it("while sending: a spinner in the button, the box read-only; Posted only after GitHub's answer (principle 8)", async () => {
		const user = userEvent.setup();
		let release: (r: Response) => void = () => {};
		answer = (_m, path) =>
			path.endsWith("/threads")
				? new Promise((r) => {
						release = r;
					})
				: Promise.reject(new Error("record failed"));
		show("Why?");
		await user.click(button());
		expect(button()).toHaveAttribute("aria-busy", "true");
		expect(button()).toHaveAttribute("aria-disabled", "true");
		expect(box()).toHaveProperty("readOnly", true);
		expect(screen.queryByText("Posted")).toBeNull();
		await act(async () => release(json(newThreadAnswer("Why?"))));
		// The record failed: Posted all the same, for this page.
		expect(await screen.findByText("Posted")).toBeTruthy();
	});

	it("a refusal keeps the text, says why in red, and the button works again; nothing resends it", async () => {
		const user = userEvent.setup();
		answer = async () =>
			json(
				{
					error: "GitHub refused: the line is outside the diff",
					code: "invalid",
				},
				400,
			);
		show("Why?");
		await user.type(box(), "!");
		await user.click(button());
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("the line is outside the diff");
		expect(box()).toHaveProperty("value", "Why?!");
		expect(button()).not.toHaveAttribute("aria-disabled", "true");
		// A reload resends nothing: a refusal is never retried by itself.
		cleanup();
		resetAgentComments();
		calls = [];
		show("Why?");
		await act(async () => {});
		expect(calls.filter((c) => c.method === "POST")).toEqual([]);
	});

	it("a lost record: after a reload the box shows Posted from what the browser kept, and the record is written then; nothing posts again", async () => {
		const user = userEvent.setup();
		let records = 0;
		answer = async (_m, path) => {
			if (path.endsWith("/threads"))
				return json(newThreadAnswer("Why? Edited"));
			records++;
			return records === 1 ? json({ error: "down" }, 500) : json(lineThread());
		};
		show("Why?");
		await user.type(box(), " Edited");
		await user.click(button());
		await screen.findByText("Posted");
		// Reloaded: the record never landed; the post is still Posted, edit and all.
		cleanup();
		resetAgentComments();
		show("Why?");
		expect(screen.getByText("Posted")).toBeTruthy();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(document.body.textContent).toContain("Why? Edited");
		await vi.waitFor(() => expect(records).toBe(2));
		const record = calls.filter((c) => c.path.endsWith("/posted"));
		expect(record[1]?.body).toMatchObject({ text: "Why? Edited", block: 0 });
		expect(calls.filter((c) => c.path.endsWith("/threads"))).toHaveLength(1);
		// Recorded: the browser's copy goes.
		await vi.waitFor(() =>
			expect(localStorage.getItem(`crb:agent-comment:${CLIENT_ID}`)).toBeNull(),
		);
	});

	it("a second press on another device (nothing kept) goes as a retry under the same id (the server finds it: never twice)", async () => {
		const user = userEvent.setup();
		answer = async (_m, path) =>
			path.endsWith("/threads")
				? json(newThreadAnswer("Why?"))
				: json({ error: "down" }, 500);
		show("Why?");
		await user.click(button());
		await screen.findByText("Posted");
		// Another device: the record never landed and nothing is kept here.
		cleanup();
		resetAgentComments();
		localStorage.clear();
		show("Why?");
		await user.click(button());
		await screen.findByText("Posted");
		const posts = calls.filter((c) => c.path.endsWith("/threads"));
		expect(posts).toHaveLength(2);
		for (const p of posts) {
			expect(p.body).toMatchObject({ clientId: CLIENT_ID, retry: true });
		}
	});

	it("a press cut short by a reload (it may have landed) is resent once on the next load, as it was sent", async () => {
		const user = userEvent.setup();
		answer = async () => json({ error: "unreachable" }, 502);
		show("Why?");
		await user.type(box(), "!");
		await user.click(button());
		expect((await screen.findByRole("alert")).textContent).toMatch(
			/may have landed/i,
		);
		cleanup();
		resetAgentComments();
		calls = [];
		answer = async (_m, path) =>
			path.endsWith("/threads")
				? json(newThreadAnswer("Why?!"))
				: json({ error: "down" }, 500);
		show("Why?");
		await screen.findByText("Posted");
		const posts = calls.filter((c) => c.path.endsWith("/threads"));
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ body: "Why?!", retry: true });
	});

	it("a conversation on a GitHub thread replies to it, with the comments known when the agent wrote", async () => {
		const user = userEvent.setup();
		const thread = lineThread({
			anchor: {
				subject: "thread",
				thread: "PRRT_1",
				path: "src/x.ts",
				commit: OLD,
			},
		});
		answer = async (_m, path) =>
			path.includes("/replies")
				? json({
						threadId: "PRRT_1",
						comment: { id: "PRRC_3" },
						comments: { threadId: "PRRT_1", comments: [] },
						url: "https://github.com/o/r/pull/1#discussion_r3",
					})
				: json({ error: "down" }, 500);
		const { client } = show("Thanks!", thread);
		client.setQueryData(["comments", "r1", "PRRT_1"], {
			threadId: "PRRT_1",
			comments: [
				{ id: "PRRC_1", publishedAt: "2026-11-16T09:00:00Z" },
				{ id: "PRRC_2", publishedAt: "2026-11-16T10:30:00Z" },
			],
		});
		expect(screen.getByText("Reply")).toBeTruthy();
		await user.click(button());
		await screen.findByText("Posted");
		const post = calls.find((c) => c.path.includes("/replies"));
		expect(post?.path).toContain("/threads/PRRT_1/replies");
		expect(post?.body).toMatchObject({
			body: "Thanks!",
			clientId: CLIENT_ID,
			retry: true,
			knownCommentIds: ["PRRC_1"],
		});
	});

	it("in doubt, the text is fixed: the box can't be edited, a press resends what was sent, Posted shows GitHub's text", async () => {
		const user = userEvent.setup();
		const thread = lineThread({
			anchor: {
				subject: "thread",
				thread: "PRRT_1",
				path: "src/x.ts",
				commit: OLD,
			},
		});
		let replies = 0;
		answer = async (_m, path, body) => {
			if (path.endsWith("/posted")) return json(thread);
			replies++;
			return replies === 1
				? json({ error: "unreachable" }, 502)
				: json({
						threadId: "PRRT_1",
						comment: { id: "PRRC_3", body: (body as { body: string }).body },
						comments: { threadId: "PRRT_1", comments: [] },
						url: "https://github.com/o/r/pull/1#discussion_r3",
					});
		};
		const { client } = show("Thanks!", thread);
		client.setQueryData(["comments", "r1", "PRRT_1"], {
			threadId: "PRRT_1",
			comments: [{ id: "PRRC_1", publishedAt: "2026-11-16T09:00:00Z" }],
		});
		await user.click(button());
		expect((await screen.findByRole("alert")).textContent).toMatch(
			/may have landed/i,
		);
		expect(box()).toHaveProperty("readOnly", true);
		await user.type(box(), " typo fixed");
		expect(box()).toHaveProperty("value", "Thanks!");
		await user.click(button());
		await screen.findByText("Posted");
		const sent = calls.filter((c) => c.path.includes("/replies"));
		expect(sent.map((c) => (c.body as { body: string }).body)).toEqual([
			"Thanks!",
			"Thanks!",
		]);
		expect(document.body.textContent).toContain("Thanks!");
		expect(document.body.textContent).not.toContain("typo fixed");
	});

	it("a reply whose thread comments can't be read is refused (nothing was sent), never 'may have landed'", async () => {
		const user = userEvent.setup();
		const thread = lineThread({
			anchor: {
				subject: "thread",
				thread: "PRRT_1",
				path: "src/x.ts",
				commit: OLD,
			},
		});
		const { client } = show("Thanks!", thread);
		// The thread's comments came, but all after the agent wrote (clocks apart).
		client.setQueryData(["comments", "r1", "PRRT_1"], {
			threadId: "PRRT_1",
			comments: [{ id: "PRRC_1", publishedAt: "2026-11-16T11:00:00Z" }],
		});
		await user.click(button());
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Couldn't read the thread's comments");
		expect(alert.textContent).not.toMatch(/may have landed/i);
		expect(alert.className).toContain("text-bad");
		expect(calls.filter((c) => c.path.includes("/replies"))).toEqual([]);
		expect(button()).not.toHaveAttribute("aria-disabled", "true");
	});

	it("a deleted GitHub thread: the button is off and says so", () => {
		show(
			"x",
			lineThread({
				anchor: {
					subject: "thread",
					thread: "PRRT_1",
					path: "src/x.ts",
					commit: OLD,
				},
				orphaned: true,
			}),
		);
		expect(button()).toHaveAttribute("aria-disabled", "true");
		expect(button()).toHaveAccessibleDescription(THREAD_GONE);
	});
});

describe("AgentComment: placement", () => {
	const old = lineThread({
		anchor: {
			subject: "line",
			path: "src/x.ts",
			commit: OLD,
			side: "RIGHT",
			line: 44,
			startSide: "RIGHT",
			startLine: 41,
		},
	});

	it("while the placement loads, a spinner on the button, never Lines gone (principle 8)", async () => {
		let release: (r: Response) => void = () => {};
		placements = () =>
			new Promise((r) => {
				release = r;
			});
		show("x", old);
		expect(button()).toHaveAttribute("aria-busy", "true");
		expect(button()).toHaveAttribute("aria-disabled", "true");
		expect(document.body.textContent).not.toContain(LINES_GONE);
		await act(async () =>
			release(
				json({
					revision: "r",
					threads: [
						{
							id: T,
							placement: {
								kind: "unplaced",
								fate: "deleted",
								path: "src/x.ts",
								nearest: null,
							},
						},
					],
				} satisfies AgentPlacementsAnswer),
			),
		);
		await vi.waitFor(() =>
			expect(button()).not.toHaveAttribute("aria-busy", "true"),
		);
		expect(button()).toHaveAttribute("aria-disabled", "true");
		expect(button()).toHaveAccessibleDescription(LINES_GONE);
	});

	it("a conversation newer than the placements: asked once more, pending meanwhile, then placed", async () => {
		let asked = 0;
		placements = async () => {
			asked++;
			return json({
				revision: "r",
				threads:
					asked === 1
						? []
						: [
								{
									id: T,
									placement: {
										kind: "placed",
										changed: false,
										anchor: {
											path: "src/x.ts",
											side: "RIGHT",
											startSide: "RIGHT",
											startLine: 41,
											line: 44,
										},
									},
								},
							],
			} satisfies AgentPlacementsAnswer);
		};
		show("x", old);
		await vi.waitFor(() => expect(asked).toBe(2));
		await vi.waitFor(() =>
			expect(button()).not.toHaveAttribute("aria-disabled", "true"),
		);
		expect(document.body.textContent).not.toContain("Couldn't trace");
	});

	it("lines changed: posts on the traced lines and shows the changed icon", async () => {
		placements = async () =>
			json({
				revision: "r",
				threads: [
					{
						id: T,
						placement: {
							kind: "changed",
							anchor: {
								path: "src/x.ts",
								side: "RIGHT",
								startSide: "RIGHT",
								startLine: 47,
								line: 50,
							},
							old: { side: "RIGHT", startLine: 41, line: 44, text: [] },
							now: [],
						},
					},
				],
			} satisfies AgentPlacementsAnswer);
		show("x", old);
		expect(
			await screen.findByRole("img", {
				name: "The code here changed since the agent wrote this",
			}),
		).toBeTruthy();
		expect(screen.getByText("L47–50")).toBeTruthy();
		expect(button()).not.toHaveAttribute("aria-disabled", "true");
	});
});

describe("AgentComment: kept in the browser", () => {
	const KEY = `crb:agent-comment:${CLIENT_ID}`;

	it("another tab's press fixes the text here too (a storage event)", async () => {
		show("Why?");
		expect(box()).toHaveProperty("readOnly", false);
		localStorage.setItem(
			KEY,
			JSON.stringify({
				sending: {
					attemptedAt: "2026-11-16T10:02:00.000Z",
					body: "Sent there",
				},
			}),
		);
		act(() => {
			window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
		});
		expect(box()).toHaveProperty("value", "Sent there");
		expect(box()).toHaveProperty("readOnly", true);
	});

	it("a press left in doubt where the block can't post now says it may have landed", () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({
				sending: {
					attemptedAt: "2026-11-16T10:02:00.000Z",
					body: "Sent before",
				},
			}),
		);
		show(
			"x",
			lineThread({
				anchor: {
					subject: "thread",
					thread: "PRRT_1",
					path: "src/x.ts",
					commit: OLD,
				},
				orphaned: true,
			}),
		);
		expect(box()).toHaveProperty("value", "Sent before");
		expect(screen.getByRole("alert").textContent).toMatch(/may have landed/i);
		expect(button()).toHaveAccessibleDescription(THREAD_GONE);
		expect(calls.filter((c) => c.method === "POST")).toEqual([]);
	});

	it("a kept post whose record is in the agent ref is dropped from the browser", async () => {
		const posted = {
			block: 0,
			url: "https://github.com/o/r/pull/1#discussion_r9",
			at: "2026-11-16T10:05:00.000Z",
			text: "Why?",
		};
		localStorage.setItem(
			KEY,
			JSON.stringify({
				posted: {
					...posted,
					github: { thread: "PRRT_9", comment: "PRRC_9", url: posted.url },
				},
			}),
		);
		const msg = message({ posted: [posted] });
		show("x", lineThread({ messages: [msg] }), msg);
		expect(screen.getByText("Posted")).toBeTruthy();
		await vi.waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
		expect(calls.filter((c) => c.method === "POST")).toEqual([]);
	});
});

describe("AgentComment: where nothing posts", () => {
	it("a conversation of any other kind (the whole review's) shows the read-only quote and Copy, no box", () => {
		const review = lineThread({
			anchor: { subject: "review" },
		});
		show("Ask the author why", review);
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Add review comment" }),
		).toBeNull();
		expect(screen.getByRole("button", { name: "Copy comment" })).toBeTruthy();
		expect(document.body.textContent).toContain("Ask the author why");
	});
});

describe("AgentComment: posted", () => {
	it("a link that isn't http(s) is never rendered", () => {
		const posted = message({
			posted: [
				{
					block: 0,
					url: "javascript:alert(1)",
					at: "2026-11-16T10:05:00.000Z",
					text: "x",
				},
			],
		});
		show("x", lineThread({ messages: [posted] }), posted);
		expect(screen.getByText("Posted")).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Open on GitHub" })).toBeNull();
	});

	it("folds to Posted, the text rendered as GitHub comments are (sanitized)", () => {
		const posted = message({
			posted: [
				{
					block: 0,
					url: "https://github.com/o/r/pull/1#discussion_r9",
					at: "2026-11-16T10:05:00.000Z",
					text: 'Look **here** <img src=x onerror="window.pwned = 6">',
				},
			],
		});
		const { view } = show("x", lineThread({ messages: [posted] }), posted);
		expect(screen.getByText("Posted")).toBeTruthy();
		expect(screen.queryByRole("textbox")).toBeNull();
		const html = view.container.innerHTML;
		expect(
			view.container.querySelector(".markdown-body strong")?.textContent,
		).toBe("here");
		expect(html).not.toMatch(/onerror/i);
		expect((window as { pwned?: number }).pwned).toBeUndefined();
	});
});
