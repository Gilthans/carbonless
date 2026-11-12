import {
	AlertIcon,
	CheckCircleIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	HistoryIcon,
	IssueReopenedIcon,
	SparkleFillIcon,
	SquareFillIcon,
} from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Fragment,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	type AgentActivity,
	type AgentMessage,
	type AgentStatus,
	type AgentStop,
	type AgentThread,
	type AgentView,
	MAX_AGENT_TEXT,
} from "../../shared/agent";
import { sessionQuery } from "../api";
import { Badge, LabeledIcon } from "../overview/parts";
import { RelativeTime } from "../RelativeTime";
import { Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { commentSurface } from "../threads/Conversation";
import { newClientId } from "../threads/newThreads";
import { Avatar, usePerson } from "../threads/people";
import { AgentMarkdown } from "./AgentMarkdown";
import {
	type AgentWrite,
	dropAgentWrite,
	replyAgent,
	retryAgentWrite,
	useAgentWrites,
} from "./agentWrites";
import {
	agentStatusQuery,
	agentThreadsQuery,
	postAgentCancel,
	postAgentResolved,
	withThread,
} from "./api";
import { openAgentSetup } from "./setupStore";
import { useSeenWriter, useSendView } from "./threadAgent";

/** The longest request the origin chip shows. */
const MAX_ORIGIN = 200;

const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

/** "read 2 files · ran 1 command · edited 1 file · used 2 tools"; "" for none. */
export function activitySummary(activity: readonly AgentActivity[]): string {
	let read = 0;
	let ran = 0;
	let edited = 0;
	let used = 0;
	for (const a of activity) {
		if (a.kind === "read") read++;
		else if (a.kind === "execute") ran++;
		else if (a.kind === "edit" || a.kind === "delete" || a.kind === "move") {
			edited++;
		} else used++;
	}
	return [
		read && `read ${plural(read, "file", "files")}`,
		ran && `ran ${plural(ran, "command", "commands")}`,
		edited && `edited ${plural(edited, "file", "files")}`,
		used && `used ${plural(used, "tool", "tools")}`,
	]
		.filter(Boolean)
		.join(" · ");
}

/** What a turn that didn't end normally says, and its tone. */
const STOPS: Partial<
	Record<AgentStop, { label: string; tip: string; tone: "gray" | "red" }>
> = {
	max_tokens: {
		label: "cut off",
		tip: "The agent hit its length limit",
		tone: "gray",
	},
	max_turn_requests: {
		label: "cut off",
		tip: "The agent hit its step limit",
		tone: "gray",
	},
	refusal: { label: "refused", tip: "The agent refused", tone: "gray" },
	cancelled: {
		label: "stopped",
		tip: "Stopped before it finished",
		tone: "gray",
	},
	error: {
		label: "failed",
		tip: "The agent stopped with an error",
		tone: "red",
	},
};

/**
 * What the agent did for a reply (or is doing): one collapsed line of
 * counts, opened to every title, carbonless's decisions marked. Stays with
 * the message, so what a PR made the agent do remains visible.
 */
export function ActivityLine(props: { activity: readonly AgentActivity[] }) {
	const summary = activitySummary(props.activity);
	if (!summary) return null;
	return (
		<details
			data-testid="agent-activity"
			className="group/act min-w-0 text-xs text-muted"
		>
			<summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
				<span
					aria-hidden
					className="transition-transform group-open/act:rotate-90"
				>
					›
				</span>
				<span className="min-w-0 truncate">{summary}</span>
			</summary>
			<ul className="space-y-0.5 pb-1 pl-5">
				{props.activity.map((a, i) => (
					<li
						// The list is append-only.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above.
						key={i}
						className="flex min-w-0 items-baseline gap-2"
					>
						<span className="shrink-0 text-faint">{a.kind}</span>
						<span className="min-w-0 font-mono break-words text-ink-soft">
							{a.title}
						</span>
						{a.decision === "rejected" && (
							<span className="shrink-0 text-bad">rejected</span>
						)}
						{a.decision === "allowed" && (
							<span className="shrink-0 text-faint">allowed</span>
						)}
					</li>
				))}
			</ul>
		</details>
	);
}

/** The agent's box: its tint, the text as GitHub-flavored Markdown. */
const AGENT_SURFACE =
	"min-w-0 rounded-md border border-agent-edge bg-agent px-3 py-2";

function Who(props: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-1.5 px-0.5 text-xs text-muted">
			{props.children}
		</div>
	);
}

