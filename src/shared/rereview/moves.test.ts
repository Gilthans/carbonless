import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IDENTITY } from "../tracer/lineMapper.js";
import type { DiffSide, ThreadAnchorRef } from "../types.js";
import {
	effectiveMove,
	foldMoves,
	liveMove,
	MAX_MOVES_PER_THREAD,
	type MoveChoice,
	type MoveUndo,
	movedInfo,
	placeWithMoves,
	type ThreadMove,
	type ThreadRef,
	threadKey,
	visibleBefore,
} from "./moves.js";
import type { ThreadInput } from "./placement.js";

/*
 * Thread moves, pure (CAR-139): the fold (order, dedupe, undos, the cap,
 * legacy moves merged in), the three rules for which move a snapshot
 * uses, and placeWithMoves never dropping or adding a thread.
 */

const PS2 = { base: "b".repeat(40), head: "2".repeat(40), patchset: 2 };
const PS3 = { base: "b".repeat(40), head: "3".repeat(40), patchset: 3 };
const HEAD4 = { base: "b".repeat(40), head: "4".repeat(40) };
const gh: ThreadRef = { source: "github", id: "PRRT_1" };
const ai: ThreadRef = { source: "agent", id: "01jaaaaaaaaaaaaaaaaaaaaaaa" };

const at = (line: number, path = "a.ts"): ThreadAnchorRef => ({
	path,
	startSide: "RIGHT",
	startLine: line,
	side: "RIGHT",
	line,
});

let seq = 0;
const ulid = (n: number) =>
	`01j${String(n).padStart(23, "0")}`.replace(/[ilou]/g, "0");

function move(
	thread: ThreadRef,
	on: ThreadMove["on"],
	line: number,
	ts: number,
	path?: string,
): ThreadMove {
	seq += 1;
	return {
		id: ulid(ts * 1000 + seq),
		ts,
		thread,
		on,
		anchor: at(line, path),
		engine: 1,
	};
}
const undo = (m: ThreadMove, ts: number, thread = m.thread): MoveUndo => ({
	id: ulid(ts * 1000 + 999),
	ts,
	thread,
	move: m.id,
});

/** Every file is 20 lines long; "missing.ts" is no file of the target. */
const count = (path: string, _side: DiffSide) =>
	path === "missing.ts" ? null : 20;
const fits = (m: ThreadMove) =>
	m.anchor.path !== "missing.ts" && m.anchor.line <= 20;
const all = () => true;

describe("foldMoves", () => {
	it("orders by (ts, id), deduplicates, and keys by source and id", () => {
		const a = move(gh, PS2, 3, 20);
		const b = move(gh, PS2, 4, 10);
		const c = move(ai, PS2, 5, 15);
		const folded = foldMoves([a, b, a, c], []);
		expect(folded.get(threadKey(gh))?.map((m) => m.id)).toEqual([b.id, a.id]);
		expect(folded.get(threadKey(ai))?.map((m) => m.id)).toEqual([c.id]);
		// The same id under the other source is another thread.
		expect(folded.get("agent:PRRT_1")).toBeUndefined();
	});

	it("an undo takes back its own thread's move only; an unknown id does nothing", () => {
		const a = move(gh, PS2, 3, 10);
		const b = move(gh, PS2, 4, 20);
		const c = move(ai, PS2, 5, 15);
		const folded = foldMoves(
			[a, b, c],
			[
				undo(b, 30),
				// Names gh's move under the agent thread: nothing.
				undo(a, 31, ai),
				{ id: ulid(99), ts: 32, thread: gh, move: ulid(12345) },
			],
		);
		expect(folded.get(threadKey(gh))?.map((m) => m.id)).toEqual([a.id]);
		expect(folded.get(threadKey(ai))?.map((m) => m.id)).toEqual([c.id]);
		expect(liveMove(folded, b.id)).toBeUndefined();
		expect(liveMove(folded, a.id)?.id).toBe(a.id);
	});

	it("legacy moves (thread-placed read as moves) merge in (ts, id) order and are undone by id", () => {
		const legacy = move(gh, PS2, 7, 5);
		const later = move(gh, PS3, 8, 50);
		const folded = foldMoves([later, legacy], []);
		expect(folded.get(threadKey(gh))?.map((m) => m.id)).toEqual([
			legacy.id,
			later.id,
		]);
		const undone = foldMoves([later, legacy], [undo(legacy, 60)]);
		expect(undone.get(threadKey(gh))?.map((m) => m.id)).toEqual([later.id]);
	});

	it(`keeps at most ${MAX_MOVES_PER_THREAD} moves of a thread: later ones are dropped`, () => {
		const moves = Array.from({ length: MAX_MOVES_PER_THREAD + 5 }, (_, i) =>
			move(gh, PS2, (i % 20) + 1, i + 1),
		);
		const folded = foldMoves(moves, []).get(threadKey(gh)) ?? [];
		expect(folded).toHaveLength(MAX_MOVES_PER_THREAD);
		expect(folded.at(-1)?.id).toBe(moves[MAX_MOVES_PER_THREAD - 1]?.id);
	});
});

