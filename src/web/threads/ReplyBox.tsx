import { PaperAirplaneIcon } from "@primer/octicons-react";
import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { ReviewThread } from "../../shared/types";
import type { Shortcut } from "../shortcuts";
import { Tooltip } from "../Tooltip";
import { useClearOfNotices } from "./clearOfNotices";
import { useDraft } from "./drafts";
import { useThreadWriter, useThreadWrites } from "./threadWrites";

/** The reply and edit boxes' own keys (their textareas handle them), for the help. */
export const EDITOR_KEYS: Omit<Shortcut, "run" | "when">[] = [
	{
		keys: "Mod+Enter",
		label: "Send the reply, save the edit",
		group: "Threads",
	},
	{
		keys: "Escape",
		label: "Leave the reply, cancel the edit",
		group: "Threads",
	},
];

/**
 * A thread's reply box: plain text, one line until focused, growing with
 * what's typed. Send (or Ctrl/Cmd+Enter) posts it to GitHub at once; blank
 * text can't be sent; Escape leaves the box, keeping the draft. What's
 * typed is the thread's draft (drafts.ts): it outlives closing the thread.
 */
export function ReplyBox(props: {
	thread: ReviewThread;
	/** Told when the box opens (focused, or holding a draft) and closes. */
	onOpenChange?: (open: boolean) => void;
}) {
	const { thread } = props;
	const writer = useThreadWriter();
	const [text, setText] = useDraft(thread.id);
	const [focused, setFocused] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);
	const row = useRef<HTMLDivElement>(null);
	// A refused reply is back in the box: keep it above the notice.
	const refused =
		useThreadWrites().threads.get(thread.id)?.failed?.action === "Reply";
	useClearOfNotices(row, refused);
	const blank = !text.trim();
	const open = focused || !blank;
	const { onOpenChange } = props;
	useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured as the text changes.
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		if (open) el.style.height = `${el.scrollHeight + 2}px`;
	}, [text, open]);
	const send = () => {
		// What the store holds now, not this render's copy: one send per text.
		const now = writer.drafts.text(thread.id);
		if (!now.trim()) return;
		writer.reply(thread.id, now);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			send();
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.currentTarget.blur();
		}
	};
	return (
		<div ref={row} data-testid="reply-box" className="flex items-end gap-1.5">
			<textarea
				ref={box}
				aria-label="Reply"
				placeholder="Reply…"
				rows={open ? 3 : 1}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				onKeyDown={onKeyDown}
				className="block max-h-80 min-h-10 min-w-0 flex-1 resize-none rounded-md border border-line-strong bg-raised px-3 py-2 text-sm leading-normal text-ink placeholder:text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent"
			/>
			<Tooltip content="Reply" describe={false}>
				{(trigger) => (
					<button
						{...trigger}
						type="button"
						aria-label="Reply"
						disabled={blank}
						onClick={send}
						// Keeps the box's focus (and so its size) on a mouse click.
						onMouseDown={(e) => e.preventDefault()}
						className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-link hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint disabled:hover:bg-transparent"
					>
						<PaperAirplaneIcon size={16} aria-hidden />
					</button>
				)}
			</Tooltip>
		</div>
	);
}
