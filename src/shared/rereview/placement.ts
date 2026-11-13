/**
 * Where an unresolved thread sits in a target snapshot: the tracer's
 * three-diff trace of its range (src/shared/tracer/), turned into what the
 * page shows. Placed, on the same text; changed, on the lines that replaced
 * it, with the text as it was; unplaced, under its file with a fate; or
 * outside, when its file is not in the comparison at all (the page's
 * trailing "Not in this comparison" group). Every thread gets one: none is
 * dropped.
 *
 * A stored placement (the reviewer's `thread-placed`) wins once it is
 * checked against the target (its path a file of the snapshot, its lines
 * inside that file); one that fails the check is ignored, never moved
 * elsewhere. `moved` is only ever a rename pair's new path (git's rename
 * detection), never a text search across lines. Which commit did what is
 * not computed (owner, 2026-11-07: deferred).
 *
 * A thread that can't be traced from its own commit (none given, or one
 * git can't have) is traced from where GitHub puts it now instead: its
 * current line on the PR's head (`source: "github"`; owner, 2026-11-11,
 * CAR-116). Only the same text counts there: anything else (its line
 * changed or gone, its file out of the comparison) is `untraced`, since
 * "since the review" would be a claim about history it never followed.
 * With no line from GitHub either, it is `outdated` (GitHub's word) or
 * `untraced`, under its file. `rewritten` stays a trace's own answer.
 *
 * Pure: no git, no I/O, nothing from `src/server/`.
 */

import type { LineMapper } from "../tracer/lineMapper.js";
import {
	type Placement,
	type Position,
	type TraceDiffs,
	traceRange,
} from "../tracer/trace.js";
import type { CodeAnchor, DiffSide, ThreadAnchorRef } from "../types.js";

/**
 * What became of a thread's lines: deleted (nothing replaced them);
 * rewritten (a trace lost them: past the end of the file); outdated
 * (never traced: no commit of its own to trace from, and GitHub marks it
 * outdated); untraced (never traced, and GitHub gives no line it still
 * sits on here); file-gone (the file was deleted);
 * moved (the file was renamed and the lines didn't follow: a candidate
 * only); reverted (the PR no longer changes that place: what the thread was
 * about is out of the PR); base-changed (an old-side line the base itself
 * changed since).
 */
export type Fate =
	| "deleted"
	| "rewritten"
	| "outdated"
	| "untraced"
	| "file-gone"
	| "moved"
	| "reverted"
	| "base-changed";

export type ThreadPlacement =
	/**
	 * On the same text (a stored placement too: the reviewer's word);
	 * `source: "github"`: traced from GitHub's current line, not from the
	 * thread's own commit.
	 */
	| {
			kind: "placed";
			anchor: ThreadAnchorRef;
			changed: false;
			source?: "github";
	  }
	/**
	 * On the lines that replaced the commented ones; `old` the commented
	 * range in the thread's own snapshot and its text there (empty when
	 * unknown).
	 */
	| {
			kind: "changed";
			anchor: ThreadAnchorRef;
			old: { side: DiffSide; startLine: number; line: number; text: string[] };
			/** The replacing lines' text in the target (empty when unknown). */
			now: string[];
	  }
	/**
	 * Under the file at `path` (its path in the target), fate first;
	 * `nearest`: the closest surviving line above, in the target.
	 */
	| {
			kind: "unplaced";
			fate: Fate;
			path: string;
			nearest: Position | null;
			movedTo?: string;
	  }
	/** A file comment, on its file (through a rename). */
	| { kind: "file"; path: string }
	/**
	 * The file is not in the comparison at all: listed in the trailing
	 * group by its original `path`, with why (file-gone: deleted; reverted:
	 * the PR no longer changes it; outdated, untraced: not traceable).
	 */
	| { kind: "outside"; path: string; fate: Fate };

