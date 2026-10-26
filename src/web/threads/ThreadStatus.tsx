import { CheckCircleIcon, CommentIcon } from "@primer/octicons-react";
import type { ReviewThread } from "../../shared/types";
import { LabeledIcon, plural } from "../overview/parts";
import { Tooltip } from "../Tooltip";

/**
 * A thread's state at a glance, icons only: resolved (a green check), how
 * many comments, and a yellow dot when it's the viewer's turn (they are in
 * its attention set; never once resolved). Each has a name and a tooltip.
 */
export function ThreadStatus(props: {
	thread: ReviewThread;
	/**
	 * Show the resolved check (default). Off where the resolved state is
	 * already named beside it, as in the Overview card's header.
	 */
	mark?: boolean;
}) {
	const { thread } = props;
	const n = thread.commentCount;
	return (
		<span className="inline-flex items-center gap-2">
			{thread.resolved && props.mark !== false && (
				<LabeledIcon
					icon={CheckCircleIcon}
					label="Resolved"
					className="text-ok"
				/>
			)}
			<LabeledIcon
				icon={CommentIcon}
				label={plural(n, "comment")}
				text={String(n)}
				className="gap-1 text-muted"
			/>
			{thread.yourTurn && !thread.resolved && <YourTurnDot />}
		</span>
	);
}

/** The notification dot: the thread waits on the viewer. */
function YourTurnDot() {
	return (
		<Tooltip content="Your turn" describe={false}>
			{(trigger) => (
				<span
					{...trigger}
					role="img"
					aria-label="Your turn"
					data-testid="your-turn"
					// Focusable so keyboard and touch users can read the tooltip.
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className="relative inline-flex h-4 w-2.5 shrink-0 cursor-help items-center justify-center rounded-sm after:absolute after:top-1/2 after:left-1/2 after:h-10 after:w-8 after:-translate-x-1/2 after:-translate-y-1/2 focus-visible:outline-2 focus-visible:outline-accent"
				>
					<span aria-hidden className="h-2.5 w-2.5 rounded-full bg-warn" />
				</span>
			)}
		</Tooltip>
	);
}
