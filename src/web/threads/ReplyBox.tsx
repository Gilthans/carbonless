import { PaperAirplaneIcon, SparkleFillIcon } from "@primer/octicons-react";
import { useQueryClient } from "@tanstack/react-query";
import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { MAX_AGENT_TEXT } from "../../shared/agent";
import type { ReviewThread } from "../../shared/types";
import { askAgentOnThread, replyAgent } from "../agent/agentWrites";
import {
	agentDraftText,
	setAgentDraft,
	useAgentDraft,
	useSendView,
	useThreadAgentContext,
} from "../agent/threadAgent";
import type { Shortcut } from "../shortcuts";
import { Tooltip } from "../Tooltip";
import { useClearOfNotices } from "./clearOfNotices";
import { useDraft } from "./drafts";
import { newClientId } from "./newThreads";
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
	const client = useQueryClient();
	// The thread's agent conversation open: the box asks the agent, with
	// its own text (kept while it closes), and "Ask agent…" fades in.
	const agent = useThreadAgentContext();
	const asking = agent?.open === true;
	const conversation = agent?.conversation;
	const view = useSendView();
	const [reply, setReply] = useDraft(thread.id);
	const [question, setQuestion] = useAgentDraft(thread.id);
	const text = asking ? question : reply;
	const setText = asking ? setQuestion : setReply;
	// GitHub couldn't be read: whether the thread is open is unknown.
	const off = asking && conversation?.githubUnknown === true;
	const [focused, setFocused] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);
	const row = useRef<HTMLDivElement>(null);
	// A refused reply is back in the box: keep it above the notice.
	const refused =
		useThreadWrites()
			.threads.get(thread.id)
			?.refused.some((f) => f.action === "Reply" && !f.retrying) ?? false;
	useClearOfNotices(row, refused);
	const tooLong = asking && bytes(text) > MAX_AGENT_TEXT;
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
	const composer = agent?.composerRef;
	useEffect(() => {
		if (!composer) return;
		composer.current = box.current;
		return () => {
			composer.current = null;
		};
	}, [composer]);
	const send = () => {
		if (asking) {
			const now = agentDraftText(thread.id);
			if (!now.trim() || off || bytes(now) > MAX_AGENT_TEXT) return;
			if (conversation) {
				replyAgent(client, conversation.id, now, newClientId(), view);
			} else {
				askAgentOnThread(client, thread.id, now, newClientId(), view);
			}
			setAgentDraft(thread.id, "");
			return;
		}
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
	const sendLabel = asking ? "Send to agent" : "Reply";
	return (
		<div ref={row} data-testid="reply-box" className="flex items-end gap-1.5">
			<div className="relative min-w-0 flex-1">
				<textarea
					ref={box}
					aria-label={asking ? "Ask agent" : "Reply"}
					placeholder={asking ? "Ask agent…" : "Reply…"}
					rows={open ? 3 : 1}
					value={text}
					disabled={off}
					onChange={(e) => setText(e.target.value)}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					onKeyDown={onKeyDown}
					className={`block max-h-80 min-h-10 w-full min-w-0 resize-none rounded-md border bg-raised px-3 py-2 text-sm leading-normal text-ink placeholder:text-transparent focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 ${
						asking ? "border-agent-edge" : "border-line-strong"
					}`}
				/>
				{/* The placeholders, crossfading as the box changes hands. */}
				{!text && (
					<span
						aria-hidden
						className="pointer-events-none absolute top-2 left-3 text-sm leading-normal text-faint"
					>
						<span
							className={`transition-opacity duration-200 motion-reduce:transition-none ${asking ? "opacity-0" : "opacity-100"}`}
						>
							Reply…
						</span>
						<span
							className={`absolute top-0 left-0 whitespace-nowrap transition-opacity duration-200 motion-reduce:transition-none ${asking ? "opacity-100" : "opacity-0"}`}
						>
							Ask agent…
						</span>
					</span>
				)}
			</div>
			<Tooltip content={sendLabel} describe={false}>
				{(trigger) => (
					<button
						{...trigger}
						type="button"
						aria-label={sendLabel}
						disabled={blank || off || tooLong}
						onClick={send}
						// Keeps the box's focus (and so its size) on a mouse click.
						onMouseDown={(e) => e.preventDefault()}
						className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint disabled:hover:bg-transparent ${
							asking ? "text-agent-ink" : "text-link"
						}`}
					>
						{asking ? (
							<SparkleFillIcon size={16} aria-hidden />
						) : (
							<PaperAirplaneIcon size={16} aria-hidden />
						)}
					</button>
				)}
			</Tooltip>
		</div>
	);
}

const bytes = (t: string) => new TextEncoder().encode(t).length;
