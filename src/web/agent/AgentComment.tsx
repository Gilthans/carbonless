/**
 * A ```comment block of an agent message (CAR-83): the agent's suggested
 * review comment as an editable box with Add review comment, which posts
 * exactly the box's text to GitHub, as the reviewer, where the
 * conversation sits (agentComments.ts). Posted, it folds to one row with
 * a link to the comment and the text as GitHub comments render. Outside
 * a conversation that can post (no `at`: a turn still streaming, or one
 * with nowhere to post), it's a read-only quote with a copy button.
 */
import {
	AlertIcon,
	CheckIcon,
	CommentIcon,
	LinkExternalIcon,
	ReplyIcon,
	UndoIcon,
} from "@primer/octicons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Marked } from "marked";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	type AgentMessage,
	type AgentPostedComment,
	type AgentThread,
	agentCommentClientId,
} from "../../shared/agent";
import { escapeTags } from "../../shared/markdownEscape";
import { sessionQuery } from "../api";
import { type Copied, CopyMark, copyInto, copyWord } from "../CopyMark";
import { GithubHtml } from "../GithubHtml";
import { RelativeTime } from "../RelativeTime";
import { SpinnerIcon } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { useWritesOn } from "../threads/threadWrites";
import { safeHref } from "../ui";
import {
	AgentCommentError,
	CHANGED,
	type CommentPlace,
	commentPlace,
	keptOf,
	placeLabel,
	postAgentComment,
	postedOnPage,
	refusalText,
	setDraft,
	subscribeKept,
	takeResend,
	WRITES_OFF,
} from "./agentComments";
import { agentPlacementsOnHeadQuery, agentThreadsQuery } from "./api";

const md = new Marked({ gfm: true, breaks: false, async: false });

/** Where an agent message's comment blocks post from. */
export interface CommentAt {
	thread: AgentThread;
	message: AgentMessage;
}

const PLACING = "Finding these lines in the latest push";

const FRAME =
	"my-2 flex min-w-0 flex-col gap-2 rounded-lg border border-line-strong bg-surface p-2";
const ICON_BUTTON =
	"flex size-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent";

export function AgentComment(props: {
	text: string;
	block: number;
	at?: CommentAt;
}) {
	if (!props.at) return <ReadOnlyComment text={props.text} />;
	return <CommentBox text={props.text} block={props.block} at={props.at} />;
}

/** A block with nowhere to post: the text as it is, to copy. */
function ReadOnlyComment(props: { text: string }) {
	const [copied, setCopied] = useState<Copied>(null);
	const quote = useRef<HTMLPreElement>(null);
	return (
		<div data-testid="agent-comment" className={FRAME}>
			<div className="flex min-h-7 items-center gap-1.5 text-xs text-muted">
				<CommentIcon size={14} aria-hidden />
				<span className="flex-1" />
				<Tooltip content={copyWord(copied)} describe={false}>
					{(trigger) => (
						<button
							{...trigger}
							type="button"
							aria-label="Copy comment"
							onClick={() =>
								void copyInto(props.text, quote.current, setCopied)
							}
							className={ICON_BUTTON}
						>
							<CopyMark copied={copied} />
						</button>
					)}
				</Tooltip>
			</div>
			<pre
				ref={quote}
				className="min-w-0 whitespace-pre-wrap break-words rounded-md border border-line bg-raised px-2.5 py-2 font-mono text-sm leading-5 text-ink"
			>
				{props.text}
			</pre>
		</div>
	);
}

/** Where the block posts now: its conversation's place on the snapshot's head. */
function usePlace(thread: AgentThread): CommentPlace {
	const head = useQuery({ ...sessionQuery, enabled: false }).data?.snapshotHead;
	const a = thread.anchor;
	const needed = a.subject !== "thread" && !!head && a.commit !== head;
	const all = useQuery({ ...agentThreadsQuery, enabled: false }).data?.threads;
	const ids = useMemo(() => {
		const spans = (all ?? [])
			.filter((t) => t.anchor.subject !== "thread")
			.map((t) => t.id);
		return spans.includes(thread.id) ? spans : [...spans, thread.id];
	}, [all, thread.id]);
	const placed = useQuery({
		...agentPlacementsOnHeadQuery(head ?? "", ids),
		enabled: needed,
	});
	const placement = placed.data?.threads.find(
		(t) => t.id === thread.id,
	)?.placement;
	const placing = placed.data ? "in" : placed.isError ? "failed" : "pending";
	return commentPlace({ thread, head, placement, placing });
}

