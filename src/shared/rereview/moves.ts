/**
 * Thread moves (CAR-139): the reviewer putting a thread, a GitHub review
 * thread or an agent thread, on other lines of the snapshot they view. A
 * move is the reviewer's view, kept as `thread-moved` events (undone by
 * `thread-move-undone`) in their private agent threads ref; old
 * `thread-placed` events are read as moves too. This module folds them
 * and says which move a target snapshot's placement stands on:
 *
 * 1. a move made on the target itself (the last one that fits it): the
 *    thread is placed there as chosen, not traced;
 * 2. else the last move visible at the target, traced from its own
 *    snapshot into the target by the tracer;
 * 3. else none: the thread's own anchor, traced as before.
 *
 * Whatever the moves say, every thread keeps exactly one placement
 * (placeWithMoves): a move that can't be traced (its commits gone) leaves
 * the thread unplaced as `rewritten`, never gone and never back on the
 * tracer's older guess. See docs/superpowers/specs/2026-11-18-thread-placement-design.md.
 *
 * Pure: no git, no I/O, nothing from `src/server/`.
 */

import type { DiffSide, ThreadAnchorRef } from "../types.js";
import {
	oldLines,
	placeThread,
	type ThreadInput,
	type ThreadPlacement,
	validAnchor,
} from "./placement.js";

/** Where a thread comes from: an agent thread, or a GitHub review thread. */
export type ThreadSource = "agent" | "github";

/** A thread named by its source and id (a lowercase ULID, or GitHub's node id). */
export interface ThreadRef {
	source: ThreadSource;
	id: string;
}

/** The snapshot a move was made in; `patchset` when it is one of the reviewer's. */
export interface MoveSnapshot {
	base: string;
	head: string;
	patchset?: number;
}

/** One move as folded: a `thread-moved` event, or a legacy `thread-placed`. */
export interface ThreadMove {
	id: string;
	/** Milliseconds since epoch. */
	ts: number;
	thread: ThreadRef;
	on: MoveSnapshot;
	anchor: ThreadAnchorRef;
	engine: number;
}

/** A `thread-move-undone`: takes back move `move` of `thread`. */
export interface MoveUndo {
	id: string;
	ts: number;
	thread: ThreadRef;
	move: string;
}

/** The most moves of one thread the fold keeps (later ones are dropped). */
export const MAX_MOVES_PER_THREAD = 200;

/** The longest anchor path a move may name (bytes of UTF-8). */
export const MAX_MOVE_PATH = 4096;

/** The longest GitHub thread id a move may name. */
export const MAX_GITHUB_THREAD_ID = 200;

/** A thread's key in the fold: `github:PRRT_…`, `agent:01j…`. */
export const threadKey = (t: ThreadRef): string => `${t.source}:${t.id}`;

const byTsId = (a: { ts: number; id: string }, b: { ts: number; id: string }) =>
	a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Each thread's live moves (by threadKey), oldest first: every move in
 * `(ts, id)` order, deduplicated by id, the first MAX_MOVES_PER_THREAD
 * of a thread kept, minus those an undo of the same thread names. An
 * undo naming another thread's move, or an unknown id, does nothing.
 */
export function foldMoves(
	moves: readonly ThreadMove[],
	undos: readonly MoveUndo[],
): Map<string, ThreadMove[]> {
	const seen = new Set<string>();
	const sorted = moves
		.filter((m) => !seen.has(m.id) && seen.add(m.id))
		.sort(byTsId);
	const undone = new Set(undos.map((u) => `${threadKey(u.thread)} ${u.move}`));
	const out = new Map<string, ThreadMove[]>();
	const counted = new Map<string, number>();
	for (const m of sorted) {
		const key = threadKey(m.thread);
		const n = counted.get(key) ?? 0;
		if (n >= MAX_MOVES_PER_THREAD) continue;
		counted.set(key, n + 1);
		if (undone.has(`${key} ${m.id}`)) continue;
		const list = out.get(key);
		if (list) list.push(m);
		else out.set(key, [m]);
	}
	return out;
}

/** The move an undo of `moveId` would take back, if it is live. */
export function liveMove(
	folded: ReadonlyMap<string, readonly ThreadMove[]>,
	moveId: string,
): ThreadMove | undefined {
	for (const list of folded.values()) {
		const found = list.find((m) => m.id === moveId);
		if (found) return found;
	}
	return undefined;
}

/** What a placement answer says of a moved thread: the move it stands on. */
export interface MovedInfo {
	/** The move's id (what Undo names). */
	id: string;
	/** Where it was made: a patch set of the reviewer's, else a head. */
	on: { patchset: number } | { head: string };
	/** When (ISO). */
	at: string;
	/** Made on the target itself (rule 1): placed as chosen, not traced. */
	here: boolean;
	/** The file it was moved to, in its own snapshot. */
	path: string;
}

export function movedInfo(move: ThreadMove, here: boolean): MovedInfo {
	return {
		id: move.id,
		on:
			move.on.patchset !== undefined
				? { patchset: move.on.patchset }
				: { head: move.on.head },
		at: new Date(move.ts).toISOString(),
		here,
		path: move.anchor.path,
	};
}