function HumanMessage(props: { message: AgentMessage; viewer: string }) {
	const me = usePerson(props.viewer);
	return (
		<div className="min-w-0 space-y-1">
			<Who>
				<Avatar login={props.viewer} url="" />
				<span className="font-semibold text-ink-soft">{props.viewer}</span>
				<RelativeTime iso={props.message.at} />
				{props.message.view && <ViewChip view={props.message.view} />}
			</Who>
			<p
				data-testid="agent-message-human"
				className={`${commentSurface(me.tint)} text-sm whitespace-pre-wrap break-words`}
			>
				{props.message.text}
			</p>
			{props.message.truncated && <TruncatedChip />}
		</div>
	);
}

/** The accent dot of a conversation with an answer the reviewer hasn't seen. */
function UnreadDot(props: { unread: boolean }) {
	if (!props.unread) return null;
	return (
		<span
			role="img"
			aria-label="Unread"
			data-testid="agent-unread-dot"
			className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent"
		/>
	);
}

/** The comparison a question was asked in: "PS 3", or the commit's short id. */
function ViewChip(props: { view: AgentView }) {
	const { target } = props.view;
	const label =
		"patchset" in target ? `PS ${target.patchset}` : target.head.slice(0, 7);
	const tip =
		"patchset" in target
			? `Asked viewing patch set ${target.patchset}`
			: `Asked viewing commit ${target.head.slice(0, 7)}`;
	return (
		<Tooltip content={tip} describe={false}>
			{(trigger) => (
				<span
					{...trigger}
					data-testid="agent-view-chip"
					// Focusable so keyboard and touch users get the tip.
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className="inline-flex rounded-full focus-visible:outline-2 focus-visible:outline-accent"
				>
					<Badge tone="gray">{label}</Badge>
				</span>
			)}
		</Tooltip>
	);
}

/** Over an agent-opened conversation's first message: the request behind it. */
function OriginChip(props: { request: string }) {
	const text =
		props.request.length > MAX_ORIGIN
			? `${props.request.slice(0, MAX_ORIGIN - 1)}…`
			: props.request;
	return (
		<Tooltip content={props.request} describe={false}>
			{(trigger) => (
				<span
					{...trigger}
					data-testid="agent-origin-chip"
					// Focusable so keyboard and touch users get the full request.
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className="inline-flex max-w-full self-start rounded-full border border-agent-edge bg-agent px-2 py-0.5 text-xs break-words text-agent-ink focus-visible:outline-2 focus-visible:outline-accent"
				>
					↳ {text}
				</span>
			)}
		</Tooltip>
	);
}

function TruncatedChip() {
	return (
		<span data-testid="agent-truncated-chip">
			<Badge tone="gray" icon={AlertIcon}>
				truncated
			</Badge>
		</span>
	);
}

function AiMessage(props: {
	message: AgentMessage;
	name: string;
	/** The last part of the reply, inside its box (the suggestion's button). */
	footer?: ReactNode;
}) {
	const { message } = props;
	const known = message.stop ? STOPS[message.stop] : undefined;
	// A failed turn names the agent's reason (rate limit, expired login…).
	const stop =
		known && message.stop === "error" && message.error
			? { ...known, tip: `${known.tip}: ${message.error}` }
			: known;
	const reason = message.stop === "error" ? message.error : undefined;
	return (
		<div className="min-w-0 space-y-1">
			<Who>
				<SparkleFillIcon size={14} aria-hidden className="text-agent-ink" />
				<span className="font-semibold text-ink-soft">
					{message.agent?.name ?? props.name}
				</span>
				<RelativeTime iso={message.at} />
				{stop && (
					<Tooltip content={stop.tip} describe={false}>
						{(trigger) => (
							<span
								{...trigger}
								data-testid="agent-stop-chip"
								role="img"
								aria-label={stop.tip}
								// Focusable so keyboard and touch users get the tip.
								// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
								tabIndex={0}
								className="inline-flex rounded-full focus-visible:outline-2 focus-visible:outline-accent"
							>
								<Badge tone={stop.tone}>{stop.label}</Badge>
							</span>
						)}
					</Tooltip>
				)}
				{message.truncated && <TruncatedChip />}
			</Who>
			<div
				data-testid="agent-message-ai"
				className={`${AGENT_SURFACE} text-sm`}
			>
				{message.text || !reason ? (
					<AgentMarkdown text={message.text} head={message.head} />
				) : (
					<p
						data-testid="agent-message-error"
						className="flex items-start gap-1.5 break-words text-bad"
					>
						<AlertIcon size={14} aria-hidden className="mt-0.5 shrink-0" />
						{reason}
					</p>
				)}
				{props.footer && (
					<div
						data-message={message.id}
						className="mt-2 flex border-agent-edge border-t pt-2"
					>
						{props.footer}
					</div>
				)}
			</div>
			{message.activity && <ActivityLine activity={message.activity} />}
		</div>
	);
}

