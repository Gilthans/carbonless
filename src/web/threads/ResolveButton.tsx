import { CheckCircleIcon, IssueReopenedIcon } from "@primer/octicons-react";
import type { ReviewThread } from "../../shared/types";
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
 * "Resolve" on an open thread, "Unresolve" on a resolved one: a big
 * button (text and icon) beside the reply box, the bigger action next to
 * Send. Flips at once and goes to GitHub through the thread's write queue.
 * Hidden where the viewer can't, or the session doesn't write. Never
 * touches review progress (principle 2): it's a GitHub action on a thread.
 */
export function ResolveButton(props: {
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
		<button
			type="button"
			data-testid="resolve-button"
			onClick={() => {
				const next = !thread.resolved;
				writer.setResolved(thread.id, next);
				props.onToggle?.(next);
			}}
			// A focused reply box keeps its focus (and so its size) on a mouse
			// click: shrinking under the pointer, it would move the button away.
			onMouseDown={(e) => e.preventDefault()}
			className={`flex h-10 shrink-0 items-center justify-center gap-2 self-end ml-auto rounded-md border px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent ${
				thread.resolved
					? "border-line-strong text-ink-soft hover:bg-overlay hover:text-ink"
					: "border-ok/60 bg-ok/10 text-ok hover:bg-ok/20"
			}`}
		>
			<IconEl size={16} aria-hidden />
			{label}
		</button>
	);
}
