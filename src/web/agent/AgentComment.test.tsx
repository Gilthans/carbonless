// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
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

const box = () => screen.getByRole("textbox", { name: "Review comment" });
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
	it("shows the agent's raw text as the textarea's value, never as HTML", () => {
		const hostile = '<img src=x onerror="window.pwned = 5">';
		const { view } = show(hostile);
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

	it("a second press after a reload goes as a retry under the same id (the server finds it: never twice)", async () => {
		const user = userEvent.setup();
		answer = async (_m, path) =>
			path.endsWith("/threads")
				? json(newThreadAnswer("Why?"))
				: json({ error: "down" }, 500);
		show("Why?");
		await user.click(button());
		await screen.findByText("Posted");
		// Reloaded: the record never landed, so the box is back.
		cleanup();
		resetAgentComments();
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

describe("AgentComment: posted", () => {
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
