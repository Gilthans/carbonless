import {
	ClockIcon,
	MarkGithubIcon,
	PencilIcon,
	TrashIcon,
} from "@primer/octicons-react";
import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	MAX_REPLY,
	type ReviewThread,
	type ThreadComment,
} from "../../shared/types";
import { LabeledIcon } from "../overview/parts";
import { fullDate } from "../RelativeTime";
import { Tooltip } from "../Tooltip";
import { CommentBody } from "./CommentBody";
import { useEditDraft } from "./drafts";
import { useThreadWriter, useThreadWrites, useWritesOn } from "./threadWrites";

/**
 * What the viewer's writes do to one comment right now: an edit saving
 * (its new text, shown at once), a delete waiting out its undo window or
 * on its way (or done, its thread gone and fading out: it never shows
 * again), and whether its editor is open (a draft not saving, or the
 * reviewer just opened it).
 */
export function useCommentWrite(threadId: string, comment: ThreadComment) {
	const writes = useThreadWrites();
	const view = writes.threads.get(threadId);
	const id = comment.id;
	const saving = id
		? view?.edits.findLast((e) => e.commentId === id)
		: undefined;
	const gone = writes.gone.has(threadId);
	const deleting:
		| { commentId: string; undo: boolean; done?: boolean }
		| undefined = !id
		? undefined
		: gone
			? { commentId: id, undo: false, done: true }
			: view?.deletes.find((d) => d.commentId === id);
	const draft = useEditDraft(id);
	const [opened, setOpened] = useState(false);
	const editing =
		Boolean(id) &&
		!saving &&
		!deleting &&
		(opened || (draft?.edit !== undefined && !draft.edit.saving));
	return {
		/** The new text of an edit not yet confirmed. */
		saving: saving?.text,
		deleting,
		editing,
		setEditing: setOpened,
	};
}

/** The viewer may edit or delete it here (GitHub's viewerCan, the session writing). */
export function useCommentCan(comment: ThreadComment) {
	const on = useWritesOn();
	const ok = on && comment.id !== "" && !comment.pending;
	return {
		// A blanked opener is never edited back; GitHub may still let it be
		// deleted (a sole one: the thread goes).
		update: ok && !comment.deleted && comment.viewerCan.update,
		delete: ok && comment.viewerCan.delete,
	};
}

/**
 * The comment whose delete was just undone by a click that had the focus:
 * its Delete takes the focus back as it mounts in that same render. Only
 * for that render: cleared right after, so a later mount (a card opened
 * minutes on) never grabs the focus.
 */
let refocus: { id: string } | null = null;

const ICON_BUTTON =
	"flex h-10 w-10 shrink-0 items-center justify-center rounded-md hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent";

/**
 * Pencil and trash for the viewer's own comment, each where GitHub allows
 * it and the session writes. 40px targets kept from growing the line they
 * sit on (`compact`: negative margins).
 */
export function CommentActions(props: {
	threadId: string;
	comment: ThreadComment;
	onEdit: () => void;
	compact?: boolean;
}) {
	const writer = useThreadWriter();
	const can = useCommentCan(props.comment);
	const del = useRef<HTMLButtonElement | null>(null);
	const { id } = props.comment;
	// Back from Undo (this very click, on a page on screen): focus where it
	// was, on Delete.
	useLayoutEffect(() => {
		const el = del.current;
		if (!el || refocus?.id !== id || el.closest("[inert]")) return;
		refocus = null;
		el.focus({ preventScroll: true });
	}, [id]);
	if (!can.update && !can.delete) return null;
	const button = (
		label: string,
		Icon: typeof PencilIcon,
		onClick: () => void,
		tone: string,
		testId: string,
		ref?: (el: HTMLButtonElement | null) => void,
	) => (
		<Tooltip content={label} describe={false}>
			{(trigger) => (
				<button
					{...trigger}
					ref={(el) => {
						trigger.ref(el);
						ref?.(el);
					}}
					type="button"
					aria-label={label}
					data-testid={testId}
					onClick={onClick}
					className={`${ICON_BUTTON} ${tone}`}
				>
					<Icon size={16} aria-hidden />
				</button>
			)}
		</Tooltip>
	);
	return (
		<span
			data-testid="comment-actions"
			className={`ml-auto flex shrink-0 items-center ${props.compact ? "-my-2.5" : ""}`}
		>
			{can.update &&
				button(
					"Edit",
					PencilIcon,
					props.onEdit,
					"text-ink-soft hover:text-ink",
					"comment-edit",
				)}
			{can.delete &&
				button(
					"Delete",
					TrashIcon,
					() => writer.deleteComment(props.threadId, props.comment.id),
					"text-ink-soft hover:text-bad",
					"comment-delete",
					(el) => {
						del.current = el;
					},
				)}
		</span>
	);
}

