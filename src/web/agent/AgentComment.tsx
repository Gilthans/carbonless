/**
 * A ```comment block of an agent message (CAR-83): the agent's suggested
 * review comment as an editable box with Reply (on a GitHub thread) or
 * Add review comment (new, on its lines or file), which posts exactly the
 * box's text to GitHub, as the reviewer, where the conversation sits
 * (agentComments.ts, postLabel). Posted, it folds to one row with
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
import {
	type KeyboardEvent,
	type RefObject,
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
import { sessionQuery } from "../api";
import {
	CommentHtml,
	CommentPreview,
	isPreviewKey,
	PreviewToggle,
	useWritePreview,
} from "../CommentPreview";
import { type Copied, CopyMark, copyInto, copyWord } from "../CopyMark";
import { noLineReason } from "../files/selectionActions";
import { threadFocus } from "../files/threadFocus";
import { RelativeTime } from "../RelativeTime";
import { SpinnerIcon } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { targetOf } from "../threads/newThreads";
import { useWritesOn } from "../threads/threadWrites";
import { safeHref } from "../ui";
import {
	AgentCommentError,
	CHANGED,
	type CommentPlace,
	commentPlace,
	dropKeptPosted,
	keptOf,
	opensThreadCard,
	type PostingThread,
	placeLabel,
	postAgentComment,
	postLabel,
	postsAsReply,
	postsFrom,
	recordPosted,
	refusalText,
	setDraft,
	siblingKey,
	siblingOf,
	subscribeKept,
	takeResend,
	WRITES_OFF,
} from "./agentComments";
import { agentPlacementsOnHeadQuery } from "./api";
import { spanOfAnchor } from "./askAgentAction";
import { useCommentScope } from "./commentOnGithub";

/** Where an agent message's comment blocks post from. */
export interface CommentAt {
	thread: AgentThread;
	message: AgentMessage;
}

const PLACING = "Finding these lines in the latest push";
/** The box's group name: its Reply is told apart from the thread's own (CAR-237). */
export const SUGGESTED = "Suggested comment";

const FRAME =
	"my-2 flex min-w-0 flex-col gap-2 rounded-lg border border-line-strong bg-surface p-2";
const ICON_BUTTON =
	"flex size-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent";

export function AgentComment(props: {
	text: string;
	block: number;
	at?: CommentAt;
}) {
	// Only a conversation on code or a GitHub thread has a place to post;
	// any other (the whole review's) shows the block read-only.
	const at = props.at;
	if (!at || !postsFrom(at.thread)) {
		return <ReadOnlyComment text={props.text} />;
	}
	return (
		<CommentBox
			text={props.text}
			block={props.block}
			at={{ thread: at.thread, message: at.message }}
		/>
	);
}

