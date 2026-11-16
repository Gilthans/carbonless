// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAnchor, AgentThread } from "../../shared/agent";
import type { PrOverview, SessionInfo } from "../../shared/types";
import { overviewQuery, sessionQuery } from "../api";
import {
	getComposers,
	newThreadItems,
	resetComposers,
	targetOf,
} from "../threads/newThreads";
import { AgentThreadCard } from "./AgentThreadCard";
import { agentCommentAvailable } from "./agentComment";
import { resetAgentWrites } from "./agentWrites";
import { SendViewProvider } from "./threadAgent";

const HEAD = "h".repeat(40);
const line: AgentAnchor = {
	subject: "line",
	path: "src/math.js",
	commit: HEAD,
	side: "RIGHT",
	line: 3,
	startSide: "RIGHT",
	startLine: 2,
	startCol: 4,
	endCol: 9,
};

const thread = (more: Partial<AgentThread> = {}): AgentThread => ({
	id: "01k9e6m2q8x4v7c3n5b0h1j2t6",
	anchor: line,
	openedBy: "human",
	at: "2026-11-07T10:00:00Z",
	messages: [
		{ id: "m1", by: "human", at: "2026-11-07T10:00:00Z", text: "Why?" },
	],
	resolved: false,
	waiting: false,
	unread: false,
	...more,
});

const on = {
	writes: "on" as const,
	commentLeft: true,
	right: HEAD,
	readOnly: false,
};

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200 })),
	);
});
afterEach(() => {
	cleanup();
	resetComposers();
	resetAgentWrites();
	vi.unstubAllGlobals();
});

function show(
	t: AgentThread,
	opts: {
		writes?: PrOverview["writes"];
		commentLeft?: boolean;
		patchsets?: number[];
		wrap?: (n: ReactNode) => ReactNode;
	} = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, enabled: false } },
	});
	client.setQueryData(overviewQuery.queryKey, {
		writes: opts.writes ?? "on",
		commentLeft: opts.commentLeft ?? true,
	} as PrOverview);
	client.setQueryData(sessionQuery.queryKey, {
		viewer: "dan",
		snapshotHead: HEAD,
		patchsets: (opts.patchsets ?? []).map((n) => ({
			number: n,
			head: n === (opts.patchsets ?? []).at(-1) ? HEAD : `${n}`.repeat(40),
			mergeBase: "b".repeat(40),
		})),
	} as unknown as SessionInfo);
	const card = <AgentThreadCard thread={t} status={undefined} />;
	return render(
		<QueryClientProvider client={client}>
			{opts.wrap ? opts.wrap(card) : card}
		</QueryClientProvider>,
	);
}

describe("agentCommentAvailable", () => {
	it("is the Comment action's availability, plus the anchor's commit against the viewed head", () => {
		expect(agentCommentAvailable(line, on)).toBe(true);
		expect(
			agentCommentAvailable({ subject: "file", path: "a", commit: HEAD }, on),
		).toBe(true);
		expect(agentCommentAvailable(line, { ...on, writes: "as-of" })).toMatch(
			/cutoff/,
		);
		expect(agentCommentAvailable(line, { ...on, writes: "viewer" })).toMatch(
			/someone else/,
		);
		expect(agentCommentAvailable(line, { ...on, readOnly: true })).toMatch(
			/earlier patch set/,
		);
		expect(
			agentCommentAvailable(line, { ...on, right: "o".repeat(40) }),
		).toMatch(/earlier version/);
		expect(agentCommentAvailable(line, { ...on, right: undefined })).toMatch(
			/loading/i,
		);
		const left = { ...line, side: "LEFT" as const, startSide: "LEFT" as const };
		expect(agentCommentAvailable(left, { ...on, commentLeft: false })).toMatch(
			/Old lines/,
		);
	});
});

describe("Comment on an agent conversation", () => {
	it("opens an empty, focused composer on the conversation's span, linked to it; once", async () => {
		show(thread());
		const button = screen.getByRole("button", { name: "Comment on GitHub" });
		await userEvent.click(button);
		await userEvent.click(button);
		const composers = getComposers();
		expect(composers).toHaveLength(1);
		expect(composers[0]).toMatchObject({
			focus: true,
			agentThread: thread().id,
			span: {
				path: "src/math.js",
				commit: HEAD,
				subject: "line",
				side: "RIGHT",
				line: 3,
				startSide: "RIGHT",
				startLine: 2,
				startCol: 4,
				endCol: 9,
			},
		});
		// The composer's item, and the draft typed in it, carry the link.
		const [item] = newThreadItems([], composers);
		expect(item?.agentThread).toBe(thread().id);
		if (!item) throw new Error("no item");
		expect(targetOf(item.span, thread().id)).toMatchObject({
			agentThread: thread().id,
			path: "src/math.js",
		});
	});

	it("a file conversation opens a file composer", async () => {
		show(
			thread({ anchor: { subject: "file", path: "README.md", commit: HEAD } }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Comment on GitHub" }),
		);
		expect(getComposers()[0]?.span).toEqual({
			path: "README.md",
			commit: HEAD,
			subject: "file",
		});
	});

	it("is off, with the reason, where GitHub can't take the comment", async () => {
		const cases: [Parameters<typeof show>[1], Partial<AgentThread>, RegExp][] =
			[
				[{ writes: "as-of" }, {}, /cutoff/],
				[{ writes: "viewer" }, {}, /someone else/],
				[
					{},
					{ anchor: { ...line, commit: "o".repeat(40) } },
					/earlier version/,
				],
				[
					{
						patchsets: [1, 2],
						wrap: (n) => (
							<SendViewProvider
								value={{ target: { patchset: 1 }, from: { branch: true } }}
							>
								{n}
							</SendViewProvider>
						),
					},
					{},
					/earlier patch set/,
				],
			];
		for (const [opts, more, why] of cases) {
			show(thread(more), opts);
			const button = screen.getByRole("button", {
				name: /^Comment on GitHub — /,
			});
			expect(button.getAttribute("aria-disabled")).toBe("true");
			expect(button.getAttribute("aria-label")).toMatch(why);
			await userEvent.click(button);
			expect(getComposers()).toEqual([]);
			cleanup();
		}
	});

	it("isn't offered on a GitHub thread's conversation, nor on an orphan of one", () => {
		show(
			thread({
				anchor: {
					subject: "thread",
					thread: "PRRT_1",
					path: "a",
					commit: HEAD,
				},
			}),
		);
		expect(
			screen.queryByRole("button", { name: /Comment on GitHub/ }),
		).toBeNull();
		cleanup();
		show(thread({ orphaned: true }));
		expect(
			screen.queryByRole("button", { name: /Comment on GitHub/ }),
		).toBeNull();
	});
});
