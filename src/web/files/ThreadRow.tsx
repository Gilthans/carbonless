import {
	AlertIcon,
	CheckCircleIcon,
	CommentDiscussionIcon,
	HistoryIcon,
} from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AgentThread } from "../../shared/agent";
import type { DiffSide, ReviewThread } from "../../shared/types";
import { AgentThreadCard } from "../agent/AgentThreadCard";
import { agentStatusQuery } from "../agent/api";
import { Badge, LabeledIcon } from "../overview/parts";
import { Conversation } from "../threads/Conversation";
import { ThreadStatus } from "../threads/ThreadStatus";

/**
 * One thread opened in Files changed: a header with its state (resolved in
 * green, unmistakably), its count and your-turn dot, outdated, and a flag
 * when its line couldn't be placed; then every comment, the reply box and
 * the Resolve button.
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
 * Where a row's card (an opened thread, a composer) sits in the diff table:
 * across all its `columns`, or side by side under the `side` it belongs to.
 */
export type CardPlace = { columns: number } | { side: DiffSide };

/** The card's box: a conversation's font and wrapping, on the canvas. */
const CARD =
	"space-y-2 border-y border-line bg-canvas py-2 font-sans text-sm leading-normal whitespace-normal text-ink";

/**
 * A row under a line's row holding a card. Across the table (unified, and
 * side by side on a phone, where half of 360px is unreadable) its content
 * stays at the scroll container's visible width (`--diff-w`, set by
 * DiffBody) and in view however far the code scrolls sideways, the
 * cluster's rail painted down its left edge. Under one side of a
 * side-by-side row (which never scrolls sideways): the rail and controls
 * cells, then the card over that side's number and code columns and a
 * blank over the other side's, in the blank side's tone. Text wraps to the
 * card's width; wide code in a comment scrolls in the comment.
 */
export function TailRow(props: {
	testId: string;
	id?: string;
	place: CardPlace;
	/** The cluster rail's class, carried on beside the card (the rows it sits between are one cluster). */
	rail?: string;
	children: ReactNode;
}) {
	const { place } = props;
	if ("columns" in place) {
		return (
			<tr data-testid={props.testId} id={props.id}>
				<td colSpan={place.columns} className="p-0">
					<div
						className={`sticky left-0 w-[var(--diff-w,100%)] max-w-full pr-2 pl-3 ${CARD}`}
					>
						{props.rail && (
							<span
								aria-hidden
								data-testid="thread-rail"
								className={`absolute inset-y-0 left-0 w-1 ${props.rail}`}
							/>
						)}
						{props.children}
					</div>
				</td>
			</tr>
		);
	}
	const blank = <td colSpan={2} className="bg-band" />;
	return (
		<tr data-testid={props.testId} id={props.id}>
			<td
				aria-hidden
				data-testid="thread-rail"
				className={`p-0 ${props.rail ?? ""}`}
			/>
			<td />
			{place.side === "RIGHT" && blank}
			<td colSpan={2} className="p-0">
				<div className={`px-2 ${CARD}`}>{props.children}</div>
			</td>
			{place.side === "LEFT" && blank}
		</tr>
	);
}

/** The threads of a bubble, opened under their line (TailRow). */
export function ThreadRow(props: {
	readId: string;
	threads: ReviewThread[];
	id?: string;
	place: CardPlace;
	rail?: string;
}) {
	return (
		<TailRow
			testId="thread-row"
			id={props.id}
			place={props.place}
			rail={props.rail}
		>
			{props.threads.map((t, i) => (
				<ThreadBlock key={t.id || `#${i}`} readId={props.readId} thread={t} />
			))}
		</TailRow>
	);
}

/**
 * The agent threads of an agent bubble, opened under their line, after the
 * line's comment threads. The status comes from the chip's poll.
 */
export function AgentThreadRow(props: {
	threads: AgentThread[];
	id?: string;
	place: CardPlace;
	rail?: string;
	/** Their line isn't in this diff (the file's header). */
	unplaced?: boolean;
}) {
	const status = useQuery({ ...agentStatusQuery, enabled: false }).data;
	return (
		<TailRow
			testId="agent-thread-row"
			id={props.id}
			place={props.place}
			rail={props.rail}
		>
			{props.threads.map((t) => (
				<AgentThreadCard
					key={t.id}
					thread={t}
					status={status}
					unplaced={props.unplaced}
				/>
			))}
		</TailRow>
	);
}