const sameSnapshot = (
	m: ThreadMove,
	target: { base: string; head: string },
): boolean => m.on.base === target.base && m.on.head === target.head;

/**
 * The move a thread's placement in `target` stands on: the last move made
 * on the target that `fits` it (rule 1, `here`), else the last visible
 * move made elsewhere (rule 2, traced from it), else none (rule 3). A move
 * on the target that doesn't fit is skipped for both rules.
 */
export function effectiveMove(
	moves: readonly ThreadMove[],
	target: { base: string; head: string },
	opts: {
		/** Whether a move counts at the target (an earlier patch set's cutoff). */
		visible: (m: ThreadMove) => boolean;
		/** Whether a move made on the target is lines of it (validAnchor). */
		fits: (m: ThreadMove) => boolean;
	},
): { move: ThreadMove; here: boolean } | null {
	const shown = moves.filter(opts.visible);
	for (let i = shown.length - 1; i >= 0; i--) {
		const m = shown[i] as ThreadMove;
		if (sameSnapshot(m, target) && opts.fits(m)) return { move: m, here: true };
	}
	for (let i = shown.length - 1; i >= 0; i--) {
		const m = shown[i] as ThreadMove;
		if (!sameSnapshot(m, target)) return { move: m, here: false };
	}
	return null;
}

/**
 * Which moves count at an earlier patch set: those made before the next
 * patch set started (`nextStartedAt`, ms); every move at the latest patch
 * set or a head (null).
 */
export const visibleBefore =
	(nextStartedAt: number | null) =>
	(m: ThreadMove): boolean =>
		nextStartedAt === null || m.ts < nextStartedAt;

/** How a moved thread is placed (built by the caller, which does the git). */
export type MoveChoice =
	| { move: ThreadMove; here: true }
	| {
			move: ThreadMove;
			here: false;
			/** The trace's input from the move's snapshot; null: it couldn't be had (its commits gone). */
			input: ThreadInput | null;
			/** The move's path is a file of the target's comparison. */
			inComparison: boolean;
	  };

export interface PlacedWithMove {
	id: string;
	placement: ThreadPlacement;
	moved?: MovedInfo;
}

/**
 * Every input placed once, in order: by its move when `choices` has one
 * (rule 1 placed as chosen once it checks against the target, rule 2
 * traced from the move, or `rewritten` when that trace can't be had),
 * else by its own trace. Never drops or adds a thread.
 */
export function placeWithMoves(
	inputs: readonly ThreadInput[],
	choices: ReadonlyMap<string, MoveChoice>,
	lineCount: (path: string, side: DiffSide) => number | null,
	own: (input: ThreadInput) => ThreadPlacement = (input) =>
		placeThread(input, lineCount),
): PlacedWithMove[] {
	return inputs.map((input) => {
		const c = choices.get(input.id);
		if (!c) return { id: input.id, placement: own(input) };
		const moved = movedInfo(c.move, c.here);
		if (c.here) {
			const { path, startSide, startLine, side, line } = c.move.anchor;
			const anchor = { path, startSide, startLine, side, line };
			// Checked by the caller already; a second check costs nothing.
			if (validAnchor(anchor, lineCount)) {
				return {
					id: input.id,
					placement: { kind: "placed", anchor, changed: false },
					moved,
				};
			}
			return { id: input.id, placement: own(input) };
		}
		if (c.input) {
			const { source: _github, untraced: _u, ...traced } = c.input;
			const placement = placeThread({ ...traced, id: input.id }, lineCount);
			// Unplaced: the lines it was moved to are its Original Reviewed Change.
			if (placement.kind === "unplaced" && traced.diffs) {
				const old = oldLines(traced.diffs, c.move.anchor);
				if (old.text.length > 0) {
					return { id: input.id, placement: { ...placement, old }, moved };
				}
			}
			return { id: input.id, placement, moved };
		}
		// Its commits are gone: never the tracer's older guess.
		const path = c.move.anchor.path;
		return {
			id: input.id,
			placement: c.inComparison
				? { kind: "unplaced", fate: "rewritten", path, nearest: null }
				: { kind: "outside", path, fate: "rewritten" },
			moved,
		};
	});
}

/** POST /moves: move a thread to lines of the target viewed. */
export interface MoveRequest {
	thread: ThreadRef;
	/** The target viewed: the latest patch set, or a head. */
	to: { patchset: number } | { head: string };
	anchor: ThreadAnchorRef;
}

/** POST /moves's answer: the move written and the thread's placement. */
export interface MoveAnswer {
	move: string;
	thread: ThreadRef;
	placement: ThreadPlacement;
	moved: MovedInfo;
}

/** DELETE /moves/:id's answer; the placement when it is known at once. */
export interface UndoMoveAnswer {
	undone: string;
	thread: ThreadRef;
	placement?: ThreadPlacement;
	moved?: MovedInfo;
}
