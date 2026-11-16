import { describe, expect, it } from "vitest";
import type { AgentThread } from "../../shared/agent";
import type { ReviewThread } from "../../shared/types";
import { agentPlaceable } from "../agent/placeable";
import { conversation, reviewThread } from "../agent/threadAgentFixtures";
import { threadsCount } from "./ThreadsPanel";
import {
	agentBlurb,
	agentRows,
	type FocusWorld,
	focusPlan,
	githubRows,
	listedConversations,
	listedRows,
	plainText,
} from "./threadRows";

const span = (more: Partial<AgentThread> = {}): AgentThread =>
	conversation({
		id: "S1",
		anchor: {
			subject: "line",
			path: "src/a.ts",
			commit: "c0",
			side: "RIGHT",
			line: 9,
			startSide: "RIGHT",
			startLine: 9,
		},
		...more,
	});

describe("githubRows", () => {
	it("names who spoke last, with their avatar, and dates the row by the last activity", () => {
		const [row] = githubRows(
			[
				reviewThread({
					lastAuthor: { login: "ci", avatarUrl: "https://x/a.png", bot: true },
					lastActivityAt: "2026-01-05T00:00:00Z",
				}),
			],
			new Map(),
		);
		expect(row?.last).toEqual({
			kind: "person",
			login: "ci",
			avatarUrl: "https://x/a.png",
			bot: true,
		});
		expect(row?.at).toBe("2026-01-05T00:00:00Z");
		expect(row?.key).toBe("gh:RT1");
	});

	it("goes where the thread shows in the viewed snapshot, else opens its file", () => {
		const t = reviewThread({ path: "old.ts", line: 4 });
		const shown: ReviewThread = {
			...t,
			path: "new.ts",
			anchor: {
				path: "new.ts",
				commit: "h",
				side: "LEFT",
				line: 12,
				startSide: "LEFT",
				startLine: 12,
				at: t.createdAt,
			},
		};
		const [placed] = githubRows([t], new Map([[t.id, shown]]));
		expect(placed).toMatchObject({
			path: "new.ts",
			line: 12,
			focus: { id: "RT1" },
		});
		const [unshown] = githubRows([t], new Map());
		expect(unshown).toMatchObject({
			path: "old.ts",
			line: 4,
			focus: { id: "RT1" },
		});
		// A file comment shows its path with no line.
		const file = { ...shown, subject: "file" as const, anchor: null };
		const [onFile] = githubRows([t], new Map([[t.id, file]]));
		expect(onFile).toMatchObject({
			path: "new.ts",
			line: null,
			focus: { id: "RT1" },
		});
	});

	it("keeps the thread's cues: your turn (never once resolved), outdated, resolved", () => {
		const rows = githubRows(
			[
				reviewThread({ id: "a", yourTurn: true }),
				reviewThread({ id: "b", yourTurn: true, resolved: true }),
				reviewThread({ id: "c", outdated: true }),
			],
			new Map(),
		);
		expect(rows.map((r) => [r.yourTurn, r.resolved, r.outdated])).toEqual([
			[true, false, false],
			[false, true, false],
			[false, false, true],
		]);
	});
});

describe("agentRows", () => {
	it("dates by the last message, else the thread's own time; says who spoke last", () => {
		const [answered, asked] = agentRows(
			[
				conversation({ id: "A1" }),
				span({ id: "S1", at: "2026-11-12T00:00:00Z", messages: [] }),
			],
			new Map(),
			new Map(),
		);
		expect(answered?.at).toBe("2026-11-11T10:03:00Z");
		expect(answered?.last).toEqual({ kind: "agent", by: "ai" });
		expect(asked?.at).toBe("2026-11-12T00:00:00Z");
		// No message: whoever opened it.
		expect(asked?.last).toEqual({ kind: "agent", by: "human" });
	});

	it("a conversation on a GitHub thread goes where that thread shows", () => {
		const gh = reviewThread({
			path: "moved.ts",
			anchor: {
				path: "moved.ts",
				commit: "h",
				side: "RIGHT",
				line: 30,
				startSide: "RIGHT",
				startLine: 30,
				at: "",
			},
		});
		const [row] = agentRows(
			[conversation()],
			new Map(),
			new Map([["RT1", gh]]),
		);
		expect(row).toMatchObject({
			key: "ai:A1",
			path: "moved.ts",
			line: 30,
			// Its GitHub thread's card, with the conversation open.
			focus: { id: "RT1", conversation: "A1" },
		});
		// Its GitHub thread shows nowhere: where it was asked, still that
		// thread's card (wherever it is listed).
		const [asked] = agentRows([conversation()], new Map(), new Map());
		expect(asked).toMatchObject({
			path: "src/cache.ts",
			line: 4,
			focus: { id: "RT1", conversation: "A1" },
		});
	});

	it("a span question goes where Files changed shows it, else where it was asked", () => {
		const t = span();
		const placed = {
			...agentPlaceable(t),
			path: "src/b.ts",
			anchor: {
				side: "RIGHT" as const,
				line: 20,
				startSide: "RIGHT" as const,
				startLine: 20,
				startCol: null,
				endCol: null,
			},
		};
		expect(
			agentRows([t], new Map([[t.id, placed]]), new Map())[0],
		).toMatchObject({ path: "src/b.ts", line: 20 });
		expect(agentRows([t], new Map(), new Map())[0]).toMatchObject({
			path: "src/a.ts",
			line: 9,
			focus: { id: "S1" },
		});
	});

	it("carries unread and waiting", () => {
		const [row] = agentRows(
			[span({ unread: true, waiting: true })],
			new Map(),
			new Map(),
		);
		expect(row?.unread).toBe(true);
		expect(row?.waiting).toBe(true);
	});
});

