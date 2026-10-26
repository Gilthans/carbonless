import {
	AlertIcon,
	CheckCircleIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	CodeReviewIcon,
	CommentDiscussionIcon,
	CommentIcon,
	EyeIcon,
	GitBranchIcon,
	GitCommitIcon,
	GitMergeIcon,
	GitPullRequestClosedIcon,
	GitPullRequestDraftIcon,
	GitPullRequestIcon,
	type Icon,
	LinkIcon,
	RepoPushIcon,
} from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useMemo, useState } from "react";
import type {
	PrOverview,
	ReviewThread,
	ReviewVerdict,
	ThreadsView,
	TimelineActor,
	TimelineEvent,
	TimelineReviewComment,
	TimelineReviewItem,
} from "../../shared/types";
import { sessionQuery, timelineQuery } from "../api";
import { type FilesSearch, threadTarget } from "../files/landing";
import { RelativeTime } from "../RelativeTime";
import { Tooltip } from "../Tooltip";
import { ErrorMessage, safeHref } from "../ui";
import {
	BotIcon,
	Chip,
	GithubLink,
	headerLine,
	LabeledIcon,
	plural,
	REVIEW_ICON,
	Section,
	SkeletonBar,
} from "./OverviewPage";
import { runResolution } from "./timelineRuns";

/** Events shown before "Show N earlier events": the latest ones. */
export const TIMELINE_LATEST = 30;

const short = (oid: string) => oid.slice(0, 7);

/**
 * The PR's timeline, oldest at the top: a rail with a node per event (runs
 * of commits or of one person's review activity, and history facts), each
 * run opening into its items.
 */
export function Timeline({
	pr,
	threads,
	onShowThread,
}: {
	pr: PrOverview;
	/** The review threads, once their summaries are in. */
	threads: ThreadsView | undefined;
	/** Brings a thread card above into view. */
	onShowThread: (threadId: string) => void;
}) {
	// The previous read's stays on screen until this one's lands (a Refresh).
	const timeline = useQuery({
		...timelineQuery(pr.readId),
		placeholderData: (previous) => previous,
	});
	const [showAll, setShowAll] = useState(false);
	const byId = useMemo(
		() => new Map((threads?.threads ?? []).map((t) => [t.id, t])),
		[threads],
	);
	const events = timeline.data?.events ?? [];
	const hidden = showAll ? 0 : Math.max(0, events.length - TIMELINE_LATEST);
	return (
		<Section label="Timeline">
			{timeline.isPending && <TimelineSkeleton />}
			{timeline.isError && !timeline.data && (
				<ErrorMessage error={timeline.error} />
			)}
			{timeline.data?.gaps.map((gap) => (
				<p
					key={gap}
					data-testid="timeline-gap"
					className="flex items-center gap-1.5 text-sm text-warn"
				>
					<AlertIcon size={14} aria-hidden className="shrink-0" />
					{gap}
				</p>
			))}
			{timeline.data && events.length === 0 && (
				<p className="text-sm text-faint">No activity</p>
			)}
			{hidden > 0 && (
				<div className="flex justify-center">
					<button
						type="button"
						onClick={() => setShowAll(true)}
						className="flex min-h-10 items-center gap-2 rounded-lg border border-line-strong bg-raised px-4 py-2 text-sm font-semibold text-link shadow-control transition-colors hover:border-accent hover:bg-overlay focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
					>
						<ChevronUpIcon size={16} aria-hidden className="shrink-0" />
						{`Show ${plural(hidden, "earlier event")}`}
					</button>
				</div>
			)}
			{events.length > 0 && (
				<ol
					aria-label="Timeline events"
					aria-busy={timeline.isPlaceholderData || undefined}
					// The rail runs through the nodes' centres.
					className="relative before:absolute before:top-5 before:bottom-5 before:left-5 before:w-px before:-translate-x-1/2 before:bg-line-strong"
				>
					{events.slice(hidden).map((event, i) => (
						<TimelineRow
							// Events only grow at the end; the index is stable.
							// biome-ignore lint/suspicious/noArrayIndexKey: see above.
							key={`${hidden + i}:${event.kind}`}
							event={event}
							pr={pr}
							threads={threads ? byId : undefined}
							onShowThread={onShowThread}
						/>
					))}
				</ol>
			)}
		</Section>
	);
}

