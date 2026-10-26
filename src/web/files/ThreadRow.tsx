import {
	AlertIcon,
	CheckCircleIcon,
	CommentDiscussionIcon,
	HistoryIcon,
} from "@primer/octicons-react";
import type { ReviewThread } from "../../shared/types";
import { Badge, LabeledIcon } from "../overview/parts";
import { Conversation } from "../threads/Conversation";
import { ThreadStatus } from "../threads/ThreadStatus";

/**
 * One thread opened in Files changed: a header with its state (resolved in
 * green, unmistakably), its count and your-turn dot, outdated, and a flag
 * when its line couldn't be placed; then every comment.
 */
export function ThreadBlock(props: {
	readId: string;
	thread: ReviewThread;
	/** Its line isn't in this diff: shown in the file's header instead. */
	unplaced?: boolean;
}) {
	const { thread } = props;
	return (
		<article
			data-testid="files-thread"
			aria-label={`${thread.resolved ? "Resolved" : "Unresolved"} thread by ${thread.author}`}
			className="min-w-0 overflow-hidden rounded-lg border border-edge bg-surface"
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-band px-2.5 py-1 text-xs text-muted">
				{thread.resolved ? (
					<CheckCircleIcon size={14} aria-hidden className="shrink-0 text-ok" />
				) : (
					<CommentDiscussionIcon
						size={14}
						aria-hidden
						className="shrink-0 text-warn"
					/>
				)}
				<span
					className={`font-semibold ${thread.resolved ? "text-ok" : "text-ink-soft"}`}
				>
					{thread.resolved ? "Resolved" : "Unresolved"}
				</span>
				{props.unplaced && (
					<LabeledIcon
						icon={AlertIcon}
						label="Line not in this diff"
						className="text-warn"
					/>
				)}
				<span className="ml-auto flex items-center gap-2">
					<ThreadStatus thread={thread} mark={false} />
					{thread.outdated && (
						<Badge tone="gray" icon={HistoryIcon}>
							outdated
						</Badge>
					)}
				</span>
			</div>
			<div className="p-2.5">
				<Conversation readId={props.readId} thread={thread} />
			</div>
		</article>
	);
}

/**
 * The threads of a bubble, opened under their line: a row of the diff
 * table whose content stays at the scroll container's visible width
 * (`--diff-w`, set by DiffBody) and in view however far the code scrolls
 * sideways. Text wraps to that width; wide code in a comment scrolls in
 * the comment.
 */
export function ThreadRow(props: {
	readId: string;
	threads: ReviewThread[];
	id?: string;
	columns: number;
	/** The cluster rail's class, carried on beside the thread (the rows it sits between are one cluster). */
	rail?: string;
}) {
	return (
		<tr data-testid="thread-row" id={props.id}>
			<td colSpan={props.columns} className="p-0">
				<div className="sticky left-0 w-[var(--diff-w,100%)] max-w-full space-y-2 border-y border-line bg-canvas py-2 pr-2 pl-3 font-sans text-sm leading-normal whitespace-normal text-ink">
					{props.rail && (
						<span
							aria-hidden
							data-testid="thread-rail"
							className={`absolute inset-y-0 left-0 w-1 ${props.rail}`}
						/>
					)}
					{props.threads.map((t, i) => (
						<ThreadBlock
							key={t.id || `#${i}`}
							readId={props.readId}
							thread={t}
						/>
					))}
				</div>
			</td>
		</tr>
	);
}