export interface ThreadInput {
	id: string;
	/** The thread's path in its own snapshot. */
	path: string;
	/** Its range in its own snapshot; null for a file comment. */
	anchor: Pick<CodeAnchor, "side" | "line" | "startSide" | "startLine"> | null;
	/**
	 * The three diffs of its file into the target (`ac`, `bd`, `cd`);
	 * null: the file is gone from the target's head, or the thread's own
	 * snapshot couldn't be had (`newPath` then says which: null for gone).
	 */
	diffs: TraceDiffs | null;
	/** Its file's path in the target's head (a rename pair's new path); null: gone. */
	newPath: string | null;
	/** The target's diff lists `newPath` (or, gone, `path`). */
	inComparison: boolean;
	/** The reviewer's placement for this patch set, unchecked. */
	stored?: ThreadAnchorRef;
	/**
	 * The thread's own diff (its base to its commit), this file: tells a
	 * line the PR added, for `reverted`.
	 */
	own?: LineMapper;
	/** Text in the target snapshot, for a changed thread's new lines. */
	newLineText?: (pos: Position) => string | null;
	/**
	 * "github": `anchor`, `diffs` and `own` are GitHub's current line on
	 * the PR's head, not the thread's own commit (it has none to trace
	 * from).
	 */
	source?: "github";
	/**
	 * Why `diffs` is null when the file isn't gone: there is nothing to
	 * trace from, and GitHub says outdated ("outdated") or gives no line
	 * ("untraced", the default).
	 */
	untraced?: "outdated" | "untraced";
}

const isLine = (n: unknown): n is number =>
	typeof n === "number" && Number.isInteger(n) && n >= 1;

/**
 * A stored anchor that fits the target: its path a file of the snapshot,
 * both ends inside that file on their side, the start not after the end
 * on one side.
 */
export function validAnchor(
	anchor: ThreadAnchorRef,
	lineCount: (path: string, side: DiffSide) => number | null,
): boolean {
	const { path, side, line, startSide, startLine } = anchor;
	if (typeof path !== "string" || path === "") return false;
	if (side !== "LEFT" && side !== "RIGHT") return false;
	if (startSide !== "LEFT" && startSide !== "RIGHT") return false;
	if (!isLine(line) || !isLine(startLine)) return false;
	if (startSide === side && startLine > line) return false;
	const endCount = lineCount(path, side);
	const startCount = lineCount(path, startSide);
	return (
		endCount !== null &&
		startCount !== null &&
		line <= endCount &&
		startLine <= startCount
	);
}

/** The old text of a range, line by line (one side), else its end alone. */
function oldText(
	diffs: TraceDiffs,
	start: Position,
	end: Position,
): { startLine: number; text: string[] } {
	const read = diffs.oldLineText;
	if (!read) return { startLine: end.line, text: [] };
	if (start.side === end.side && start.line <= end.line) {
		const text: string[] = [];
		for (let n = start.line; n <= end.line; n++) {
			const t = read({ side: end.side, line: n });
			if (t === null) return { startLine: start.line, text: [] };
			text.push(t);
		}
		return { startLine: start.line, text };
	}
	const t = read(end);
	return { startLine: end.line, text: t === null ? [] : [t] };
}

/**
 * The PR no longer changes the place a deleted line of its own sat: in the
 * target's own diff (`cd`) nothing is added or removed between the nearest
 * surviving line above and the one after it.
 */
function noChangeAt(cd: LineMapper, nearest: Position | null): boolean {
	const above = nearest?.line ?? 0;
	const oldAbove = above === 0 ? 0 : cd.newToOld(above);
	if (oldAbove === null) return false;
	if (cd.hunkRemovingOld(oldAbove + 1) !== null) return false;
	// The line after: kept from the base, or past the end of both.
	if (cd.hunkAddingNew(above + 1) !== null) return false;
	return true;
}

function fateOf(
	end: Extract<Placement, { kind: "unplaced" }>,
	t: ThreadInput,
	diffs: TraceDiffs,
): Fate {
	if (end.reason === "base-changed") return "base-changed";
	if (end.reason === "outside" || end.reason === "rewritten") {
		return "rewritten";
	}
	if (t.newPath !== null && t.newPath !== t.path) return "moved";
	const anchor = t.anchor;
	if (
		anchor &&
		anchor.side === "RIGHT" &&
		t.own?.hunkAddingNew(anchor.line) &&
		noChangeAt(diffs.cd, end.nearest)
	) {
		return "reverted";
	}
	return "deleted";
}