function TimelineSkeleton() {
	return (
		<ul
			aria-label="Loading the timeline"
			aria-busy="true"
			data-testid="timeline-loading"
			className="space-y-3"
		>
			<li className="sr-only">Loading…</li>
			{["w-1/2", "w-2/3", "w-2/5"].map((w) => (
				<li key={w} aria-hidden className="flex items-center gap-3">
					<div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-overlay motion-reduce:animate-none" />
					<SkeletonBar className={w} />
				</li>
			))}
		</ul>
	);
}

/** Each event kind's node: its icon, name and colour. */
const NODE: Record<
	TimelineEvent["kind"],
	{ icon: Icon; label: string; className: string }
> = {
	commits: { icon: GitCommitIcon, label: "Commits", className: "text-muted" },
	review: {
		icon: CodeReviewIcon,
		label: "Review activity",
		className: "text-muted",
	},
	"force-push": {
		icon: RepoPushIcon,
		label: "Force-push",
		className: "text-warn",
	},
	"base-change": {
		icon: GitBranchIcon,
		label: "Base changed",
		className: "text-warn",
	},
	ready: { icon: EyeIcon, label: "Ready for review", className: "text-ok" },
	draft: {
		icon: GitPullRequestDraftIcon,
		label: "Draft",
		className: "text-muted",
	},
	merged: { icon: GitMergeIcon, label: "Merged", className: "text-done" },
	closed: {
		icon: GitPullRequestClosedIcon,
		label: "Closed",
		className: "text-bad",
	},
	reopened: {
		icon: GitPullRequestIcon,
		label: "Reopened",
		className: "text-ok",
	},
};

