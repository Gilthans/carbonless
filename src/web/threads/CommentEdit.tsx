import { ClockIcon, PencilIcon, TrashIcon } from "@primer/octicons-react";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { MAX_REPLY, type ThreadComment } from "../../shared/types";
import { LabeledIcon } from "../overview/parts";
import { fullDate } from "../RelativeTime";
import { Tooltip } from "../Tooltip";
import { useEditDraft } from "./drafts";
import { useThreadWriter, useThreadWrites, useWritesOn } from "./threadWrites";

/**
 * What the viewer's writes do to one comment right now: an edit saving
 * (its new text, shown at once), a delete waiting out its undo window or
 * on its way, and whether its editor is open (a draft not saving, or the
 * reviewer just opened it).
 */
export function useCommentWrite(threadId: string, comment: ThreadComment) {
	const view = useThreadWrites().threads.get(threadId);
	const id = comment.id;
	const saving = id
		? view?.edits.findLast((e) => e.commentId === id)
		: undefined;
	const deleting = id
		? view?.deletes.find((d) => d.commentId === id)
		: undefined;
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
	const ok = on && comment.id !== "" && !comment.pending && !comment.deleted;
	return {
		update: ok && comment.viewerCan.update,
		delete: ok && comment.viewerCan.delete,
	};
}

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
	if (!can.update && !can.delete) return null;
	const button = (
		label: string,
		Icon: typeof PencilIcon,
		onClick: () => void,
		tone: string,
		testId: string,
	) => (
		<Tooltip content={label} describe={false}>
			{(trigger) => (
				<button
					{...trigger}
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
	/** The editor closes (saved or cancelled). */
	onClose: () => void;
}) {
	const { threadId, comment } = props;
	const writer = useThreadWriter();
	const draft = useEditDraft(comment.id);
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
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			save();
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			const changed = writer.drafts.edit(comment.id) !== undefined;
			if (!changed || window.confirm("Discard your edit?")) cancel();
		}
	};
	return (
		<div data-testid="edit-form" className="space-y-1.5">
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
					onClick={cancel}
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
}) {
	const writer = useThreadWriter();
	return (
		<div
			role="status"
			data-testid="comment-deleted-row"
			className="comment-collapse flex min-h-10 items-center gap-1.5 rounded-md border border-dashed border-line px-3 text-sm text-muted"
		>
			<TrashIcon size={14} aria-hidden className="shrink-0" />
			<span>Deleted</span>
			<span aria-hidden>·</span>
			{props.undo ? (
				<button
					type="button"
					data-testid="comment-undo"
					onClick={() => writer.undoDelete(props.threadId, props.commentId)}
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
