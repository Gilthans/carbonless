import { describe, expect, it } from "vitest";
import { needsCommentPages, parseHead, pickHead } from "./pinnedHead";

const A = `abc1234${"a".repeat(33)}`;
const B = `abc1299${"b".repeat(33)}`;
const C = "c".repeat(40);
const D = "d".repeat(40);
const PR = "acme/widget#12";
const commit = (oid: string) => ({ commit: { oid } });
const review = (
	login: string,
	oid: string,
	submittedAt: string | null,
	state = "COMMENTED",
	more: Record<string, unknown> = { body: "Looks fine" },
) => ({
	author: { login, __typename: "User" },
	state,
	submittedAt,
	commit: { oid },
	...more,
});
/** Its comments' first page: each a reply (`true`) or a new thread. */
const comments = (replies: boolean[], hasNextPage = false) => ({
	comments: {
		pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor:1" : null },
		nodes: replies.map((r) => ({ replyTo: r ? { id: "C1" } : null })),
	},
});
/** A COMMENTED review with no body and these comments. */
const silent = (
	login: string,
	oid: string,
	at: string,
	replies: boolean[],
	hasNextPage = false,
) =>
	review(login, oid, at, "COMMENTED", {
		body: "",
		...comments(replies, hasNextPage),
	});
const reviewed = { kind: "reviewed" } as const;
const sha = (prefix: string) => ({ kind: "sha", prefix }) as const;

describe("parseHead", () => {
	it("takes reviewed or a sha of 7+ hex digits, lowercased", () => {
		expect(parseHead("reviewed")).toEqual(reviewed);
		expect(parseHead("Reviewed")).toEqual(reviewed);
		expect(parseHead("ABC1234")).toEqual(sha("abc1234"));
		expect(parseHead(C)).toEqual(sha(C));
	});

	it("rejects anything else", () => {
		for (const bad of ["abc123", "latest", "xyz1234", "", `${C}${C}a`]) {
			expect(() => parseHead(bad)).toThrow(/Invalid --head/);
		}
	});
});