/** A block with nowhere to post: the text as it is, to copy. */
function ReadOnlyComment(props: { text: string }) {
	const [copied, setCopied] = useState<Copied>(null);
	const quote = useRef<HTMLPreElement>(null);
	return (
		// biome-ignore lint/a11y/useSemanticElements: a named group of a box, not a form's fieldset (its flex frame and min-width stay).
		<div
			data-testid="agent-comment"
			role="group"
			aria-label={SUGGESTED}
			className={FRAME}
		>
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
function usePlace(thread: PostingThread, clientId: string): CommentPlace {
	const head = useQuery({ ...sessionQuery, enabled: false }).data?.snapshotHead;
	const a = thread.anchor;
	// Another block of a conversation on lines posting, or posted with its
	// record not in (CAR-236): this one waits, or replies to its thread.
	const siblingAt = useSyncExternalStore(
		subscribeKept,
		() => (a.subject === "thread" ? "" : siblingKey(thread.id, clientId)),
		() => "",
	);
	const sibling = useMemo(() => siblingOf(siblingAt), [siblingAt]);
	// The since view: on lines only its compared patch set had, it posts
	// there, on that commit, as a direct comment on them (CAR-264).
	const scope = useCommentScope();
	const early = useMemo(() => {
		if (a.subject !== "line" || !scope?.earlier) return undefined;
		const e = scope.earlier(spanOfAnchor(a));
		if (e === null) return undefined;
		return typeof e === "string" ? noLineReason(e) : targetOf(e);
	}, [a, scope]);
	// A joined conversation replies, needing no lines; one whose thread is
	// gone (orphaned) is back on its lines: placed like any other.
	const needed =
		a.subject !== "thread" &&
		!(thread.joined && !thread.orphaned) &&
		!thread.githubUnknown &&
		sibling === undefined &&
		!!head &&
		a.commit !== head &&
		early === undefined;
	const placed = useQuery({
		...agentPlacementsOnHeadQuery(head ?? ""),
		enabled: needed,
	});
	const { data, isError, dataUpdatedAt, refetch } = placed;
	const placement = data?.threads.find((t) => t.id === thread.id)?.placement;
	// A conversation newer than the answer (the agent just opened it): asked
	// once more, pending meanwhile; still missing then, it couldn't be traced.
	const missing = needed && data !== undefined && placement === undefined;
	const [askedAt, setAskedAt] = useState<number | null>(null);
	useEffect(() => {
		if (!missing || askedAt !== null) return;
		setAskedAt(dataUpdatedAt);
		void refetch({ cancelRefetch: false });
	}, [missing, askedAt, dataUpdatedAt, refetch]);
	const waiting = missing && (askedAt === null || dataUpdatedAt === askedAt);
	const placing = isError ? "failed" : !data || waiting ? "pending" : "in";
	return useMemo(
		() =>
			commentPlace({
				thread,
				head,
				placement,
				placing,
				...(sibling ? { sibling } : {}),
				...(early ? { earlier: early } : {}),
			}),
		[thread, head, placement, placing, sibling, early],
	);
}

type Phase =
	| { kind: "ready" }
	| { kind: "sending" }
	| { kind: "refused"; why: string }
	| { kind: "doubt" };

function CommentBox(props: {
	text: string;
	block: number;
	at: { thread: PostingThread; message: AgentMessage };
}) {
	const { block } = props;
	const { thread, message } = props.at;
	const clientId = agentCommentClientId(thread.id, message.id, block);
	const client = useQueryClient();
	const stored = message.posted?.find((p) => p.block === block);
	const [postedNow, setPostedNow] = useState<AgentPostedComment | undefined>();
	// Posted here or on an earlier load, its record not yet written.
	const keptPosted = useSyncExternalStore(
		subscribeKept,
		() => keptOf(clientId).posted,
		() => undefined,
	);
	const posted = stored ?? postedNow ?? keptPosted;
	const draft = useSyncExternalStore(
		subscribeKept,
		() => keptOf(clientId).text ?? null,
		() => null,
	);
	// A press on its way or in doubt fixes the text: a retry looks for it.
	const sentBody = useSyncExternalStore(
		subscribeKept,
		() => keptOf(clientId).sending?.body ?? null,
		() => null,
	);
	const text = sentBody ?? draft ?? props.text;
	const place = usePlace(thread, clientId);
	const writes = useWritesOn();
	const [phase, setPhase] = useState<Phase>({ kind: "ready" });
	const sending = phase.kind === "sending";
	// Markdown the reviewer didn't write: read first (CAR-202).
	const box = useRef<HTMLTextAreaElement>(null);
	const view = useWritePreview({ initial: "preview", text, box });
	// Write and Preview swap the box for the preview in one commit, which
	// shrinks a scroll box around it for a moment (the preview's text comes
	// in a layout effect) and clamps its scrollTop; React, refocusing, puts
	// that clamped value back, and the final size is the same, so nothing
	// else sees it. The scroll boxes around it keep the scrollTop they had
	// at the press (CAR-246: the agent card's scroller kept at its end).
	const keptScroll = useRef<[Element, number][] | null>(null);
	const keepScroll = () => {
		keptScroll.current = box.current ? scrolledAncestors(box.current) : null;
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per switch.
	useLayoutEffect(() => {
		const kept = keptScroll.current;
		keptScroll.current = null;
		for (const [a, top] of kept ?? [])
			if (a.scrollTop !== top) a.scrollTop = top;
	}, [view.mode]);
	const toggleProps = {
		...view.toggleProps,
		onChange: (mode: Parameters<typeof view.choose>[0]) => {
			if (mode !== view.mode) keepScroll();
			view.choose(mode);
		},
		onKeyDown: (e: Parameters<typeof view.toggleProps.onKeyDown>[0]) => {
			if (view.toggle && isPreviewKey(e)) keepScroll();
			view.toggleProps.onKeyDown(e);
		},
	};

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
				({ githubThread, recorded, ...p }) => {
					setPostedNow(p);
					setPhase({ kind: "ready" });
					// The conversation is that thread's now (CAR-236): its card
					// opens with it, once it's in.
					if (opensThreadCard(thread, recorded)) {
						threadFocus.request({ id: githubThread, conversation: thread.id });
					}
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
	// Posted on an earlier load whose record didn't land: written now.
	useEffect(() => {
		if (!keptPosted) return;
		// Recorded already (its answer lost): the browser's copy has served.
		if (stored) dropKeptPosted(clientId);
		else void recordPosted(client, thread.id, message.id, clientId, keptPosted);
	}, [stored, keptPosted, client, thread.id, message.id, clientId]);

	if (posted) return <PostedRow posted={posted} />;

	const blank = !text.trim();
	const pending = place.kind === "pending";
	const off: string | null = !writes
		? WRITES_OFF
		: place.kind === "off"
			? place.why
			: null;
	const disabled = blank || sending || pending || off !== null;
	// Button, icon and target agree on where it posts (CAR-237).
	const reply = postsAsReply(place, thread);
	const label = placeLabel(place, thread.anchor, reply);
	const press = () => {
		if (disabled) return;
		send(text);
	};
	const why = off ?? (place.kind === "pending" ? (place.why ?? PLACING) : null);
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
			{postLabel(place, thread)}
		</button>
	);
	const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
		if (view.toggle && isPreviewKey(e)) keepScroll();
		view.onKeyDown(e);
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			press();
		}
	};
	return (
		// biome-ignore lint/a11y/useSemanticElements: a named group of a box, not a form's fieldset (its flex frame and min-width stay).
		<div
			data-testid="agent-comment"
			data-block={block}
			role="group"
			aria-label={SUGGESTED}
			aria-busy={sending || pending || undefined}
			className={FRAME}
		>
			<div className="flex min-h-7 min-w-0 items-center gap-1.5 text-xs text-muted">
				{reply ? (
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
				{view.toggle && <PreviewToggle {...toggleProps} />}
				{draft !== null && sentBody === null && !sending && (
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
				box={box}
				value={text}
				hidden={view.mode === "preview"}
				readOnly={sending || sentBody !== null}
				onChange={(v) => setDraft(clientId, v, props.text)}
				onKeyDown={onKeyDown}
			/>
			{view.mode === "preview" && (
				<CommentPreview
					text={text}
					{...view.previewProps}
					onKeyDown={onKeyDown}
					className="max-h-64 min-h-16"
				/>
			)}
			{phase.kind === "refused" && (
				<p
					role="alert"
					className="flex items-start gap-1.5 text-sm text-bad break-words"
				>
					<AlertIcon size={14} aria-hidden className="mt-0.5 shrink-0" />
					{phase.why}
				</p>
			)}
			{(phase.kind === "doubt" || (sentBody !== null && !sending)) && (
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

/**
 * The element scroll boxes around `el` that are scrolled, with their
 * scrollTop (not the page's: body and html are left out).
 */
function scrolledAncestors(el: Element): [Element, number][] {
	const kept: [Element, number][] = [];
	for (
		let a = el.parentElement;
		a && a !== document.body && a !== document.documentElement;
		a = a.parentElement
	) {
		if (a.scrollTop <= 0) continue;
		const y = getComputedStyle(a).overflowY;
		if (y === "auto" || y === "scroll") kept.push([a, a.scrollTop]);
	}
	return kept;
}

/** The box: monospace like the reply box, growing to about 12 lines, then scrolling. */
function CommentText(props: {
	box: RefObject<HTMLTextAreaElement | null>;
	value: string;
	/** Previewing: kept mounted, so Write brings the cursor back. */
	hidden: boolean;
	readOnly: boolean;
	onChange: (value: string) => void;
	onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}) {
	const { box } = props;
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured as the text changes, and once it shows.
	useLayoutEffect(() => {
		const el = box.current;
		if (!el || props.hidden) return;
		// Collapsing it to measure shrinks a scroll box it sits in (the agent
		// card's), which clamps that box's scrollTop: kept across the
		// measurement, so typing never moves the comment (CAR-246). The page
		// itself is left as it was.
		const kept = scrolledAncestors(el);
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight + 2}px`;
		for (const [a, top] of kept) if (a.scrollTop !== top) a.scrollTop = top;
	}, [props.value, props.hidden]);
	return (
		<textarea
			ref={box}
			aria-label="Review comment"
			rows={3}
			hidden={props.hidden}
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
	const href = safeHref(posted.url);
	return (
		// biome-ignore lint/a11y/useSemanticElements: a named group of a box, not a form's fieldset (its flex frame and min-width stay).
		<div
			data-testid="agent-comment"
			data-posted
			role="group"
			aria-label={SUGGESTED}
			className={FRAME}
		>
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
			<CommentHtml
				text={posted.text}
				className="border-l-2 border-ok-fill pl-2.5"
			/>
		</div>
	);
}
