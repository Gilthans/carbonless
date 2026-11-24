import { CommentIcon, type Icon } from "@primer/octicons-react";
import type { DiffSide, FileSummary, PrOverview } from "../../shared/types";
import { openComposer } from "../threads/newThreads";

/**
 * What a selection in Files changed points at, whatever is done with it: a
 * range of `path`'s rows in the diff at `commit` (GitHub's range: start =
 * the first row, end = the last), the exact characters when `startCol` and
 * `endCol` are set (UTF-16, end exclusive), or the whole file.
 */
export interface CodeSpan {
	path: string;
	commit: string;
	subject: "line" | "file";
	/**
	 * On the since view's compared (earlier) patch set's commit on purpose:
	 * its RIGHT lines that only that patch set had (CAR-233).
	 */
	earlier?: boolean;
	startSide?: DiffSide;
	startLine?: number;
	side?: DiffSide;
	line?: number;
	startCol?: number | null;
	endCol?: number | null;
}

/** What an action needs to know besides the span to say whether it can run. */
export interface SelectionContext {
	writes: PrOverview["writes"];
	commentLeft: boolean;
	file: Pick<FileSummary, "binary" | "submodule">;
	/**
	 * Whether both ends of the span are lines of GitHub's diff (a hunk's,
	 * not expanded context). Undefined: unknown, taken as yes.
	 */
	inDiff?: boolean;
	/**
	 * The since view: the span has no GitHub lines: a line only an earlier
	 * patch set had and not in that patch set's diff either, a line the
	 * view doesn't know (CAR-217), or the earlier patch set's lines mixed
	 * with the head's (CAR-233).
	 */
	noLine?: "earlier" | "unknown" | "mixed" | "renamed" | "split" | "orphan";
	/**
	 * The diff on screen is not yet the viewed head's (a Refresh moved the
	 * head first): its lines would be named on the wrong commit.
	 */
	headUnsure?: boolean;
	/** An earlier patch set (read-only): GitHub's comments go on the latest. */
	readOnly?: boolean;
}

/**
 * Why nothing can start on a span with a line only an earlier patch set
 * had, outside that patch set's diff on GitHub too (CAR-233: one inside
 * it takes a comment, on that patch set's commit).
 */
export const EARLIER_ONLY = "Not in the earlier patch set's diff on GitHub";

/** Why nothing can start on the earlier patch set's lines mixed with the head's. */
export const MIXED_COMMITS =
	"Mixes an earlier patch set's lines with the head's";

/** Why nothing can start on a span with a line whose GitHub line isn't known. */
export const NO_GITHUB_LINE = "Can't place this line on GitHub's diff";

/** The reason for a span's line with no GitHub line (SelectionContext.noLine). */
/** Why nothing can start on an earlier patch set's line whose file was renamed since. */
export const RENAMED_SINCE = "Renamed since the earlier patch set";

/** Why nothing can start on an earlier patch set's lines that aren't one run there. */
export const SPLIT_EARLIER = "Not one range on the earlier patch set";

/**
 * Why nothing can start on a since-view orphan removed line (CAR-216)
 * with lines outside its run (CAR-276).
 */
export const ORPHAN_MIXED = "Mixes lines not reviewed earlier with others";

export const noLineReason = (
	why: "earlier" | "unknown" | "mixed" | "renamed" | "split" | "orphan",
) =>
	why === "earlier"
		? EARLIER_ONLY
		: why === "mixed"
			? MIXED_COMMITS
			: why === "renamed"
				? RENAMED_SINCE
				: why === "split"
					? SPLIT_EARLIER
					: why === "orphan"
						? ORPHAN_MIXED
						: NO_GITHUB_LINE;

/** Why nothing can start on a span while the diff shown isn't the head's. */
export const HEAD_UNSURE = "The new head's diff is loading";

/** One thing a selection can start: Comment now, more kinds later. */
export interface SelectionAction {
	id: string;
	icon: Icon;
	label: string;
	/** Its icon's colour when available (a token class), else the bar's ink. */
	iconClassName?: string;
	/** Its key in the shortcuts help (desktop only). */
	shortcut?: string;
	/** True, or why not (the disabled button's tooltip). */
	available(span: CodeSpan, ctx: SelectionContext): true | string;
	start(span: CodeSpan): void;
}

/**
 * Whether GitHub takes a comment on a line that only expanded context shows
 * (outside every hunk): it doesn't (422), so Comment is off there.
 */
export const COMMENT_OUTSIDE_HUNKS = false;

const sides = (span: CodeSpan): DiffSide[] =>
	span.subject === "file"
		? []
		: [span.startSide, span.side].filter((s): s is DiffSide => s !== undefined);

/** Why a comment can't go on the span; true when it can. */
export function commentAvailable(
	span: CodeSpan,
	ctx: SelectionContext,
): true | string {
	if (ctx.writes === "as-of") return "Comments are off as of a cutoff";
	if (ctx.readOnly) return "An earlier patch set: comment on the latest";
	if (ctx.headUnsure && span.subject !== "file") return HEAD_UNSURE;
	if (ctx.writes === "viewer") {
		return "Comments are off when viewing as someone else";
	}
	if (span.subject === "file") return true;
	if (ctx.file.binary || ctx.file.submodule) {
		return "No lines to comment on in this file";
	}
	if (ctx.noLine) return noLineReason(ctx.noLine);
	if (!ctx.commentLeft && sides(span).includes("LEFT")) {
		return "Old lines can't take comments with this pinned head";
	}
	// Checked on GitHub: a line only expanded context shows is refused (a
	// range across hunks is taken).
	if (!COMMENT_OUTSIDE_HUNKS && ctx.inDiff === false) {
		return "GitHub only takes comments on lines in the diff";
	}
	return true;
}

export const COMMENT_ACTION: SelectionAction = {
	id: "comment",
	icon: CommentIcon,
	label: "Comment",
	shortcut: "c",
	available: commentAvailable,
	start: (span) => openComposer(span),
};

/** The registered actions: a new array on each change (a store's snapshot). */
let registry: readonly SelectionAction[] = [COMMENT_ACTION];
const listeners = new Set<() => void>();

/** Adds an action to every selection's bar (in order); returns its removal. */
export function registerSelectionAction(action: SelectionAction): () => void {
	registry = [...registry, action];
	for (const l of listeners) l();
	return () => {
		registry = registry.filter((a) => a !== action);
		for (const l of listeners) l();
	};
}

/** The actions a selection's bar offers, in order. */
export function selectionActions(): readonly SelectionAction[] {
	return registry;
}

export function subscribeSelectionActions(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** "line 12, new", "old lines 3–5", "lines 4–7": where a span lands on GitHub. */
export function describeSpan(span: CodeSpan): string {
	if (span.subject === "file" || span.line === undefined) return "whole file";
	const word = (side: DiffSide | undefined) =>
		side === "LEFT" ? "old" : "new";
	const start = span.startLine ?? span.line;
	if (start === span.line && span.startSide === span.side) {
		return `line ${span.line}, ${word(span.side)}`;
	}
	if (span.startSide === span.side) {
		return `lines ${start}–${span.line}, ${word(span.side)}`;
	}
	return `${word(span.startSide)} ${start} – ${word(span.side)} ${span.line}`;
}
