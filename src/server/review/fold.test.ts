import { describe, expect, it } from "vitest";
import type { ClusterState } from "../../shared/types.js";
import {
	type CarriedEntry,
	type CrbEvent,
	newEvent,
	type ThreadAnchorRef,
} from "./events.js";
import { foldProgress, type StateEntry } from "./fold.js";

const REV = "a".repeat(64);
const OTHER_REV = "b".repeat(64);
const THIRD_REV = "c".repeat(64);
const K1 = "1".repeat(64);
const K2 = "2".repeat(64);
const K3 = "3".repeat(64);
const K4 = "4".repeat(64);

let clock = 1_000;
/** Events with strictly increasing timestamps, so their order is known. */
function at<E extends CrbEvent>(e: E): E {
	clock += 10;
	return { ...e, ts: clock };
}

const started = (revision = REV, patchset = 1, since?: number) =>
	at(
		newEvent("patchset-started", "dan", {
			patchset,
			revision,
			mergeBase: "1".repeat(40),
			head: "2".repeat(40),
			...(since !== undefined ? { since, shape: "S1" as const } : {}),
		}),
	);

const state = (
	cluster: string,
	s: ClusterState,
	opts: { reason?: string; patchset?: string; by?: "human" | "ai" } = {},
) =>
	at(
		newEvent(
			"cluster-state",
			"dan",
			{
				patchset: opts.patchset ?? REV,
				cluster,
				path: "src/a.ts",
				state: s,
				...(opts.reason !== undefined ? { reason: opts.reason } : {}),
			},
			opts.by ?? "human",
		),
	);

const carried = (
	states: CarriedEntry[],
	opts: { from?: number; to?: number; rule?: "exact" | "rename" } = {},
) =>
	at(
		newEvent(
			"carried",
			"dan",
			{
				from: opts.from ?? 1,
				to: opts.to ?? 2,
				rule: opts.rule ?? "exact",
				states,
			},
			"auto",
		),
	);

const anchor = (line: number): ThreadAnchorRef => ({
	path: "src/a.ts",
	startSide: "RIGHT",
	startLine: line,
	side: "RIGHT",
	line,
});

const placed = (thread: string, patchset: number, line: number) =>
	at(
		newEvent("thread-placed", "dan", {
			thread,
			patchset,
			anchor: anchor(line),
			engine: 1,
		}),
	);

function shuffle<T>(items: T[]): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
	}
	return copy;
}

const entry = (key: string, fromKey: string, s: CarriedEntry["state"]) => ({
	key,
	fromKey,
	state: s,
});

/** The folded entries of the patch set on `revision`, as plain objects. */
const statesOf = (events: CrbEvent[], revision: string) =>
	Object.fromEntries(
		foldProgress(events).statesByRevision.get(revision) ??
			new Map<string, StateEntry>(),
	);

