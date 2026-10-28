import { AlertIcon, ClockIcon, SyncIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import type { ReviewThread, ThreadComment } from "../../shared/types";
import { ApiError, sessionQuery } from "../api";
import { BotIcon, LabeledIcon, plural } from "../overview/parts";
import { RelativeTime } from "../RelativeTime";
import { Tooltip } from "../Tooltip";
import { CommentBody } from "./CommentBody";
import {
	CommentActions,
	DeletedPlaceholder,
	DeletedRow,
	EditedMark,
	EditForm,
	SavingText,
	useCommentWrite,
} from "./CommentEdit";
import { useDrafts } from "./drafts";
import { OrphanDraft } from "./OrphanDraft";
import { Avatar, tintSurface, usePerson } from "./people";
import { ReplyBox } from "./ReplyBox";
import { canToggle, ResolveButton } from "./ResolveButton";
import { useThreadWriter, useThreadWrites, useWritesOn } from "./threadWrites";
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

/** GitHub's text on its author's tint (people.tsx): their own surface. */
export const commentSurface = (tint: number) =>
	`min-w-0 rounded-md border px-3 py-2 ${tintSurface(tint)}`;

/**
 * A thread's comments, oldest first: each with its author (avatar, bot
 * icon), when it was published (or a pending mark for the viewer's own
 * draft) and its text as GitHub renders it on the author's tint,
 * suggested changes drawn. Nothing waits on it: a spinner while they
 * load, Retry when they couldn't be read, and a flag when fewer came than
 * the thread counts, never a short thread passed off as whole. Then the
 * reply box and the Resolve button (ThreadActions).
 */
export function Conversation(props: {
	readId: string;
	thread: ReviewThread;
	/** Leave out the opening comment (shown above it already). */
	skipFirst?: boolean;
	/** Told after a resolve or unresolve (the Overview's fade). */
	onToggle?: (resolved: boolean) => void;
}) {
	const { thread } = props;
	if (thread.unavailable !== undefined || thread.id === "")
		return <UnavailableText reason={thread.unavailable ?? "unreadable"} />;
	return (
		<div className="space-y-2">
			<ThreadComments {...props} />
			{/* While they load or fail too: a draft is never kept from its thread. */}
			<ThreadActions thread={thread} onToggle={props.onToggle} />
		</div>
	);
}

/** What the viewer may do to the thread here: reply, resolve or unresolve. */
export function useCanAct(thread: ReviewThread): boolean {
	const on = useWritesOn();
	return (
		on &&
		thread.id !== "" &&
		thread.unavailable === undefined &&
		(thread.viewerCan.reply || canToggle(thread, on))
	);
}

/**
 * The reply box with the Resolve button beside it (below it on a phone):
 * each only where the viewer may, nothing when they may do neither.
 */
export function ThreadActions(props: {
	thread: ReviewThread;
	onToggle?: (resolved: boolean) => void;
}) {
	const { thread } = props;
	const on = useWritesOn();
	// The box closed (one line, empty): Resolve beside it on a phone too;
	// opened, it takes the phone's width and Resolve goes below.
	const [boxOpen, setBoxOpen] = useState(false);
	if (!useCanAct(thread)) return null;
	return (
		<div
			data-testid="thread-actions"
			data-box-open={boxOpen || undefined}
			className={`flex gap-2 ${boxOpen ? "flex-col sm:flex-row sm:items-end" : "flex-row items-end"}`}
		>
			{on && thread.viewerCan.reply && (
				<div className="min-w-0 flex-1">
					<ReplyBox thread={thread} onOpenChange={setBoxOpen} />
				</div>
			)}
			<ResolveButton thread={thread} onToggle={props.onToggle} />
		</div>
	);
}

/** Replies sent and not yet confirmed, unless GitHub's list already has them. */
function useSending(
	threadId: string,
	comments: ThreadComment[] | undefined,
): ThreadComment[] {
	const sending = useThreadWrites().threads.get(threadId)?.replies ?? [];
	const viewer = useQuery({ ...sessionQuery, enabled: false }).data?.viewer;
	const clean = (t: string) => t.replace(/\s+$/, "");
	return sending
		.filter(
			(r) =>
				!comments?.some(
					(c) =>
						c.author.toLowerCase() === viewer?.toLowerCase() &&
						clean(c.body) === clean(r.text) &&
						c.publishedAt !== null &&
						Date.parse(c.publishedAt) >= Date.parse(r.attemptedAt) - 60_000,
				),
		)
		.map((r) => ({
			id: "",
			author: viewer ?? "you",
			bot: false,
			avatarUrl: "",
			publishedAt: null,
			pending: false,
			html: "",
			body: r.text,
			text: r.text,
			editedAt: null,
			viewerCan: { update: false, delete: false },
			deleted: false,
		}));
}

/** The comments alone, with their loading, error and missing states. */
export function ThreadComments(props: {
	readId: string;
	thread: ReviewThread;
	skipFirst?: boolean;
}): ReactNode {
	const { thread } = props;
	const query = useThreadComments(props.readId, thread.id);
	const writer = useThreadWriter();
	const sending = useSending(thread.id, query.data?.comments);
	const lost = useLostEdits(thread.id, query.data?.comments);
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
	if (shown.length + sending.length + lost.length === 0 && !data.missing) {
		return null;
	}
	return (
		<div className="space-y-2">
			{shown.length + sending.length > 0 && (
				<ol aria-label="Comments" className="space-y-2">
					{shown.map((c, i) => (
						<CommentItem
							// The host's id; its place when it gave none (never reordered).
							key={c.id || `#${i}`}
							comment={c}
							thread={thread}
							keepsPlace={
								c === data.comments[0] &&
								data.comments.length + sending.length > 1
							}
						/>
					))}
					{sending.map((c, i) => (
						<CommentItem
							// biome-ignore lint/suspicious/noArrayIndexKey: sent replies only ever append.
							key={`sending-${i}`}
							comment={c}
							thread={thread}
							sending
						/>
					))}
				</ol>
			)}
			{lost.length > 0 && (
				<ul aria-label="Edits of comments gone" className="space-y-2">
					{lost.map((d) => (
						<OrphanDraft
							key={d.commentId}
							label="Comment gone"
							text={d.text}
							onDiscard={() => writer.cancelEdit(thread.id, d.commentId)}
						/>
					))}
				</ul>
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

/**
 * Edit drafts of this thread's comments that its comments no longer have
 * (deleted on GitHub meanwhile): shown to copy or discard, never lost.
 */
function useLostEdits(
	threadId: string,
	comments: ThreadComment[] | undefined,
): { commentId: string; text: string }[] {
	const drafts = useDrafts();
	if (!comments) return [];
	const ids = new Set(comments.map((c) => c.id));
	return drafts.flatMap((d) =>
		d.threadId === threadId && d.edit && !ids.has(d.edit.commentId)
			? [{ commentId: d.edit.commentId, text: d.text }]
			: [],
	);
}

function CommentItem(props: {
	comment: ThreadComment;
	thread: ReviewThread;
	/** The viewer's reply on its way to GitHub. */
	sending?: boolean;
	/** The opener, with replies: deleted, it stays as "[deleted]". */
	keepsPlace?: boolean;
}) {
	const { comment: c, thread } = props;
	const author = c.author || "ghost";
	const { tint } = usePerson(author, c.avatarUrl);
	const write = useCommentWrite(thread.id, c);
	if (write.deleting) {
		return (
			<li data-testid="thread-comment" data-author={author} className="min-w-0">
				<DeletedRow
					threadId={thread.id}
					commentId={c.id}
					undo={write.deleting.undo}
					done={write.deleting.done}
				/>
			</li>
		);
	}
	const saving = write.saving !== undefined;
	return (
		<li
			data-testid={props.sending ? "thread-comment-sending" : "thread-comment"}
			data-author={author}
			className="min-w-0 space-y-1"
		>
			<div className="flex min-h-5 flex-wrap items-center gap-x-1.5 px-0.5 text-xs text-muted">
				<Avatar login={author} url={c.avatarUrl} />
				<span className="inline-flex items-center gap-1 font-semibold text-ink-soft">
					{author}
					{c.bot && <BotIcon />}
				</span>
				{props.sending ? (
					<LabeledIcon icon={ClockIcon} label="Sending" className="text-warn" />
				) : c.pending ? (
					<LabeledIcon
						icon={ClockIcon}
						label="Pending, only you see it"
						className="text-warn"
					/>
				) : (
					c.publishedAt && <RelativeTime iso={c.publishedAt} />
				)}
				{saving ? (
					<LabeledIcon icon={ClockIcon} label="Saving" className="text-warn" />
				) : (
					!c.deleted && <EditedMark iso={c.editedAt} />
				)}
				{!props.sending && !saving && !write.editing && (
					<CommentActions
						threadId={thread.id}
						comment={c}
						onEdit={() => write.setEditing(true)}
						compact
						keepsPlace={props.keepsPlace}
					/>
				)}
			</div>
			{write.editing ? (
				<EditForm
					threadId={thread.id}
					comment={c}
					thread={thread}
					onClose={() => write.setEditing(false)}
				/>
			) : c.deleted && !saving ? (
				<DeletedPlaceholder />
			) : (
				<div
					data-testid="thread-comment-body"
					data-tint={tint}
					className={`${commentSurface(tint)} break-words`}
				>
					{saving ? (
						<SavingText text={write.saving ?? ""} />
					) : c.html.trim() ? (
						<CommentBody
							html={c.html}
							body={c.body}
							code={thread.code}
							path={thread.path}
							open
						/>
					) : (
						<p className="text-sm whitespace-pre-wrap">
							{c.text || <span className="text-muted italic">No text</span>}
						</p>
					)}
				</div>
			)}
		</li>
	);
}
