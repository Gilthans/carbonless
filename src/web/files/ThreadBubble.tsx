import { AlertIcon, CheckIcon, CommentIcon } from "@primer/octicons-react";
import { useEffect, useRef } from "react";
import type { ReviewThread } from "../../shared/types";
import { plural } from "../overview/parts";
import { Tooltip } from "../Tooltip";

/**
 * The bubble's name: its comment count and where ("on line 16", "in this
 * file"), then what stands out.
 */
export function bubbleLabel(
	threads: ReviewThread[],
	flagged = false,
	where?: string,
): string {
	const count = threads.reduce((n, t) => n + t.commentCount, 0);
	const parts = [
		where ? `${plural(count, "comment")} ${where}` : plural(count, "comment"),
	];
	if (threads.length > 0 && threads.every((t) => t.resolved)) {
		parts.push("resolved");
	}
	if (threads.some((t) => t.yourTurn && !t.resolved)) parts.push("your turn");
	if (flagged) parts.push("line not in this diff");
	return parts.join(", ");
}

/**
 * The threads on one line (or a gap, or a file's header), icon first: the
 * comment glyph and count, muted with a check once every thread is
 * resolved, a yellow dot when one waits on the viewer, and a yellow alert
 * when a line couldn't be placed (`flagged`). A 40px target (in a diff
 * row with a mouse, the row's height); it opens and closes the threads. `inline`: in a diff row,
 * where it stays at the visible right edge of the code as that scrolls.
 */
export function ThreadBubble(props: {
	threads: ReviewThread[];
	open: boolean;
	onToggle: () => void;
	flagged?: boolean;
	inline?: boolean;
	controls?: string;
	/** Where, for its name: "on line 16", "in this file". */
	where?: string;
	/** Take focus once shown (then `onFocused`). */
	focus?: boolean;
	onFocused?: () => void;
}) {
	const { threads } = props;
	const label = bubbleLabel(threads, props.flagged, props.where);
	const button = useRef<HTMLButtonElement | null>(null);
	const { focus, onFocused } = props;
	useEffect(() => {
		if (!focus || !button.current) return;
		button.current.focus({ preventScroll: true });
		onFocused?.();
	}, [focus, onFocused]);
	const count = threads.reduce((n, t) => n + t.commentCount, 0);
	const resolved = threads.every((t) => t.resolved);
	const yourTurn = threads.some((t) => t.yourTurn && !t.resolved);
	return (
		// Toggling closes its tip, so a tap doesn't leave it over the thread.
		<Tooltip content={label} describe={false} dismissKey={props.open}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					ref={(el) => {
						button.current = el;
						trigger.ref(el);
					}}
					data-testid="thread-bubble"
					aria-label={label}
					aria-expanded={props.open}
					aria-controls={props.controls}
					onClick={props.onToggle}
					// In a row: as tall as the row for a mouse, 40px on touch (the
					// row grows to it, so neighbouring bubbles never overlap).
					className={`group/bubble z-[4] flex min-w-10 shrink-0 items-center justify-center rounded-md font-sans focus-visible:outline-2 focus-visible:outline-accent ${
						props.inline
							? "sticky right-0 float-right -mr-2 h-5 pointer-coarse:h-10"
							: "h-10"
					}`}
				>
					<span
						aria-hidden
						className={`flex h-5 items-center gap-1 rounded-full border px-1.5 text-xs leading-none tabular-nums shadow-control transition-colors motion-reduce:transition-none ${
							props.open
								? "border-accent bg-pressed text-ink"
								: resolved
									? "border-line-strong bg-raised text-muted group-hover/bubble:text-ink"
									: "border-line-strong bg-raised text-ink-soft group-hover/bubble:text-ink"
						}`}
					>
						{resolved ? (
							<CheckIcon size={12} className="text-ok" />
						) : (
							<CommentIcon size={12} />
						)}
						{count}
						{props.flagged && <AlertIcon size={12} className="text-warn" />}
						{yourTurn && (
							<span
								data-testid="your-turn-dot"
								className="h-2 w-2 rounded-full bg-warn"
							/>
						)}
					</span>
				</button>
			)}
		</Tooltip>
	);
}
