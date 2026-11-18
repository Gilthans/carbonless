import { describe, expect, it } from "vitest";
import {
	NEW_PR_QUESTIONS,
	REREVIEW_QUESTIONS,
	reviewQuestions,
	SPAN_QUESTIONS,
	viewedPatchset,
	withQuestion,
} from "./quickQuestions";

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

describe("viewedPatchset", () => {
	it("a patch set's own number; the head, the next after the reviewer's; unknown without the session", () => {
		expect(viewedPatchset({ patchset: 1 }, 3)).toBe(1);
		expect(viewedPatchset({ patchset: 2 }, undefined)).toBe(2);
		expect(viewedPatchset({ head: "h1" }, 0)).toBe(1);
		expect(viewedPatchset({ head: "h3" }, 2)).toBe(3);
		expect(viewedPatchset({ head: "" }, undefined)).toBeUndefined();
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
		expect(reviewQuestions(1)).toBe(NEW_PR_QUESTIONS);
		expect(reviewQuestions(2)).toBe(REREVIEW_QUESTIONS);
		expect(reviewQuestions(5)).toBe(REREVIEW_QUESTIONS);
	});
});
