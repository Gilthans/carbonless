// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentSpanAnchor } from "../../shared/agent";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import {
	type CommentPlace,
	commentPlace,
	GITHUB_UNKNOWN,
	knownBefore,
	knownForReply,
	LINES_GONE,
	opensThreadCard,
	type PostingThread,
	placeLabel,
	postLabel,
	postsAsReply,
	resetAgentComments,
	SIBLING_SENDING,
	siblingKey,
	siblingOf,
	THREAD_GONE,
	UNTRACED,
} from "./agentComments";

const OLD = "a".repeat(40);
const HEAD = "b".repeat(40);

const conversation = (
	anchor: AgentSpanAnchor,
	more: Partial<PostingThread> = {},
): PostingThread => ({
	id: "01k9e6m2q8x4v7c3n5b0h1j2t6",
	anchor,
	openedBy: "human",
	at: "2026-11-16T10:00:00.000Z",
	messages: [],
	resolved: false,
	waiting: false,
	unread: false,
	...more,
});

const line = (
	more: Partial<Extract<AgentSpanAnchor, { subject: "line" }>> = {},
) =>
	conversation({
		subject: "line",
		path: "src/x.ts",
		commit: OLD,
		side: "RIGHT",
		line: 44,
		startSide: "RIGHT",
		startLine: 41,
		startCol: 7,
		endCol: 20,
		...more,
	});

const placed = (
	more: Partial<{ side: "LEFT" | "RIGHT"; path: string }> = {},
): ThreadPlacement => ({
	kind: "placed",
	changed: false,
	anchor: {
		path: more.path ?? "src/x.ts",
		side: more.side ?? "RIGHT",
		startSide: more.side ?? "RIGHT",
		startLine: 47,
		line: 50,
	},
});

const at = (
	thread: PostingThread,
	placement: ThreadPlacement | undefined,
	placing: "in" | "pending" | "failed" = "in",
) => commentPlace({ thread, head: HEAD, placement, placing });

describe("commentPlace: where a ```comment block posts", () => {
	it("an anchor already on the head is used as it is, columns kept", () => {
		expect(at(line({ commit: HEAD }), undefined, "pending")).toEqual({
			kind: "new",
			changed: false,
			target: {
				path: "src/x.ts",
				commit: HEAD,
				subject: "line",
				startSide: "RIGHT",
				startLine: 41,
				side: "RIGHT",
				line: 44,
				startCol: 7,
				endCol: 20,
			},
		});
	});

	it("placed: the traced lines on the head, columns kept", () => {
		expect(at(line(), placed())).toEqual({
			kind: "new",
			changed: false,
			target: {
				path: "src/x.ts",
				commit: HEAD,
				subject: "line",
				startSide: "RIGHT",
				startLine: 47,
				side: "RIGHT",
				line: 50,
				startCol: 7,
				endCol: 20,
			},
		});
	});

	it("changed: the traced lines, without columns, flagged", () => {
		const changed: ThreadPlacement = {
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
		};
		const place = at(line(), changed);
		expect(place).toMatchObject({ kind: "new", changed: true });
		expect(place.kind === "new" && place.target).not.toHaveProperty("startCol");
		expect(place.kind === "new" && place.target).not.toHaveProperty("endCol");
	});

	it("LEFT stays LEFT", () => {
		const left = line({ side: "LEFT", startSide: "LEFT", commit: HEAD });
		expect(at(left, undefined)).toMatchObject({
			target: { side: "LEFT", startSide: "LEFT" },
		});
		expect(
			at(line({ side: "LEFT", startSide: "LEFT" }), placed({ side: "LEFT" })),
		).toMatchObject({ target: { side: "LEFT", startSide: "LEFT" } });
	});

	it("a file conversation: a file comment on its path now", () => {
		const file = conversation({
			subject: "file",
			path: "src/old.ts",
			commit: OLD,
		});
		expect(at(file, { kind: "file", path: "src/new.ts" })).toEqual({
			kind: "new",
			changed: false,
			target: { path: "src/new.ts", commit: HEAD, subject: "file" },
		});
		expect(
			at(
				conversation({ subject: "file", path: "src/x.ts", commit: HEAD }),
				undefined,
			),
		).toMatchObject({ target: { subject: "file", path: "src/x.ts" } });
	});

	it("unplaced or outside: the button is off, the lines are gone", () => {
		for (const p of [
			{
				kind: "unplaced",
				fate: "deleted",
				path: "src/x.ts",
				nearest: null,
			},
			{ kind: "outside", path: "src/x.ts", fate: "file-gone" },
		] satisfies ThreadPlacement[]) {
			expect(at(line(), p)).toEqual({ kind: "off", why: LINES_GONE });
		}
	});

	it("while the placement loads it is pending, never gone (principle 8); a failure says it couldn't trace", () => {
		expect(at(line(), undefined, "pending")).toEqual({ kind: "pending" });
		expect(
			commentPlace({
				thread: line(),
				head: undefined,
				placement: undefined,
				placing: "in",
			}),
		).toEqual({ kind: "pending" });
		expect(at(line(), undefined, "failed")).toEqual({
			kind: "off",
			why: UNTRACED,
		});
		// In, but this conversation isn't in the answer: it couldn't be traced.
		expect(at(line(), undefined, "in")).toEqual({ kind: "off", why: UNTRACED });
	});

	it("a GitHub-thread conversation replies to its thread; a deleted thread is off", () => {
		const gh = conversation({
			subject: "thread",
			thread: "PRRT_1",
			path: "src/x.ts",
			commit: OLD,
		});
		expect(at(gh, undefined, "pending")).toEqual({
			kind: "reply",
			thread: "PRRT_1",
		});
		expect(at({ ...gh, orphaned: true }, undefined)).toEqual({
			kind: "off",
			why: THREAD_GONE,
		});
	});
});

