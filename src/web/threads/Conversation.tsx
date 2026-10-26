import { AlertIcon, ClockIcon, SyncIcon } from "@primer/octicons-react";
import type { ReviewThread, ThreadComment } from "../../shared/types";
import { ApiError } from "../api";
import { BotIcon, LabeledIcon, plural } from "../overview/parts";
import { RelativeTime } from "../RelativeTime";
import { Tooltip } from "../Tooltip";
import { CommentBody } from "./CommentBody";
import { useThreadComments } from "./useThreadComments";

/** GitHub's text: its own raised surface, apart from the card and the code. */
export const COMMENT_SURFACE =
	"min-w-0 rounded-md border border-edge bg-raised px-3 py-2";

/** Why a thread's text will never come, said plainly. */
export function UnavailableText(props: {
	reason: "deleted" | "unreadable";
	id?: string;
}) {
	return (
		<p
			id={props.id}
			data-testid="thread-body-unavailable"
			className={`${COMMENT_SURFACE} flex items-center gap-1.5 text-sm text-muted italic`}
		>
			<AlertIcon size={14} aria-hidden className="shrink-0 text-warn" />
			{props.reason === "deleted"
				? "Deleted on GitHub"
				: "Couldn't be read from GitHub"}
		</p>
	);
}

/**
 * A thread's comments, oldest first: each with its author (bot icon), when
 * it was published (or a pending mark for the viewer's own draft) and its
 * text as GitHub renders it, suggested changes drawn. Nothing waits on it:
 * a spinner while they load, Retry when they couldn't be read, and a flag
 * when fewer came than the thread counts, never a short thread passed off
 * as whole.
 */
export function Conversation(props: {
	readId: string;
	thread: ReviewThread;
	/** Leave out the opening comment (shown above it already). */
	skipFirst?: boolean;
}) {
	const { thread } = props;
	const never = thread.unavailable !== undefined || thread.id === "";
	const query = useThreadComments(props.readId, thread.id, {
		enabled: !never,
	});
	if (never)
		return <UnavailableText reason={thread.unavailable ?? "unreadable"} />;
	// A read gone (410, a Refresh or a restart): the overview is read again
	// and the comments follow the new read, so it is still loading; a Retry
	// under the gone read could only fail.
	const readGone =
		query.error instanceof ApiError && query.error.status === 410;
	if (query.isPending || readGone) {
		return (
			<Tooltip content="Loading comments" describe={false}>
				{(trigger) => (
					<p
						{...trigger}
						role="status"
						aria-label="Loading comments"
						data-testid="comments-loading"
						className="flex min-h-10 w-fit items-center px-1 text-muted"
					>
						<SyncIcon
							size={16}
							aria-hidden
							className="animate-spin motion-reduce:animate-none"
						/>
					</p>
				)}
			</Tooltip>
		);
	}
	if (query.isError) {
		return (
			<div
				role="alert"
				data-testid="comments-error"
				className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-bad/40 bg-bad/10 px-3 py-1 text-sm text-bad"
			>
				<span className="flex items-center gap-1.5">
					<AlertIcon size={14} aria-hidden className="shrink-0" />
					Comments couldn't be loaded
				</span>
				<button
					type="button"
					onClick={() => void query.refetch()}
					className="min-h-10 rounded-md px-2 font-semibold text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
				>
					Retry
				</button>
			</div>
		);
	}
	const { data } = query;
	if (data.unavailable) return <UnavailableText reason={data.unavailable} />;
	const shown = props.skipFirst ? data.comments.slice(1) : data.comments;
	return (
		<div className="space-y-2">
			{shown.length > 0 && (
				<ol aria-label="Comments" className="space-y-2">
					{shown.map((c, i) => (
						<CommentItem
							// The host's id; its place when it gave none (never reordered).
							key={c.id || `#${i}`}
							comment={c}
							thread={thread}
						/>
					))}
				</ol>
			)}
			{data.missing ? (
				<p className="flex min-h-10 items-center px-1 text-sm text-warn">
					<LabeledIcon
						icon={AlertIcon}
						label={`${plural(data.missing, "comment")} couldn't be loaded`}
						text={`${data.missing} missing`}
						className="gap-1.5 text-warn"
					/>
				</p>
			) : null}
		</div>
	);
}

function CommentItem(props: { comment: ThreadComment; thread: ReviewThread }) {
	const { comment: c, thread } = props;
	return (
		<li data-testid="thread-comment" className="min-w-0 space-y-1">
			<p className="flex flex-wrap items-center gap-x-1.5 px-0.5 text-xs text-muted">
				<span className="inline-flex items-center gap-1 font-semibold text-ink-soft">
					{c.author || "ghost"}
					{c.bot && <BotIcon />}
				</span>
				{c.pending ? (
					<LabeledIcon
						icon={ClockIcon}
						label="Pending, only you see it"
						className="text-warn"
					/>
				) : (
					c.publishedAt && <RelativeTime iso={c.publishedAt} />
				)}
			</p>
			<div
				data-testid="thread-comment-body"
				className={`${COMMENT_SURFACE} break-words`}
			>
				{c.html.trim() ? (
					<CommentBody
						html={c.html}
						body={c.body}
						code={thread.code}
						path={thread.path}
						open
					/>
				) : (
					<p className="text-sm">
						{c.text || <span className="text-muted italic">No text</span>}
					</p>
				)}
			</div>
		</li>
	);
}