type Phase =
	| { kind: "ready" }
	| { kind: "sending" }
	| { kind: "refused"; why: string }
	| { kind: "doubt" };

function CommentBox(props: { text: string; block: number; at: CommentAt }) {
	const { block } = props;
	const { thread, message } = props.at;
	const clientId = agentCommentClientId(thread.id, message.id, block);
	const client = useQueryClient();
	const stored = message.posted?.find((p) => p.block === block);
	const [postedNow, setPostedNow] = useState<AgentPostedComment | undefined>(
		() => postedOnPage(clientId),
	);
	const posted = stored ?? postedNow;
	const draft = useSyncExternalStore(
		subscribeKept,
		() => keptOf(clientId).text ?? null,
		() => null,
	);
	const text = draft ?? props.text;
	const place = usePlace(thread);
	const writes = useWritesOn();
	const [phase, setPhase] = useState<Phase>({ kind: "ready" });
	const sending = phase.kind === "sending";

	const send = useCallback(
		(
			body: string,
			resend?: Parameters<typeof postAgentComment>[1]["resend"],
		) => {
			if (place.kind !== "new" && place.kind !== "reply") return;
			setPhase({ kind: "sending" });
			postAgentComment(client, {
				thread,
				message,
				block,
				body,
				place,
				...(resend ? { resend } : {}),
			}).then(
				(p) => {
					setPostedNow(p);
					setPhase({ kind: "ready" });
				},
				(error: unknown) => {
					if (error instanceof AgentCommentError && error.inDoubt) {
						setPhase({ kind: "doubt" });
						return;
					}
					const e = error instanceof AgentCommentError ? error.cause : error;
					setPhase({
						kind: "refused",
						why: refusalText(
							e instanceof Error ? e : new Error(String(e)),
							place,
						),
					});
				},
			);
		},
		[client, thread, message, block, place],
	);

	// A press a reload cut short may have landed: resent once, as it was
	// sent (the server looks for it first). Never a refused one.
	const postable = (place.kind === "new" || place.kind === "reply") && writes;
	useEffect(() => {
		if (posted || !postable) return;
		const resend = takeResend(clientId);
		if (resend) send(resend.body, resend);
	}, [posted, postable, clientId, send]);

	if (posted) return <PostedRow posted={posted} />;

	const blank = !text.trim();
	const pending = place.kind === "pending";
	const off: string | null = !writes
		? WRITES_OFF
		: place.kind === "off"
			? place.why
			: null;
	const disabled = blank || sending || pending || off !== null;
	const label = placeLabel(place, thread.anchor);
	const press = () => {
		if (disabled) return;
		send(text);
	};
	const why = off ?? (pending ? PLACING : null);
	const button = (trigger: object) => (
		<button
			{...trigger}
			type="button"
			aria-disabled={disabled || undefined}
			aria-busy={sending || pending || undefined}
			onClick={press}
			className="flex h-10 w-full items-center justify-center gap-2 self-end rounded-md bg-ok-fill px-4 text-sm font-semibold text-canvas hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-not-allowed aria-disabled:bg-overlay aria-disabled:text-muted aria-disabled:hover:brightness-100 sm:w-auto"
		>
			{(sending || pending) && <SpinnerIcon size={14} />}
			Add review comment
		</button>
	);
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			press();
		}
	};
	return (
		<div
			data-testid="agent-comment"
			data-block={block}
			aria-busy={sending || pending || undefined}
			className={FRAME}
		>
			<div className="flex min-h-7 min-w-0 items-center gap-1.5 text-xs text-muted">
				{place.kind === "reply" ? (
					<ReplyIcon size={14} aria-hidden className="shrink-0" />
				) : (
					<CommentIcon size={14} aria-hidden className="shrink-0" />
				)}
				<Tooltip content={label.full}>
					{(trigger) => (
						<span
							{...trigger}
							data-testid="agent-comment-target"
							// Focusable so keyboard and touch users get the tip.
							// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
							tabIndex={0}
							className={`min-w-0 truncate rounded-sm font-mono focus-visible:outline-2 focus-visible:outline-accent ${
								off ? "text-faint" : "text-ink-soft"
							}`}
						>
							{label.short}
						</span>
					)}
				</Tooltip>
				{place.kind === "new" && place.changed && (
					<Tooltip content={CHANGED} describe={false}>
						{(trigger) => (
							<span
								{...trigger}
								role="img"
								aria-label={CHANGED}
								// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
								tabIndex={0}
								className="inline-flex shrink-0 rounded-sm text-warn focus-visible:outline-2 focus-visible:outline-accent"
							>
								<AlertIcon size={14} aria-hidden />
							</span>
						)}
					</Tooltip>
				)}
				<span className="flex-1" />
				{draft !== null && !sending && (
					<Tooltip content="Back to the agent's text" describe={false}>
						{(trigger) => (
							<button
								{...trigger}
								type="button"
								aria-label="Back to the agent's text"
								onClick={() => setDraft(clientId, props.text, props.text)}
								className={ICON_BUTTON}
							>
								<UndoIcon size={16} aria-hidden />
							</button>
						)}
					</Tooltip>
				)}
			</div>
			<CommentText
				value={text}
				readOnly={sending}
				onChange={(v) => setDraft(clientId, v, props.text)}
				onKeyDown={onKeyDown}
			/>
			{phase.kind === "refused" && (
				<p
					role="alert"
					className="flex items-start gap-1.5 text-sm text-bad break-words"
				>
					<AlertIcon size={14} aria-hidden className="mt-0.5 shrink-0" />
					{phase.why}
				</p>
			)}
			{phase.kind === "doubt" && (
				<p
					role="alert"
					className="flex items-start gap-1.5 text-sm text-warn break-words"
				>
					<AlertIcon size={14} aria-hidden className="mt-0.5 shrink-0" />
					May have landed; press again to check
				</p>
			)}
			{why ? (
				<Tooltip content={why}>{(trigger) => button(trigger)}</Tooltip>
			) : (
				button({})
			)}
		</div>
	);
}

