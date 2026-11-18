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
const facts = (
	snapshotHead: string,
	patchsets: RereviewFacts["patchsets"],
	head: string | null = snapshotHead,
): RereviewFacts => ({
	snapshotHead,
	patchsets,
	head:
		head === null
			? null
			: { oid: head, mergeBase: "b", baseBranch: "main", commits: 0 },
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
			"merged (no head check): the snapshot's",
			facts("h1", ps("h1"), null),
			false,
		],
		[
			"merged after a second patch set",
			facts("h2", ps("h1", "h2"), null),
			true,
		],
	])("%s", (_, f, want) => {
		expect(isRereview(f)).toBe(want);
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
		expect(reviewQuestions(undefined)).toBeNull();
		expect(reviewQuestions(facts("h1", ps("h1")))).toBe(NEW_PR_QUESTIONS);
		expect(reviewQuestions(facts("h3", ps("h1", "h3")))).toBe(
			REREVIEW_QUESTIONS,
		);
	});
});
