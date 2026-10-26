import { CheckCircleIcon, IssueReopenedIcon } from "@primer/octicons-react";
import type { ReviewThread } from "../../shared/types";
import { Tooltip } from "../Tooltip";
import { useThreadWriter, useWritesOn } from "./threadWrites";

/** The thread may be resolved or unresolved here (by GitHub and the session). */
export function canToggle(thread: ReviewThread, writesOn: boolean): boolean {
	return (
		writesOn &&
		thread.id !== "" &&
		thread.unavailable === undefined &&
		(thread.viewerCan.resolve || thread.viewerCan.unresolve)
	);
}

/**
 * Resolve (a check) on an open thread, unresolve on a resolved one: flips
 * at once and goes to GitHub through the thread's write queue. Hidden
 * where the viewer can't, or the session doesn't write. Never touches
 * review progress (principle 2): it's a GitHub action on a thread.
 */
export function ResolveToggle(props: {
	/** The thread as the reviewer intends it (overlayThreads). */
	thread: ReviewThread;
	/** Told after each flip, with the new state (the Overview's fade). */
	onToggle?: (resolved: boolean) => void;
}) {
	const { thread } = props;
	const writer = useThreadWriter();
	const on = useWritesOn();
	if (!canToggle(thread, on)) return null;
	const label = thread.resolved ? "Unresolve" : "Resolve";
	const IconEl = thread.resolved ? IssueReopenedIcon : CheckCircleIcon;
	return (
		<Tooltip content={label} describe={false}>
			{(trigger) => (
				<button
					{...trigger}
					type="button"
					aria-label={label}
					data-testid="resolve-toggle"
					onClick={() => {
						const next = !thread.resolved;
						writer.setResolved(thread.id, next);
						props.onToggle?.(next);
					}}
					className={`-my-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-md hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent ${thread.resolved ? "text-muted hover:text-ink" : "text-ok"}`}
				>
					<IconEl size={16} aria-hidden />
				</button>
			)}
		</Tooltip>
	);
}
