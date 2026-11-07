import { AlertIcon, SparkleFillIcon } from "@primer/octicons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useLayoutEffect, useRef } from "react";
import { MAX_AGENT_TEXT } from "../../shared/agent";
import { sessionQuery } from "../api";
import { type CodeSpan, describeSpan } from "../files/selectionActions";
import { Spinner } from "../Spinner";
import { commentSurface } from "../threads/Conversation";
import type { LineTexts } from "../threads/drafts";
import { Avatar, usePerson } from "../threads/people";
import { askAgent, dropAgentWrite, useAgentWrites } from "./agentWrites";
import {
	agentComposerFocused,
	closeAgentComposer,
	setAgentComposerText,
	useAgentComposers,
} from "./askAgentAction";

/** UTF-8 bytes, as the server caps a question. */
const bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * A question to the reviewer's agent under its span's last row (or in a
 * file's header): the comment composer's frame and band, the span quoted,
 * a box, Cancel and Ask. Ctrl/Cmd+Enter asks; Escape cancels. Asked, it
 * shows the question with a spinner until the server has the thread, which
 * then shows in its place; refused, the box is back with why.
 */
export function AgentComposer(props: {
	clientId: string;
	span: CodeSpan;
	/** The span's text (quoteOf). */
	quote: string;
	/** Kept for parity with NewThread; questions aren't drafts yet. */
	lineTexts?: LineTexts;
}) {
	const { clientId, span } = props;
	const client = useQueryClient();
	const item = useAgentComposers().find((c) => c.clientId === clientId);
	const text = item?.text ?? "";
	const write = useAgentWrites().pending.get(clientId);
	const sending = write !== undefined && !write.error;
	const viewer = useQuery({ ...sessionQuery, enabled: false }).data?.viewer;
	const me = usePerson(viewer ?? "you");
	const box = useRef<HTMLTextAreaElement>(null);
	const focus = item?.focus ?? false;
	useLayoutEffect(() => {
		if (!focus) return;
		const el = box.current;
		if (el) {
			el.focus({ preventScroll: true });
			el.scrollIntoView?.({ block: "nearest" });
		}
		agentComposerFocused(clientId);
	}, [focus, clientId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured as the text changes.
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight + 2}px`;
	}, [text, sending]);
	const tooLong = bytes(text) > MAX_AGENT_TEXT;
	const blank = !text.trim();
	const ask = () => {
		if (blank || tooLong || sending) return;
		askAgent(client, span, text, clientId);
	};
	const cancel = () => {
		if (text.trim() && !window.confirm("Discard your question?")) return;
		dropAgentWrite(clientId);
		closeAgentComposer(clientId);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			ask();
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			cancel();
		}
	};
	return (
		<article
			data-testid="agent-composer"
			data-sending={sending || undefined}
			aria-label="Ask your agent"
			className={`min-w-0 ${span.subject === "file" ? "" : "max-w-[40rem]"} overflow-hidden rounded-lg border border-agent-edge bg-surface`}
		>
			<div className="flex min-h-8 min-w-0 items-center gap-2 border-b border-line bg-band px-2.5 py-1 text-xs">
				<SparkleFillIcon
					size={14}
					aria-hidden
					className="shrink-0 text-agent-ink"
				/>
				{props.quote && (
					<code
						className={`min-w-0 truncate rounded-sm px-0.5 font-mono text-code-ink ${
							span.subject === "line" && span.startCol != null
								? "span-mark"
								: ""
						}`}
					>
						{props.quote}
					</code>
				)}
				<span className="shrink-0 font-mono text-faint">
					{describeSpan(span)}
				</span>
			</div>
			<div className="space-y-1.5 p-2.5">
				{sending ? (
					<div
						data-testid="agent-composer-sending"
						aria-busy="true"
						className="min-w-0 space-y-1"
					>
						<div className="flex min-h-5 items-center gap-x-1.5 px-0.5 text-xs text-muted">
							<Avatar login={viewer ?? "you"} url="" />
							<span className="font-semibold text-ink-soft">
								{viewer ?? "you"}
							</span>
							<Spinner label="Asking" size={12} />
						</div>
						<p
							className={`${commentSurface(me.tint)} text-sm whitespace-pre-wrap break-words`}
						>
							{text}
						</p>
					</div>
				) : (
					<>
						{(write?.error || tooLong) && (
							<p
								role="alert"
								data-testid="agent-composer-error"
								className="flex flex-wrap items-center gap-x-2 text-sm text-bad"
							>
								<AlertIcon size={14} aria-hidden className="shrink-0" />
								{tooLong ? "Too long to ask" : write?.error?.message}
							</p>
						)}
						<textarea
							ref={box}
							aria-label="Ask your agent"
							placeholder="Ask your agent…"
							rows={3}
							value={text}
							onChange={(e) => setAgentComposerText(clientId, e.target.value)}
							onKeyDown={onKeyDown}
							className="block max-h-96 min-h-16 w-full min-w-0 resize-none rounded-md border border-line-strong bg-raised px-3 py-2 text-sm leading-normal text-ink placeholder:text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent"
						/>
						<div className="flex items-center justify-end gap-2">
							<button
								type="button"
								onClick={cancel}
								className="flex h-10 items-center rounded-md px-3 text-sm font-medium text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
							>
								Cancel
							</button>
							<button
								type="button"
								data-testid="agent-composer-ask"
								disabled={blank || tooLong}
								onClick={ask}
								onMouseDown={(e) => e.preventDefault()}
								className="flex h-10 items-center gap-1.5 rounded-md border border-accent/60 bg-accent/15 px-4 text-sm font-semibold text-link hover:bg-accent/25 focus-visible:outline-2 focus-visible:outline-accent disabled:border-line disabled:bg-transparent disabled:text-faint"
							>
								<SparkleFillIcon size={16} aria-hidden />
								Ask
							</button>
						</div>
					</>
				)}
			</div>
		</article>
	);
}
