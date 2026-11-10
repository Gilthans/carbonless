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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus } from "../../shared/agent";
import type { PrOverview } from "../../shared/types";
import { overviewQuery } from "../api";
import { agentStatusQuery } from "./api";
import { approveTip, JoinBar, withJoinPrefix } from "./JoinBar";

const status = (more: Partial<AgentStatus> = {}): AgentStatus => ({
	state: "ready",
	configured: true,
	agent: { name: "Claude Agent", version: "0.100.0" },
	since: "2026-11-10T10:00:00Z",
	waiting: 0,
	joinRequest: {
		id: "01req",
		name: "carbonless · car-81",
		machine: "devbox",
		harness: "Claude Code 2.1",
		at: "2026-11-10T10:01:00Z",
	},
	...more,
});

let visibility: DocumentVisibilityState = "visible";
const setVisibility = (v: DocumentVisibilityState) => {
	visibility = v;
	document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
	visibility = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visibility,
	);
	document.title = "Fix it #7 · carbonless";
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function show(s: AgentStatus | undefined, writes = "on") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, enabled: false } },
	});
	if (s) client.setQueryData(agentStatusQuery.queryKey, s);
	client.setQueryData(overviewQuery.queryKey, { writes } as PrOverview);
	render(
		<QueryClientProvider client={client}>
			<JoinBar />
		</QueryClientProvider>,
	);
	return { client, user: userEvent.setup() };
}

/**
 * A fetch whose writes wait for `release`, one per call; a status read
 * again (once one lands) answers `after`. `posts()`: the writes sent.
 */
function heldPosts(after: AgentStatus = status({ joinRequest: undefined })) {
	const releases: Array<(status: number, body: unknown) => void> = [];
	const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
		init?.method === "POST"
			? new Promise<Response>((done) => {
					releases.push((status, body) =>
						done(new Response(JSON.stringify(body), { status })),
					);
				})
			: Promise.resolve(new Response(JSON.stringify(after))),
	);
	vi.stubGlobal("fetch", fetchMock);
	return {
		fetchMock,
		posts: () =>
			fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
		release: (status: number, body: unknown) =>
			act(async () => releases.shift()?.(status, body)),
	};
}

