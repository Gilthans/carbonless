import type { ClusterState } from "../../shared/types.js";
import type { CrbEvent, ShapeCode, ThreadPlacedEvent } from "./events.js";

/** One of the reviewer's patch sets, as its `patchset-started` recorded it. */
export interface PatchsetRecord {
	number: number;
	/** The snapshot id. */
	revision: string;
	mergeBase: string;
	head: string;
	/** The event's `ts` (ms since epoch). */
	startedAt: number;
	/** The patch set this one follows; null for PS1 (and older events). */
	since: number | null;
	shape: ShapeCode | null;
	baseBranch: string | null;
	interdiff: "available" | "unavailable" | null;
}

/** A cluster's folded state in one patch set. */
export interface StateEntry {
	state: ClusterState;
	reason?: string;
	/**
	 * The engine carried it from that patch set under that rule, and no
	 * human state has replaced it since. Absent on a human state.
	 */
	carried?: { from: number; rule: "exact" | "rename" };
}

export interface ProgressState {
	/** Every patch set, in start order. */
	patchsets: PatchsetRecord[];
	/** The latest patch set, or null before the reviewer's first action. */
	patchset: PatchsetRecord | null;
	/** The latest patch set's states (cluster key → entry); empty without one. */
	states: Map<string, StateEntry>;
	/** Each patch set's states, by its snapshot id. */
	statesByRevision: Map<string, Map<string, StateEntry>>;
	/** Patch set number → thread id → its last placement. */
	placements: Map<number, Map<string, ThreadPlacedEvent>>;
}

/**
 * Folds one reviewer's progress events into state: drop duplicate ids, sort
 * by (ts, id), take every `patchset-started` as a patch set (a repeated
 * number or snapshot id is ignored), then replay the rest in order: a human
 * `cluster-state` sets the cluster's entry in the patch set on its
 * snapshot id (none: ignored); a `carried` entry sets the target's entry
 * only when, at that moment, its source cluster in `from` holds a human
 * state equal to it (CLAUDE.md principle 2: anything else leaves the
 * target unreviewed); a `thread-placed` replaces the thread's placement in
 * its patch set. Later events win. The result doesn't depend on the order
 * of `events` or on repeats.
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

	const patchsets: PatchsetRecord[] = [];
	const byNumber = new Map<number, PatchsetRecord>();
	const statesByRevision: ProgressState["statesByRevision"] = new Map();
	const placements: ProgressState["placements"] = new Map();

	// Patch sets first, whatever their events' timestamps: a state stamped
	// before its patch set's start (a clock oddity) still belongs to it.
	for (const e of ordered) {
		if (e.type !== "patchset-started") continue;
		if (byNumber.has(e.patchset) || statesByRevision.has(e.revision)) {
			continue;
		}
		const record: PatchsetRecord = {
			number: e.patchset,
			revision: e.revision,
			mergeBase: e.mergeBase,
			head: e.head,
			startedAt: e.ts,
			since: e.since ?? null,
			shape: e.shape ?? null,
			baseBranch: e.baseBranch ?? null,
			interdiff: e.interdiff ?? null,
		};
		patchsets.push(record);
		byNumber.set(record.number, record);
		statesByRevision.set(record.revision, new Map());
	}

	for (const e of ordered) {
		switch (e.type) {
			case "cluster-state": {
				// Fail safe: only a human changes a cluster's state.
				if (e.by !== "human") break;
				const states = statesByRevision.get(e.patchset);
				if (!states) break;
				states.set(
					e.cluster,
					e.reason !== undefined
						? { state: e.state, reason: e.reason }
						: { state: e.state },
				);
				break;
			}
			case "carried": {
				// Parse enforces both; the fold holds them on its own too.
				if (e.by !== "auto" || e.from >= e.to) break;
				const from = byNumber.get(e.from);
				const to = byNumber.get(e.to);
				if (!from || !to) break;
				const source = statesByRevision.get(from.revision);
				const target = statesByRevision.get(to.revision);
				if (!source || !target) break;
				for (const entry of e.states) {
					// Parse fills fromKey in; the fallback keeps the guard whole
					// for an event that didn't pass through it.
					const origin = source.get(entry.fromKey ?? entry.key);
					// Only a human reviewed or crossed-off state carries, and only
					// as what it is: a forged or stale entry leaves the target alone.
					if (
						!origin ||
						origin.carried !== undefined ||
						origin.state === "unreviewed" ||
						origin.state !== entry.state
					) {
						continue;
					}
					target.set(entry.key, {
						state: origin.state,
						...(origin.reason !== undefined ? { reason: origin.reason } : {}),
						carried: { from: e.from, rule: e.rule },
					});
				}
				break;
			}
			case "thread-placed": {
				if (e.by === "auto") break;
				let threads = placements.get(e.patchset);
				if (!threads) {
					threads = new Map();
					placements.set(e.patchset, threads);
				}
				threads.set(e.thread, e);
				break;
			}
			default:
				break;
		}
	}

	const patchset = patchsets.at(-1) ?? null;
	return {
		patchsets,
		patchset,
		states: (patchset && statesByRevision.get(patchset.revision)) ?? new Map(),
		statesByRevision,
		placements,
	};
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
