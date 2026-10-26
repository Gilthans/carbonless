import { describe, expect, it } from "vitest";
import { reviewThread, threadComment } from "../../test/fake-gh/scenario";
import { visibleAt } from "./commentTime";
import { mapThreads } from "./overview";

/** No PR author or viewer: these tests are about dates. */
const ctx = (asOf?: string) => ({ asOf, prAuthor: "", viewer: "" });

describe("visibleAt", () => {
	it("is when the comment was published, else its review submitted, else written", () => {
		expect(
			visibleAt({
				createdAt: "2026-01-01T00:00:00Z",
				publishedAt: "2026-01-02T00:00:00Z",
			}),
		).toBe("2026-01-02T00:00:00Z");
		expect(
			visibleAt(
				{ createdAt: "2026-01-01T00:00:00Z", publishedAt: null },
				"2026-01-03T00:00:00Z",
			),
		).toBe("2026-01-03T00:00:00Z");
		expect(
			visibleAt({
				createdAt: "2026-01-01T00:00:00Z",
				pullRequestReview: {
					state: "COMMENTED",
					submittedAt: "2026-01-04T00:00:00Z",
				},
			}),
		).toBe("2026-01-04T00:00:00Z");
		expect(
			visibleAt({ createdAt: "2026-01-01T00:00:00Z", publishedAt: null }),
		).toBe("2026-01-01T00:00:00Z");
	});

	it("is null for a pending comment, and never throws on junk", () => {
		expect(
			visibleAt({
				createdAt: "2026-01-01T00:00:00Z",
				publishedAt: null,
				state: "PENDING",
			}),
		).toBeNull();
		expect(
			visibleAt({
				createdAt: "2026-01-01T00:00:00Z",
				pullRequestReview: { state: "PENDING", submittedAt: null },
			}),
		).toBeNull();
		expect(visibleAt(null)).toBe("");
		expect(visibleAt("x")).toBe("");
	});
});

describe("mapThreads dates comments by when they were published", () => {
	type C = Omit<Parameters<typeof threadComment>[0], "login">;
	const ann = (c: C) => threadComment({ login: "ann", ...c });
	const bob = (c: C) => threadComment({ login: "bob", ...c });
	const CUTOFF = "2026-01-03T12:00:00Z";
	// Drafted at 10:00 in a review submitted at 13:00, after the cutoff.
	const drafted = reviewThread({ path: "drafted.ts" }, [
		ann({
			text: "drafted early",
			createdAt: "2026-01-03T10:00:00Z",
			publishedAt: "2026-01-03T13:00:00Z",
		}),
	]);
	// Opened at 09:00; a reply drafted at 11:00, submitted at 14:00.
	const replied = reviewThread({ path: "replied.ts" }, [
		ann({ text: "open", createdAt: "2026-01-03T09:00:00Z" }),
		bob({
			text: "late reply",
			createdAt: "2026-01-03T11:00:00Z",
			publishedAt: "2026-01-03T14:00:00Z",
		}),
	]);

	it("as of a cutoff, hides what was drafted by then but submitted after", () => {
		const threads = mapThreads([drafted, replied], ctx(CUTOFF));
		expect(
			threads.map((t) => [
				t.path,
				t.commentCount,
				t.hasReply,
				t.lastActivityAt,
			]),
		).toEqual([["replied.ts", 1, false, "2026-01-03T09:00:00Z"]]);
		// Submitted by the cutoff: shown, at its submission.
		const shown = mapThreads([drafted], ctx("2026-01-03T13:00:00Z"));
		expect(shown.map((t) => t.createdAt)).toEqual(["2026-01-03T13:00:00Z"]);
	});

	it("opens, updates and orders threads by publication", () => {
		const threads = mapThreads([drafted, replied], ctx());
		expect(
			threads.map((t) => [t.path, t.createdAt, t.lastActivityAt, t.hasReply]),
		).toEqual([
			// Its reply was published last (written before the other's opener).
			["replied.ts", "2026-01-03T09:00:00Z", "2026-01-03T14:00:00Z", true],
			["drafted.ts", "2026-01-03T13:00:00Z", "2026-01-03T13:00:00Z", false],
		]);
	});

	it("keeps the code at when the comment was written (the author's view)", () => {
		const [t] = mapThreads(
			[
				reviewThread({ path: "code.ts", line: 3 }, [
					ann({
						text: "x",
						createdAt: "2026-01-03T10:00:00Z",
						publishedAt: "2026-01-03T13:00:00Z",
						commit: "a".repeat(40),
					}),
				]),
			],
			ctx(),
		);
		expect(t?.code?.anchor.at).toBe("2026-01-03T10:00:00Z");
		expect(t?.createdAt).toBe("2026-01-03T13:00:00Z");
	});

	it("leaves out the viewer's pending comments: a thread they open, a reply in another", () => {
		const pendingThread = reviewThread({ path: "pending.ts" }, [
			ann({
				text: "not yet",
				createdAt: "2026-01-03T10:00:00Z",
				pending: true,
			}),
		]);
		const pendingReply = reviewThread({ path: "open.ts" }, [
			bob({ text: "open", createdAt: "2026-01-03T09:00:00Z" }),
			ann({ text: "draft", createdAt: "2026-01-03T15:00:00Z", pending: true }),
		]);
		for (const asOf of [undefined, "2026-01-04T00:00:00Z"]) {
			const threads = mapThreads([pendingThread, pendingReply], ctx(asOf));
			expect(
				threads.map((t) => [
					t.path,
					t.commentCount,
					t.hasReply,
					t.lastActivityAt,
				]),
			).toEqual([["open.ts", 1, false, "2026-01-03T09:00:00Z"]]);
		}
	});

	it("doesn't count a pending latest comment past the first 100 listed", () => {
		const node = reviewThread({ path: "long.ts" }, [
			bob({ text: "open", createdAt: "2026-01-03T09:00:00Z" }),
		]);
		node.comments.totalCount = 150;
		node.latest = {
			nodes: [
				{
					createdAt: "2026-01-03T15:00:00Z",
					publishedAt: null,
					state: "PENDING",
				},
			],
		};
		const [t] = mapThreads([node], ctx());
		expect(t?.commentCount).toBe(149);
		expect(t?.lastActivityAt).toBe("2026-01-03T09:00:00Z");
	});

	it("falls back to when it was written when GitHub reports no publication", () => {
		const [t] = mapThreads(
			[
				reviewThread({ path: "a.ts" }, [
					ann({
						text: "x",
						createdAt: "2026-01-03T10:00:00Z",
						publishedAt: null,
					}),
				]),
			],
			ctx(CUTOFF),
		);
		expect(t?.createdAt).toBe("2026-01-03T10:00:00Z");
	});
});
