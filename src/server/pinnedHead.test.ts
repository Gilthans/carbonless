import { describe, expect, it } from "vitest";
import { parseHead, pickHead } from "./pinnedHead";

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
) => ({
	author: { login, __typename: "User" },
	state,
	submittedAt,
	commit: { oid },
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
