import { describe, expect, it } from "vitest";
import type { ClusterState } from "../../shared/types.js";
import { type CrbEvent, newEvent } from "./events.js";
import { foldProgress } from "./fold.js";

const REV = "a".repeat(64);
const OTHER_REV = "b".repeat(64);

let clock = 1_000;
/** Events with strictly increasing timestamps, so their order is known. */
function at<E extends CrbEvent>(e: E): E {
	clock += 10;
	return { ...e, ts: clock };
}

const started = (revision = REV, patchset = 1) =>
	at(
		newEvent("patchset-started", "dan", {
			patchset,
			revision,
			mergeBase: "1".repeat(40),
			head: "2".repeat(40),
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

function shuffle<T>(items: T[]): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
	}
	return copy;
}

describe("foldProgress", () => {
	it("has no patch set and no states without events", () => {
		expect(foldProgress([])).toEqual({ patchset: null, states: new Map() });
	});

	it("is independent of event order and duplicates", () => {
		const evs = [
			started(),
			state("k1", "reviewed"),
			state("k2", "crossed-off", { reason: "generated" }),
			state("k1", "unreviewed"),
			state("k3", "reviewed"),
			state("k1", "reviewed"),
		];
		const expected = foldProgress(evs);
		for (let i = 0; i < 20; i++) {
			expect(foldProgress(shuffle([...evs, ...evs]))).toEqual(expected);
		}
		expect(expected.states.size).toBe(3);
	});

	it("orders events with the same timestamp by id", () => {
		const a = state("k1", "reviewed");
		const b = { ...state("k1", "unreviewed"), ts: a.ts };
		expect(a.id < b.id).toBe(true);
		expect(foldProgress([started(), b, a]).states.get("k1")?.state).toBe(
			"unreviewed",
		);
	});

	it("last event per cluster wins", () => {
		const progress = foldProgress([
			started(),
			state("k1", "reviewed"),
			state("k1", "crossed-off", { reason: "generated" }),
			state("k2", "crossed-off", { reason: "generated" }),
			state("k2", "reviewed"),
		]);
		expect(progress.states.get("k1")).toEqual({
			state: "crossed-off",
			reason: "generated",
		});
		expect(progress.states.get("k2")).toEqual({ state: "reviewed" });
	});

	it("takes the latest patch set", () => {
		const evs = [started(REV, 1), started(OTHER_REV, 2)];
		expect(foldProgress(shuffle(evs)).patchset).toEqual({
			number: 2,
			revision: OTHER_REV,
			mergeBase: "1".repeat(40),
			head: "2".repeat(40),
		});
	});

	it("ignores states recorded against another revision", () => {
		const progress = foldProgress([
			started(),
			state("k1", "reviewed", { patchset: OTHER_REV }),
			state("k2", "reviewed"),
			state("k2", "unreviewed", { patchset: OTHER_REV }),
		]);
		expect([...progress.states.keys()]).toEqual(["k2"]);
		expect(progress.states.get("k2")?.state).toBe("reviewed");
	});

	it("ignores states when there is no patch set", () => {
		expect(foldProgress([state("k1", "reviewed")]).states.size).toBe(0);
	});

	it("ignores cluster states not written by a human", () => {
		const progress = foldProgress([
			started(),
			state("k1", "reviewed"),
			state("k1", "unreviewed", { by: "ai" }),
			state("k2", "reviewed", { by: "ai" }),
		]);
		expect(progress.states.get("k1")?.state).toBe("reviewed");
		expect(progress.states.has("k2")).toBe(false);
	});
});