/** The box: monospace like the reply box, growing to about 12 lines, then scrolling. */
function CommentText(props: {
	value: string;
	readOnly: boolean;
	onChange: (value: string) => void;
	onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
	const box = useRef<HTMLTextAreaElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured as the text changes.
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight + 2}px`;
	}, [props.value]);
	return (
		<textarea
			ref={box}
			aria-label="Review comment"
			rows={3}
			value={props.value}
			readOnly={props.readOnly}
			onChange={(e) => props.onChange(e.target.value)}
			onKeyDown={props.onKeyDown}
			className="block max-h-64 min-h-16 w-full min-w-0 resize-none rounded-md border border-line-strong bg-raised px-2.5 py-2 font-mono text-sm leading-5 text-ink focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent read-only:opacity-70"
		/>
	);
}

/** Posted: one row (when, a link to it), then the text as GitHub comments render. */
function PostedRow(props: { posted: AgentPostedComment }) {
	const { posted } = props;
	const html = useMemo(
		() => md.parse(escapeTags(posted.text)) as string,
		[posted.text],
	);
	const href = safeHref(posted.url);
	return (
		<div data-testid="agent-comment" data-posted className={FRAME}>
			<div className="flex min-h-7 min-w-0 items-center gap-1.5 text-sm">
				<CheckIcon size={16} aria-hidden className="shrink-0 text-ok" />
				<span className="font-semibold text-ink-soft">Posted</span>
				<RelativeTime iso={posted.at} className="text-xs text-muted" />
				<span className="flex-1" />
				{href && (
					<Tooltip content="Open on GitHub" describe={false}>
						{(trigger) => (
							<a
								{...trigger}
								href={href}
								target="_blank"
								rel="noreferrer noopener"
								aria-label="Open on GitHub"
								className={ICON_BUTTON}
							>
								<LinkExternalIcon size={16} aria-hidden />
							</a>
						)}
					</Tooltip>
				)}
			</div>
			<GithubHtml
				html={html}
				className="border-l-2 border-ok-fill pl-2.5 text-sm"
			/>
		</div>
	);
}