/** The target's text of a placed range (one side), else its end alone. */
function nowText(t: ThreadInput, start: Position, end: Position): string[] {
	const read = t.newLineText;
	if (!read) return [];
	const from =
		start.side === end.side && start.line <= end.line ? start.line : end.line;
	const text: string[] = [];
	for (let n = from; n <= end.line; n++) {
		const line = read({ side: end.side, line: n });
		if (line === null) return [];
		text.push(line);
	}
	return text;
}

const refOf = (
	path: string,
	start: { side: DiffSide; line: number },
	end: { side: DiffSide; line: number },
): ThreadAnchorRef => ({
	path,
	startSide: start.side,
	startLine: start.line,
	side: end.side,
	line: end.line,
});

/**
 * Where thread `t` sits in the target. `targetLineCount` gives a target
 * file's length on a side (null: not a file of the snapshot, or not on
 * that side): it checks a stored placement.
 */
export function placeThread(
	t: ThreadInput,
	targetLineCount: (path: string, side: DiffSide) => number | null,
): ThreadPlacement {
	if (t.stored && validAnchor(t.stored, targetLineCount)) {
		const { path, startSide, startLine, side, line } = t.stored;
		return {
			kind: "placed",
			anchor: { path, startSide, startLine, side, line },
			changed: false,
		};
	}
	const p = traced(t);
	if (t.source !== "github" || p.kind === "file") return p;
	if (p.kind === "placed") return { ...p, source: "github" };
	// Only GitHub's own line, unchanged, is GitHub's word: the rest was
	// never traced from the thread's own commit.
	if (p.kind === "outside") return { ...p, fate: "untraced" };
	return p.kind === "changed"
		? {
				kind: "unplaced",
				fate: "untraced",
				path: p.anchor.path,
				nearest: { side: p.anchor.side, line: p.anchor.line },
			}
		: { kind: "unplaced", fate: "untraced", path: p.path, nearest: p.nearest };
}

/** placeThread's trace, with no stored placement. */
function traced(t: ThreadInput): ThreadPlacement {
	const gone = t.newPath === null;
	if (!t.inComparison) {
		return {
			kind: "outside",
			path: t.path,
			fate: gone
				? "file-gone"
				: t.diffs === null
					? (t.untraced ?? "untraced")
					: "reverted",
		};
	}
	const path = t.newPath ?? t.path;
	if (gone) {
		return { kind: "unplaced", fate: "file-gone", path, nearest: null };
	}
	if (!t.anchor) return { kind: "file", path };
	const diffs = t.diffs;
	if (!diffs) {
		return {
			kind: "unplaced",
			fate: t.untraced ?? "untraced",
			path,
			nearest: null,
		};
	}
	const startPos: Position = {
		side: t.anchor.startSide,
		line: t.anchor.startLine,
	};
	const endPos: Position = { side: t.anchor.side, line: t.anchor.line };
	const { start, end, collapsed } = traceRange(startPos, endPos, diffs);
	const old = () => {
		const o = oldText(diffs, startPos, endPos);
		return {
			side: endPos.side,
			startLine: o.startLine,
			line: endPos.line,
			text: o.text,
		};
	};
	if (end.kind === "unplaced") {
		// The range's last line is gone; a surviving start carries it (C4).
		if (start.kind !== "unplaced") {
			return {
				kind: "changed",
				anchor: refOf(path, start, start),
				old: old(),
				now: nowText(t, start, start),
			};
		}
		const fate = fateOf(end, t, diffs);
		return {
			kind: "unplaced",
			fate,
			path,
			nearest: end.nearest,
			...(fate === "moved" ? { movedTo: path } : {}),
		};
	}
	// The end placed; a start that didn't trace starts at the end.
	const first = start.kind === "unplaced" ? end : start;
	if (
		collapsed ||
		end.kind === "changed" ||
		first.kind === "changed" ||
		start.kind === "unplaced"
	) {
		return {
			kind: "changed",
			anchor: refOf(path, first, end),
			old: old(),
			now: nowText(t, first, end),
		};
	}
	return { kind: "placed", anchor: refOf(path, first, end), changed: false };
}
