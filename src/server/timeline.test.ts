import { describe, expect, it } from "vitest";
import {
	timelineComment,
	timelineCommit,
	timelineFact,
	timelineReview,
} from "../../test/fake-gh/scenario.js";
import type { TimelineEvent } from "../shared/types.js";
import { threadsByComment } from "./overviewRead.js";
import { buildTimeline, firstLine } from "./timeline.js";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const at = (min: number) =>
	new Date(Date.UTC(2026, 0, 2, 10, min)).toISOString().replace(".000Z", "Z");

/** Each event as "kind:login:count" (facts: "kind:login"). */
function shape(events: TimelineEvent[]): string[] {
	return events.map((e) =>
		e.kind === "commits" || e.kind === "review"
			? `${e.kind}:${e.actor.login}:${e.items.length}`
			: `${e.kind}:${e.actor.login}`,
	);
}

const build = (nodes: unknown[], more: { asOf?: string } = {}) =>
	buildTimeline({ nodes, commitCount: null, ...more });

describe("buildTimeline", () => {
	it("makes runs of one author's commits and one person's review activity", () => {
		const { events, gaps } = build([
			timelineCommit({ login: "ann", at: at(1), oid: sha(1) }),
			timelineCommit({ login: "ann", at: at(2), oid: sha(2) }),
			timelineReview({
				login: "bob",
				at: at(3),
				comments: [
					{ id: "c1", path: "a.ts", line: 3, at: at(3), text: "Why?" },
				],
			}),
			timelineComment({ login: "bob", at: at(4), text: "Also this" }),
			timelineCommit({ login: "ann", at: at(5), oid: sha(3) }),
			timelineReview({ login: "cy", at: at(6), state: "APPROVED" }),
			timelineReview({ login: "bob", at: at(7), state: "CHANGES_REQUESTED" }),
		]);
		expect(shape(events)).toEqual([
			"commits:ann:2",
			"review:bob:2",
			"commits:ann:1",
			"review:cy:1",
			"review:bob:1",
		]);
		expect(gaps).toEqual([]);
		const first = events[0];
		expect(first?.kind === "commits" && [first.from, first.to]).toEqual([
			at(1),
			at(2),
		]);
	});

	it("keeps a person's run apart when someone else acts in between", () => {
		// Same author's commits on either side of another person's review.
		const { events } = build([
			timelineCommit({ login: "ann", at: at(1), oid: sha(1) }),
			timelineReview({ login: "bob", at: at(2), text: "Looks odd" }),
			timelineCommit({ login: "ann", at: at(3), oid: sha(2) }),
		]);
		expect(shape(events)).toEqual([
			"commits:ann:1",
			"review:bob:1",
			"commits:ann:1",
		]);
	});

	it("starts a new run for another kind by the same person", () => {
		const { events } = build([
			timelineComment({ login: "ann", at: at(1), text: "Pushing a fix" }),
			timelineCommit({ login: "ann", at: at(2), oid: sha(1) }),
			timelineComment({ login: "ann", at: at(3), text: "Done" }),
		]);
		expect(shape(events)).toEqual([
			"review:ann:1",
			"commits:ann:1",
			"review:ann:1",
		]);
	});

	it("keeps bots as their own actors", () => {
		const { events } = build([
			timelineReview({
				login: "cursor",
				bot: true,
				at: at(1),
				comments: [{ id: "c1", path: "a", line: 1, at: at(1), text: "x" }],
			}),
			timelineReview({
				login: "cursor",
				bot: true,
				at: at(2),
				comments: [{ id: "c2", path: "a", line: 2, at: at(2), text: "y" }],
			}),
			timelineComment({ login: "dependabot[bot]", at: at(3), text: "bump" }),
			timelineComment({ login: "ann", at: at(4), text: "ok" }),
		]);
		expect(shape(events)).toEqual([
			"review:cursor:2",
			"review:dependabot[bot]:1",
			"review:ann:1",
		]);
		expect(events.map((e) => e.actor.bot)).toEqual([true, true, false]);
	});

	it("shows a history fact alone, and it ends a run", () => {
		const { events } = build([
			timelineCommit({ login: "ann", at: at(1), oid: sha(1) }),
			timelineFact("HeadRefForcePushedEvent", {
				login: "ann",
				at: at(2),
				beforeCommit: { oid: sha(1) },
				afterCommit: { oid: sha(2) },
			}),
			timelineCommit({ login: "ann", at: at(3), oid: sha(3) }),
			timelineFact("BaseRefChangedEvent", {
				login: "ann",
				at: at(4),
				previousRefName: "main",
				currentRefName: "release",
			}),
			timelineFact("ConvertToDraftEvent", { login: "ann", at: at(5) }),
			timelineFact("ReadyForReviewEvent", { login: "ann", at: at(6) }),
			timelineFact("ClosedEvent", { login: "bob", at: at(7) }),
			timelineFact("ReopenedEvent", { login: "bob", at: at(8) }),
			timelineFact("MergedEvent", {
				login: "bob",
				at: at(9),
				commit: { oid: sha(9) },
			}),
		]);
		expect(shape(events)).toEqual([
			"commits:ann:1",
			"force-push:ann",
			"commits:ann:1",
			"base-change:ann",
			"draft:ann",
			"ready:ann",
			"closed:bob",
			"reopened:bob",
			"merged:bob",
		]);
		expect(events[1]).toMatchObject({ before: sha(1), after: sha(2) });
		expect(events[3]).toMatchObject({ before: "main", after: "release" });
		expect(events[8]).toMatchObject({ commit: sha(9) });
	});

	it("orders by time, equal times in GitHub's order, every time the same", () => {
		const nodes = [
			timelineCommit({ login: "ann", at: at(5), oid: sha(1) }),
			timelineCommit({ login: "ann", at: at(5), oid: sha(2) }),
			timelineComment({ login: "bob", at: at(5), text: "same minute" }),
			timelineCommit({ login: "ann", at: at(1), oid: sha(3) }),
		];
		const once = build(nodes);
		expect(shape(once.events)).toEqual(["commits:ann:3", "review:bob:1"]);
		const commits = once.events[0];
		expect(
			commits?.kind === "commits" && commits.items.map((c) => c.oid),
		).toEqual([sha(3), sha(1), sha(2)]);
		expect(build(nodes)).toEqual(once);
	});

	it("keeps an undated item where GitHub listed it", () => {
		const { events } = build([
			timelineCommit({ login: "ann", at: at(1), oid: sha(1) }),
			timelineComment({ login: "bob", at: "", text: "no time" }),
			timelineCommit({ login: "ann", at: at(2), oid: sha(2) }),
		]);
		expect(shape(events)).toEqual([
			"commits:ann:1",
			"review:bob:1",
			"commits:ann:1",
		]);
	});

	it("as of a cutoff: only what happened by then", () => {
		const { events } = build(
			[
				timelineCommit({ login: "ann", at: at(1), oid: sha(1) }),
				timelineReview({
					login: "bob",
					at: at(4),
					state: "APPROVED",
					comments: [
						// Written before the cutoff (as the threads count it).
						{ id: "c1", path: "a", line: 1, at: at(2), text: "early" },
					],
				}),
				timelineFact("MergedEvent", { login: "bob", at: at(5) }),
			],
			{ asOf: at(3) },
		);
		expect(shape(events)).toEqual(["commits:ann:1", "review:bob:1"]);
		const review = events[1];
		expect(review?.kind === "review" && review.items[0]?.kind).toBe("comment");
	});

	it("maps a review: verdict or text as an item, a plain reply as its comment alone", () => {
		const { events } = build([
			timelineReview({
				login: "bob",
				at: at(1),
				state: "CHANGES_REQUESTED",
				text: "Please fix\nmore",
				comments: [
					{ id: "c1", path: "src/a.ts", line: 7, at: at(1), text: "Here\nand" },
				],
			}),
			// A reply: a COMMENTED review with no text.
			timelineReview({
				login: "bob",
				at: at(2),
				comments: [
					{
						id: "c2",
						path: "src/a.ts",
						line: 7,
						at: at(2),
						text: "Ping",
						replyTo: "c1",
					},
				],
			}),
			// The viewer's own pending review: not submitted, not shown.
			timelineReview({ login: "bob", at: "", state: "PENDING", text: "draft" }),
		]);
		const review = events[0];
		expect(review?.kind).toBe("review");
		expect(review?.kind === "review" && review.items).toEqual([
			{
				kind: "review",
				at: at(1),
				state: "CHANGES_REQUESTED",
				text: "Please fix",
				url: expect.any(String),
			},
			{
				kind: "comment",
				at: at(1),
				path: "src/a.ts",
				line: 7,
				text: "Here",
				url: expect.any(String),
				threadId: null,
			},
			expect.objectContaining({ kind: "comment", text: "Ping" }),
		]);
	});

	it("ties review comments to their threads by comment id, replies by the one they answer", () => {
		const threadOf = threadsByComment([
			{
				id: "T1",
				first: { nodes: [{ id: "c1" }] },
				comments: { nodes: [{ id: "c1" }, { id: "c2" }] },
			},
			{ id: "T2", first: { nodes: [{ id: "c9" }] } },
		]);
		const { events } = buildTimeline({
			nodes: [
				timelineReview({
					login: "bob",
					at: at(1),
					comments: [
						{ id: "c1", path: "a", line: 1, at: at(1), text: "x" },
						{ id: "c2", path: "a", line: 1, at: at(1), text: "y" },
						// Past the 100 comments a summary lists: by the one it answers.
						{
							id: "c3",
							path: "b",
							line: 1,
							at: at(1),
							text: "z",
							replyTo: "c9",
						},
						{ id: "c4", path: "c", line: 1, at: at(1), text: "?" },
					],
				}),
			],
			commitCount: null,
			threadOf,
		});
		const review = events[0];
		expect(
			review?.kind === "review" &&
				review.items.map((i) => (i.kind === "comment" ? i.threadId : "-")),
		).toEqual(["T1", "T1", "T2", null]);
	});

	it("says what GitHub didn't list", () => {
		const { gaps } = buildTimeline({
			nodes: [
				timelineCommit({ login: "ann", at: at(1), oid: sha(1) }),
				timelineReview({
					login: "bob",
					at: at(2),
					comments: [{ id: "c1", path: "a", line: 1, at: at(2), text: "x" }],
					totalComments: 103,
				}),
			],
			commitCount: 251,
		});
		expect(gaps).toEqual([
			"GitHub listed 1 of 251 commits",
			"102 review comments past GitHub's first 100 of a review not listed",
		]);
	});

	it("takes the first line of text, at most 200 characters", () => {
		expect(firstLine("\n\n  hello  \nworld")).toBe("hello");
		expect(firstLine(undefined)).toBe("");
		expect(firstLine("x".repeat(300))).toHaveLength(200);
	});
});