type Answering = NonNullable<AgentStatus["answering"]>;

/** A thread's state, as its name says it; `answering` is what useAnswering shows. */
export function agentThreadState(
	thread: AgentThread,
	answering: Answering | undefined,
): "waiting" | "answering" | "answered" | "resolved" {
	if (thread.resolved) return "resolved";
	if (answering) return "answering";
	return thread.waiting ? "waiting" : "answered";
}

/** Whether the thread holds the reply to the turn `a` (its replyTo names a.asked). */
const holdsReply = (thread: AgentThread, a: Answering): boolean =>
	a.asked !== undefined &&
	thread.messages.some((m) => m.by === "ai" && m.replyTo === a.asked);

/**
 * The turn the card shows as under way: the status's, until the thread
 * holds its reply. The status drops a turn once its reply is stored, and
 * the threads are read again only then (useAgentSync): in between, the
 * last streamed text stays, so it never vanishes and "waiting" never
 * flashes. It goes once the reply is in, once a threads read that began
 * after the turn ended lands without it (stopped on purpose, a failed
 * write), or when the agent restarts or goes.
 */
export function useAnswering(
	thread: AgentThread,
	status: AgentStatus | undefined,
): Answering | undefined {
	const client = useQueryClient();
	// Subscribed only so a threads read re-renders the card.
	useQuery({ ...agentThreadsQuery, enabled: false });
	const reads =
		client.getQueryState(agentThreadsQuery.queryKey)?.dataUpdateCount ?? 0;
	const held = useRef<{ answering: Answering; reads?: number } | null>(null);
	const live =
		status?.answering?.thread === thread.id ? status.answering : undefined;
	if (live) {
		held.current = { answering: live };
		return holdsReply(thread, live) ? undefined : live;
	}
	const h = held.current;
	if (!h) return undefined;
	const restarted =
		status?.state === "starting" ||
		status?.state === "off" ||
		status?.state === "elsewhere";
	h.reads ??= reads;
	if (restarted || holdsReply(thread, h.answering) || reads > h.reads) {
		held.current = null;
		return undefined;
	}
	return h.answering;
}

/** The agent's name for a thread: the live one, else the last that answered. */
export function agentName(
	thread: AgentThread,
	status: AgentStatus | undefined,
): string {
	const last = [...thread.messages].reverse().find((m) => m.agent)?.agent;
	return status?.agent?.name ?? last?.name ?? "Agent";
}

/**
 * A private thread with the reviewer's own agent: the agent's sparkle and
 * name at its head, the reviewer's messages in their tint and the agent's
 * in the agent tint, rendered as Markdown. While the agent answers it, its
 * text grows in place under a spinner with one collapsed activity line and
 * Stop; while it waits for an agent, a yellow dot (with no agent set up,
 * the row opens the setup). Then the reply box, and Resolve or Unresolve.
 * Resolving closes it to one row, still the agent's (its tint, edge and
 * sparkle, with the resolved check), that opens again; a resolved thread
 * starts closed, and Unresolve opens it. Nothing here reaches GitHub.
 */
