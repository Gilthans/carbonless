import {
	AlertIcon,
	ClockIcon,
	CommentIcon,
	LinkExternalIcon,
	SparkleFillIcon,
} from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useLayoutEffect, useRef } from "react";
import { MAX_REPLY } from "../../shared/types";
import { useCommentScope } from "../agent/agentComment";
import { agentAsking } from "../agent/agentWrites";
import { askAgentAvailable, openAgentComposer } from "../agent/askAgentAction";
import { ASK_HANDLE, HANDLE, HANDLE_OFF } from "../agent/handle";
import { overviewQuery, sessionQuery } from "../api";
import {
	type CodeSpan,
	commentAvailable,
	describeSpan,
} from "../files/selectionActions";
import { LabeledIcon } from "../overview/parts";
import { Tooltip } from "../Tooltip";
import { safeHref } from "../ui";
import { COMMENT_SURFACE } from "./Conversation";
import { useClearOfNotices } from "./clearOfNotices";
import { type LineTexts, newThreadKey } from "./drafts";
import {
	closeComposer,
	composerFocused,
	type NewThreadItem,
	targetOf,
} from "./newThreads";
import { Avatar } from "./people";
import {
	useThreadWriter,
	useThreadWrites,
	type WriteFailure,
} from "./threadWrites";

/** Why GitHub didn't take a new thread, in a few words. */
export function newThreadError(
	failed: Pick<WriteFailure, "code" | "error">,
	span?: Pick<CodeSpan, "subject">,
): string {
	switch (failed.code) {
		case "pending-review":
			return "A pending review on GitHub blocks comments";
		case "gone":
			return span?.subject === "file"
				? "GitHub doesn't take a comment on this file"
				: "GitHub doesn't take a comment on this line";
		case "stale":
			return "The PR moved on; refresh";
		default:
			return failed.error.message;
	}
}

/** The span's text, as quoted above its composer: one line, clipped. */
export function quoteOf(span: CodeSpan, texts: readonly string[]): string {
	if (span.subject === "file") return span.path;
	if (texts.length === 0) return "";
	const { startCol, endCol } = span;
	const cut =
		startCol != null && endCol != null
			? texts.length === 1
				? [(texts[0] ?? "").slice(startCol, endCol)]
				: [
						(texts[0] ?? "").slice(startCol),
						...texts.slice(1, -1),
						(texts[texts.length - 1] ?? "").slice(0, endCol),
					]
			: texts;
	const first = (cut.find((t) => t.trim()) ?? cut[0] ?? "").trim();
	return cut.length > 1 ? `${first} …` : first;
}

const ASK_INSTEAD = "Ask agent instead";
/** A comment started from an agent conversation's card: it takes that conversation along. */
export const MOVES_CONVERSATION =
	"Moves your agent conversation to this thread";
/** Why Ask agent instead is off on such a comment. */
const CARRIES = "Carries your agent conversation: ask there";
/** Why neither switch is on before the overview is known. */
export const LOADING = "Loading the PR";

/** The longest first comment: GitHub's limit less room for carbonless's hidden marker. */
export const MAX_NEW_THREAD = MAX_REPLY - 200;

/**
 * A new thread under its span's last row (or in a file's header): the span
 * quoted, then a box for its first comment. Ctrl/Cmd+Enter or Comment
 * posts it (ThreadWrites); Escape or Cancel drops it, asking first when
 * anything was typed. What's typed is a draft from the first keystroke
 * (drafts.ts `create`). Posted, it shows as sending (the clock) until
 * GitHub has it; refused, the box is back with why. A line comment's
 * card keeps a readable width; a file comment's spans its row, as the
 * file's threads do once it is posted (FileThreadsRow).
 */
