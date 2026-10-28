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
	/** Its start comes after its end in GitHub's order (Ignore whitespace's pairs). */
	backwards?: boolean;
}

/** One thing a selection can start: Comment now, more kinds later. */
export interface SelectionAction {
	id: string;
	icon: Icon;
	label: string;
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
	if (ctx.writes === "viewer") {
		return "Comments are off when viewing as someone else";
	}
	if (span.subject === "file") return true;
	if (ctx.file.binary || ctx.file.submodule) {
		return "No lines to comment on in this file";
	}
	if (!ctx.commentLeft && sides(span).includes("LEFT")) {
		return "Old lines can't take comments with this pinned head";
	}
	if (ctx.backwards) {
		return "Turn off Ignore whitespace to comment on these lines together";
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