export function AgentThreadCard(props: {
	thread: AgentThread;
	status: AgentStatus | undefined;
	/** Its line isn't in this diff: shown in the file's header instead. */
	unplaced?: boolean;
	/** Asked on this earlier head (its commit): marked outdated. */
	outdated?: string;
}) {
	const { thread, status } = props;
	const client = useQueryClient();
	const viewer =
		useQuery({ ...sessionQuery, enabled: false }).data?.viewer ?? "you";
	const name = agentName(thread, status);
	const [resolvedNow, setResolvedNow] = useState<boolean | null>(null);
	const resolved = resolvedNow ?? thread.resolved;

	// Open unless resolved; resolving closes it, unresolving opens it.
	const [expanded, setExpanded] = useState(!thread.resolved);
	const bodyId = useId();
	const shown = { ...thread, resolved };
	const turn = useAnswering(thread, status);
	const state = agentThreadState(shown, turn);
	const answering = state === "answering" ? turn : undefined;
	const resolve = useMutation({
		mutationFn: (next: boolean) => postAgentResolved(thread.id, next),
		onMutate: (next) => {
			setResolvedNow(next);
			setExpanded(!next);
		},
		onSuccess: (saved) => {
			client.setQueryData(agentThreadsQuery.queryKey, (list) =>
				withThread(list, saved),
			);
			// Kept until the thread shown says so too (no flash back).
			setResolvedNow(saved.resolved);
		},
		onError: () => {
			// Not saved: back as it was, open so the error shows.
			setResolvedNow(null);
			setExpanded(true);
		},
	});
	// The thread shown caught up with what was saved: it speaks for itself.
	const settled = !resolve.isPending && thread.resolved === resolvedNow;
	useEffect(() => {
		if (settled) setResolvedNow(null);
	}, [settled]);
	const stop = useMutation({
		mutationFn: postAgentCancel,
		onSettled: () =>
			client.invalidateQueries({ queryKey: agentStatusQuery.queryKey }),
	});
	const writes = useAgentWrites();
	const replies = [...writes.pending.entries()].filter(
		([, w]) => w.thread === thread.id,
	);
	const closed = resolved && !expanded;
	// Span threads too: an accent dot while an answer is unseen, and the
	// same seen mark the thread panel writes, once it has been in view.
	const card = useRef<HTMLElement>(null);
	useSeenWriter(thread, !closed, card);
	const first = thread.messages.find((m) => m.by === "human")?.text ?? "";
	const toggle = (
		<Tooltip content={closed ? "Show thread" : "Hide thread"} describe={false}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					data-testid="agent-thread-toggle"
					aria-label={closed ? "Show thread" : "Hide thread"}
					aria-expanded={!closed}
					aria-controls={closed ? undefined : bodyId}
					onClick={() => setExpanded(closed)}
					className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
				>
					{closed ? (
						<ChevronDownIcon size={16} aria-hidden />
					) : (
						<ChevronUpIcon size={16} aria-hidden />
					)}
				</button>
			)}
		</Tooltip>
	);
	if (closed) {
		// Closed, still the agent's: its tint and edge, the sparkle, the
		// resolved check, the question, and the way back in.
		return (
			<article
				ref={card}
				data-testid="agent-thread"
				data-thread={thread.id}
				data-closed="true"
				aria-label={`Agent thread, ${state}`}
				className="min-w-0 overflow-hidden rounded-lg border border-agent-edge bg-agent"
			>
				<div className="flex min-h-10 min-w-0 items-center gap-x-2 px-2.5 text-xs text-muted">
					<SparkleFillIcon
						size={14}
						aria-hidden
						className="shrink-0 text-agent-ink"
					/>
					<span className="shrink-0 font-semibold text-ink-soft">{name}</span>
					<UnreadDot unread={thread.unread} />
					<LabeledIcon
						icon={CheckCircleIcon}
						label="Resolved"
						className="text-ok"
					/>
					{props.outdated && (
						<span data-testid="agent-outdated" className="flex">
							<LabeledIcon
								icon={HistoryIcon}
								label={`Asked on an earlier version (${props.outdated.slice(0, 7)})`}
								className="text-muted"
							/>
						</span>
					)}
					<span className="min-w-0 truncate text-ink-soft">{first}</span>
					{toggle}
				</div>
			</article>
		);
	}
	return (
		<article
			ref={card}
			data-testid="agent-thread"
			data-thread={thread.id}
			aria-label={`Agent thread, ${state}`}
			className="min-w-0 overflow-hidden rounded-lg border border-agent-edge bg-surface"
		>
			<div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-band px-2.5 py-0.5 text-xs text-muted">
				<SparkleFillIcon
					size={14}
					aria-hidden
					className="shrink-0 text-agent-ink"
				/>
				<span className="font-semibold text-ink-soft">{name}</span>
				<UnreadDot unread={thread.unread} />
				{state === "resolved" && (
					<LabeledIcon
						icon={CheckCircleIcon}
						label="Resolved"
						className="text-ok"
					/>
				)}
				{props.outdated && (
					<span data-testid="agent-outdated" className="flex">
						<LabeledIcon
							icon={HistoryIcon}
							label={`Asked on an earlier version (${props.outdated.slice(0, 7)})`}
							className="text-muted"
						/>
					</span>
				)}
				{props.unplaced && (
					<LabeledIcon
						icon={AlertIcon}
						label="Line not in this diff"
						className="text-warn"
					/>
				)}
				{answering && (
					<button
						type="button"
						data-testid="agent-stop"
						disabled={stop.isPending}
						onClick={() => stop.mutate()}
						className="ml-auto flex h-10 items-center gap-1.5 rounded-md border border-line-strong px-3 text-sm font-medium text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint"
					>
						<SquareFillIcon size={12} aria-hidden />
						Stop
					</button>
				)}
				{resolved && toggle}
			</div>
			<div id={bodyId} className="space-y-2 p-2.5">
				<AgentMessageItems
					thread={shown}
					status={status}
					answering={answering}
					viewer={viewer}
					name={name}
					pending={replies}
				/>
				{resolve.error && (
					<p
						role="alert"
						className="flex items-center gap-1.5 text-sm text-bad"
					>
						<AlertIcon size={14} aria-hidden />
						{resolve.error.message}
					</p>
				)}
				<div className="flex flex-wrap items-end gap-2">
					{!resolved && <AgentReplyBox thread={thread.id} />}
					<button
						type="button"
						data-testid="agent-resolve"
						disabled={resolve.isPending}
						aria-busy={resolve.isPending || undefined}
						onClick={() => resolve.mutate(!resolved)}
						onMouseDown={(e) => e.preventDefault()}
						className={`ml-auto flex h-10 shrink-0 items-center justify-center gap-2 rounded-md border px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 ${
							resolved
								? "border-line-strong text-ink-soft hover:bg-overlay hover:text-ink"
								: "border-ok/60 bg-ok/10 text-ok hover:bg-ok/20"
						}`}
					>
						{resolved ? (
							<IssueReopenedIcon size={16} aria-hidden />
						) : (
							<CheckCircleIcon size={16} aria-hidden />
						)}
						{resolved ? "Unresolve" : "Resolve"}
					</button>
				</div>
			</div>
		</article>
	);
}