describe("foldProgress", () => {
	it("has no patch set and no states without events", () => {
		expect(foldProgress([])).toEqual({
			patchsets: [],
			patchset: null,
			states: new Map(),
			statesByRevision: new Map(),
			placements: new Map(),
		});
	});

	it("is independent of event order and duplicates", () => {
		const evs = [
			started(),
			state(K1, "reviewed"),
			state(K2, "crossed-off", { reason: "generated" }),
			state(K1, "unreviewed"),
			state(K3, "reviewed"),
			state(K1, "reviewed"),
			started(OTHER_REV, 2, 1),
			carried([entry(K4, K3, "reviewed")]),
			placed("t1", 2, 3),
		];
		const expected = foldProgress(evs);
		for (let i = 0; i < 20; i++) {
			expect(foldProgress(shuffle([...evs, ...evs]))).toEqual(expected);
		}
		expect(expected.statesByRevision.get(REV)?.size).toBe(3);
		expect(expected.states.size).toBe(1);
	});

	it("orders events with the same timestamp by id", () => {
		const a = state(K1, "reviewed");
		const b = { ...state(K1, "unreviewed"), ts: a.ts };
		expect(a.id < b.id).toBe(true);
		expect(foldProgress([started(), b, a]).states.get(K1)?.state).toBe(
			"unreviewed",
		);
	});

	it("last event per cluster wins", () => {
		const progress = foldProgress([
			started(),
			state(K1, "reviewed"),
			state(K1, "crossed-off", { reason: "generated" }),
			state(K2, "crossed-off", { reason: "generated" }),
			state(K2, "reviewed"),
		]);
		expect(progress.states.get(K1)).toEqual({
			state: "crossed-off",
			reason: "generated",
		});
		expect(progress.states.get(K2)).toEqual({ state: "reviewed" });
	});

	it("keeps every patch set in start order, the latest as `patchset`", () => {
		const first = started(REV, 1);
		const second = started(OTHER_REV, 2, 1);
		const progress = foldProgress(shuffle([second, first]));
		expect(progress.patchsets).toEqual([
			{
				number: 1,
				revision: REV,
				mergeBase: "1".repeat(40),
				head: "2".repeat(40),
				startedAt: first.ts,
				since: null,
				shape: null,
				baseBranch: null,
				interdiff: null,
			},
			{
				number: 2,
				revision: OTHER_REV,
				mergeBase: "1".repeat(40),
				head: "2".repeat(40),
				startedAt: second.ts,
				since: 1,
				shape: "S1",
				baseBranch: null,
				interdiff: null,
			},
		]);
		expect(progress.patchset).toBe(progress.patchsets[1]);
	});

	it("records a patch set's optional fields", () => {
		const first = started();
		const e = at(
			newEvent("patchset-started", "dan", {
				patchset: 2,
				revision: OTHER_REV,
				mergeBase: "1".repeat(40),
				head: "2".repeat(40),
				since: 1,
				shape: "S4b",
				baseBranch: "main",
				interdiff: "unavailable",
			}),
		);
		expect(foldProgress([first, e]).patchset).toMatchObject({
			since: 1,
			shape: "S4b",
			baseBranch: "main",
			interdiff: "unavailable",
		});
	});

	it("ignores a repeated patch set number, and a repeated revision", () => {
		const progress = foldProgress([
			started(REV, 1),
			started(OTHER_REV, 1),
			started(REV, 2),
			started(THIRD_REV, 3),
		]);
		expect(progress.patchsets.map((p) => [p.number, p.revision])).toEqual([
			[1, REV],
			[3, THIRD_REV],
		]);
	});

	it("folds each patch set's states into its own map", () => {
		const evs = [
			started(REV, 1),
			state(K1, "reviewed"),
			started(OTHER_REV, 2, 1),
			state(K2, "reviewed", { patchset: OTHER_REV }),
			state(K1, "crossed-off"),
		];
		expect(statesOf(evs, REV)).toEqual({ [K1]: { state: "crossed-off" } });
		expect(statesOf(evs, OTHER_REV)).toEqual({ [K2]: { state: "reviewed" } });
		const progress = foldProgress(evs);
		expect(progress.states).toBe(progress.statesByRevision.get(OTHER_REV));
	});

	it("ignores states recorded against a revision that is no patch set", () => {
		const progress = foldProgress([
			started(),
			state(K1, "reviewed", { patchset: OTHER_REV }),
			state(K2, "reviewed"),
			state(K2, "unreviewed", { patchset: OTHER_REV }),
		]);
		expect([...progress.states.keys()]).toEqual([K2]);
		expect(progress.states.get(K2)?.state).toBe("reviewed");
		expect(progress.statesByRevision.has(OTHER_REV)).toBe(false);
	});

	it("ignores states when there is no patch set", () => {
		expect(foldProgress([state(K1, "reviewed")]).states.size).toBe(0);
	});

	it("ignores cluster states not written by a human", () => {
		const progress = foldProgress([
			started(),
			state(K1, "reviewed"),
			state(K1, "unreviewed", { by: "ai" }),
			state(K2, "reviewed", { by: "ai" }),
		]);
		expect(progress.states.get(K1)?.state).toBe("reviewed");
		expect(progress.states.has(K2)).toBe(false);
	});

	describe("carried entries", () => {
		const twoSets = () => [
			started(REV, 1),
			state(K1, "reviewed"),
			state(K2, "crossed-off", { reason: "generated" }),
			state(K3, "reviewed"),
			state(K3, "unreviewed"),
			started(OTHER_REV, 2, 1),
		];

		it("mark the target with the state and where it came from", () => {
			const evs = [
				...twoSets(),
				carried([entry(K4, K1, "reviewed")]),
				carried([entry(K3, K2, "crossed-off")], { rule: "rename" }),
			];
			expect(statesOf(evs, OTHER_REV)).toEqual({
				[K4]: { state: "reviewed", carried: { from: 1, rule: "exact" } },
				[K3]: {
					state: "crossed-off",
					reason: "generated",
					carried: { from: 1, rule: "rename" },
				},
			});
			// The source patch set is untouched.
			expect(statesOf(evs, REV)[K1]).toEqual({ state: "reviewed" });
		});

		it("are ignored when the source cluster was unreviewed in `from`", () => {
			const evs = [...twoSets(), carried([entry(K4, K3, "reviewed")])];
			expect(statesOf(evs, OTHER_REV)).toEqual({});
		});

		it("are ignored when the source cluster has no state in `from`", () => {
			const evs = [...twoSets(), carried([entry(K4, K4, "reviewed")])];
			expect(statesOf(evs, OTHER_REV)).toEqual({});
		});

		it("are ignored when `from` is not a known patch set", () => {
			const evs = [
				...twoSets(),
				carried([entry(K4, K1, "reviewed")], { from: 3, to: 4 }),
			];
			expect(statesOf(evs, OTHER_REV)).toEqual({});
			const unknownTo = [
				...twoSets(),
				carried([entry(K4, K1, "reviewed")], { from: 1, to: 3 }),
			];
			expect(foldProgress(unknownTo).statesByRevision.size).toBe(2);
			expect(statesOf(unknownTo, OTHER_REV)).toEqual({});
		});

		it("are ignored when the source entry was itself carried", () => {
			const evs = [
				...twoSets(),
				carried([entry(K4, K1, "reviewed")]),
				started(THIRD_REV, 3, 2),
				// K4 in PS2 is a carried entry, not a human state.
				carried([entry(K4, K4, "reviewed")], { from: 2, to: 3 }),
				// K2 in PS2 has no state at all.
				carried([entry(K2, K2, "crossed-off")], { from: 2, to: 3 }),
			];
			expect(statesOf(evs, THIRD_REV)).toEqual({});
			expect(statesOf(evs, OTHER_REV)[K4]).toMatchObject({
				state: "reviewed",
			});
		});

		it("are ignored when the entry's state differs from the source's", () => {
			const evs = [
				...twoSets(),
				carried([entry(K4, K1, "crossed-off"), entry(K3, K2, "reviewed")]),
			];
			expect(statesOf(evs, OTHER_REV)).toEqual({});
		});

		it("are ignored when the source state reached `from` after the carry", () => {
			// The source cluster's human state must stand at the carry's moment.
			const evs = [
				started(REV, 1),
				started(OTHER_REV, 2, 1),
				carried([entry(K4, K1, "reviewed")]),
				state(K1, "reviewed"),
			];
			expect(statesOf(evs, OTHER_REV)).toEqual({});
		});

		it("are ignored when from isn't before to, even past the parser", () => {
			// newEvent doesn't validate: the fold must hold the rule on its own.
			const evs = [
				...twoSets(),
				state(K4, "reviewed", { patchset: OTHER_REV }),
				carried([entry(K1, K4, "reviewed")], { from: 2, to: 1 }),
				carried([entry(K2, K2, "crossed-off")], { from: 1, to: 1 }),
			];
			expect(statesOf(evs, REV)[K1]).toEqual({ state: "reviewed" });
			expect(statesOf(evs, REV)[K2]).toEqual({
				state: "crossed-off",
				reason: "generated",
			});
			expect(statesOf(evs, OTHER_REV)).toEqual({ [K4]: { state: "reviewed" } });
		});

		it("apply entry by entry: a bad entry doesn't take the good ones with it", () => {
			const evs = [
				...twoSets(),
				carried([entry(K4, K1, "reviewed"), entry(K3, K3, "reviewed")]),
			];
			expect(Object.keys(statesOf(evs, OTHER_REV))).toEqual([K4]);
		});

		it("lose to a later human state on the same key", () => {
			const evs = [
				...twoSets(),
				carried([entry(K4, K1, "reviewed")]),
				state(K4, "unreviewed", { patchset: OTHER_REV }),
			];
			expect(statesOf(evs, OTHER_REV)).toEqual({
				[K4]: { state: "unreviewed" },
			});
		});

		it("don't override an earlier-ordered human untick in the target, and do a later one", () => {
			const base = twoSets();
			const untick = state(K4, "unreviewed", { patchset: OTHER_REV });
			const carry = carried([entry(K4, K1, "reviewed")]);
			// Ordered by (ts, id): the carry comes first, the untick wins.
			const first = [...base, { ...carry, ts: untick.ts - 1 }, untick];
			expect(statesOf(first, OTHER_REV)[K4]).toEqual({ state: "unreviewed" });
			// The engine never writes this, but the rule is last event wins.
			const later = [...base, untick, { ...carry, ts: untick.ts + 1 }];
			expect(statesOf(later, OTHER_REV)[K4]).toMatchObject({
				state: "reviewed",
				carried: { from: 1, rule: "exact" },
			});
		});

		it("can chain: a human state carried into PS2 and then a human re-tick carries on", () => {
			const evs = [
				...twoSets(),
				carried([entry(K4, K1, "reviewed")]),
				state(K4, "reviewed", { patchset: OTHER_REV }),
				started(THIRD_REV, 3, 2),
				carried([entry(K4, K4, "reviewed")], { from: 2, to: 3 }),
			];
			expect(statesOf(evs, THIRD_REV)).toEqual({
				[K4]: { state: "reviewed", carried: { from: 2, rule: "exact" } },
			});
		});
	});

	describe("thread placements", () => {
		it("keep the last per thread per patch set", () => {
			const a = placed("t1", 1, 3);
			const b = placed("t1", 1, 7);
			const c = placed("t2", 1, 2);
			const d = placed("t1", 2, 9);
			const progress = foldProgress(shuffle([started(), b, a, c, d]));
			expect(progress.placements.get(1)?.get("t1")).toEqual(b);
			expect(progress.placements.get(1)?.get("t2")).toEqual(c);
			expect(progress.placements.get(2)?.get("t1")).toEqual(d);
			expect(progress.placements.get(3)).toBeUndefined();
		});

		it("never touch cluster states", () => {
			const progress = foldProgress([
				started(),
				state(K1, "reviewed"),
				placed("t1", 1, 3),
			]);
			expect(progress.states.get(K1)).toEqual({ state: "reviewed" });
		});
	});
});