export function NewThread(props: {
	item: NewThreadItem;
	/** The span's text (quoteOf). */
	quote: string;
	/** Posted (the thread will open where it lands). */
	onPosted?: () => void;
	/** A line comment's first and last line as shown (kept with the draft). */
	lineTexts?: LineTexts;
	/** The diff shown isn't yet the viewed head's (askAgentAvailable). */
	headUnsure?: boolean;
}) {
	const { item } = props;
	const { clientId, span } = item;
	const writer = useThreadWriter();
	const lane = useThreadWrites().threads.get(newThreadKey(clientId));
	const failed =
		lane?.refused.find((f) => f.action === "New comment" && !f.retrying) ??
		null;
	const viewer = useQuery({ ...sessionQuery, enabled: false }).data?.viewer;
	const box = useRef<HTMLTextAreaElement>(null);
	const card = useRef<HTMLElement>(null);
	// Refused: the text and its Comment button stay above the notice.
	useClearOfNotices(card, failed !== null && !item.sending);
	const blank = !item.text.trim();
	// Opened from an agent conversation on another version (Comment on its
	// card), the page then showing that version: its lines checked as the
	// selection bar checks them, so a span GitHub won't take says why here
	// rather than after Comment.
	const scope = useCommentScope();
	const overview = useQuery({ ...overviewQuery, enabled: false }).data;
	const notHere =
		item.agentThread && overview && scope?.inDiff(span) === false
			? commentAvailable(span, {
					writes: overview.writes,
					commentLeft: overview.commentLeft !== false,
					file: { binary: false, submodule: false },
					inDiff: false,
				})
			: true;
	useLayoutEffect(() => {
		if (!item.focus) return;
		const el = box.current;
		if (el) {
			el.focus({ preventScroll: true });
			el.scrollIntoView?.({ block: "nearest" });
		}
		composerFocused(clientId);
	}, [item.focus, clientId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured as the text changes.
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight + 2}px`;
	}, [item.text, item.sending]);
	const post = () => {
		const now = writer.drafts.newThread(clientId);
		if (!now?.text.trim() || notHere !== true) return;
		writer.createThread(clientId);
		closeComposer(clientId);
		props.onPosted?.();
	};
	const cancel = () => {
		const typed = writer.drafts.newThread(clientId)?.text.trim();
		if (typed && !window.confirm("Discard your comment?")) return;
		writer.discard(newThreadKey(clientId));
		closeComposer(clientId);
	};
	// The agent button: the comment becomes a question on the same span,
	// its text moved (so no "Discard?"), nothing sent anywhere.
	const writes = useQuery({ ...overviewQuery, enabled: false }).data?.writes;
	// Carrying an agent conversation (Comment on its card), it stays a
	// comment: the conversation is one already, nothing to lose by switching.
	const askable = item.agentThread
		? CARRIES
		: writes
			? askAgentAvailable(span, { writes, headUnsure: props.headUnsure })
			: LOADING;
	const toAgent = () => {
		if (askable !== true) return;
		const text = writer.drafts.newThread(clientId)?.text ?? item.text;
		writer.discard(newThreadKey(clientId));
		closeComposer(clientId);
		openAgentComposer(span, undefined, text, (c) => !agentAsking(c.clientId));
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			post();
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			cancel();
		}
	};
	const href =
		failed?.code === "pending-review" ? safeHref(failed.url) : undefined;
	return (
		<article
			ref={card}
			data-testid="new-thread"
			data-sending={item.sending || undefined}
			aria-label="New comment"
			className={`min-w-0 ${span.subject === "file" ? "" : "max-w-[40rem]"} overflow-hidden rounded-lg border border-edge bg-surface`}
		>
			<div className="flex min-h-8 min-w-0 items-center gap-2 border-b border-line bg-band px-2.5 py-1 text-xs">
				{props.quote && (
					<code
						data-testid="new-thread-quote"
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
				{item.agentThread && (
					<Tooltip content={MOVES_CONVERSATION} describe={false}>
						{(trigger) => (
							<span
								{...trigger}
								role="img"
								aria-label={MOVES_CONVERSATION}
								data-testid="new-thread-carries"
								// Focusable so keyboard and touch users get the tip.
								// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
								tabIndex={0}
								// A 40px target around the 12px mark at the band's right end: the band no taller.
								className="-my-3.5 -mr-2.5 ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-agent-ink focus-visible:outline-2 focus-visible:outline-accent"
							>
								<SparkleFillIcon size={12} aria-hidden />
							</span>
						)}
					</Tooltip>
				)}
			</div>
			<div className="space-y-1.5 p-2.5">
				{item.sending ? (
					<div data-testid="new-thread-sending" className="min-w-0 space-y-1">
						<div className="flex min-h-5 items-center gap-x-1.5 px-0.5 text-xs text-muted">
							<Avatar login={viewer ?? "you"} url="" />
							<span className="font-semibold text-ink-soft">
								{viewer ?? "you"}
							</span>
							<LabeledIcon
								icon={ClockIcon}
								label="Sending"
								className="text-warn"
							/>
						</div>
						<p
							className={`${COMMENT_SURFACE} text-sm whitespace-pre-wrap break-words`}
						>
							{item.text}
						</p>
					</div>
				) : (
					<>
						{notHere !== true && (
							<p
								role="alert"
								data-testid="new-thread-not-here"
								className="flex flex-wrap items-center gap-x-2 text-sm text-bad"
							>
								<AlertIcon size={14} aria-hidden className="shrink-0" />
								{notHere}
							</p>
						)}
						{failed && (
							<p
								role="alert"
								data-testid="new-thread-error"
								className="flex flex-wrap items-center gap-x-2 text-sm text-bad"
							>
								<AlertIcon size={14} aria-hidden className="shrink-0" />
								{newThreadError(failed, span)}
								{href && (
									<a
										href={href}
										target="_blank"
										rel="noreferrer"
										className="inline-flex min-h-10 items-center gap-1 font-semibold text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
									>
										Open on GitHub
										<LinkExternalIcon size={14} aria-hidden />
									</a>
								)}
							</p>
						)}
						<textarea
							ref={box}
							aria-label="Comment"
							placeholder="Comment…"
							rows={3}
							maxLength={MAX_NEW_THREAD}
							value={item.text}
							onChange={(e) =>
								writer.drafts.setNew(
									clientId,
									targetOf(span, item.agentThread),
									e.target.value,
									props.lineTexts,
								)
							}
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
								data-testid="new-thread-post"
								disabled={blank || notHere !== true}
								onClick={post}
								// Keeps the box's focus on a mouse click.
								onMouseDown={(e) => e.preventDefault()}
								className="flex h-10 items-center gap-1.5 rounded-md border border-accent/60 bg-accent/15 px-4 text-sm font-semibold text-link hover:bg-accent/25 focus-visible:outline-2 focus-visible:outline-accent disabled:border-line disabled:bg-transparent disabled:text-faint"
							>
								<CommentIcon size={16} aria-hidden />
								Comment
							</button>
							{/* Where a thread's agent handle is: the row's right end. */}
							<Tooltip
								content={askable === true ? ASK_INSTEAD : askable}
								describe={askable !== true}
							>
								{(trigger) => (
									<button
										{...trigger}
										type="button"
										data-testid="new-thread-agent"
										aria-label={ASK_INSTEAD}
										aria-disabled={askable !== true || undefined}
										onClick={toAgent}
										className={`${HANDLE} ${ASK_HANDLE} ${HANDLE_OFF} focus-visible:outline-2 focus-visible:outline-accent`}
									>
										<SparkleFillIcon size={14} aria-hidden />
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