describe("the cap counts live moves only", () => {
	it("undone moves leave room: the 201st move counts once one is undone", () => {
		const moves = Array.from({ length: MAX_MOVES_PER_THREAD + 1 }, (_, i) =>
			move(gh, PS2, (i % 20) + 1, i + 1),
		);
		const first = moves[0] as ThreadMove;
		const last = moves.at(-1) as ThreadMove;
		expect(foldMoves(moves, []).get(threadKey(gh))?.at(-1)?.id).not.toBe(
			last.id,
		);
		const folded =
			foldMoves(moves, [undo(first, 999)]).get(threadKey(gh)) ?? [];
		expect(folded).toHaveLength(MAX_MOVES_PER_THREAD);
		expect(folded.at(-1)?.id).toBe(last.id);
	});
});

describe("effectiveMove", () => {
	it("rule 1: the last move made on the target itself, as chosen", () => {
		const a = move(gh, PS3, 3, 10);
		const b = move(gh, PS3, 9, 20);
		expect(effectiveMove([a, b], PS3, { visible: all, fits })).toEqual({
			move: b,
			here: true,
		});
	});

	it("rule 1 wins over a later move elsewhere", () => {
		const a = move(gh, PS3, 3, 10);
		const b = move(gh, HEAD4, 9, 20);
		expect(effectiveMove([a, b], PS3, { visible: all, fits })).toEqual({
			move: a,
			here: true,
		});
	});

	it("rule 2: the last visible move elsewhere, traced", () => {
		const a = move(gh, PS2, 3, 10);
		const b = move(gh, PS3, 9, 20);
		expect(effectiveMove([a, b], HEAD4, { visible: all, fits })).toEqual({
			move: b,
			here: false,
		});
	});

	it("an earlier patch set sees only moves made before the next one started", () => {
		const a = move(gh, PS2, 3, 10);
		const b = move(gh, PS3, 9, 30);
		const visible = visibleBefore(25);
		expect(effectiveMove([a, b], PS2, { visible, fits })).toEqual({
			move: a,
			here: true,
		});
		// On PS2 with nothing of its own visible: none of PS3's.
		expect(
			effectiveMove([b], PS2, { visible: visibleBefore(25), fits }),
		).toBeNull();
		expect(visibleBefore(null)(b)).toBe(true);
	});

	it("a move on the target that doesn't fit it is skipped for both rules: the next one down", () => {
		const a = move(gh, PS2, 3, 10);
		const bad = move(gh, PS3, 99, 20);
		expect(effectiveMove([a, bad], PS3, { visible: all, fits })).toEqual({
			move: a,
			here: false,
		});
		const badPath = move(gh, PS3, 2, 30, "missing.ts");
		expect(effectiveMove([badPath], PS3, { visible: all, fits })).toBeNull();
	});

	it("rule 3: no move, none", () => {
		expect(effectiveMove([], PS3, { visible: all, fits })).toBeNull();
	});
});