describe("listedRows", () => {
	const rows = githubRows(
		[
			reviewThread({ id: "old", lastActivityAt: "2026-01-01T00:00:00Z" }),
			reviewThread({ id: "new", lastActivityAt: "2026-01-09T00:00:00Z" }),
			reviewThread({
				id: "done",
				resolved: true,
				lastActivityAt: "2026-01-10T00:00:00Z",
			}),
			reviewThread({ id: "undated", lastActivityAt: "" }),
			reviewThread({ id: "mid", lastActivityAt: "2026-01-05T00:00:00Z" }),
		],
		new Map(),
	);

	it("lists newest activity first, an undated one last, resolved ones left out", () => {
		expect(listedRows(rows, false).map((r) => r.id)).toEqual([
			"new",
			"mid",
			"old",
			"undated",
		]);
	});

	it("lists resolved ones too when asked, in their place by activity", () => {
		expect(listedRows(rows, true).map((r) => r.id)).toEqual([
			"done",
			"new",
			"mid",
			"old",
			"undated",
		]);
	});

	it("never drops an unresolved row, whatever its data", () => {
		const odd = githubRows(
			[
				reviewThread({ id: "x", lastActivityAt: "not a date", path: "" }),
				reviewThread({
					id: "y",
					lastAuthor: { login: "", avatarUrl: "", bot: false },
				}),
			],
			new Map(),
		);
		expect(listedRows(odd, false)).toHaveLength(2);
	});
});

describe("threadsCount", () => {
	const people = githubRows(
		[reviewThread({ id: "a" }), reviewThread({ id: "b", resolved: true })],
		new Map(),
	);
	const ai = agentRows(
		[span(), span({ id: "S2", resolved: true })],
		new Map(),
		new Map(),
	);
	const ok = { people: false, ai: false };

	it("counts the unresolved conversations of both regions", () => {
		expect(threadsCount(people, ai, ok)).toEqual({ state: "open", n: 2 });
	});

	it("is loading while either region loads, never a partial count", () => {
		expect(threadsCount(null, ai, ok)).toEqual({ state: "loading" });
		expect(threadsCount(people, null, ok)).toEqual({ state: "loading" });
	});

	it("names a failed region rather than counting without it", () => {
		expect(threadsCount(people, null, { people: false, ai: true })).toEqual({
			state: "failed",
			what: "AI",
		});
		expect(threadsCount(null, ai, { people: true, ai: false })).toEqual({
			state: "failed",
			what: "People",
		});
		expect(threadsCount(null, null, { people: true, ai: true })).toEqual({
			state: "failed",
			what: "People and AI",
		});
	});
});

