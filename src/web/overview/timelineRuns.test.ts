import { describe, expect, it } from "vitest";
import type {
	ReviewThread,
	TimelineReviewComment,
	TimelineReviewItem,
} from "../../shared/types";
import { runResolution } from "./timelineRuns";

const comment = (threadId: string | null): TimelineReviewComment => ({
	kind: "comment",
	at: "2026-01-02T10:00:00Z",
	path: "a.ts",
	line: 1,
	text: "x",
	url: "",
	threadId,
});
const threads = (resolved: Record<string, boolean>) =>
	new Map(
		Object.entries(resolved).map(([id, r]) => [
			id,
			{ id, resolved: r } as ReviewThread,
		]),
	);

describe("runResolution", () => {
	it("counts distinct threads: a thread's opener and its replies once", () => {
		const items: TimelineReviewItem[] = [
			comment("T1"),
			comment("T1"),
			comment("T2"),
			comment("T3"),
			{
				kind: "review",
				at: "2026-01-02T10:00:00Z",
				state: "APPROVED",
				text: "",
				url: "",
			},
			{ kind: "conversation", at: "2026-01-02T10:00:00Z", text: "hi", url: "" },
		];
		expect(
			runResolution(items, threads({ T1: true, T2: false, T3: true })),
		).toEqual({ resolved: 2, total: 3 });
	});

	it("leaves out comments whose thread isn't known", () => {
		expect(
			runResolution(
				[comment(null), comment("gone"), comment("T1")],
				threads({ T1: false }),
			),
		).toEqual({ resolved: 0, total: 1 });
	});

	it("gives none for a run without review comments", () => {
		expect(runResolution([], threads({}))).toEqual({ resolved: 0, total: 0 });
	});
});
