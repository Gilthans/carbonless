import { describe, expect, it } from "vitest";
import {
	isRereview,
	NEW_PR_QUESTIONS,
	REREVIEW_QUESTIONS,
	type RereviewFacts,
	reviewQuestions,
	SPAN_QUESTIONS,
	withQuestion,
} from "./quickQuestions";

const ps = (...heads: string[]) =>
	heads.map((head, i) => ({
		number: i + 1,
		head,
	})) as RereviewFacts["patchsets"];
const headInfo = (oid: string) => ({
	oid,
	mergeBase: "b",
	baseBranch: "main",
	commits: 0,
});
/** A session: the snapshot's head, the patch sets, GitHub's head (null: no head check). */
const facts = (
	snapshotHead: string,
	patchsets: RereviewFacts["patchsets"],
	head: string | null = snapshotHead,
	more: Partial<RereviewFacts> = {},
): RereviewFacts => ({
	snapshotHead,
	currentHead: head ?? snapshotHead,
	patchsets,
	head: head === null ? null : headInfo(head),
	asOf: null,
	pinnedHead: null,
	...more,
});

describe("withQuestion", () => {
	it("replaces an empty or blank box", () => {
		expect(withQuestion("", "Why this change?")).toBe("Why this change?");
		expect(withQuestion("  \n ", "Why this change?")).toBe("Why this change?");
	});

	it("appends on a new line after typed text, its trailing space dropped", () => {
		expect(withQuestion("Look at x.", "Is this tested?")).toBe(
			"Look at x.\nIs this tested?",
		);
		expect(withQuestion("  Look at x. \n\n", "Is this tested?")).toBe(
			"  Look at x.\nIs this tested?",
		);
	});
});

describe("isRereview", () => {
	it.each<[string, RereviewFacts | undefined, boolean | undefined]>([
		["the session unknown", undefined, undefined],
		["no patch set yet", facts("h1", []), false],
		["the first patch set, the PR's head", facts("h1", ps("h1")), false],
		["a second patch set", facts("h2", ps("h1", "h2")), true],
		[
			"pushed after the first patch set (the snapshot still on it)",
			facts("h1", ps("h1"), "h2"),
			true,
		],
		[
			"the snapshot moved on, no patch set of its own yet",
			facts("h2", ps("h1")),
			true,
		],
		[
			"merged on the reviewed head (no head check)",
			facts("h1", ps("h1"), null),
			false,
		],
		[
			"pushed after PS1, then merged: GitHub's last head, not PS1's pinned one",
			facts("h1", ps("h1"), null, { currentHead: "h2" }),
			true,
		],
		[
			"merged after a second patch set",
			facts("h2", ps("h1", "h2"), null),
			true,
		],
		[
			"as of a time: the snapshot's head",
			facts("h1", ps("h1"), null, { currentHead: "h2", asOf: "2026-11-01" }),
			false,
		],
		[
			"a pinned head: the snapshot's",
			facts("h1", ps("h1"), null, { currentHead: "h2", pinnedHead: "h1" }),
			false,
		],
	])("%s", (_, f, want) => {
		expect(isRereview(f, true)).toBe(want);
	});

	it("patch sets on one head wait for the head check; none, or two heads, never do", () => {
		expect(isRereview(facts("h1", ps("h1")), false)).toBeUndefined();
		expect(isRereview(facts("h1", ps("h1"), "h2"), false)).toBeUndefined();
		expect(isRereview(facts("h1", []), false)).toBe(false);
		expect(isRereview(facts("h2", ps("h1", "h2")), false)).toBe(true);
	});
});

describe("the questions", () => {
	it("are the owner's defaults", () => {
		expect(SPAN_QUESTIONS).toEqual([
			"Explain this code please",
			"Why this change?",
			"What calls this?",
			"Is this tested?",
		]);
		expect(reviewQuestions(undefined, true)).toBeNull();
		expect(reviewQuestions(facts("h1", ps("h1")), false)).toBeNull();
		expect(reviewQuestions(facts("h1", ps("h1")), true)).toBe(NEW_PR_QUESTIONS);
		expect(reviewQuestions(facts("h3", ps("h1", "h3")), true)).toBe(
			REREVIEW_QUESTIONS,
		);
	});
});