describe("the join request bar", () => {
	it("shows the session's name and machine, its harness in the plug's name", () => {
		show(status());
		const bar = screen.getByRole("region", { name: "Join request" });
		expect(within(bar).getByTestId("join-bar-name")).toHaveTextContent(
			"carbonless · car-81",
		);
		expect(within(bar).getByTestId("join-bar-machine")).toHaveTextContent(
			"devbox",
		);
		expect(
			within(bar).getByRole("img", {
				name: "Asks to join: carbonless · car-81 · devbox · Claude Code 2.1",
			}),
		).toBeInTheDocument();
		expect(
			within(bar).getByRole("button", { name: "Deny" }),
		).toBeInTheDocument();
		expect(
			within(bar).getByRole("button", { name: "Approve" }),
		).toBeInTheDocument();
	});

	it("isn't there without a request, nor on a review with no agent", () => {
		show(status({ joinRequest: undefined }));
		expect(screen.queryByTestId("join-bar")).toBeNull();
		cleanup();
		show(status(), "viewer");
		expect(screen.queryByTestId("join-bar")).toBeNull();
	});

	it("a session's name with markup shows as text", () => {
		const name = '<img src=x onerror="alert(1)">';
		show(
			status({
				joinRequest: {
					id: "01req",
					name,
					machine: "<b>m</b>",
					at: "2026-11-10T10:01:00Z",
				},
			}),
		);
		const bar = screen.getByTestId("join-bar");
		expect(bar.querySelector("img, b b")).toBeNull();
		expect(screen.getByTestId("join-bar-name")).toHaveTextContent(name);
		expect(screen.getByTestId("join-bar-machine")).toHaveTextContent(
			"<b>m</b>",
		);
	});

	it("Approve posts once per press, then the bar goes", async () => {
		const posts = heldPosts();
		const { user } = show(status());
		const approve = screen.getByRole("button", { name: "Approve" });
		await user.click(approve);
		// Pressed again while the first is under way: nothing more.
		await user.click(approve);
		await user.click(screen.getByRole("button", { name: "Deny" }));
		expect(posts.posts()).toHaveLength(1);
		expect(posts.fetchMock).toHaveBeenCalledWith(
			"/api/agent/join/01req",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ approve: true }),
			}),
		);
		expect(screen.getByRole("status", { name: "Approving" })).toBeVisible();
		await posts.release(200, { ok: true });
		await waitFor(() => expect(screen.queryByTestId("join-bar")).toBeNull());
		expect(posts.posts()).toHaveLength(1);
	});

	it("Deny answered first in another tab (409): the bar goes", async () => {
		const posts = heldPosts();
		const { user } = show(status());
		await user.click(screen.getByRole("button", { name: "Deny" }));
		expect(posts.fetchMock).toHaveBeenCalledWith(
			"/api/agent/join/01req",
			expect.objectContaining({ body: JSON.stringify({ approve: false }) }),
		);
		await posts.release(409, { error: "answered", code: "stale-join" });
		await waitFor(() => expect(screen.queryByTestId("join-bar")).toBeNull());
	});

	it("a newer request (the first replaced) shows again after one was answered", async () => {
		const posts = heldPosts();
		const { client, user } = show(status());
		await user.click(screen.getByRole("button", { name: "Deny" }));
		await posts.release(200, { ok: true });
		await waitFor(() => expect(screen.queryByTestId("join-bar")).toBeNull());
		await act(async () =>
			client.setQueryData(
				agentStatusQuery.queryKey,
				status({
					joinRequest: {
						id: "01new",
						name: "other",
						machine: "laptop",
						at: "2026-11-10T10:02:00Z",
					},
				}),
			),
		);
		expect(await screen.findByTestId("join-bar-name")).toHaveTextContent(
			"other",
		);
	});

	it("Approve refused because another server holds the review: says which, until dismissed", async () => {
		const posts = heldPosts();
		const { user } = show(status());
		await user.click(screen.getByRole("button", { name: "Approve" }));
		await posts.release(409, {
			error: "Another carbonless server (port 4748) holds this review's agent",
			code: "elsewhere",
			port: 4748,
		});
		const alert = await screen.findByTestId("join-bar-error");
		expect(alert).toHaveTextContent("Answered by the server on :4748");
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByTestId("join-bar")).toBeNull();
	});

	it("a failed post (crb gone) keeps the bar to press again", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("network");
			}),
		);
		const { user } = show(status());
		await user.click(screen.getByRole("button", { name: "Approve" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not reach carbonless",
		);
		expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
	});
});

describe("Approve's tooltip", () => {
	it("says what it replaces: a running ACP agent, or a joined session", () => {
		expect(approveTip(status())).toBe("Replaces Claude Agent");
		expect(approveTip(status({ state: "busy" }))).toBe("Replaces Claude Agent");
		expect(approveTip(status({ state: "off", agent: undefined }))).toBe(
			"Approve",
		);
		expect(approveTip(status({ state: "error" }))).toBe("Approve");
		expect(
			approveTip(
				status({
					via: "mcp",
					joined: { name: "old one", machine: "m", since: "x" },
				}),
			),
		).toBe("Replaces old one");
	});
});

describe("the title prefix", () => {
	it("is added and taken off once, never twice", () => {
		expect(withJoinPrefix("T", true)).toBe("⏚ T");
		expect(withJoinPrefix("⏚ T", true)).toBe("⏚ T");
		expect(withJoinPrefix("⏚ T", false)).toBe("T");
		expect(withJoinPrefix("T", false)).toBe("T");
	});

	it("shows while a request waits and the tab is hidden", async () => {
		const { client } = show(status());
		expect(document.title).toBe("Fix it #7 · carbonless");
		act(() => setVisibility("hidden"));
		expect(document.title).toBe("⏚ Fix it #7 · carbonless");
		act(() => setVisibility("visible"));
		expect(document.title).toBe("Fix it #7 · carbonless");
		act(() => setVisibility("hidden"));
		// Answered (in another tab): off, though still hidden.
		await act(async () =>
			client.setQueryData(
				agentStatusQuery.queryKey,
				status({ joinRequest: undefined }),
			),
		);
		await waitFor(() => expect(document.title).toBe("Fix it #7 · carbonless"));
	});

	it("shows when a request reaches a tab already hidden", async () => {
		act(() => setVisibility("hidden"));
		const { client } = show(status({ joinRequest: undefined }));
		expect(document.title).toBe("Fix it #7 · carbonless");
		await act(async () =>
			client.setQueryData(agentStatusQuery.queryKey, status()),
		);
		await waitFor(() =>
			expect(document.title).toBe("⏚ Fix it #7 · carbonless"),
		);
	});
});