describe("commentPlace: a conversation on lines only the since view's earlier patch set had (CAR-264)", () => {
	const target = {
		path: "src/x.ts",
		commit: OLD,
		subject: "line" as const,
		startSide: "RIGHT" as const,
		startLine: 41,
		side: "RIGHT" as const,
		line: 44,
		earlier: true,
	};
	it("posts a new thread on that patch set's commit, marked earlier, whatever the tracer says (the lines are gone at the head)", () => {
		for (const placing of ["in", "pending", "failed"] as const) {
			expect(
				commentPlace({
					thread: line(),
					head: HEAD,
					placement: { kind: "unplaced", fate: "deleted" } as never,
					placing,
					earlier: target,
				}),
			).toEqual({ kind: "new", changed: false, target });
		}
	});
	it("off with the since view's reason where it can't (mixed, renamed)", () => {
		expect(
			commentPlace({
				thread: line(),
				head: HEAD,
				placement: undefined,
				placing: "pending",
				earlier: "Renamed since the earlier patch set",
			}),
		).toEqual({ kind: "off", why: "Renamed since the earlier patch set" });
	});
	it("a joined conversation still replies to its thread", () => {
		expect(
			commentPlace({
				thread: line({}),
				head: HEAD,
				placement: undefined,
				placing: "in",
				earlier: target,
				sibling: { kind: "reply", thread: "PRRT_9" },
			}),
		).toEqual({ kind: "reply", thread: "PRRT_9" });
	});
});

describe("commentPlace: a conversation joined to its comment's thread (CAR-236)", () => {
	it("another block posted as a new thread, its record not in: this one replies to that thread, never a second one", () => {
		expect(
			commentPlace({
				thread: line({ commit: HEAD }),
				head: HEAD,
				placement: undefined,
				placing: "in",
				sibling: { kind: "reply", thread: "PRRT_9" },
			}),
		).toEqual({ kind: "reply", thread: "PRRT_9" });
	});

	it("another block on its way or in doubt: this one waits (it may start the thread)", () => {
		expect(
			commentPlace({
				thread: line({ commit: HEAD }),
				head: HEAD,
				placement: undefined,
				placing: "in",
				sibling: { kind: "pending" },
			}),
		).toEqual({ kind: "pending", why: SIBLING_SENDING });
	});

	it("shown where it was asked because its thread isn't in this view: replies to its thread", () => {
		const shown = {
			...line(),
			joined: { thread: "PRRT_9", asked: line().anchor },
		};
		expect(at(shown, undefined, "pending")).toEqual({
			kind: "reply",
			thread: "PRRT_9",
		});
	});

	it("its joined thread deleted (back on its lines, orphaned): a new thread, as before the post, never a reply to the gone one", () => {
		const back = line({ commit: HEAD });
		expect(
			at(
				{
					...back,
					orphaned: true,
					joined: { thread: "PRRT_gone", asked: back.anchor },
				},
				undefined,
			),
		).toMatchObject({ kind: "new", changed: false });
	});

	it("another block in doubt, this block's lines gone: off with its reason, never waiting forever", () => {
		expect(
			commentPlace({
				thread: line(),
				head: HEAD,
				placement: { kind: "unplaced" } as unknown as ThreadPlacement,
				placing: "in",
				sibling: { kind: "pending" },
			}),
		).toEqual({ kind: "off", why: LINES_GONE });
		// A placement failed: off too.
		expect(
			commentPlace({
				thread: line(),
				head: HEAD,
				placement: undefined,
				placing: "failed",
				sibling: { kind: "pending" },
			}),
		).toEqual({ kind: "off", why: UNTRACED });
	});

	it("another block posted, this block's lines gone: a reply needs no lines, so it replies", () => {
		expect(
			commentPlace({
				thread: line(),
				head: HEAD,
				placement: undefined,
				placing: "failed",
				sibling: { kind: "reply", thread: "PRRT_9" },
			}),
		).toEqual({ kind: "reply", thread: "PRRT_9" });
	});

	it("shown where it was asked while GitHub can't be read: off, never a second new thread", () => {
		const unknown = line({ commit: HEAD });
		expect(
			at(
				{
					...unknown,
					githubUnknown: true,
					joined: { thread: "PRRT_9", asked: unknown.anchor },
				},
				undefined,
			),
		).toEqual({ kind: "off", why: GITHUB_UNKNOWN });
	});
});

