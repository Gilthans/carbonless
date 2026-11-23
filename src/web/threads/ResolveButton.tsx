import { CheckCircleIcon, IssueReopenedIcon } from "@primer/octicons-react";
import type { ReviewThread } from "../../shared/types";
import { Tooltip, type TooltipTriggerProps } from "../Tooltip";
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
 * `compact`: the icon alone on a phone (a closed Overview card's Show more
 * row, beside the toggle and the agent's handle), named and tipped.
 */
export function ResolveButton(props: {
	/** The thread as the reviewer intends it (overlayThreads). */
	thread: ReviewThread;
	/** Told after each flip, with the new state and the button (the Overview's fade, Files changed's close). */
	onToggle?: (resolved: boolean, from: Element) => void;
	/** The thread's agent suggests resolving it: an `ok` ring. */
	suggested?: boolean;
	/** The icon alone below `sm`, with a tooltip (the word from `sm` up). */
	compact?: boolean;
}) {
	const { thread } = props;
	const writer = useThreadWriter();
	const on = useWritesOn();
	if (!canToggle(thread, on)) return null;
	const label = thread.resolved ? "Unresolve" : "Resolve";
	const IconEl = thread.resolved ? IssueReopenedIcon : CheckCircleIcon;
	const button = (trigger?: TooltipTriggerProps) => (
		<button
			{...trigger}
			type="button"
			data-testid="resolve-button"
			aria-label={props.compact ? label : undefined}
			onClick={(e) => {
				const next = !thread.resolved;
				writer.setResolved(thread.id, next);
				props.onToggle?.(next, e.currentTarget);
			}}
			// A focused reply box keeps its focus (and so its size) on a mouse
			// click: shrinking under the pointer, it would move the button away.
			onMouseDown={(e) => e.preventDefault()}
			className={`flex h-10 min-w-10 shrink-0 items-center justify-center gap-2 self-end ml-auto rounded-md border text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent ${
				props.compact ? "px-2.5 sm:px-4" : "px-4"
			} ${
				thread.resolved
					? "border-line-strong text-ink-soft hover:bg-overlay hover:text-ink"
					: "border-ok/60 bg-ok/10 text-ok hover:bg-ok/20"
			}${props.suggested && !thread.resolved ? " ring-2 ring-ok ring-offset-1 ring-offset-surface" : ""}`}
		>
			<IconEl size={16} aria-hidden />
			{props.compact ? (
				<span className="hidden sm:inline">{label}</span>
			) : (
				label
			)}
		</button>
	);
	return props.compact ? (
		<Tooltip content={label} describe={false} dismissKey={thread.resolved}>
			{button}
		</Tooltip>
	) : (
		button()
	);
}