describe("blurbs", () => {
	it("a GitHub thread's is its excerpt; loading while unread; why not when gone", () => {
		const blurb = (more: Partial<ReviewThread>) =>
			githubRows([reviewThread(more)], new Map())[0]?.blurb;
		expect(blurb({ excerpt: "Should this expire?" })).toEqual({
			kind: "text",
			text: "Should this expire?",
		});
		expect(blurb({ loaded: false, excerpt: "" })).toEqual({ kind: "loading" });
		// The read that brings its text failed: says so, never loads forever.
		expect(
			githubRows([reviewThread({ loaded: false })], new Map(), {
				contentFailed: true,
			})[0]?.blurb,
		).toEqual({ kind: "failed" });
		expect(blurb({ unavailable: "deleted" })).toEqual({
			kind: "unavailable",
			text: "Deleted on GitHub",
		});
		expect(blurb({ unavailable: "unreadable" })).toEqual({
			kind: "unavailable",
			text: "Couldn't be read from GitHub",
		});
	});

	it("an agent thread's is the reviewer's first question, as plain text", () => {
		expect(
			agentBlurb(
				span({
					messages: [
						{
							id: "m1",
							by: "human",
							at: "2026-11-11T10:00:00Z",
							text: "## Why  **this**\n\n- does `foo_bar` [link](https://x.y) _here_?",
						},
						{
							id: "m2",
							by: "ai",
							at: "2026-11-11T10:01:00Z",
							text: "Because.",
						},
					],
				}),
			),
		).toEqual({
			kind: "text",
			text: "Why this does foo_bar link here?",
		});
	});

	it("one the agent opened: the reviewer's request it came from, else its first message", () => {
		const asked = span({
			id: "S0",
			messages: [
				{
					id: "q1",
					by: "human",
					at: "2026-11-11T09:00:00Z",
					text: "Check the **cache** keys",
				},
			],
		});
		const opened = span({
			id: "S9",
			openedBy: "ai",
			messages: [
				{
					id: "m1",
					by: "ai",
					at: "2026-11-11T10:00:00Z",
					text: "Found one.",
					origin: { thread: "S0", message: "q1" },
				},
			],
		});
		expect(agentBlurb(opened, [asked, opened])).toEqual({
			kind: "text",
			text: "Check the cache keys",
		});
		// Its request not among the threads: its own first message.
		expect(agentBlurb(opened, [opened])).toEqual({
			kind: "text",
			text: "Found one.",
		});
		expect(agentRows([asked, opened], new Map(), new Map())[1]?.blurb).toEqual({
			kind: "text",
			text: "Check the cache keys",
		});
	});

	it("plain text keeps code and words, drops markup and collapses whitespace", () => {
		expect(plainText("```ts\nconst a = 1;\n```\n> quoted\n1. item")).toBe(
			"const a = 1; quoted item",
		);
		expect(plainText("<b>x</b>  ![img](u)\t~~y~~")).toBe("x img y");
		expect(plainText("snake_case_name and 2*3*4")).toBe(
			"snake_case_name and 2*3*4",
		);
	});
});

describe("focusPlan", () => {
	const world = (more: Partial<FocusWorld> = {}): FocusWorld => ({
		fileOf: (path) => ({ "src/cache.ts": 0, "src/a.ts": 1 })[path],
		hidden: () => false,
		githubAfter: new Set(),
		agentAfter: new Set(),
		pending: false,
		...more,
	});
	const [gh] = githubRows([reviewThread()], new Map());
	const [onThread] = agentRows([conversation()], new Map(), new Map());
	const [onSpan] = agentRows([span()], new Map(), new Map());
	if (!gh || !onThread || !onSpan) throw new Error("no rows");

	it("a thread in a file: that file opens and its card is asked for", () => {
		expect(focusPlan(gh, world())).toEqual({
			open: 0,
			unhide: false,
			request: { id: "RT1" },
		});
		expect(focusPlan(onSpan, world())).toEqual({
			open: 1,
			unhide: false,
			request: { id: "S1" },
		});
		expect(focusPlan(onThread, world())).toEqual({
			open: 0,
			unhide: false,
			request: { id: "RT1", conversation: "A1" },
		});
	});

	it('"needs eyes" lets the file show again only when it hides the card\'s file', () => {
		expect(focusPlan(gh, world({ hidden: () => true })).unhide).toBe(true);
		// Its card after the files: the filter stays.
		expect(
			focusPlan(
				gh,
				world({ hidden: () => true, githubAfter: new Set(["RT1"]) }),
			),
		).toEqual({ open: null, unhide: false, request: { id: "RT1" } });
		expect(
			focusPlan(
				onSpan,
				world({ hidden: () => true, agentAfter: new Set(["S1"]) }),
			),
		).toEqual({ open: null, unhide: false, request: { id: "S1" } });
	});

	it("leaves nothing pending when no card can show it", () => {
		// No file, not after the files, nothing on its way.
		const nowhere = world({ fileOf: () => undefined });
		expect(focusPlan(gh, nowhere).request).toBeNull();
		// While the placements come, a card may yet show: asked for.
		expect(focusPlan(gh, { ...nowhere, pending: true }).request).toEqual({
			id: "RT1",
		});
	});
});

describe("listedConversations", () => {
	it("lists a conversation on a review thread only while that thread is listed; span questions and orphans always", () => {
		const onThread = conversation({ id: "A1" });
		const orphan = conversation({ id: "A2", orphaned: true });
		const question = span({ id: "S1" });
		const all = [onThread, orphan, question];
		expect(listedConversations(all, new Set(["RT1"])).map((t) => t.id)).toEqual(
			["A1", "A2", "S1"],
		);
		// Its thread not in this view (published after the viewed patch
		// set, deleted here): no row, nothing counted.
		const shown = listedConversations(all, new Set());
		expect(shown.map((t) => t.id)).toEqual(["A2", "S1"]);
		const rows = agentRows(shown, new Map(), new Map());
		expect(rows).toHaveLength(2);
		expect(threadsCount([], rows, { people: false, ai: false })).toEqual({
			state: "open",
			n: 2,
		});
	});

	it("an orphan is its own card, not its gone thread's", () => {
		const [row] = agentRows(
			[conversation({ id: "A2", orphaned: true })],
			new Map(),
			new Map(),
		);
		expect(row?.focus).toEqual({ id: "A2" });
	});
});