function TimelineRow({
	event,
	pr,
	threads,
	onShowThread,
}: {
	event: TimelineEvent;
	pr: PrOverview;
	threads: Map<string, ReviewThread> | undefined;
	onShowThread: (threadId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const listId = useId();
	const node = NODE[event.kind];
	const run = event.kind === "commits" || event.kind === "review";
	const comments =
		event.kind === "review" ? event.items.filter(isComment).length : 0;
	const count =
		event.kind === "commits"
			? plural(event.items.length, "commit")
			: event.kind === "review"
				? comments > 0
					? plural(comments, "comment")
					: ""
				: "";
	const expandable =
		event.kind === "commits" || (event.kind === "review" && comments > 0);
	return (
		<li data-testid="timeline-event" className="relative flex gap-3 py-1.5">
			<span
				className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line-strong bg-raised ${node.className}`}
			>
				<LabeledIcon icon={node.icon} label={node.label} />
			</span>
			<div className="min-w-0 flex-1">
				{/* The summary wraps; the toggle stays at the right of its first line. */}
				<div className="flex items-start gap-2">
					<div className="flex min-h-10 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
						<Actor actor={event.actor} />
						{run ? (
							<>
								{count && <span className="text-ink-soft">{count}</span>}
								{event.kind === "review" && (
									<Verdicts items={event.items} bare={comments === 0} />
								)}
								{event.kind === "review" && threads && (
									<ResolvedChip
										items={event.items}
										threads={threads}
										asOf={Boolean(pr.asOf)}
									/>
								)}
								<When from={event.from} to={event.to} />
							</>
						) : (
							<>
								<Fact event={event} />
								<When from={event.at} to={event.at} />
							</>
						)}
					</div>
					{expandable && (
						<button
							type="button"
							aria-expanded={open}
							aria-controls={listId}
							aria-label={`Show ${event.kind === "commits" ? count : plural(comments, "comment")}`}
							onClick={() => setOpen((o) => !o)}
							className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-link hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
						>
							<ChevronDownIcon
								size={16}
								aria-hidden
								className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
							/>
						</button>
					)}
				</div>
				{expandable && open && (
					<ul
						id={listId}
						aria-label={event.kind === "commits" ? "Commits" : "Comments"}
						className="mt-1 space-y-1 border-l-2 border-line pl-2"
					>
						{event.kind === "commits"
							? event.items.map((c, i) => (
									<li
										// The index keeps keys apart should the host list a commit twice.
										// biome-ignore lint/suspicious/noArrayIndexKey: see above.
										key={`${c.oid}:${i}`}
										data-testid="timeline-item"
										className="flex flex-wrap items-center gap-x-2 text-sm"
									>
										<CommitLink oid={c.oid} url={c.url} pr={pr} />
										<span className="min-w-0 break-words">{c.headline}</span>
										<RelativeTime iso={c.at} className="text-xs text-muted" />
									</li>
								))
							: event.kind === "review" &&
								event.items.map((item, i) => (
									<ReviewItem
										// Items of a run never reorder.
										// biome-ignore lint/suspicious/noArrayIndexKey: see above.
										key={i}
										item={item}
										threads={threads}
										onShowThread={onShowThread}
									/>
								))}
					</ul>
				)}
			</div>
		</li>
	);
}

/** A review run's items that count as comments: all but a bare verdict. */
function isComment(item: TimelineReviewItem): boolean {
	return item.kind !== "review" || item.text !== "";
}

function Actor({ actor }: { actor: TimelineActor }) {
	const [broken, setBroken] = useState(false);
	const src = safeHref(actor.avatarUrl);
	return (
		<span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-ink">
			{src && !broken && (
				<img
					src={src}
					alt=""
					width={20}
					height={20}
					loading="lazy"
					referrerPolicy="no-referrer"
					onError={() => setBroken(true)}
					className="h-5 w-5 shrink-0 rounded-full bg-overlay"
				/>
			)}
			<span className="break-all">{actor.login}</span>
			{actor.bot && <BotIcon />}
		</span>
	);
}

/** "from X to Y", or one date when they are the same. */
function When({ from, to }: { from: string; to: string }) {
	if (!from && !to) return null;
	if (!to || from === to || !from) {
		return <RelativeTime iso={from || to} className="text-xs text-muted" />;
	}
	return (
		<span className="text-xs text-muted">
			from <RelativeTime iso={from} /> to <RelativeTime iso={to} />
		</span>
	);
}

/** The run's verdicts (approved, changes requested, dismissed), each once. */
function Verdicts({
	items,
	bare,
}: {
	items: TimelineReviewItem[];
	/** No comments: the verdict is all there is, so it's named in text too. */
	bare: boolean;
}) {
	const states: ReviewVerdict[] = [];
	for (const item of items) {
		if (item.kind === "review" && !states.includes(item.state)) {
			if (item.state !== "COMMENTED" || bare) states.push(item.state);
		}
	}
	return (
		<>
			{states.map((state) => {
				const v = REVIEW_ICON[state];
				return bare ? (
					<span
						key={state}
						className={`inline-flex items-center gap-1 ${v.className}`}
					>
						<v.icon size={16} aria-hidden />
						{v.label}
					</span>
				) : (
					<LabeledIcon
						key={state}
						icon={v.icon}
						label={v.label}
						className={v.className}
					/>
				);
			})}
		</>
	);
}

/** "R of N resolved": the threads the run's review comments are in. */
function ResolvedChip({
	items,
	threads,
	asOf,
}: {
	items: TimelineReviewItem[];
	threads: Map<string, ReviewThread>;
	asOf: boolean;
}) {
	const { resolved, total } = runResolution(items, threads);
	if (total === 0) return null;
	// As of a cutoff, whether a thread was resolved then isn't known.
	if (asOf) {
		return (
			<Chip
				tone="gray"
				icon={CommentDiscussionIcon}
				testId="timeline-resolved"
				tip="Resolution isn't known as of the cutoff"
			>
				{plural(total, "thread")}
			</Chip>
		);
	}
	return (
		<Chip
			tone={resolved === total ? "green" : "yellow"}
			icon={resolved === total ? CheckIcon : CommentDiscussionIcon}
			testId="timeline-resolved"
			tip={`${resolved} of the ${plural(total, "thread")} these comments are in ${resolved === 1 ? "is" : "are"} resolved now`}
		>
			{`${resolved} of ${total} resolved`}
		</Chip>
	);
}

function Fact({
	event,
}: {
	event: Exclude<TimelineEvent, { kind: "commits" | "review" }>;
}) {
	const code = (text: string) => (
		<code className="rounded bg-overlay px-1 font-mono text-xs break-all text-ink-soft">
			{text}
		</code>
	);
	const text = (t: string, rest?: ReactNode) => (
		<span className="inline-flex flex-wrap items-center gap-1 text-ink-soft">
			{t}
			{rest}
		</span>
	);
	switch (event.kind) {
		case "force-push":
			return text(
				"force-pushed",
				<>
					{code(short(event.before) || "?")}
					<span aria-hidden>→</span>
					<span className="sr-only">to</span>
					{code(short(event.after) || "?")}
				</>,
			);
		case "base-change":
			return text(
				"changed the base",
				<>
					{code(event.before || "?")}
					<span aria-hidden>→</span>
					<span className="sr-only">to</span>
					{code(event.after || "?")}
				</>,
			);
		case "ready":
			return text("marked ready for review");
		case "draft":
			return text("converted to draft");
		case "closed":
			return text("closed");
		case "reopened":
			return text("reopened");
		case "merged":
			return text("merged", event.commit ? code(short(event.commit)) : null);
	}
}

/** A commit's short sha: its page in the PR on GitHub. */
function CommitLink({
	oid,
	url,
	pr,
}: {
	oid: string;
	url: string;
	pr: PrOverview;
}) {
	const href = safeHref(url) ?? safeHref(oid ? `${pr.url}/commits/${oid}` : "");
	const label = <code className="font-mono text-xs">{short(oid) || "?"}</code>;
	if (!href) return label;
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			className="inline-flex min-h-10 items-center text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
		>
			{label}
		</a>
	);
}

function ReviewItem({
	item,
	threads,
	onShowThread,
}: {
	item: TimelineReviewItem;
	threads: Map<string, ReviewThread> | undefined;
	onShowThread: (threadId: string) => void;
}) {
	if (item.kind === "comment") {
		return (
			<CommentItem item={item} threads={threads} onShowThread={onShowThread} />
		);
	}
	const icon =
		item.kind === "review"
			? REVIEW_ICON[item.state]
			: { icon: CommentIcon, label: "Commented", className: "text-muted" };
	return (
		<li
			data-testid="timeline-item"
			className="flex flex-wrap items-center gap-x-2 text-sm"
		>
			<LabeledIcon
				icon={icon.icon}
				label={icon.label}
				className={icon.className}
			/>
			<span className="min-w-0 break-words">{item.text || icon.label}</span>
			<RelativeTime iso={item.at} className="text-xs text-muted" />
			<GithubLink url={item.url} />
		</li>
	);
}

function CommentItem({
	item,
	threads,
	onShowThread,
}: {
	item: TimelineReviewComment;
	threads: Map<string, ReviewThread> | undefined;
	onShowThread: (threadId: string) => void;
}) {
	const session = useQuery(sessionQuery);
	const thread = item.threadId ? threads?.get(item.threadId) : undefined;
	const target: FilesSearch = thread
		? threadTarget(thread, session.data, headerLine(thread))
		: { path: item.path };
	const line = thread ? headerLine(thread) : item.line;
	const state = !thread
		? null
		: session.data?.asOf
			? {
					// Whether it was resolved then isn't known.
					icon: CommentDiscussionIcon,
					label: "Thread; resolution isn't known as of the cutoff",
					className: "text-muted",
				}
			: thread.resolved
				? { icon: CheckCircleIcon, label: "Resolved", className: "text-ok" }
				: {
						icon: CommentDiscussionIcon,
						label: "Unresolved",
						className: "text-warn",
					};
	return (
		<li
			data-testid="timeline-item"
			className="flex flex-wrap items-center gap-x-2 text-sm"
		>
			{state ? (
				<LabeledIcon
					icon={state.icon}
					label={state.label}
					className={state.className}
				/>
			) : (
				<LabeledIcon
					icon={CommentIcon}
					label="Comment"
					className="text-muted"
				/>
			)}
			{item.path && (
				<Link
					to="/files"
					search={target}
					data-testid="timeline-place"
					className="inline-flex min-h-10 max-w-full items-center rounded-sm font-mono text-xs break-all text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
				>
					<code>
						{item.path}
						{line !== null && `:${line}`}
					</code>
				</Link>
			)}
			<span className="min-w-0 break-words">{item.text}</span>
			<RelativeTime iso={item.at} className="text-xs text-muted" />
			{thread && (
				<Tooltip content="Go to the thread" describe={false}>
					{(trigger) => (
						<a
							{...trigger}
							href={`#thread-${thread.id}`}
							aria-label="Go to the thread"
							onClick={(e) => {
								e.preventDefault();
								onShowThread(thread.id);
							}}
							className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-link hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
						>
							<LinkIcon size={16} aria-hidden />
						</a>
					)}
				</Tooltip>
			)}
		</li>
	);
}
