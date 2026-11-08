import {
	CheckCircleIcon,
	ChevronDownIcon,
	ClockIcon,
	CommentDiscussionIcon,
	ReplyIcon,
} from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import type { ReviewThread } from "../../shared/types";
import { commentsQuery } from "../api";
import { Tooltip, type TooltipTriggerProps } from "../Tooltip";
import { useThreadWrites } from "./threadWrites";

/*
 * A thread card's "Show more" and its reply count, shared by the
 * Overview's thread cards and Files changed's unplaced threads.
 */

export const repliesText = (n: number) =>
	`${n} ${n === 1 ? "reply" : "replies"}`;

/**
 * How many replies a card has: GitHub's count past the opener, plus the
 * viewer's own pending ones once their comments are in, plus replies sent
 * and not yet confirmed.
 */
export function useReplyCount(
	thread: ReviewThread,
	readId: string,
): { n: number; pending: number } {
	const sending = useThreadWrites().threads.get(thread.id)?.replies.length ?? 0;
	const known = useQuery({
		...commentsQuery(readId, thread.id),
		enabled: false,
	}).data;
	const pending = known?.comments.filter((c) => c.pending).length ?? 0;
	return {
		n: Math.max(0, thread.commentCount - 1) + pending + sending,
		pending,
	};
}

const TOGGLE_TEXT = {
	more: { closed: "Show more", open: "Show less" },
	reply: { closed: "Reply", open: "Hide" },
	resolve: { closed: "Resolve", open: "Hide" },
} as const;

/**
 * The card's one toggle: "Show more", with how many replies wait behind
 * it (and a clock for the viewer's pending ones), or "Show less". On a
 * card with nothing more to read, "Reply" (or "Resolve") and "Hide".
 */
export function MoreToggle(props: {
	open: boolean;
	onClick: () => void;
	controls: string;
	replies: { n: number; pending: number };
	kind: "more" | "reply" | "resolve";
}) {
	const { open, replies, kind } = props;
	const text = TOGGLE_TEXT[kind];
	const KindIcon =
		kind === "reply" ? ReplyIcon : kind === "resolve" ? CheckCircleIcon : null;
	const { pending } = replies;
	// Why the count passes the header's, and why it grew.
	const pendingTip =
		!open && pending > 0
			? `${pending} pending, only you see ${pending === 1 ? "it" : "them"}`
			: null;
	const toggle = (trigger?: TooltipTriggerProps) => (
		<button
			{...trigger}
			type="button"
			aria-expanded={open}
			aria-controls={props.controls}
			aria-label={
				open
					? text.open
					: [
							text.closed,
							replies.n > 0 ? repliesText(replies.n) : "",
							pendingTip ?? "",
						]
							.filter(Boolean)
							.join(", ")
			}
			data-testid="thread-more"
			onClick={props.onClick}
			className="-mb-2 flex min-h-10 items-center gap-1 rounded-md text-xs font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
		>
			{KindIcon && !open ? (
				<KindIcon size={16} aria-hidden />
			) : (
				<ChevronDownIcon
					size={16}
					aria-hidden
					className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
				/>
			)}
			{open ? text.open : text.closed}
			{!open && replies.n > 0 && (
				<>
					<span aria-hidden className="px-0.5">
						·
					</span>
					<CommentDiscussionIcon size={16} aria-hidden />
					{repliesText(replies.n)}
				</>
			)}
			{pendingTip && (
				<ClockIcon
					size={16}
					aria-hidden
					data-testid="replies-pending"
					className="text-warn"
				/>
			)}
		</button>
	);
	return pendingTip ? (
		<Tooltip content={pendingTip} describe={false}>
			{toggle}
		</Tooltip>
	) : (
		toggle()
	);
}
