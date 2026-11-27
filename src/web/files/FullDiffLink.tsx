import { FileDiffIcon } from "@primer/octicons-react";
import { Link } from "@tanstack/react-router";
import { useReviewId } from "../reviewId";
import { Tooltip } from "../Tooltip";
import type { FilesSearch } from "./landing";

/** Where a full diff link lands: a line, and a card to open there. */
export interface FullDiffTarget {
	path: string;
	line: number;
	side: "LEFT" | "RIGHT";
	/** The card to open on arrival: a review thread's id, or an agent conversation's. */
	open?: { thread: string } | { conversation: string };
}

/**
 * The full diff's address for `target`, from the current one: the viewed
 * dot (`ps` or `head`) stays, the base moves to the branch, and only the
 * landing is added; nothing else of the address is carried.
 */
export function fullDiffSearch(
	prev: Pick<FilesSearch, "ps" | "head">,
	target: FullDiffTarget,
): FilesSearch {
	return {
		...(prev.ps === undefined ? {} : { ps: prev.ps }),
		...(prev.head === undefined ? {} : { head: prev.head }),
		from: "branch",
		path: target.path,
		line: target.line,
		side: target.side,
		...target.open,
	};
}

/**
 * The since view's way to a line in the full diff (fullDiffSearch): an
 * icon, with "full diff" beside it from `sm` up (a phone's card header
 * keeps to one line); its name and tooltip say where it goes.
 */
export function FullDiffLink(props: {
	target: FullDiffTarget;
	testId?: string;
}) {
	const id = useReviewId();
	return (
		<Tooltip content="Open in the full diff, on its line" describe={false}>
			{(trigger) => (
				<Link
					{...trigger}
					to="/r/$id/files"
					params={{ id }}
					search={(prev: FilesSearch) => fullDiffSearch(prev, props.target)}
					aria-label="Open in the full diff"
					data-testid={props.testId ?? "full-diff-link"}
					className="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-sm px-1 text-xs font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
				>
					<FileDiffIcon size={14} aria-hidden />
					<span className="max-sm:hidden">full diff</span>
				</Link>
			)}
		</Tooltip>
	);
}
