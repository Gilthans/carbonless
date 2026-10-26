import { describe, expect, it } from "vitest";
import type {
	ReviewThread,
	TimelineReviewComment,
	TimelineReviewItem,
} from "../../shared/types";
import { eventKeys, runResolution } from "./timelineRuns";

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

describe("eventKeys", () => {
	const actor = (login: string) => ({ login, avatarUrl: "", bot: false });
	const run = (login: string, from: string) => ({
		kind: "commits" as const,
		actor: actor(login),
		from,
		to: from,
		items: [],
	});

	it("keys an event by what it is, not where it stands", () => {
		const a = run("ann", "2026-01-01T09:00:00Z");
		const b = run("bob", "2026-01-02T09:00:00Z");
		const inserted = run("cy", "2026-01-01T10:00:00Z");
		const before = new Map(eventKeys([a, b]).map(([k, e]) => [e, k]));
		const after = new Map(eventKeys([a, inserted, b]).map(([k, e]) => [e, k]));
		expect(after.get(b)).toBe(before.get(b));
		expect(after.get(a)).toBe(before.get(a));
	});

	it("keeps keys unique when an event repeats", () => {
		const keys = eventKeys([
			run("ann", "2026-01-01T09:00:00Z"),
			{ kind: "closed", actor: actor("bob"), at: "2026-01-01T09:00:00Z" },
			run("ann", "2026-01-01T09:00:00Z"),
		]).map(([k]) => k);
		expect(new Set(keys).size).toBe(3);
	});
});

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
