import {
	AlertIcon,
	CommentIcon,
	SparkleFillIcon,
} from "@primer/octicons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useLayoutEffect, useRef } from "react";
import { MAX_AGENT_TEXT } from "../../shared/agent";
import { overviewQuery, sessionQuery } from "../api";
import {
	type CodeSpan,
	commentAvailable,
	describeSpan,
	type SelectionContext,
} from "../files/selectionActions";
import { Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { commentSurface } from "../threads/Conversation";
import type { LineTexts } from "../threads/drafts";
import { LOADING } from "../threads/NewThread";
import {
	getComposers,
	openComposer,
	sameSpan,
	spanOfDraft,
	targetOf,
} from "../threads/newThreads";
import { Avatar, usePerson } from "../threads/people";
import { useThreadWriter } from "../threads/threadWrites";
import { askAgent, dropAgentWrite, useAgentWrites } from "./agentWrites";
import {
	agentComposerFocused,
	closeAgentComposer,
	setAgentComposerText,
	useAgentComposers,
} from "./askAgentAction";
import { HANDLE, HANDLE_OFF } from "./handle";
import { QuickQuestionChips } from "./QuickQuestionChips";
import { SPAN_QUESTIONS, withQuestion } from "./quickQuestions";
import { useSendView } from "./threadAgent";

/**
 * What Comment's availability needs beyond the overview (commentAvailable):
 * the file's kind, whether the span's lines are GitHub's diff's, whether
 * the diff shown is the head's, an earlier patch set. Left out: a text
 * file, lines in the diff, the head's, the latest.
 */
export type AgentCommentContext = Partial<
	Pick<SelectionContext, "file" | "inDiff" | "headUnsure" | "readOnly">
> & {
	/** Asked on a head other than the one the diff shows. */
	stale?: boolean;
	/** The head shown isn't known yet. */
	loading?: boolean;
};

/** Where a question stands to the head shown (`head`, "" or undefined while unknown). */
export function headFacts(
	span: CodeSpan,
	head: string | undefined,
): Pick<AgentCommentContext, "stale" | "loading"> {
	return head ? { stale: span.commit !== head } : { loading: true };
}

const COMMENT_INSTEAD = "Comment instead";

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
	/** Where it is, as the view numbers its rows (NewThread's `where`). */
	where?: string;
	/** Kept for parity with NewThread; questions aren't drafts yet. */
	lineTexts?: LineTexts;
	/** For its Comment button (switching to a comment). */
	comment?: AgentCommentContext;
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
	// A tapped question: the box takes focus, the caret after the text.
	const caretToEnd = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once the tapped question is in the box.
	useLayoutEffect(() => {
		const el = box.current;
		if (!caretToEnd.current || !el) return;
		caretToEnd.current = false;
		el.focus({ preventScroll: true });
		el.setSelectionRange(el.value.length, el.value.length);
	}, [text]);
	const pick = (question: string) => {
		caretToEnd.current = true;
		setAgentComposerText(clientId, withQuestion(text, question));
	};
	const tooLong = bytes(text) > MAX_AGENT_TEXT;
	const blank = !text.trim();
	const view = useSendView();
	const ask = () => {
		if (blank || tooLong || sending) return;
		askAgent(client, span, text, clientId, view);
	};
	const cancel = () => {
		if (text.trim() && !window.confirm("Discard your question?")) return;
		dropAgentWrite(clientId);
		closeAgentComposer(clientId);
	};
	// The Comment button: the question becomes a comment on the same span,
	// its text moved into the comment's draft (so no "Discard?"); nothing
	// goes to GitHub until Comment is pressed there.
	const writer = useThreadWriter();
	const overview = useQuery({ ...overviewQuery, enabled: false }).data;
	const commentable =
		!overview || props.comment?.loading
			? LOADING
			: props.comment?.stale
				? "Asked on an earlier head"
				: commentAvailable(span, {
						writes: overview.writes,
						commentLeft: overview.commentLeft !== false,
						file: props.comment?.file ?? { binary: false, submodule: false },
						inDiff: props.comment?.inDiff,
						headUnsure: props.comment?.headUnsure,
						readOnly: props.comment?.readOnly,
					});
	const toComment = () => {
		if (commentable !== true || sending) return;
		dropAgentWrite(clientId);
		closeAgentComposer(clientId);
		// A draft already on the span (one restored from a reload) takes it,
		// rather than a second card; one being sent doesn't.
		const restored = getComposers().some((c) => sameSpan(c.span, span))
			? undefined
			: writer.drafts.get().find((d) => {
					const at = d.create?.sending === undefined && spanOfDraft(d);
					return at && sameSpan(at, span);
				})?.create?.clientId;
		const id = openComposer(span, restored);
		const before = writer.drafts.newThread(id)?.text ?? "";
		const joined =
			before.trim() && text ? `${before}\n\n${text}` : before || text;
		// A comment there carrying an agent conversation keeps carrying it.
		const carries =
			writer.drafts.newThread(id)?.create?.agentThread ??
			getComposers().find((c) => c.clientId === id)?.agentThread;
		writer.drafts.setNew(id, targetOf(span, carries), joined, props.lineTexts);
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
					{props.where ?? describeSpan(span)}
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
						<QuickQuestionChips questions={SPAN_QUESTIONS} onPick={pick} />
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
							{/* Where a thread's agent handle is: the row's right end. */}
							<Tooltip
								content={commentable === true ? COMMENT_INSTEAD : commentable}
								describe={commentable !== true}
							>
								{(trigger) => (
									<button
										{...trigger}
										type="button"
										data-testid="agent-composer-comment"
										aria-label={COMMENT_INSTEAD}
										aria-disabled={commentable !== true || undefined}
										onClick={toComment}
										className={`${HANDLE} ${HANDLE_OFF} border-line-strong text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent`}
									>
										<CommentIcon size={16} aria-hidden />
									</button>
								)}
							</Tooltip>
						</div>
					</>
				)}
			</div>
		</article>
	);
}
