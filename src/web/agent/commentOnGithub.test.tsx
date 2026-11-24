// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAnchor, AgentThread, AgentView } from "../../shared/agent";
import {
	type DisplayHunk,
	type PrOverview,
	type ReviewThread,
	SAME_AS_BASE,
	type SessionInfo,
} from "../../shared/types";
import { overviewQuery, sessionQuery } from "../api";
import type { Viewing } from "../files/comparison";
import {
	HEAD_UNSURE,
	MIXED_COMMITS,
	RENAMED_SINCE,
} from "../files/selectionActions";
import {
	getComposers,
	newThreadItems,
	openComposer,
	resetComposers,
	targetOf,
} from "../threads/newThreads";
import { addThread, threadWritesFor } from "../threads/threadWrites";
import { AgentThreadCard } from "./AgentThreadCard";
import { resetAgentWrites } from "./agentWrites";
import { spanOfAnchor } from "./askAgentAction";
import {
	agentCommentAvailable,
	baseOf,
	type CommentScope,
	CommentScopeProvider,
	earlierSpan,
	onHeadMove,
	ShowVersionProvider,
	spanInHunks,
	spanOffGithub,
	versionOf,
	viewingOf,
} from "./commentOnGithub";
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
		/** The Files page's move of the viewed dot (null: none, outside it). */
		showVersion?: ((v: Viewing, path: string) => void) | null;
		/** GitHub's head, when it moved on from the snapshot. */
		githubHead?: string;
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
		head: opts.githubHead ? { oid: opts.githubHead } : null,
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
	const wrapped = opts.wrap ? opts.wrap(card) : card;
	const go = opts.showVersion === undefined ? vi.fn() : opts.showVersion;
	const shown = go ? (
		<ShowVersionProvider value={go}>{wrapped}</ShowVersionProvider>
	) : (
		wrapped
	);
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
		// Asked on another version than the one on screen: that version's rules.
		const elsewhere = { ...on, right: "o".repeat(40) };
		expect(
			agentCommentAvailable(line, { ...elsewhere, version: "commentable" }),
		).toBe(true);
		expect(
			agentCommentAvailable(line, { ...elsewhere, version: "read-only" }),
		).toBe("An earlier patch set: comment on the latest");
		expect(
			agentCommentAvailable(line, { ...elsewhere, version: "unknown" }),
		).toMatch(/earlier version/);
		expect(agentCommentAvailable(line, elsewhere)).toBe("Loading the PR");
		expect(agentCommentAvailable(line, { ...on, right: undefined })).toMatch(
			/loading/i,
		);
		const left = { ...line, side: "LEFT" as const, startSide: "LEFT" as const };
		expect(agentCommentAvailable(left, { ...on, commentLeft: false })).toMatch(
			/Old lines/,
		);
	});

	it("on another version, the screen's facts don't count: an earlier patch set shown, its diff loading, lines not in it", () => {
		const elsewhere = {
			...on,
			right: "o".repeat(40),
			version: "commentable" as const,
		};
		expect(
			agentCommentAvailable(line, {
				...elsewhere,
				readOnly: true,
				headUnsure: true,
				inDiff: false,
			}),
		).toBe(true);
		// The PR's own rules still hold there.
		expect(
			agentCommentAvailable(line, { ...elsewhere, writes: "as-of" }),
		).toMatch(/cutoff/);
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

	it("old lines only when numbered in today's merge base: asked against the base branch, or recorded with it (CAR-276)", () => {
		const left = { ...line, side: "LEFT" as const, startSide: "LEFT" as const };
		const BASE = "b".repeat(40);
		const asked = (from: AgentView["from"], l = BASE): AgentView => ({
			target: { patchset: 2 },
			from,
			left: l,
			right: HEAD,
		});
		const branch = { ...on, base: BASE };
		expect(
			agentCommentAvailable(left, { ...branch, asked: asked({ patchset: 1 }) }),
		).toMatch(/asked against a patch set/);
		// The base moved since it was asked: its old lines aren't GitHub's now.
		expect(
			agentCommentAvailable(left, {
				...branch,
				asked: asked({ branch: true }, "c".repeat(40)),
			}),
		).toMatch(/earlier base/);
		expect(
			agentCommentAvailable(left, {
				...on,
				asked: asked({ branch: true }),
			}),
		).toMatch(/earlier base/);
		// No question with a comparison (one the agent opened, or older).
		expect(agentCommentAvailable(left, branch)).toBe(
			"Old lines: not known to be the base branch's",
		);
		expect(
			agentCommentAvailable(left, {
				...branch,
				asked: asked({ branch: true }),
			}),
		).toBe(true);
		// Asked in a since view with its merge base recorded (CAR-276): its
		// old lines are base lines (CAR-217), GitHub's at that base.
		const PS1 = "e".repeat(40);
		expect(
			agentCommentAvailable(left, {
				...branch,
				asked: { ...asked({ patchset: 1 }, PS1), base: BASE },
			}),
		).toBe(true);
		expect(
			agentCommentAvailable(left, {
				...branch,
				asked: { ...asked({ patchset: 1 }, PS1), base: "c".repeat(40) },
			}),
		).toMatch(/earlier base/);
		// New lines are the head's whatever it was compared against.
		expect(
			agentCommentAvailable(line, { ...on, asked: asked({ patchset: 1 }) }),
		).toBe(true);
	});
});