/**
 * A conversation's messages as the agent card and the thread agent panel
 * show them: each message (the "new" divider above `divider`, `footer`
 * inside each agent reply), the turn under way (its streamed text, activity and
 * `stop`), the waiting dot, and the replies on their way.
 */
export function AgentMessageItems(props: {
	thread: AgentThread | undefined;
	status: AgentStatus | undefined;
	answering: Answering | undefined;
	viewer: string;
	name: string;
	pending: readonly (readonly [string, AgentWrite])[];
	/** The first unseen message: the "new" divider goes above it. */
	divider?: string;
	/** Inside an agent reply, its last part (the suggestion's button). */
	footer?: (message: AgentMessage) => ReactNode;
	/** In the answering row (the panel's Stop). */
	stop?: ReactNode;
}) {
	const { thread, status, answering, viewer, name } = props;
	const waiting =
		thread !== undefined && agentThreadState(thread, answering) === "waiting";
	return (
		<>
			{thread?.messages.map((m, i) => (
				<Fragment key={m.id}>
					{i === 0 && thread.origin && (
						<OriginChip request={thread.origin.request} />
					)}
					{m.id === props.divider && <NewDivider />}
					{m.by === "human" ? (
						<HumanMessage message={m} viewer={viewer} />
					) : (
						<AiMessage message={m} name={name} footer={props.footer?.(m)} />
					)}
				</Fragment>
			))}
			{answering && (
				<div
					data-testid="agent-answering"
					aria-busy="true"
					className="min-w-0 space-y-1"
				>
					<Who>
						<SparkleFillIcon size={14} aria-hidden className="text-agent-ink" />
						<span className="font-semibold text-ink-soft">{name}</span>
						<Spinner label="Answering" size={12} />
						{props.stop}
					</Who>
					{answering.text && (
						<div className={`${AGENT_SURFACE} text-sm`}>
							<AgentMarkdown text={answering.text} />
						</div>
					)}
					<ActivityLine activity={answering.activity} />
				</div>
			)}
			{waiting &&
				(status && !status.configured && !status.joined ? (
					<button
						type="button"
						data-testid="agent-waiting"
						onClick={openAgentSetup}
						className="flex min-h-10 items-center gap-2 rounded-md px-1 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
					>
						<span
							aria-hidden
							className="h-2 w-2 shrink-0 rounded-full bg-warn"
						/>
						Set up an agent
					</button>
				) : (
					<p
						data-testid="agent-waiting"
						className="flex min-h-10 items-center gap-2 px-1 text-sm text-muted"
					>
						<span
							aria-hidden
							className="h-2 w-2 shrink-0 rounded-full bg-warn"
						/>
						waiting for an agent
					</p>
				))}
			{props.pending.map(([clientId, w]) => (
				<PendingReply
					key={clientId}
					clientId={clientId}
					text={w.text}
					error={w.error?.message}
					viewer={viewer}
				/>
			))}
		</>
	);
}

