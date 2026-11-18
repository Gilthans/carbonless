import { describe, expect, it } from "vitest";
import type { AgentSpanAnchor } from "../../shared/agent";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import {
	commentPlace,
	knownBefore,
	LINES_GONE,
	type PostingThread,
	placeLabel,
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