describe("siblingKey: the conversation's other blocks in this browser (CAR-236)", () => {
	const T = "01k9e6m2q8x4v7c3n5b0h1j2t6";
	const M = "01k9e6m2q8x4v7c3n5b0h1j2t7";
	const id = (block: number) => `ag.${T}.${M}.${block}`;
	const keep = (block: number, kept: unknown) =>
		localStorage.setItem(
			`crb:agent-comment:${id(block)}`,
			JSON.stringify(kept),
		);
	const posted = (thread: string, at: string) => ({
		posted: {
			block: 0,
			url: "https://x",
			at,
			text: "x",
			github: { thread, comment: "C", url: "https://x" },
		},
	});
	beforeEach(() => {
		localStorage.clear();
		resetAgentComments();
	});

	it("nothing kept: none; this block's own state never counts", () => {
		expect(siblingKey(T, id(0))).toBe("");
		keep(0, { sending: { attemptedAt: "2026-11-16T10:00:00Z", body: "x" } });
		expect(siblingKey(T, id(0))).toBe("");
	});

	it("another on its way: pending; another posted (record not in): reply to the earliest's thread", () => {
		keep(1, { sending: { attemptedAt: "2026-11-16T10:00:00Z", body: "x" } });
		expect(siblingKey(T, id(0))).toBe("pending");
		expect(siblingOf("pending")).toEqual({ kind: "pending" });
		keep(2, posted("PRRT_late", "2026-11-16T10:09:00Z"));
		keep(3, posted("PRRT_first", "2026-11-16T10:05:00Z"));
		resetAgentComments();
		expect(siblingKey(T, id(0))).toBe("reply:PRRT_first");
		expect(siblingOf("reply:PRRT_first")).toEqual({
			kind: "reply",
			thread: "PRRT_first",
		});
	});

	it("another conversation's blocks count for nothing", () => {
		localStorage.setItem(
			`crb:agent-comment:ag.01k9e6m2q8x4v7c3n5b0h1j2z9.${M}.1`,
			JSON.stringify(posted("PRRT_x", "2026-11-16T10:05:00Z")),
		);
		expect(siblingKey(T, id(0))).toBe("");
	});
});

describe("opensThreadCard", () => {
	it("only a conversation on lines or a file whose post was recorded (it joined): never on a failed record", () => {
		const onLines = line();
		expect(opensThreadCard(onLines, true)).toBe(true);
		expect(opensThreadCard(onLines, false)).toBe(false);
		const onThread = conversation({
			subject: "thread",
			thread: "PRRT_1",
			path: "src/x.ts",
			commit: OLD,
		});
		expect(opensThreadCard(onThread, true)).toBe(false);
	});
});

describe("postLabel / postsAsReply: the box's button and header (CAR-237)", () => {
	const joined = {
		joined: {
			thread: "PRRT_1",
			asked: { subject: "file" as const, path: "a", commit: OLD },
		},
	};
	const target = { path: "a", commit: HEAD, subject: "file" as const };
	it.each([
		["a reply", { kind: "reply", thread: "T" }, {}, "Reply"],
		[
			"a new thread",
			{ kind: "new", target, changed: false },
			{},
			"Add review comment",
		],
		["placing", { kind: "pending" }, {}, "Add review comment"],
		[
			"waiting for a sibling's thread",
			{ kind: "pending", why: SIBLING_SENDING },
			{},
			"Add review comment",
		],
		[
			"GitHub unread, joined",
			{ kind: "off", why: GITHUB_UNKNOWN },
			joined,
			"Reply",
		],
		[
			"GitHub unread, not joined",
			{ kind: "off", why: GITHUB_UNKNOWN },
			{},
			"Add review comment",
		],
		[
			"lines gone",
			{ kind: "off", why: LINES_GONE },
			joined,
			"Add review comment",
		],
	] as const)("%s: %s", (_name, place, thread, label) => {
		expect(postLabel(place as CommentPlace, thread)).toBe(label);
		expect(postsAsReply(place as CommentPlace, thread)).toBe(label === "Reply");
	});
});

