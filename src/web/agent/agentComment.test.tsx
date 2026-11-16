// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAnchor, AgentThread } from "../../shared/agent";
import type {
	DisplayHunk,
	PrOverview,
	ReviewThread,
	SessionInfo,
} from "../../shared/types";
import { overviewQuery, sessionQuery } from "../api";
import { HEAD_UNSURE } from "../files/selectionActions";
import {
	getComposers,
	newThreadItems,
	openComposer,
	resetComposers,
	targetOf,
} from "../threads/newThreads";
import { addThread, threadWritesFor } from "../threads/threadWrites";
import { AgentThreadCard } from "./AgentThreadCard";
import {
	agentCommentAvailable,
	type CommentScope,
	CommentScopeProvider,
	spanInHunks,
} from "./agentComment";
import { resetAgentWrites } from "./agentWrites";
import { spanOfAnchor } from "./askAgentAction";
import { resetLinkProblems } from "./linkProblems";
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
	resetLinkProblems();
	vi.unstubAllGlobals();
});

const SCOPE: CommentScope = { headSure: true, inDiff: () => true };

let client: QueryClient;
function show(
	t: AgentThread,
	opts: {
		writes?: PrOverview["writes"];
		commentLeft?: boolean;
		patchsets?: number[];
		wrap?: (n: ReactNode) => ReactNode;
		/** null: outside Files changed's diff (the Overview). */
		scope?: CommentScope | null;
		unplaced?: boolean;
		outdated?: string;
	} = {},
) {
	client = new QueryClient({
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
	const card = (
		<AgentThreadCard
			thread={t}
			status={undefined}
			unplaced={opts.unplaced}
			outdated={opts.outdated}
		/>
	);
	const scope = opts.scope === undefined ? SCOPE : opts.scope;
	const shown = opts.wrap ? opts.wrap(card) : card;
	return render(
		<QueryClientProvider client={client}>
			{scope ? (
				<CommentScopeProvider value={scope}>{shown}</CommentScopeProvider>
			) : (
				shown
			)}
		</QueryClientProvider>,
	);
}

const commentButton = () =>
	screen.queryByRole("button", { name: /^Comment on GitHub/ });

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

	it("waits while the head's diff isn't shown yet, and only takes lines of GitHub's diff", () => {
		expect(agentCommentAvailable(line, { ...on, headUnsure: true })).toBe(
			HEAD_UNSURE,
		);
		expect(agentCommentAvailable(line, { ...on, inDiff: false })).toMatch(
			/only takes comments on lines in the diff/,
		);
		// A whole file takes one whatever its lines.
		const file = { subject: "file" as const, path: "a", commit: HEAD };
		expect(agentCommentAvailable(file, { ...on, inDiff: false })).toBe(true);
	});

	it("old lines only when asked against the base branch (a since view's are a patch set's)", () => {
		const left = { ...line, side: "LEFT" as const, startSide: "LEFT" as const };
		expect(
			agentCommentAvailable(left, { ...on, askedFrom: { patchset: 1 } }),
		).toMatch(/not asked against the base branch/);
		expect(agentCommentAvailable(left, on)).toMatch(
			/not asked against the base branch/,
		);
		expect(
			agentCommentAvailable(left, { ...on, askedFrom: { branch: true } }),
		).toBe(true);
		// New lines are the head's whatever it was compared against.
		expect(
			agentCommentAvailable(line, { ...on, askedFrom: { patchset: 1 } }),
		).toBe(true);
	});
});

describe("spanInHunks", () => {
	const hunks = [
		{
			lines: [{ oldNo: 1, newNo: 1 }, { newNo: 2 }, { oldNo: 2, newNo: 3 }],
		},
	] as unknown as DisplayHunk[];
	it("both ends on the side's lines of a hunk", () => {
		expect(spanInHunks(spanOfAnchor(line), hunks)).toBe(true);
		expect(
			spanInHunks(spanOfAnchor({ ...line, line: 9, startLine: 9 }), hunks),
		).toBe(false);
		expect(
			spanInHunks(
				spanOfAnchor({ ...line, side: "LEFT", startSide: "LEFT" }),
				hunks,
			),
		).toBe(false);
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
				[{ scope: { ...SCOPE, headSure: false } }, {}, /diff is loading/],
				[{ scope: { ...SCOPE, inDiff: () => false } }, {}, /lines in the diff/],
				[
					{},
					{
						anchor: { ...line, side: "LEFT", startSide: "LEFT" },
						messages: [
							{
								id: "m1",
								by: "human",
								at: "2026-11-07T10:00:00Z",
								text: "Why?",
								view: {
									target: { patchset: 2 },
									from: { patchset: 1 },
									left: "1".repeat(40),
									right: HEAD,
								},
							},
						],
					},
					/not asked against the base branch/,
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

	it("is offered only where its composer shows: not on the Overview, nor on an unplaced or outdated card", () => {
		show(thread(), { scope: null });
		expect(commentButton()).toBeNull();
		cleanup();
		show(thread(), { unplaced: true });
		expect(commentButton()).toBeNull();
		cleanup();
		show(thread(), { outdated: "o".repeat(40) });
		expect(commentButton()).toBeNull();
		cleanup();
		show(thread());
		expect(commentButton()).not.toBeNull();
	});

	it("adopts a plain composer already open on the span instead of opening a second", async () => {
		show(thread());
		const plain = openComposer(spanOfAnchor(line), "plain1");
		await userEvent.click(
			screen.getByRole("button", { name: "Comment on GitHub" }),
		);
		expect(getComposers()).toEqual([
			expect.objectContaining({
				clientId: plain,
				agentThread: thread().id,
				focus: true,
			}),
		]);
	});

	it("adopts a plain comment already typed on the span, its text kept", async () => {
		show(thread());
		const writer = threadWritesFor(client);
		writer.drafts.setNew("typed1", targetOf(spanOfAnchor(line)), "Half done");
		await userEvent.click(
			screen.getByRole("button", { name: "Comment on GitHub" }),
		);
		expect(writer.drafts.newThread("typed1")).toMatchObject({
			text: "Half done",
			create: { agentThread: thread().id },
		});
		expect(getComposers().map((c) => c.clientId)).toEqual(["typed1"]);
	});

	it("says on its card why a posted comment didn't take the conversation", async () => {
		show(thread());
		expect(screen.queryByTestId("agent-link-problem")).toBeNull();
		act(() =>
			addThread(client, {
				thread: { id: "T9" } as ReviewThread,
				comments: { threadId: "T9", comments: [] },
				agentLinkProblem: {
					thread: thread().id,
					reason: "That GitHub thread already has a conversation",
				},
			}),
		);
		expect(screen.getByTestId("agent-link-problem").textContent).toContain(
			"That GitHub thread already has a conversation",
		);
		// Pressed again: the old reason goes.
		await userEvent.click(
			screen.getByRole("button", { name: "Comment on GitHub" }),
		);
		expect(screen.queryByTestId("agent-link-problem")).toBeNull();
	});
});