describe("placeWithMoves", () => {
	const own = (id: string, line = 5): ThreadInput => ({
		id,
		path: "a.ts",
		anchor: { side: "RIGHT", line, startSide: "RIGHT", startLine: line },
		diffs: {
			ac: IDENTITY,
			bd: IDENTITY,
			cd: IDENTITY,
			newLineCount: { LEFT: 20, RIGHT: 20 },
		},
		newPath: "a.ts",
		inComparison: true,
	});

	it("rule 1 places as chosen; rule 2 traces from the move, never as GitHub's line; no move, its own trace", () => {
		const here = move(gh, PS3, 9, 10);
		const there = move(gh, PS2, 12, 10);
		const choices = new Map<string, MoveChoice>([
			["A", { move: here, here: true }],
			[
				"B",
				{
					move: there,
					here: false,
					input: { ...own("x", 12), source: "github" },
					inComparison: true,
				},
			],
		]);
		const placed = placeWithMoves(
			[{ ...own("A"), source: "github" }, own("B"), own("C", 6)],
			choices,
			count,
		);
		expect(placed.map((p) => p.id)).toEqual(["A", "B", "C"]);
		expect(placed[0]).toEqual({
			id: "A",
			placement: { kind: "placed", anchor: at(9), changed: false },
			moved: movedInfo(here, true),
		});
		expect(placed[1]?.placement).toEqual({
			kind: "placed",
			anchor: at(12),
			changed: false,
		});
		expect(placed[1]?.moved).toMatchObject({
			id: there.id,
			on: { patchset: 2 },
			here: false,
		});
		expect(placed[2]).toEqual({
			id: "C",
			placement: { kind: "placed", anchor: at(6), changed: false },
		});
	});

	it("a move whose commits are gone is rewritten, never the older trace", () => {
		const m = move(gh, HEAD4, 9, 10);
		const placed = placeWithMoves(
			[own("A"), own("B")],
			new Map<string, MoveChoice>([
				["A", { move: m, here: false, input: null, inComparison: true }],
				["B", { move: m, here: false, input: null, inComparison: false }],
			]),
			count,
		);
		expect(placed[0]?.placement).toEqual({
			kind: "unplaced",
			fate: "rewritten",
			path: "a.ts",
			nearest: null,
		});
		expect(placed[0]?.moved?.on).toEqual({ head: HEAD4.head });
		expect(placed[1]?.placement).toEqual({
			kind: "outside",
			path: "a.ts",
			fate: "rewritten",
		});
	});

	it("property: whatever the moves, undos and target, every thread has exactly one placement and the unresolved count holds", () => {
		const snapshots = [PS2, PS3, HEAD4];
		const threadArb = fc.record({
			agent: fc.boolean(),
			n: fc.integer({ min: 0, max: 5 }),
			resolved: fc.boolean(),
			line: fc.integer({ min: 1, max: 20 }),
		});
		const moveArb = fc.record({
			agent: fc.boolean(),
			// 0..5 name threads that may exist; 6..8 none of them.
			n: fc.integer({ min: 0, max: 8 }),
			on: fc.integer({ min: 0, max: 2 }),
			// Out of range, or on no file of the target, sometimes.
			line: fc.integer({ min: 1, max: 30 }),
			missing: fc.boolean(),
			ts: fc.integer({ min: 1, max: 100 }),
			// The trace from it: fine, or its commits gone.
			lost: fc.boolean(),
		});
		fc.assert(
			fc.property(
				fc.array(threadArb, { maxLength: 8 }),
				fc.array(moveArb, { maxLength: 20 }),
				fc.array(fc.nat(), { maxLength: 6 }),
				fc.integer({ min: 0, max: 2 }),
				fc.option(fc.integer({ min: 1, max: 100 })),
				(ts, ms, undoPicks, t, cutoff) => {
					const refOf = (agent: boolean, n: number): ThreadRef =>
						agent
							? { source: "agent", id: ulid(n + 1) }
							: { source: "github", id: `PRRT_${n}` };
					// Unique threads, as a placements answer has them.
					const threads = [
						...new Map(
							ts.map((x) => [threadKey(refOf(x.agent, x.n)), x]),
						).values(),
					];
					const moves = ms.map((m) =>
						move(
							refOf(m.agent, m.n),
							snapshots[m.on] as ThreadMove["on"],
							m.line,
							m.ts,
							m.missing ? "missing.ts" : "a.ts",
						),
					);
					const lost = new Set(
						ms.flatMap((m, i) => (m.lost ? [moves[i]?.id] : [])),
					);
					const undos = undoPicks.flatMap((k, i) => {
						const m = moves[k % Math.max(1, moves.length)];
						return m ? [undo(m, 200 + i)] : [];
					});
					const folded = foldMoves(moves, undos);
					const target = snapshots[t] as ThreadMove["on"];
					const inputs = threads.map((x) =>
						own(threadKey(refOf(x.agent, x.n)), x.line),
					);
					const choices = new Map<string, MoveChoice>();
					for (const input of inputs) {
						const chosen = effectiveMove(folded.get(input.id) ?? [], target, {
							visible: visibleBefore(cutoff ?? null),
							fits,
						});
						if (!chosen) continue;
						choices.set(
							input.id,
							chosen.here
								? { move: chosen.move, here: true }
								: {
										move: chosen.move,
										here: false,
										input: lost.has(chosen.move.id)
											? null
											: own(input.id, Math.min(chosen.move.anchor.line, 20)),
										inComparison: chosen.move.anchor.path !== "missing.ts",
									},
						);
					}
					const placed = placeWithMoves(inputs, choices, count);
					// One placement per thread, in order: none dropped, none added.
					expect(placed.map((p) => p.id)).toEqual(inputs.map((i) => i.id));
					expect(new Set(placed.map((p) => p.id)).size).toBe(inputs.length);
					for (const p of placed) {
						expect([
							"placed",
							"changed",
							"unplaced",
							"outside",
							"file",
						]).toContain(p.placement.kind);
					}
					// A moved thread says which move: one live at the target.
					for (const p of placed) {
						if (!p.moved) continue;
						expect(
							(folded.get(p.id) ?? []).some((m) => m.id === p.moved?.id),
						).toBe(true);
					}
				},
			),
			{ numRuns: 300 },
		);
	});
});