/** Above the first message the reviewer hadn't seen when the conversation opened. */
function NewDivider() {
	return (
		// An <hr> can't hold its label: a named separator with the word in it.
		// biome-ignore lint/a11y/useSemanticElements: see above.
		<div
			data-testid="agent-new-divider"
			role="separator"
			aria-label="new"
			className="flex items-center gap-2 text-xs font-semibold text-accent"
		>
			<span aria-hidden className="h-px flex-1 bg-accent/60" />
			new
			<span aria-hidden className="h-px flex-1 bg-accent/60" />
		</div>
	);
}

/** A reply on its way (a spinner), or refused (why, Retry, Discard). */
function PendingReply(props: {
	clientId: string;
	text: string;
	error?: string;
	viewer: string;
}) {
	const client = useQueryClient();
	const me = usePerson(props.viewer);
	return (
		<div
			data-testid="agent-reply-pending"
			aria-busy={props.error ? undefined : true}
			className="min-w-0 space-y-1"
		>
			<Who>
				<Avatar login={props.viewer} url="" />
				<span className="font-semibold text-ink-soft">{props.viewer}</span>
				{!props.error && <Spinner label="Sending" size={12} />}
			</Who>
			<p
				className={`${commentSurface(me.tint)} text-sm whitespace-pre-wrap break-words`}
			>
				{props.text}
			</p>
			{props.error && (
				<p
					role="alert"
					className="flex flex-wrap items-center gap-2 text-sm text-bad"
				>
					<AlertIcon size={14} aria-hidden />
					{props.error}
					<button
						type="button"
						onClick={() => retryAgentWrite(client, props.clientId)}
						className="flex h-10 items-center rounded-md px-3 font-medium text-link hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
					>
						Retry
					</button>
					<button
						type="button"
						onClick={() => dropAgentWrite(props.clientId)}
						className="flex h-10 items-center rounded-md px-3 font-medium text-ink-soft hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
					>
						Discard
					</button>
				</p>
			)}
		</div>
	);
}

/** The box for a follow-up question; Ctrl/Cmd+Enter or Ask sends it. */
function AgentReplyBox(props: { thread: string }) {
	const client = useQueryClient();
	const [text, setText] = useState("");
	const box = useRef<HTMLTextAreaElement>(null);
	const id = useId();
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measured as the text changes.
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight + 2}px`;
	}, [text]);
	const tooLong = new TextEncoder().encode(text).length > MAX_AGENT_TEXT;
	const view = useSendView();
	const send = () => {
		if (!text.trim() || tooLong) return;
		replyAgent(client, props.thread, text, newClientId(), view);
		setText("");
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			send();
		}
	};
	return (
		<div className="flex min-w-0 flex-[1_1_14rem] items-end gap-2">
			<textarea
				ref={box}
				id={id}
				aria-label="Reply to your agent"
				placeholder="Reply to your agent…"
				rows={1}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={onKeyDown}
				className="block max-h-96 min-h-10 w-full min-w-0 resize-none rounded-md border border-line-strong bg-raised px-3 py-2 text-sm leading-normal text-ink placeholder:text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent"
			/>
			<button
				type="button"
				data-testid="agent-reply-ask"
				disabled={!text.trim() || tooLong}
				onClick={send}
				onMouseDown={(e) => e.preventDefault()}
				className="flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-accent/60 bg-accent/15 px-4 text-sm font-semibold text-link hover:bg-accent/25 focus-visible:outline-2 focus-visible:outline-accent disabled:border-line disabled:bg-transparent disabled:text-faint"
			>
				<SparkleFillIcon size={16} aria-hidden />
				Ask
			</button>
		</div>
	);
}
