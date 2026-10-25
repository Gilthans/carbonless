import { describe, expect, it } from "vitest";
import { atOrBefore, headAsOf, parseAsOf } from "./asOf";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const commit = (oid: string, committedDate: string, pushedDate?: string) => ({
	commit: { oid, committedDate, pushedDate: pushedDate ?? null },
});
const review = (oid: string, submittedAt: string) => ({
	state: "COMMENTED",
	submittedAt,
	commit: { oid },
});

describe("parseAsOf", () => {
	it("normalizes to UTC, dropping zero milliseconds", () => {
		expect(parseAsOf("2026-09-15T11:35:52Z")).toBe("2026-09-15T11:35:52Z");
		expect(parseAsOf("2026-09-15T14:35:52+03:00")).toBe("2026-09-15T11:35:52Z");
		expect(parseAsOf("2026-09-15T11:35:52.250Z")).toBe(
			"2026-09-15T11:35:52.250Z",
		);
	});

	it("rejects times without a zone and non-dates", () => {
		expect(() => parseAsOf("2026-09-15T11:35:52")).toThrow(/Invalid --as-of/);
		expect(() => parseAsOf("2026-09-15")).toThrow(/Invalid --as-of/);
		expect(() => parseAsOf("yesterday")).toThrow(/Invalid --as-of/);
		expect(() => parseAsOf("2026-13-45T00:00:00Z")).toThrow(/Invalid/);
	});
});

describe("atOrBefore", () => {
	it("compares instants, not strings", () => {
		const cutoff = "2026-09-15T11:35:52Z";
		expect(atOrBefore("2026-09-15T11:35:52Z", cutoff)).toBe(true);
		expect(atOrBefore("2026-09-15T11:35:52.000Z", cutoff)).toBe(true);
		expect(atOrBefore("2026-09-15T11:35:53Z", cutoff)).toBe(false);
		expect(atOrBefore("2026-09-15T14:35:51+03:00", cutoff)).toBe(true);
		expect(atOrBefore(undefined, cutoff)).toBe(false);
		expect(atOrBefore("", cutoff)).toBe(false);
	});
});

describe("headAsOf", () => {
	const cutoff = "2026-09-15T11:35:52Z";

	it("takes the last commit at or before the cutoff", () => {
		const commits = [
			commit(A, "2026-09-01T00:00:00Z"),
			commit(B, "2026-09-10T00:00:00Z"),
			commit(C, "2026-09-16T00:00:00Z"),
		];
		expect(headAsOf(commits, [], cutoff)).toBe(B);
	});

	it("prefers the push time when GitHub has one", () => {
		const commits = [
			commit(A, "2026-09-01T00:00:00Z"),
			commit(B, "2026-09-02T00:00:00Z", "2026-09-20T00:00:00Z"),
		];
		expect(headAsOf(commits, [], cutoff)).toBe(A);
	});

	it("takes a review's commit when the review is later, e.g. at the cutoff itself", () => {
		const commits = [
			commit(A, "2026-09-01T00:00:00Z"),
			commit(C, "2026-09-16T00:00:00Z"),
		];
		// B was force-pushed away later; the review at the cutoff still names it.
		const reviews = [review(B, cutoff), review(C, "2026-09-17T00:00:00Z")];
		expect(headAsOf(commits, reviews, cutoff)).toBe(B);
	});

	it("lets a later push win over an earlier review", () => {
		const commits = [commit(B, "2026-09-12T00:00:00Z")];
		const reviews = [review(A, "2026-09-11T00:00:00Z")];
		expect(headAsOf(commits, reviews, cutoff)).toBe(B);
	});

	it("prefers the review on a tie", () => {
		const at = "2026-09-12T00:00:00Z";
		expect(headAsOf([commit(A, at)], [review(B, at)], cutoff)).toBe(B);
	});

	it("ignores malformed nodes and fails clearly with nothing before the cutoff", () => {
		expect(() =>
			headAsOf(
				[commit(A, "2026-09-20T00:00:00Z"), { commit: { oid: "nope" } }, null],
				[{ submittedAt: "2026-09-01T00:00:00Z" }],
				cutoff,
			),
		).toThrow(/no commit at or before 2026-09-15T11:35:52Z/);
	});
});