describe("the merge base old lines are checked against", () => {
	const left = { ...line, side: "LEFT" as const, startSide: "LEFT" as const };
	const asked: AgentView = {
		target: { head: HEAD },
		from: { branch: true },
		left: "b".repeat(40),
		right: HEAD,
	};

	it("while the session loads: loading, not an earlier base", () => {
		expect(
			agentCommentAvailable(left, { ...on, asked, baseLoading: true }),
		).toBe("Loading the PR");
	});

	it("is the shown head's patch set's, else GitHub's head's, else the snapshot's", () => {
		const session = {
			patchsets: [{ head: "p".repeat(40), mergeBase: "1".repeat(40) }],
			head: { oid: "g".repeat(40), mergeBase: "2".repeat(40) },
			snapshotHead: HEAD,
			snapshotBase: "3".repeat(40),
		} as unknown as SessionInfo;
		expect(baseOf(session, "p".repeat(40))).toBe("1".repeat(40));
		expect(baseOf(session, "g".repeat(40))).toBe("2".repeat(40));
		// No patch set yet, GitHub moved on (or as-of / pinned: no head).
		expect(baseOf(session, HEAD)).toBe("3".repeat(40));
		expect(baseOf({ ...session, head: null }, HEAD)).toBe("3".repeat(40));
		expect(baseOf(session, "o".repeat(40))).toBeUndefined();
		expect(baseOf(undefined, HEAD)).toBeUndefined();
	});
});

describe("the version a conversation was asked on", () => {
	const P1 = "1".repeat(40);
	const P2 = "2".repeat(40);
	const G = "g".repeat(40);
	const ps = (n: number, head: string) => ({ number: n, head });
	const session = (more: Partial<SessionInfo>) =>
		({ snapshotHead: P1, head: null, patchsets: [], ...more }) as SessionInfo;

	it("takes comments on the latest patch set's head, the snapshot's before any, and GitHub's head", () => {
		expect(versionOf(session({}), P1)).toBe("commentable");
		const two = session({ patchsets: [ps(1, P1), ps(2, P2)] } as never);
		expect(versionOf(two, P2)).toBe("commentable");
		expect(versionOf(two, P1)).toBe("read-only");
		expect(versionOf(two, "o".repeat(40))).toBe("unknown");
		const moved = session({
			patchsets: [ps(1, P1)],
			head: { oid: G },
		} as never);
		expect(versionOf(moved, P1)).toBe("commentable");
		expect(versionOf(moved, G)).toBe("commentable");
	});

	it("is shown as its patch set, else as the head", () => {
		const s = session({ patchsets: [ps(1, P1)] } as never);
		expect(viewingOf(s, P1)).toEqual({ kind: "patchset", number: 1 });
		expect(viewingOf(s, G)).toEqual({ kind: "head", oid: G });
	});
});

