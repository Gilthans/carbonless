import { PaperAirplaneIcon } from "@primer/octicons-react";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import type { ReviewThread } from "../../shared/types";
import { Tooltip } from "../Tooltip";
import { useDraft } from "./drafts";
import { useThreadWriter } from "./threadWrites";

/**
 * A thread's reply box: plain text, one line until focused, growing with
 * what's typed. Send (or Ctrl/Cmd+Enter) posts it to GitHub at once; blank
 * text can't be sent; Escape leaves the box, keeping the draft. What's
 * typed is the thread's draft (drafts.ts): it outlives closing the thread.
 */
export function ReplyBox(props: { thread: ReviewThread }) {
	const { thread } = props;
	const writer = useThreadWriter();
	const [text, setText] = useDraft(thread.id);
	const [focused, setFocused] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);
	const blank = !text.trim();
	const open = focused || !blank;
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured as the text changes.
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		if (open) el.style.height = `${el.scrollHeight + 2}px`;
	}, [text, open]);
	const send = () => {
		if (blank) return;
		writer.reply(thread.id, text);
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
		<div data-testid="reply-box" className="flex items-end gap-1.5">
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
