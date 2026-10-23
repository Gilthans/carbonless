import type { ClusterState } from "../../shared/types.js";
import type { CrbEvent } from "./events.js";

export interface ProgressState {
	/** The reviewer's latest patch set, or null before their first action. */
	patchset: {
		number: number;
		revision: string;
		mergeBase: string;
		head: string;
	} | null;
	/** Cluster key → last state recorded against the patch set's revision. */
	states: Map<string, { state: ClusterState; reason?: string }>;
}

/**
 * Folds one reviewer's progress events into state: drop duplicate ids, sort
 * by (ts, id), take the latest patch set, and let the last cluster-state per
 * cluster win. Only human states recorded against the patch set's revision
 * count. The result doesn't depend on the order of `events` or on repeats.
 */
export function foldProgress(events: CrbEvent[]): ProgressState {
	// Sorting on the full JSON as a last tie-break keeps the fold deterministic
	// even if two different events share an id (forged data).
	const keyed = events.map((e) => ({ e, json: JSON.stringify(e) }));
	keyed.sort(
		(a, b) =>
			a.e.ts - b.e.ts || compare(a.e.id, b.e.id) || compare(a.json, b.json),
	);
	const seen = new Set<string>();
	const ordered = keyed
		.map(({ e }) => e)
		.filter((e) => !seen.has(e.id) && seen.add(e.id));

	let patchset: ProgressState["patchset"] = null;
	for (const e of ordered) {
		if (e.type === "patchset-started") {
			const { patchset: number, revision, mergeBase, head } = e;
			patchset = { number, revision, mergeBase, head };
		}
	}

	const states: ProgressState["states"] = new Map();
	if (!patchset) return { patchset, states };
	for (const e of ordered) {
		if (e.type !== "cluster-state" || e.by !== "human") continue;
		if (e.patchset !== patchset.revision) continue;
		states.set(
			e.cluster,
			e.reason !== undefined
				? { state: e.state, reason: e.reason }
				: { state: e.state },
		);
	}
	return { patchset, states };
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