describe("pickHead: reviewed", () => {
	it("takes the viewer's latest submitted review, in any state", () => {
		const reviews = [
			review("Octo_Cat", A, "2026-01-01T00:00:00Z", "APPROVED"),
			review("Octo_Cat", B, "2026-01-03T00:00:00Z", "DISMISSED"),
			review("Octo_Cat", C, "2026-01-02T00:00:00Z", "CHANGES_REQUESTED"),
		];
		expect(pickHead(reviewed, [], reviews, "octo-cat", PR)).toBe(B);
	});

	it("ignores pending reviews and other people's", () => {
		const reviews = [
			review("Octo_Cat", A, "2026-01-01T00:00:00Z"),
			review("Octo_Cat", B, null, "PENDING"),
			review("rev1", C, "2026-01-05T00:00:00Z"),
		];
		expect(pickHead(reviewed, [], reviews, "octo-cat", PR)).toBe(A);
	});

	it("on a tie, takes the later one in GitHub's list", () => {
		const at = "2026-01-01T00:00:00Z";
		const reviews = [review("dan", A, at), review("dan", C, at)];
		expect(pickHead(reviewed, [], reviews, "dan", PR)).toBe(C);
	});

	it("fails when the latest review has no commit, never taking an older one", () => {
		const reviews = [
			review("dan", A, "2026-01-01T00:00:00Z"),
			{ ...review("dan", A, "2026-01-02T00:00:00Z"), commit: null },
		];
		expect(() => pickHead(reviewed, [], reviews, "dan", PR)).toThrow(
			"dan's last review on acme/widget#12 has no commit",
		);
		const bad = [
			review("dan", A, "2026-01-01T00:00:00Z"),
			review("dan", "not-an-oid", "2026-01-02T00:00:00Z"),
		];
		expect(() => pickHead(reviewed, [], bad, "dan", PR)).toThrow(
			/has no commit/,
		);
	});

	it("skips a later review that only replied to threads", () => {
		const reviews = [
			review("dan", A, "2026-01-01T00:00:00Z", "COMMENTED", {
				body: "",
				...comments([false]),
			}),
			silent("dan", C, "2026-01-02T00:00:00Z", [true, true]),
		];
		expect(pickHead(reviewed, [], reviews, "dan", PR)).toBe(A);
	});

	it("counts a review with a body, a new thread, or any other state", () => {
		const first = review("dan", A, "2026-01-01T00:00:00Z");
		const later = "2026-01-02T00:00:00Z";
		for (const r of [
			// A body, replies only.
			review("dan", C, later, "COMMENTED", {
				body: "Also:",
				...comments([true]),
			}),
			// One new thread among replies.
			silent("dan", C, later, [true, false]),
			// Not COMMENTED.
			review("dan", C, later, "APPROVED", { body: "", ...comments([true]) }),
			review("dan", C, later, "CHANGES_REQUESTED", {
				body: "",
				...comments([true]),
			}),
			review("dan", C, later, "DISMISSED", { body: "", ...comments([true]) }),
		]) {
			expect(pickHead(reviewed, [], [first, r], "dan", PR)).toBe(C);
		}
	});

	it("fails closed when a bodiless comment review's comments aren't all there", () => {
		const first = review("dan", A, "2026-01-01T00:00:00Z");
		for (const r of [
			silent("dan", C, "2026-01-02T00:00:00Z", [true], true),
			review("dan", C, "2026-01-02T00:00:00Z", "COMMENTED", { body: "" }),
		]) {
			expect(() => pickHead(reviewed, [], [first, r], "dan", PR)).toThrow(
				/Could not tell whether dan's review of .* only replies to threads/,
			);
		}
	});

	it("asks for more comment pages only for the viewer's bodiless comment reviews", () => {
		const at = "2026-01-02T00:00:00Z";
		expect(needsCommentPages(silent("dan", C, at, [true], true), "dan")).toBe(
			true,
		);
		expect(needsCommentPages(silent("dan", C, at, [true]), "dan")).toBe(false);
		expect(needsCommentPages(silent("rev1", C, at, [true], true), "dan")).toBe(
			false,
		);
		expect(
			needsCommentPages(
				review("dan", C, at, "COMMENTED", {
					body: "Hi",
					...comments([true], true),
				}),
				"dan",
			),
		).toBe(false);
	});

	it("says so when the viewer only ever replied", () => {
		const reviews = [silent("dan", C, "2026-01-02T00:00:00Z", [true])];
		expect(() => pickHead(reviewed, [], reviews, "dan", PR)).toThrow(
			"dan has only replied to threads on acme/widget#12, never reviewed it",
		);
	});

	it("fails clearly without a submitted review", () => {
		const reviews = [
			review("dan", B, null, "PENDING"),
			review("rev1", C, "2026-01-05T00:00:00Z"),
		];
		expect(() => pickHead(reviewed, [], reviews, "dan", PR)).toThrow(
			"dan has no submitted review on acme/widget#12",
		);
	});
});

describe("pickHead: a sha", () => {
	const commits = [commit(A), commit(C)];
	// D was reviewed, then force-pushed away: not in the commit list.
	const reviews = [review("rev1", D, "2026-01-01T00:00:00Z")];

	it("takes a full or abbreviated sha of the PR's commits or reviewed commits", () => {
		expect(pickHead(sha(C), commits, reviews, "dan", PR)).toBe(C);
		expect(pickHead(sha("abc1234"), commits, reviews, "dan", PR)).toBe(A);
		expect(pickHead(sha("ddddddd"), commits, reviews, "dan", PR)).toBe(D);
	});

	it("fails clearly on a commit not of the PR, or an ambiguous prefix", () => {
		expect(() => pickHead(sha("eeeeeee"), commits, reviews, "dan", PR)).toThrow(
			"eeeeeee is not a commit of acme/widget#12",
		);
		expect(() =>
			pickHead(sha("abc12"), [...commits, commit(B)], reviews, "dan", PR),
		).toThrow(/names more than one commit/);
	});
});