describe("a composer carrying a conversation when another head shows", () => {
	const H1 = "1".repeat(40);
	const H2 = "2".repeat(40);
	const session = (more: Partial<SessionInfo>) =>
		({ snapshotHead: H1, head: null, patchsets: [], ...more }) as SessionInfo;

	it("stays while its version takes comments (Comment went there)", () => {
		// No patch set, GitHub's head on screen: H1 is still the snapshot's.
		expect(onHeadMove(session({ head: { oid: H2 } } as never), H1, false)).toBe(
			"stay",
		);
		// PS1 the latest.
		const ps1 = session({
			patchsets: [{ number: 1, head: H1 }],
			head: { oid: H2 },
		} as never);
		expect(onHeadMove(ps1, H1, true)).toBe("stay");
	});

	it("a Refresh to H2 (H1 no longer any version): untyped it closes, typed it stays an orphan; never moved", () => {
		const refreshed = session({ snapshotHead: H2, head: { oid: H2 } } as never);
		expect(onHeadMove(refreshed, H1, false)).toBe("close");
		expect(onHeadMove(refreshed, H1, true)).toBe("orphan");
		// An earlier patch set: read-only, the same.
		const two = session({
			snapshotHead: H2,
			patchsets: [
				{ number: 1, head: H1 },
				{ number: 2, head: H2 },
			],
		} as never);
		expect(onHeadMove(two, H1, false)).toBe("close");
		expect(onHeadMove(undefined, H1, false)).toBeUndefined();
	});
});

