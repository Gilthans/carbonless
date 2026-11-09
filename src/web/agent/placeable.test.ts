import { describe, expect, it } from "vitest";
import type { AgentThread } from "../../shared/agent";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import { placeThreads } from "../files/threadPlacement";
import {
	agentOutside,
	agentPlaceable,
	shownAgentPlaceables,
	tracedAgentPlaceables,
} from "./placeable";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

const asked = (
	id: string,
	line: number,
	more: Partial<AgentThread["anchor"]> = {},
): AgentThread => ({
	id,
	anchor: {
		subject: "line",
		path: "a.ts",
		commit: H1,
		side: "RIGHT",
		line,
		startSide: "RIGHT",
		startLine: line,
		startCol: 2,
		endCol: 5,
		...more,
	} as AgentThread["anchor"],
	openedBy: "human",
	at: "2026-11-07T10:00:00Z",
	messages: [],
	resolved: false,
	waiting: false,
});

const moved: ThreadPlacement = {
	kind: "placed",
	anchor: {
		path: "a.ts",
		startSide: "RIGHT",
		startLine: 16,
		side: "RIGHT",
		line: 16,
	},
	changed: false,
};

describe("tracedAgentPlaceables", () => {
	it("puts a thread asked on an earlier head on its traced line in the viewed head", () => {
		const t = asked("A1", 15);
		const [p] = tracedAgentPlaceables([t], H2, new Map([["A1", moved]]));
		expect(p).toMatchObject({
			id: "A1",
			path: "a.ts",
			commit: H2,
			subject: "line",
			anchor: {
				side: "RIGHT",
				line: 16,
				startSide: "RIGHT",
				startLine: 16,
				startCol: 2,
				endCol: 5,
			},
			thread: t,
		});
	});

	it("a rewritten line's thread lands on the new lines, whole (its columns no longer hold)", () => {
		const changed: ThreadPlacement = {
			kind: "changed",
			anchor: { ...moved.anchor, path: "b.ts", line: 7, startLine: 7 },
			old: { side: "RIGHT", startLine: 15, line: 15, text: ["x"] },
			now: ["y"],
		};
		const [p] = tracedAgentPlaceables(
			[asked("A1", 15)],
			H2,
			new Map([["A1", changed]]),
		);
		expect(p).toMatchObject({
			path: "b.ts",
			commit: H2,
			anchor: { line: 7, startCol: null, endCol: null },
		});
	});

	it("an unplaced one is the viewed head's, under its file, with its fate (placeThreads' fates)", () => {
		const deleted: ThreadPlacement = {
			kind: "unplaced",
			fate: "deleted",
			path: "a.ts",
			nearest: { side: "RIGHT", line: 11 },
		};
		const placements = new Map([["A1", deleted]]);
		const shown = tracedAgentPlaceables([asked("A1", 10)], H2, placements);
		expect(shown[0]).toMatchObject({ commit: H2, path: "a.ts", anchor: null });
		const placed = placeThreads({
			threads: shown,
			path: "a.ts",
			snapshotHead: H2,
			hunks: { hunks: [], newLineCount: 20 } as never,
			loadedContext: [],
			placements,
		});
		expect(placed.fates.map((f) => [f.thread.thread.id, f.placement])).toEqual([
			["A1", deleted],
		]);
		expect(placed.header).toEqual([]);
	});

	it("a file question follows its file", () => {
		const t: AgentThread = {
			...asked("F", 1),
			anchor: { subject: "file", path: "old.ts", commit: H1 },
		};
		const [p] = tracedAgentPlaceables(
			[t],
			H2,
			new Map([["F", { kind: "file", path: "new.ts" } as const]]),
		);
		expect(p).toMatchObject({ path: "new.ts", commit: H2, subject: "file" });
	});

	it("one with no placement (not in yet, or its tracing failed) or outside the comparison stays where it was asked: outdated, never gone", () => {
		const a = asked("A1", 15);
		const b = asked("B1", 3);
		const shown = tracedAgentPlaceables(
			[a, b],
			H2,
			new Map([["B1", { kind: "outside", path: "a.ts", fate: "file-gone" }]]),
		);
		expect(shown).toEqual([agentPlaceable(a), agentPlaceable(b)]);
		expect(tracedAgentPlaceables([a], H2, null)).toEqual([agentPlaceable(a)]);
		expect(shown.every((p) => p.commit === H1)).toBe(true);
	});

	it("one asked on the viewed head keeps its own place", () => {
		const t = asked("A1", 15, { commit: H2 });
		expect(tracedAgentPlaceables([t], H2, new Map([["A1", moved]]))).toEqual([
			agentPlaceable(t),
		]);
	});
});

describe("shownAgentPlaceables", () => {
	it("an earlier patch set shows the threads asked before the next one started, as review threads (never traced backwards)", () => {
		const before = { ...asked("B", 3), at: "2026-11-07T10:00:00Z" };
		const after = { ...asked("L", 4), at: "2026-11-08T10:00:00Z" };
		const until = Date.parse("2026-11-08T00:00:00Z");
		expect(
			shownAgentPlaceables([before, after], H2, {
				placements: null,
				until,
			}).map((p) => p.id),
		).toEqual(["B"]);
		expect(
			shownAgentPlaceables([before, after], H2, {
				placements: null,
				until: null,
			}).map((p) => p.id),
		).toEqual(["B", "L"]);
	});

	it("resolved ones after the rest, each in its order: every group built from them follows", () => {
		const r1 = { ...asked("R1", 1), resolved: true };
		const a = asked("A", 2);
		const r2 = { ...asked("R2", 3), resolved: true };
		const b = asked("B", 4);
		expect(
			shownAgentPlaceables([r1, a, r2, b], H2, {
				placements: null,
				until: null,
			}).map((p) => p.id),
		).toEqual(["A", "B", "R1", "R2"]);
	});
});

describe("agentOutside", () => {
	it("lists those the tracer put outside the comparison, and those on a path it doesn't have (a rename still tracing, or whose trace failed); never one on a file of the diff", () => {
		const reverted = asked("REV", 3, { path: "reverted.ts" });
		const renamed = asked("REN", 3, { path: "old.ts" });
		const here = asked("HERE", 3);
		const outside = new Map<string, ThreadPlacement>([
			["REV", { kind: "outside", path: "reverted.ts", fate: "reverted" }],
		]);
		const placing = { placements: outside, until: null };
		const shown = shownAgentPlaceables([reverted, renamed, here], H2, placing);
		expect(
			agentOutside(shown, new Set(["a.ts", "new.ts"]), outside).map(
				(p) => p.id,
			),
		).toEqual(["REV", "REN"]);
		// Outside even when a file of the diff has its old path.
		expect(
			agentOutside(
				shown,
				new Set(["a.ts", "reverted.ts", "old.ts"]),
				outside,
			).map((p) => p.id),
		).toEqual(["REV"]);
	});
});