describe("placeLabel", () => {
	it("short line numbers, a span with columns, File and Reply; the tooltip in full", () => {
		const onHead = line({ commit: HEAD, startCol: null, endCol: null });
		const one = commentPlace({
			thread: onHead,
			head: HEAD,
			placement: undefined,
			placing: "in",
		});
		expect(placeLabel(one, onHead.anchor)).toEqual({
			short: "L41–44",
			full: "New thread on src/x.ts, lines 41–44, new",
		});
		const span = at(line({ commit: HEAD }), undefined);
		expect(placeLabel(span, line().anchor).short).toBe("L41:8–44:20");
		const moved = at(line(), placed());
		expect(placeLabel(moved, line().anchor).full).toBe(
			"New thread on src/x.ts, lines 47–50, new, at the latest push",
		);
		const file = at(
			conversation({ subject: "file", path: "src/x.ts", commit: HEAD }),
			undefined,
		);
		expect(
			placeLabel(file, { subject: "file", path: "src/x.ts", commit: HEAD }),
		).toEqual({
			short: "File",
			full: "New comment on src/x.ts",
		});
		expect(
			placeLabel(
				{ kind: "reply", thread: "T" },
				{ subject: "thread", thread: "T", path: "a", commit: "" },
			),
		).toEqual({ short: "Reply", full: "Reply on this GitHub thread" });
		// Off: where it was asked.
		expect(
			placeLabel({ kind: "off", why: LINES_GONE }, line().anchor).short,
		).toBe("L41:8–44:20");
		expect(
			placeLabel(
				{ kind: "pending" },
				{
					subject: "line",
					path: "a",
					commit: OLD,
					side: "RIGHT",
					line: 3,
					startSide: "RIGHT",
					startLine: 3,
				},
			).short,
		).toBe("L3");
	});
});

describe("knownForReply: what a reply's retry may not take for itself", () => {
	const c = (id: string, publishedAt: string | null) => ({ id, publishedAt });
	const message = { at: "2026-11-16T10:00:00.000Z" };

	it("a thread younger than the message (its block started it, CAR-236): the opener is known, nothing else", () => {
		expect(
			knownForReply(
				[
					c("opener", "2026-11-16T10:01:00Z"),
					c("mine", "2026-11-16T10:02:00Z"),
				],
				message,
			),
		).toEqual(["opener"]);
	});

	it("a later block's recorded post never makes an earlier block's own reply known (it is found, not posted twice)", () => {
		// Block 1's reply landed (its record lost), block 2's was recorded
		// after it: block 1 pressed again on another device must find its own.
		const comments = [
			c("opener", "2026-11-16T10:01:00Z"),
			c("block1", "2026-11-16T10:02:00Z"),
			c("block2", "2026-11-16T10:03:00Z"),
		];
		const known = knownForReply(comments, message);
		expect(known).not.toContain("block1");
		expect(known).not.toContain("block2");
	});

	it("the opener is the first listed, even when it isn't published (pending): a published reply is never taken for it", () => {
		expect(
			knownForReply(
				[c("opener", null), c("mine", "2026-11-16T10:02:00Z")],
				message,
			),
		).toEqual(["opener"]);
	});

	it("an older thread: what knownBefore gives, the opener among them", () => {
		expect(
			knownForReply(
				[
					c("b", "2026-11-16T09:30:00Z"),
					c("a", "2026-11-16T09:00:00Z"),
					c("late", "2026-11-16T10:30:00Z"),
				],
				message,
			),
		).toEqual(["b", "a"]);
	});
});

describe("knownBefore: what a reply's retry may not take for itself", () => {
	it("the thread's comments published up to the agent's message, and pending ones", () => {
		const c = (id: string, publishedAt: string | null) => ({ id, publishedAt });
		expect(
			knownBefore(
				[
					c("a", "2026-11-16T09:00:00Z"),
					c("b", "2026-11-16T10:00:00Z"),
					c("c", "2026-11-16T10:00:01Z"),
					c("d", null),
					c("", "2026-11-16T08:00:00Z"),
				],
				"2026-11-16T10:00:00.000Z",
			),
		).toEqual(["a", "b", "d"]);
	});
});