describe("openComposer with an id", () => {
	const span = spanOfAnchor(line);
	const other = { ...span, line: 9, startLine: 9 };

	it("matches that id only on the same span: never two composers with one id", () => {
		openComposer(other, "c1");
		const id = openComposer(span, "c1", thread().id);
		expect(id).not.toBe("c1");
		const ids = getComposers().map((c) => c.clientId);
		expect(new Set(ids).size).toBe(ids.length);
		expect(getComposers().find((c) => c.clientId === "c1")?.span).toEqual(
			other,
		);
		expect(getComposers().find((c) => c.clientId === id)).toMatchObject({
			span,
			agentThread: thread().id,
		});
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

describe("a since-view line GitHub's diff hasn't (CAR-293)", () => {
	const hunks = [
		{
			lines: [
				{ oldNo: 1, newNo: 1, offGithub: true },
				{ newNo: 2, offGithub: true },
				{ oldNo: 2, newNo: 3 },
				{ newNo: 4 },
			],
		},
	] as unknown as DisplayHunk[];
	const at = (startLine: number, end: number) =>
		spanOfAnchor({ ...line, startLine, line: end });
	it("isn't in GitHub's diff (spanInHunks), and says so (spanOffGithub), at either end", () => {
		expect(spanInHunks(at(2, 2), hunks)).toBe(false);
		expect(spanOffGithub(at(2, 2), hunks)).toBe(true);
		expect(spanInHunks(at(2, 4), hunks)).toBe(false);
		expect(spanOffGithub(at(2, 4), hunks)).toBe(true);
		expect(spanInHunks(at(3, 1), hunks)).toBe(false);
		expect(spanOffGithub(at(3, 1), hunks)).toBe(true);
		// The lines beside it GitHub's diff has: in, and not off.
		expect(spanInHunks(at(3, 4), hunks)).toBe(true);
		expect(spanOffGithub(at(3, 4), hunks)).toBe(false);
		// A LEFT line isn't the RIGHT line's flag: old 1 is in.
		const left = spanOfAnchor({
			...line,
			side: "LEFT",
			startSide: "LEFT",
			line: 1,
			startLine: 1,
		});
		expect(spanInHunks(left, hunks)).toBe(true);
		expect(spanOffGithub(left, hunks)).toBe(false);
	});

	it("Comment on GitHub on the conversation shown is off with why; on another version it isn't checked here", () => {
		const ctx = { ...on, inDiff: false, sameAsBase: true };
		expect(agentCommentAvailable(line, ctx)).toBe(SAME_AS_BASE);
		expect(agentCommentAvailable(line, { ...ctx, sameAsBase: undefined })).toBe(
			"GitHub only takes comments on lines in the diff",
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
					// Asked on PS1, read-only since PS2 started.
					{ anchor: { ...line, commit: "1".repeat(40) } },
					/earlier patch set/,
				],
				[
					// Asked on PS1, PS2 on screen: PS1 is read-only.
					{ patchsets: [1, 2] },
					{ anchor: { ...line, commit: "1".repeat(40) } },
					/An earlier patch set: comment on the latest/,
				],
				[
					// Outside the Files page: nowhere to go to its version.
					{ showVersion: null },
					{ anchor: { ...line, commit: "o".repeat(40) } },
					/earlier version/,
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
					/asked against a patch set/,
				],
				[
					// Asked against the branch at a base it no longer has.
					{ patchsets: [1] },
					{
						anchor: { ...line, side: "LEFT", startSide: "LEFT" },
						messages: [
							{
								id: "m1",
								by: "human",
								at: "2026-11-07T10:00:00Z",
								text: "Why?",
								view: {
									target: { patchset: 1 },
									from: { branch: true },
									left: "c".repeat(40),
									right: HEAD,
								},
							},
						],
					},
					/earlier base/,
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
		show(thread());
		expect(commentButton()).not.toBeNull();
	});

	it("sits at the bottom row's right end, after Resolve, where a GitHub thread's agent handle is", () => {
		show(thread());
		const button = screen.getByRole("button", { name: "Comment on GitHub" });
		const row = button.parentElement;
		expect(row).toBe(screen.getByTestId("agent-resolve").parentElement);
		expect(row?.lastElementChild).toBe(button);
		expect(button.className).toContain("rounded-l-lg");
		expect(button.className).toContain("h-10");
	});

	it("asked on an earlier head that takes comments: on, even on its outdated card; the page goes to that version and the composer is on its commit", async () => {
		const P1 = HEAD;
		const G = "g".repeat(40);
		const go = vi.fn();
		// PS1 is the latest patch set; GitHub's head moved on and is on screen.
		show(thread(), {
			patchsets: [1],
			githubHead: G,
			outdated: P1,
			showVersion: go,
			wrap: (n) => (
				<SendViewProvider
					value={{ target: { head: G }, from: { patchset: 1 } }}
				>
					{n}
				</SendViewProvider>
			),
		});
		const button = screen.getByRole("button", { name: "Comment on GitHub" });
		expect(button.getAttribute("aria-disabled")).toBeNull();
		await userEvent.click(button);
		expect(go).toHaveBeenCalledWith(
			{ kind: "patchset", number: 1 },
			"src/math.js",
		);
		expect(getComposers()).toMatchObject([
			{
				agentThread: thread().id,
				span: { commit: P1, path: "src/math.js", line: 3 },
			},
		]);
		// The comment posts on that version's commit (NewThread sends the span's).
		const [item] = newThreadItems([], getComposers());
		if (!item) throw new Error("no item");
		expect(targetOf(item.span, thread().id)).toMatchObject({
			commit: P1,
			agentThread: thread().id,
		});
	});

	it("on the version on screen, the page doesn't move", async () => {
		const go = vi.fn();
		show(thread(), { showVersion: go });
		await userEvent.click(
			screen.getByRole("button", { name: "Comment on GitHub" }),
		);
		expect(go).not.toHaveBeenCalled();
		expect(getComposers()).toHaveLength(1);
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

	it("a typed plain comment and an empty plain composer on the span: the typed one takes the conversation, alone, focused", async () => {
		show(thread());
		const writer = threadWritesFor(client);
		const span = spanOfAnchor(line);
		writer.drafts.setNew("typed1", targetOf(span), "Half done");
		openComposer(span, "empty1");
		await userEvent.click(
			screen.getByRole("button", { name: "Comment on GitHub" }),
		);
		const items = newThreadItems(writer.drafts.get(), getComposers());
		expect(items).toEqual([
			expect.objectContaining({
				clientId: "typed1",
				text: "Half done",
				agentThread: thread().id,
				focus: true,
			}),
		]);
	});

	it("old lines asked against the base branch at today's merge base: on", () => {
		show(
			thread({
				anchor: { ...line, side: "LEFT", startSide: "LEFT" },
				messages: [
					{
						id: "m1",
						by: "human",
						at: "2026-11-07T10:00:00Z",
						text: "Why?",
						view: {
							target: { patchset: 1 },
							from: { branch: true },
							left: "b".repeat(40),
							right: HEAD,
						},
					},
				],
			}),
			{ patchsets: [1] },
		);
		expect(
			screen.getByRole("button", { name: "Comment on GitHub" }),
		).not.toHaveAttribute("aria-disabled");
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

describe("a conversation on lines only the since view's earlier patch set had (CAR-264)", () => {
	const P1 = "1".repeat(40);
	// The since view's removed rows: PS1's RIGHT 2..3 only PS1 had (rows 60, 61).
	const early = {
		head: P1,
		row: (n: number) => (n === 2 ? 60 : n === 3 ? 61 : null),
	};
	const file = { path: "src/math.js", renamed: false };
	const asked = spanOfAnchor({
		...line,
		commit: P1,
		startCol: undefined,
		endCol: undefined,
	} as AgentAnchor & { subject: "line" });

	it("earlierSpan: its span marked earlier on that commit; mixed when some of its lines are still in the head; renamed; else none", () => {
		expect(earlierSpan(asked, early, file)).toEqual({
			...asked,
			earlier: true,
		});
		// Lines 2..4: 4 is still in the head (no removed row).
		expect(earlierSpan({ ...asked, line: 4 }, early, file)).toBe("mixed");
		expect(
			earlierSpan({ ...asked, path: "src/old.js" }, early, {
				...file,
				renamed: true,
			}),
		).toBe("renamed");
		// None of its lines removed, another commit, LEFT lines, no since view.
		expect(
			earlierSpan({ ...asked, startLine: 7, line: 8 }, early, file),
		).toBeNull();
		expect(earlierSpan({ ...asked, commit: HEAD }, early, file)).toBeNull();
		expect(
			earlierSpan({ ...asked, side: "LEFT", startSide: "LEFT" }, early, file),
		).toBeNull();
		expect(earlierSpan(asked, undefined, file)).toBeNull();
	});

	it("agentCommentAvailable: on as a direct comment there is, off with the since view's reasons", () => {
		const anchor = { ...line, commit: P1 };
		const ctx = { ...on, version: "read-only" as const };
		// Without the since view's take: an earlier version's.
		expect(agentCommentAvailable(anchor, ctx)).toMatch(/earlier/);
		expect(
			agentCommentAvailable(anchor, {
				...ctx,
				earlier: { ...asked, earlier: true },
			}),
		).toBe(true);
		expect(agentCommentAvailable(anchor, { ...ctx, earlier: "mixed" })).toBe(
			MIXED_COMMITS,
		);
		expect(agentCommentAvailable(anchor, { ...ctx, earlier: "renamed" })).toBe(
			RENAMED_SINCE,
		);
		// The rules every comment has still apply.
		expect(
			agentCommentAvailable(anchor, {
				...ctx,
				writes: "as-of",
				earlier: { ...asked, earlier: true },
			}),
		).toMatch(/cutoff/);
		expect(
			agentCommentAvailable(anchor, {
				...ctx,
				headUnsure: true,
				earlier: { ...asked, earlier: true },
			}),
		).toBe(HEAD_UNSURE);
	});

	const scopeOf = (renamed = false): CommentScope => ({
		...SCOPE,
		earlier: (span) => earlierSpan(span, early, { ...file, renamed }),
	});
	const sinceView = (n: ReactNode) => (
		<SendViewProvider value={{ target: { head: HEAD }, from: { patchset: 1 } }}>
			{n}
		</SendViewProvider>
	);

	it("the card's Comment on GitHub is on, labelled as usual; the composer is on that commit, marked earlier, and the page stays on the since view", async () => {
		const go = vi.fn();
		const t = thread({
			anchor: { ...line, commit: P1, startCol: undefined, endCol: undefined },
		});
		show(t, {
			patchsets: [1, 2],
			showVersion: go,
			scope: scopeOf(),
			wrap: sinceView,
		});
		// show() names PS1's head "1…1".
		const button = screen.getByRole("button", { name: "Comment on GitHub" });
		expect(button.getAttribute("aria-disabled")).toBeNull();
		await userEvent.click(button);
		expect(go).not.toHaveBeenCalled();
		const [item] = newThreadItems([], getComposers());
		if (!item) throw new Error("no item");
		expect(targetOf(item.span, t.id)).toEqual({
			path: "src/math.js",
			commit: P1,
			subject: "line",
			startSide: "RIGHT",
			startLine: 2,
			side: "RIGHT",
			line: 3,
			agentThread: t.id,
			earlier: true,
		});
	});

	it("off, with the reason, on a range some of whose lines are still in the head, or a file renamed since", () => {
		const mixed = thread({
			anchor: {
				...line,
				commit: P1,
				line: 4,
				startCol: undefined,
				endCol: undefined,
			},
		});
		show(mixed, { patchsets: [1, 2], scope: scopeOf(), wrap: sinceView });
		expect(
			screen.getByRole("button", {
				name: `Comment on GitHub — ${MIXED_COMMITS}`,
			}),
		).toBeTruthy();
		cleanup();
		const moved = thread({
			anchor: {
				...line,
				path: "src/old.js",
				commit: P1,
				startCol: undefined,
				endCol: undefined,
			},
		});
		show(moved, { patchsets: [1, 2], scope: scopeOf(true), wrap: sinceView });
		expect(
			screen.getByRole("button", {
				name: `Comment on GitHub — ${RENAMED_SINCE}`,
			}),
		).toBeTruthy();
	});
});