/**
 * The comment's Markdown in a textarea in place of its body: focused,
 * sized to the text, Save and Cancel. Ctrl/Cmd+Enter saves; Escape
 * cancels, asking first when the text changed; empty text can't be saved
 * (Delete removes a comment). What's typed is the comment's edit draft
 * (drafts.ts): it outlives closing the thread and a reload.
 */
export function EditForm(props: {
	threadId: string;
	comment: ThreadComment;
	/** Its thread: the code a suggested change in GitHub's text is drawn on. */
	thread: ReviewThread;
	/** The editor closes (saved or cancelled). */
	onClose: () => void;
}) {
	const { threadId, comment, thread } = props;
	const writer = useThreadWriter();
	const draft = useEditDraft(comment.id);
	// GitHub's newer text, never saved over unseen: shown while the
	// changed-on-GitHub refusal is open, and once Show theirs took it in.
	const failed = useThreadWrites().threads.get(threadId)?.failed;
	const refused =
		failed?.action === "Edit" &&
		failed.code === "changed" &&
		failed.commentId === comment.id
			? failed.current
			: undefined;
	const theirs = refused ?? (draft?.edit?.theirs ? comment : undefined);
	const from = draft?.edit?.from ?? comment.body;
	const text = draft?.text ?? from;
	const box = useRef<HTMLTextAreaElement>(null);
	const blank = !text.trim();
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.focus({ preventScroll: true });
		el.setSelectionRange(el.value.length, el.value.length);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured as the text changes.
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight + 2}px`;
	}, [text]);
	const save = () => {
		// What the store holds now, not this render's copy.
		const now = writer.drafts.edit(comment.id);
		if (now && !now.text.trim()) return;
		writer.saveEdit(threadId, comment.id);
		props.onClose();
	};
	const cancel = () => {
		writer.cancelEdit(threadId, comment.id);
		props.onClose();
	};
	/** Cancel, asking first when the text changed (nothing typed lost by a slip). */
	const ask = () => {
		const changed = writer.drafts.edit(comment.id) !== undefined;
		if (!changed || window.confirm("Discard your edit?")) cancel();
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			save();
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			ask();
		}
	};
	return (
		<div data-testid="edit-form" className="space-y-1.5">
			{theirs && (
				<div
					data-testid="edit-theirs"
					className="min-w-0 space-y-1 rounded-md border border-warn/50 bg-warn/10 px-3 py-2 break-words"
				>
					<LabeledIcon
						icon={MarkGithubIcon}
						label="On GitHub now"
						className="text-warn"
					/>
					{theirs.html.trim() ? (
						<CommentBody
							html={theirs.html}
							body={theirs.body}
							code={thread.code}
							path={thread.path}
							open
						/>
					) : (
						<p className="text-sm whitespace-pre-wrap">{theirs.body}</p>
					)}
				</div>
			)}
			<textarea
				ref={box}
				aria-label="Edit comment"
				rows={3}
				maxLength={MAX_REPLY}
				value={text}
				onChange={(e) =>
					writer.drafts.setEdit(threadId, comment.id, from, e.target.value)
				}
				onKeyDown={onKeyDown}
				className="block max-h-96 min-h-10 w-full min-w-0 resize-none rounded-md border border-line-strong bg-raised px-3 py-2 text-sm leading-normal text-ink focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent"
			/>
			<div className="flex justify-end gap-2">
				<button
					type="button"
					onClick={ask}
					className="flex h-10 items-center rounded-md px-3 text-sm font-medium text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="edit-save"
					disabled={blank}
					onClick={save}
					className="flex h-10 items-center rounded-md border border-accent/60 bg-accent/15 px-4 text-sm font-semibold text-link hover:bg-accent/25 focus-visible:outline-2 focus-visible:outline-accent disabled:border-line disabled:bg-transparent disabled:text-faint"
				>
					Save
				</button>
			</div>
		</div>
	);
}

/**
 * A deleted comment, collapsed to one line: Undo while the delete waits
 * out its window (nothing sent yet), then a clock while it goes to GitHub.
 */
export function DeletedRow(props: {
	threadId: string;
	commentId: string;
	undo: boolean;
	/** On GitHub now (its thread gone, fading out): no clock. */
	done?: boolean;
}) {
	const writer = useThreadWriter();
	const row = useRef<HTMLDivElement>(null);
	const undo = useRef<HTMLButtonElement | null>(null);
	/** Undo had the focus when it went (its ref is let go before it leaves the page). */
	const undoHadFocus = useRef(false);
	const undoRef = (el: HTMLButtonElement | null) => {
		if (!el && undo.current) {
			undoHadFocus.current = document.activeElement === undo.current;
		}
		undo.current = el;
	};
	const { undo: undoable } = props;
	// Delete was just pressed (its button is gone): Undo takes the focus.
	useLayoutEffect(() => {
		if (undoable) undo.current?.focus({ preventScroll: true });
	}, [undoable]);
	// Undo went with the window while it had the focus: the row keeps it.
	useLayoutEffect(() => {
		if (!undoable && undoHadFocus.current) {
			undoHadFocus.current = false;
			row.current?.focus({ preventScroll: true });
		}
	}, [undoable]);
	return (
		<div
			ref={row}
			role="status"
			tabIndex={-1}
			data-testid="comment-deleted-row"
			className="comment-collapse flex min-h-10 items-center gap-1.5 rounded-md border border-dashed border-line px-3 text-sm text-muted focus-visible:outline-2 focus-visible:outline-accent"
		>
			<TrashIcon size={14} aria-hidden className="shrink-0" />
			<span>Deleted</span>
			{!props.done && <span aria-hidden>·</span>}
			{props.done ? null : props.undo ? (
				<button
					ref={undoRef}
					type="button"
					data-testid="comment-undo"
					onClick={(e) => {
						const mine = { id: props.commentId };
						if (document.activeElement === e.currentTarget) refocus = mine;
						writer.undoDelete(props.threadId, props.commentId);
						setTimeout(() => {
							if (refocus === mine) refocus = null;
						}, 0);
					}}
					className="-my-px flex min-h-10 items-center rounded-md px-1.5 font-semibold text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
				>
					Undo
				</button>
			) : (
				<LabeledIcon icon={ClockIcon} label="Deleting" className="text-warn" />
			)}
		</div>
	);
}

/** An opener blanked by a delete (its replies kept): a muted placeholder. */
export function DeletedPlaceholder() {
	return (
		<p
			data-testid="comment-deleted"
			className="flex min-h-10 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-muted italic"
		>
			<TrashIcon size={14} aria-hidden className="shrink-0" />
			deleted
		</p>
	);
}

/** "edited", with when on hover or focus (as GitHub marks it). */
export function EditedMark(props: { iso: string | null }) {
	if (!props.iso) return null;
	const date = new Date(props.iso);
	if (Number.isNaN(date.getTime())) return null;
	return (
		<Tooltip content={`Edited ${fullDate(date)}`}>
			{(trigger) => (
				<span
					{...trigger}
					data-testid="comment-edited"
					// Focusable so keyboard users can open the exact date too.
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className="cursor-help rounded-sm underline decoration-faint decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
				>
					edited
				</span>
			)}
		</Tooltip>
	);
}

/** An edit's new text while GitHub hasn't confirmed it: plain, as typed. */
export function SavingText(props: { text: string }) {
	return <p className="text-sm whitespace-pre-wrap">{props.text}</p>;
}
