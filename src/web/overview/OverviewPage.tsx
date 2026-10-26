import {
	AlertIcon,
	CheckCircleIcon,
	CheckIcon,
	ChevronDownIcon,
	ClockIcon,
	CodeReviewIcon,
	CommentDiscussionIcon,
	CommentIcon,
	DotFillIcon,
	EyeIcon,
	FileDiffIcon,
	GitMergeIcon,
	GitPullRequestClosedIcon,
	GitPullRequestDraftIcon,
	HistoryIcon,
	HubotIcon,
	type Icon,
	LightBulbIcon,
	PeopleIcon,
	QuestionIcon,
	ReplyIcon,
	XIcon,
} from "@primer/octicons-react";
import {
	type UseQueryResult,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	type ReactNode,
	type Ref,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type HunkLine, numberOn } from "../../shared/diffHunk";
import {
	type CodeRow,
	type CodeWindow,
	type PrOverview,
	type Progress,
	type ReviewThread,
	THREAD_PAGE,
	type ThreadsView,
} from "../../shared/types";
import {
	OVERVIEW_FRESH_MS,
	overviewAge,
	overviewQuery,
	revalidateOverviewQuery,
	reviewQuery,
	sessionQuery,
	THREAD_STAGES,
	threadsQuery,
} from "../api";
import { CodeLine } from "../code/Invisibles";
import { languageFor } from "../files/highlight";
import { type FilesSearch, threadTarget } from "../files/landing";
import { GithubHtml, ImageErrorContext } from "../GithubHtml";
import { RelativeTime, relativeTime, useNow } from "../RelativeTime";
import { Tooltip } from "../Tooltip";
import { ErrorMessage, safeHref } from "../ui";
import { createImageRefresher } from "./imageRefresh";
import {
	Badge,
	BotIcon,
	Chip,
	GithubLink,
	headerLine,
	LabeledIcon,
	plural,
	REVIEW_ICON,
	Section,
	SkeletonBar,
} from "./parts";
import { splitSuggestions } from "./suggestions";
import { Timeline } from "./Timeline";
import { threadKeys } from "./threadKeys";

type Review = PrOverview["reviews"][number];
type Check = PrOverview["checks"][number];
type Thread = ReviewThread;

/** A thread to bring into view; `seq` is new for each request. */
interface ThreadFocus {
	id: string;
	seq: number;
}

/** A thread card's element id. */
const threadAnchor = (id: string) => `thread-${id}`;

/** How old the overview's HTML may be before a broken image reads it again. */
const IMAGE_MAX_AGE_MS = 60_000;

/**
 * A read's review threads, as far as they have come: every stage is asked
 * for at once and the furthest in is shown (OverviewRead on the server).
 */
function useThreads(readId: string | undefined): {
	view: ThreadsView | undefined;
	/** A stage failed and the threads aren't all in. */
	error: Error | null;
	/**
	 * `view` is the previous read's, kept on screen (and in place) until the
	 * new read's summaries land, as after a Refresh.
	 */
	previous: boolean;
} {
	const stages = useQueries({
		queries: THREAD_STAGES.map((stage) => ({
			...threadsQuery(readId ?? "", stage),
			enabled: Boolean(readId),
		})),
	});
	const view = stages.findLast((q) => q.data)?.data;
	const failed = stages.find((q) => q.isError);
	const error = view?.complete ? null : (failed?.error ?? null);
	const last = useRef<{ readId: string; view: ThreadsView } | null>(null);
	if (view && readId) last.current = { readId, view };
	const kept =
		!view && !error && last.current && last.current.readId !== readId
			? last.current.view
			: undefined;
	return { view: view ?? kept, error, previous: Boolean(kept) };
}

export function OverviewPage() {
	const overview = useQuery(overviewQuery);
	const queryClient = useQueryClient();
	const data = overview.data;
	const fetchedAt = data?.fetchedAt ?? "";
	// The server keeps its last read: an old one shows at once and is read
	// again meanwhile (the header's Refresh spins). Not as of a cutoff,
	// where nothing changes. The age is by the server's clock.
	const stale = !!data && !data.asOf && overviewAge(data) > OVERVIEW_FRESH_MS;
	const revalidate = useQuery({
		...revalidateOverviewQuery(fetchedAt, OVERVIEW_FRESH_MS),
		enabled: stale,
	});
	const threads = useThreads(data?.readId);
	const latest = useRef(fetchedAt);
	latest.current = fetchedAt;
	const [refreshImages] = useState(() =>
		createImageRefresher({
			refetch: () =>
				void queryClient
					.fetchQuery(revalidateOverviewQuery(latest.current, IMAGE_MAX_AGE_MS))
					.catch(() => {}),
		}),
	);
	// When it was read, on this browser's clock: received, less its age then.
	const readAt = data ? overview.dataUpdatedAt - overviewAge(data) : 0;
	const onImageError = useCallback(
		() => refreshImages(readAt),
		[refreshImages, readAt],
	);
	return (
		<ImageErrorContext value={onImageError}>
			<OverviewContent
				overview={overview}
				threads={threads}
				updateError={revalidate.isError ? revalidate.error : null}
			/>
		</ImageErrorContext>
	);
}

function OverviewContent({
	overview,
	threads,
	updateError,
}: {
	overview: UseQueryResult<PrOverview>;
	threads: ReturnType<typeof useThreads>;
	/** The overview shown couldn't be brought up to date. */
	updateError: Error | null;
}) {
	// A thread to bring into view (the timeline's "Go to the thread").
	const [focus, setFocus] = useState<ThreadFocus | null>(null);
	const showThread = useCallback(
		(id: string) => setFocus((f) => ({ id, seq: (f?.seq ?? 0) + 1 })),
		[],
	);
	return (
		<div className="space-y-6">
			{overview.isPending && <OverviewSkeleton />}
			{overview.isError && <ErrorMessage error={overview.error} />}
			{updateError && <ErrorMessage error={updateError} />}
			{overview.data && (
				<>
					<WhatItDoes pr={overview.data} threads={threads.view} />
					<WhosOnIt pr={overview.data} />
					<IsItReady
						pr={overview.data}
						threads={threads.view}
						error={threads.error}
						previous={threads.previous}
						focus={focus}
					/>
					<Timeline
						pr={overview.data}
						threads={threads.view}
						onShowThread={showThread}
					/>
				</>
			)}
			<ReviewFilesButton />
		</div>
	);
}

/** The sections' frames while GitHub is read: grey bars where text will be. */
function OverviewSkeleton() {
	const bar = (width: string) => (
		<div
			className={`h-3 animate-pulse rounded bg-overlay motion-reduce:animate-none ${width}`}
		/>
	);
	return (
		<div data-testid="overview-loading" aria-busy="true" className="space-y-6">
			<p className="sr-only">Loading the PR from GitHub…</p>
			{/* Section's frame, not its region: nothing to read in it yet. */}
			{["What it does", "Who's on it", "Is it ready", "Timeline"].map(
				(label) => (
					<div
						key={label}
						aria-hidden
						className="rounded-xl border border-line bg-surface"
					>
						<div className="rounded-t-xl border-b border-line bg-raised px-4 py-3 text-center text-[0.8125rem] font-semibold tracking-[0.2em] text-label uppercase">
							{label}
						</div>
						<div className="space-y-2.5 px-4 py-4">
							{bar("w-2/3")}
							{bar("w-full")}
							{bar("w-5/6")}
						</div>
					</div>
				),
			)}
		</div>
	);
}

function ExternalLink(props: {
	href: string | undefined;
	children: ReactNode;
}) {
	const href = safeHref(props.href);
	if (!href) return <>{props.children}</>;
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			className="text-link hover:underline"
		>
			{props.children}
		</a>
	);
}

function ReviewFilesButton() {
	const review = useQuery(reviewQuery);
	return (
		<div className="flex flex-col items-center gap-3">
			<Link
				to="/files"
				className="cta inline-flex min-h-10 items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-ink transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
			>
				Review files
				{review.data && (
					<span className="rounded-full bg-canvas/35 px-2 text-xs tabular-nums">
						{progressText(review.data.progress)}
					</span>
				)}
			</Link>
			{review.isPending && (
				<span className="text-sm text-muted">Loading progress…</span>
			)}
			{review.isError && <ErrorMessage error={review.error} />}
		</div>
	);
}

/** Cluster progress: reviewed of all that aren't crossed off. */
function progressText(progress: Progress): string {
	const { total, reviewed, crossedOff } = progress.clusters;
	const denominator = total - crossedOff;
	const percent =
		denominator === 0 ? 100 : Math.floor((reviewed / denominator) * 100);
	return `${reviewed} / ${denominator} clusters · ${percent}%`;
}

// ---- What it does ----

const STATE_BADGE = {
	MERGED: { tone: "purple", icon: GitMergeIcon, label: "Merged" },
	CLOSED: { tone: "red", icon: GitPullRequestClosedIcon, label: "Closed" },
} as const;

function WhatItDoes({
	pr,
	threads,
}: {
	pr: PrOverview;
	threads: ThreadsView | undefined;
}) {
	const stateBadge = pr.state === "OPEN" ? undefined : STATE_BADGE[pr.state];
	const updatedAt = lastUpdate(pr, threads);
	return (
		<Section label="What it does">
			<div>
				<div className="flex items-start gap-2">
					<h3 className="min-w-0 flex-1 font-display text-lg font-semibold break-words">
						{pr.title}
					</h3>
					<GithubLink url={pr.url} />
				</div>
				<p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
					{pr.isDraft && (
						<Badge tone="gray" icon={GitPullRequestDraftIcon}>
							Draft
						</Badge>
					)}
					{stateBadge && (
						<Badge tone={stateBadge.tone} icon={stateBadge.icon}>
							{stateBadge.label}
						</Badge>
					)}
					<span className="font-medium text-ink">{pr.author}</span>
					<Tooltip
						content={`Merge ${pr.headBranch} into ${pr.baseBranch}`}
						describe={false}
					>
						{(trigger) => (
							<code
								{...trigger}
								// Focusable so keyboard and touch users can read the tooltip.
								// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
								tabIndex={0}
								className="rounded bg-overlay px-1 text-ink-soft [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-accent"
							>
								{pr.baseBranch} ← {pr.headBranch}
							</code>
						)}
					</Tooltip>
					<span>
						opened <RelativeTime iso={pr.createdAt} />
					</span>
					{updatedAt && updatedAt !== pr.createdAt && (
						<span>
							updated <RelativeTime iso={updatedAt} />
						</span>
					)}
				</p>
			</div>
			<Description pr={pr} />
		</Section>
	);
}

/**
 * When the PR was last updated: GitHub's time, or as of a cutoff the last
 * activity seen by then, the review threads' too once they are in.
 */
function lastUpdate(pr: PrOverview, threads: ThreadsView | undefined): string {
	if (!pr.asOf) return pr.updatedAt;
	return (threads?.threads ?? []).reduce(
		(latest, t) =>
			Date.parse(t.lastActivityAt) > Date.parse(latest)
				? t.lastActivityAt
				: latest,
		pr.updatedAt,
	);
}

/** As GitHub shows it; the markdown source only if GitHub sent no HTML. */
function Description({ pr }: { pr: PrOverview }) {
	if (pr.bodyHtml.trim()) {
		return <GithubHtml html={pr.bodyHtml} className="text-sm" />;
	}
	if (pr.body.trim()) {
		return <p className="text-sm break-words whitespace-pre-wrap">{pr.body}</p>;
	}
	return <p className="text-sm text-muted italic">No description</p>;
}

// ---- Who's on it ----

/** Approval or change request first: a later plain comment doesn't hide it. */
function ReviewState({ review }: { review: Review }) {
	const shown = REVIEW_ICON[review.opinion ?? review.state];
	const then =
		review.opinion && review.state !== review.opinion
			? REVIEW_ICON[review.state]
			: undefined;
	return (
		<>
			<LabeledIcon
				icon={shown.icon}
				label={shown.label}
				className={shown.className}
			/>
			{then && (
				// Secondary: smaller and muted, after a short "then".
				<span className="inline-flex items-center gap-0.5 text-xs text-faint">
					<span aria-hidden>then</span>
					<LabeledIcon
						icon={then.icon}
						size={12}
						label={`then ${then.label.toLowerCase()}`}
					/>
				</span>
			)}
		</>
	);
}

function startedNames(pr: PrOverview): string[] {
	const isOther = (name: string, bot: boolean, you: boolean) =>
		!bot && !you && name.toLowerCase() !== pr.author.toLowerCase();
	const names = [
		...pr.reviews.filter((r) => isOther(r.author, r.bot, r.you)),
		...pr.commenters.filter((c) => isOther(c.author, c.bot, c.you)),
	].map((x) => x.author);
	return [...new Set(names)];
}

function Column(props: { icon: Icon; title: string; children: ReactNode }) {
	const IconEl = props.icon;
	return (
		<div>
			<h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink-soft">
				<IconEl size={16} aria-hidden className="text-muted" />
				{props.title}
			</h3>
			{props.children}
		</div>
	);
}

function None() {
	return <p className="mt-1 text-sm text-faint">None</p>;
}

function WhosOnIt({ pr }: { pr: PrOverview }) {
	const names = startedNames(pr);
	const yourReview = pr.reviews.find((r) => r.you);
	const youCommented = pr.commenters.some((c) => c.you);
	const reviewers = pr.reviews.filter((r) => !r.you);
	const reviewed = new Set(reviewers.map((r) => r.author.toLowerCase()));
	const waiting = pr.requestedReviewers.filter(
		(r) => r.team || !reviewed.has(r.name.toLowerCase()),
	);
	const commenters = pr.commenters.filter(
		(c) => !c.you && !reviewed.has(c.author.toLowerCase()),
	);

	return (
		<Section label="Who's on it">
			<p className="flex items-center gap-2 font-medium">
				{pr.humanStarted ? (
					<>
						<EyeIcon size={16} aria-hidden className="text-warn" />
						{`${names.length ? names.join(", ") : "Someone else"} already started`}
					</>
				) : (
					<>
						<CheckCircleIcon size={16} aria-hidden className="text-ok" />
						No one else has started reviewing
					</>
				)}
			</p>
			<div className="grid gap-4 sm:grid-cols-3">
				<Column icon={CodeReviewIcon} title="Reviews">
					{reviewers.length ? (
						<ul aria-label="Reviews" className="mt-1 space-y-1 text-sm">
							{reviewers.map((r) => (
								<li
									key={r.author}
									className="flex flex-wrap items-center gap-2"
								>
									<span>{r.author}</span>
									{r.bot && <BotIcon />}
									<ReviewState review={r} />
									<RelativeTime
										iso={r.submittedAt}
										className="text-xs text-muted"
									/>
								</li>
							))}
						</ul>
					) : (
						<None />
					)}
				</Column>
				<Column icon={ClockIcon} title="Requested">
					{waiting.length ? (
						<ul
							aria-label="Requested reviewers"
							className="mt-1 space-y-1 text-sm"
						>
							{waiting.map((r) => (
								<li key={r.name} className="flex items-center gap-2">
									{r.name}
									{r.team && (
										<LabeledIcon
											icon={PeopleIcon}
											label="team"
											className="text-muted"
										/>
									)}
								</li>
							))}
						</ul>
					) : (
						<None />
					)}
				</Column>
				<Column icon={CommentIcon} title="Commented">
					{commenters.length ? (
						<ul aria-label="Commenters" className="mt-1 space-y-1 text-sm">
							{commenters.map((c) => (
								<li
									key={c.author}
									className="flex flex-wrap items-center gap-2"
								>
									<span>{c.author}</span>
									{c.bot && <BotIcon />}
									<RelativeTime iso={c.lastAt} className="text-xs text-muted" />
								</li>
							))}
						</ul>
					) : (
						<None />
					)}
				</Column>
			</div>
			<p className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
				<span className="font-semibold">You</span>
				{yourReview ? (
					<>
						<ReviewState review={yourReview} />
						<RelativeTime
							iso={yourReview.submittedAt}
							className="text-xs text-muted"
						/>
					</>
				) : youCommented ? (
					<LabeledIcon
						icon={CommentIcon}
						label="Commented"
						className="text-muted"
					/>
				) : (
					<span className="text-muted">not started on GitHub</span>
				)}
			</p>
		</Section>
	);
}

// ---- Is it ready ----

function IsItReady({
	pr,
	threads,
	error,
	previous,
	focus,
}: {
	pr: PrOverview;
	/** Undefined until every thread's summary is in. */
	threads: ThreadsView | undefined;
	/** The threads couldn't all be read. */
	error: Error | null;
	/** `threads` are the previous read's, until this one's land. */
	previous: boolean;
	focus: ThreadFocus | null;
}) {
	const list = threads?.threads;
	const unreadable =
		list?.filter((t) => t.unavailable === "unreadable").length ?? 0;
	// Failed with nothing to show: the error alone, no frames left busy.
	const failed = Boolean(error) && !list;
	return (
		<Section label="Is it ready">
			<Checks pr={pr} />
			{error && <ErrorMessage error={error} />}
			{unreadable > 0 && (
				<ErrorMessage
					error={
						new Error(
							`${plural(unreadable, "thread")} couldn't be read from GitHub`,
						)
					}
				/>
			)}
			<ThreadGroup
				label="Human reviews"
				icon={CommentDiscussionIcon}
				threads={list?.filter((t) => !t.bot)}
				failed={failed}
				previous={previous}
				asOf={Boolean(pr.asOf)}
				focus={focus}
			/>
			<ThreadGroup
				label="Bot reviews"
				icon={HubotIcon}
				threads={list?.filter((t) => t.bot)}
				failed={failed}
				previous={previous}
				asOf={Boolean(pr.asOf)}
				focus={focus}
			/>
		</Section>
	);
}

/**
 * One row of chips: draft, conflicts and a CI summary. A CI chip opens the
 * list of checks, failing first.
 */
function Checks({ pr }: { pr: PrOverview }) {
	const [open, setOpen] = useState(false);
	const listId = useId();
	const headingId = useId();
	const { checks } = pr;
	const count = (status: Check["status"]) =>
		checks.filter((c) => c.status === status).length;
	const failing = count("failing");
	const pending = count("pending");
	const passing = count("passing");
	const toggle = {
		expanded: open,
		controls: listId,
		onClick: () => setOpen((o) => !o),
	};
	const tip = open ? "Hide checks" : "Show checks";
	const ci: ReactNode[] = [];
	if (checks.length === 0) {
		ci.push(
			<Chip
				key="none"
				tone="gray"
				icon={DotFillIcon}
				tip="No CI checks reported"
			>
				No checks
			</Chip>,
		);
	} else if (passing === checks.length) {
		ci.push(
			<Chip key="all" tone="green" icon={CheckIcon} tip={tip} toggle={toggle}>
				{passing}/{checks.length} passing
			</Chip>,
		);
	} else {
		if (failing) {
			ci.push(
				<Chip key="failing" tone="red" icon={XIcon} tip={tip} toggle={toggle}>
					{failing} failing
				</Chip>,
			);
		}
		if (pending) {
			ci.push(
				<Chip
					key="pending"
					tone="yellow"
					icon={DotFillIcon}
					tip={tip}
					toggle={toggle}
				>
					{pending} pending
				</Chip>,
			);
		}
		if (passing) {
			ci.push(
				<Chip
					key="passing"
					tone="green"
					icon={CheckIcon}
					tip={tip}
					toggle={toggle}
				>
					{passing} passing
				</Chip>,
			);
		}
	}
	return (
		<div>
			<div className="flex flex-wrap items-center gap-x-2">
				<h3 id={headingId} className="mr-1 text-sm font-semibold text-ink-soft">
					Checks
				</h3>
				<ul
					aria-label="Readiness"
					className="flex min-w-0 flex-wrap items-center gap-x-2"
				>
					{pr.isDraft && (
						<li>
							<Chip
								tone="yellow"
								icon={GitPullRequestDraftIcon}
								tip="Still a draft on GitHub"
							>
								Draft
							</Chip>
						</li>
					)}
					<li>
						<ConflictsChip pr={pr} />
					</li>
					{ci.map((chip, i) => (
						// Fixed order: failing, pending, passing.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above.
						<li key={i}>{chip}</li>
					))}
				</ul>
			</div>
			{open && checks.length > 0 && (
				<ul
					id={listId}
					aria-labelledby={headingId}
					className="mt-1 space-y-1 text-sm"
				>
					{checks.map((c) => (
						<CheckItem key={`${c.status}:${c.name}`} check={c} />
					))}
				</ul>
			)}
		</div>
	);
}

function ConflictsChip({ pr }: { pr: PrOverview }) {
	if (pr.mergeable === "CONFLICTING") {
		return (
			<Chip tone="red" icon={XIcon} tip={`Conflicts with ${pr.baseBranch}`}>
				Conflicts
			</Chip>
		);
	}
	if (pr.mergeable === "MERGEABLE") {
		return (
			<Chip
				tone="green"
				icon={CheckIcon}
				tip={`Merges cleanly into ${pr.baseBranch}`}
			>
				No conflicts
			</Chip>
		);
	}
	return (
		<Chip
			tone="gray"
			icon={QuestionIcon}
			tip={
				pr.asOf
					? "Unknown as of then"
					: "GitHub hasn't worked out whether it merges cleanly"
			}
		>
			Conflicts unknown
		</Chip>
	);
}

const CHECK_ICON = {
	failing: { icon: XIcon, className: "text-bad" },
	pending: { icon: DotFillIcon, className: "text-warn" },
	passing: { icon: CheckIcon, className: "text-ok" },
} as const;

function CheckItem({ check }: { check: Check }) {
	const icon = CHECK_ICON[check.status];
	return (
		<li data-testid="check" className="flex items-center gap-2">
			<LabeledIcon
				icon={icon.icon}
				label={check.status}
				className={icon.className}
			/>
			<span className="min-w-0 break-words">
				<ExternalLink href={check.url}>{check.name}</ExternalLink>
			</span>
		</li>
	);
}

// ---- Human and bot reviews ----

/**
 * "Load X more comments out of Y": Y threads not listed yet, X the next
 * page of them. Each item is a thread; the owner asked for "comments".
 */
export function loadMoreText(hidden: number): string {
	const next = Math.min(hidden, THREAD_PAGE);
	return `Load ${plural(next, "more comment")} out of ${hidden}`;
}

/**
 * One group's review threads, inside "Is it ready": unresolved ones listed,
 * or resolved ones while their count is pressed; five at a time. As of a
 * cutoff no thread is known to be resolved.
 */
function ThreadGroup(props: {
	label: string;
	icon: Icon;
	/** Undefined while the threads are read: the list's frame shows. */
	threads: Thread[] | undefined;
	/** They couldn't be read: no frame (the error says so). */
	failed: boolean;
	/** They are the previous read's, until this one's land. */
	previous: boolean;
	asOf: boolean;
	/** A thread to bring into view, if it is in this group. */
	focus: ThreadFocus | null;
}) {
	const { asOf, focus } = props;
	const loading = props.threads === undefined && !props.failed;
	const threads = props.threads ?? [];
	const [showResolved, setShowResolved] = useState(false);
	const [limit, setLimit] = useState(THREAD_PAGE);
	const listId = useId();
	const headingId = useId();
	const unresolved = threads.filter((t) => !t.resolved);
	const resolved = threads.filter((t) => t.resolved);
	const listed = showResolved ? resolved : unresolved;
	// Pressing never leads to an empty list (as of a cutoff, none is resolved);
	// pressed, it can always go back.
	const toggleOff = !showResolved && resolved.length === 0;
	const IconEl = props.icon;
	// Bringing a thread into view: its list, enough of it, then the card.
	const [reveal, setReveal] = useState<ThreadFocus | null>(null);
	const handled = useRef<ThreadFocus | null>(null);
	useEffect(() => {
		if (!focus || handled.current === focus) return;
		const thread = threads.find((t) => t.id === focus.id);
		if (!thread) return;
		handled.current = focus;
		const list = threads.filter((t) => t.resolved === thread.resolved);
		const index = list.indexOf(thread);
		setShowResolved(thread.resolved);
		setLimit((n) =>
			Math.max(n, Math.ceil((index + 1) / THREAD_PAGE) * THREAD_PAGE),
		);
		setReveal(focus);
	}, [focus, threads]);
	useEffect(() => {
		if (!reveal) return;
		setReveal(null);
		const card = document.getElementById(threadAnchor(reveal.id));
		if (!card) return;
		const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)")
			.matches;
		card.scrollIntoView?.({
			block: "center",
			behavior: smooth ? "smooth" : "auto",
		});
		card.focus({ preventScroll: true });
	}, [reveal]);
	return (
		<section aria-labelledby={headingId} className="space-y-3">
			{/* A band across the section, quieter than the section's own title. */}
			<div
				data-testid="thread-group-band"
				className="-mx-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-line bg-band px-4 py-1"
			>
				<h3
					id={headingId}
					className="flex min-h-10 items-center gap-2 text-base font-semibold text-ink"
				>
					<IconEl size={18} aria-hidden className="text-label" />
					{props.label}
				</h3>
				{loading ? (
					<SkeletonBar className="w-32" />
				) : props.threads === undefined ? null : threads.length === 0 ? (
					<p className="text-sm text-faint">No threads</p>
				) : (
					<ul
						aria-label="Thread counts"
						className="flex flex-wrap items-center gap-x-2"
					>
						{unresolved.length > 0 && (
							<li className="inline-flex min-h-10 items-center">
								<Badge tone="yellow" icon={CommentDiscussionIcon}>
									{unresolved.length} unresolved
								</Badge>
							</li>
						)}
						<li>
							<Chip
								tone={resolved.length ? "green" : "gray"}
								icon={CheckIcon}
								tip={
									asOf
										? "Resolution history isn't known for a past moment: every thread counts as unresolved"
										: toggleOff
											? "No resolved threads"
											: showResolved
												? "Show unresolved threads"
												: "Show resolved threads"
								}
								describeTip={asOf || toggleOff}
								toggle={{
									pressed: showResolved,
									disabled: toggleOff,
									controls: listId,
									onClick: () => {
										setShowResolved((on) => !on);
										setLimit(THREAD_PAGE);
									},
								}}
							>
								{resolved.length} resolved
							</Chip>
						</li>
					</ul>
				)}
			</div>
			<div id={listId}>
				{loading && (
					<ul
						aria-label="Loading threads"
						aria-busy="true"
						data-testid="threads-loading"
						className="space-y-3"
					>
						<li className="sr-only">Loading…</li>
						{[0, 1].map((i) => (
							<li
								key={i}
								className="space-y-2.5 rounded-lg border border-edge bg-surface px-3 py-3"
							>
								<SkeletonBar className="w-1/2" />
								<SkeletonBar className="w-full" />
								<SkeletonBar className="w-3/4" />
							</li>
						))}
					</ul>
				)}
				{threads.length > 0 && listed.length === 0 && (
					<p className="text-sm text-faint">
						{showResolved ? "No resolved threads" : "No unresolved threads"}
					</p>
				)}
				{listed.length > 0 && (
					<ul
						aria-label={
							showResolved ? "Resolved threads" : "Unresolved threads"
						}
						// The previous read's, until this one's land (a Refresh).
						aria-busy={props.previous || undefined}
						className="space-y-3"
					>
						{threadKeys(listed.slice(0, limit)).map(([key, t]) => (
							<ThreadItem key={key} thread={t} />
						))}
					</ul>
				)}
				{listed.length > limit && (
					<div className="mt-3 flex justify-center">
						<button
							type="button"
							onClick={() => setLimit((n) => n + THREAD_PAGE)}
							className="flex min-h-10 max-w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-raised px-4 py-2 text-center text-sm font-semibold text-link shadow-control transition-colors hover:border-accent hover:bg-overlay focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
						>
							<ChevronDownIcon size={16} aria-hidden className="shrink-0" />
							{loadMoreText(listed.length - limit)}
						</button>
					</div>
				)}
			</div>
		</section>
	);
}

/** Overflowing `el` (when `axis` is "both", sideways too), re-measured as it resizes. */
function useOverflow(
	el: RefObject<HTMLElement | null>,
	active: boolean,
	axis: "y" | "both",
): boolean {
	const [over, setOver] = useState(false);
	useLayoutEffect(() => {
		const box = el.current;
		if (!box || !active) return;
		const measure = () =>
			setOver(
				box.scrollHeight > box.clientHeight + 1 ||
					(axis === "both" && box.scrollWidth > box.clientWidth + 1),
			);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(box);
		const inner = box.firstElementChild;
		if (inner) observer.observe(inner);
		return () => observer.disconnect();
	}, [el, active, axis]);
	return over;
}

/**
 * A part of a thread's header line, with its "·" before it (read as a
 * comma, so the parts don't run together).
 */
const HEAD_PART =
	"inline-flex items-center before:inline-block before:w-3 before:shrink-0 before:text-center before:content-['·'_/_',']";

/**
 * One thread: where, who, when it was last active, how many comments,
 * whether anyone answered; then the code it was written on beside the first
 * comment as GitHub renders it (stacked on a phone), both clipped until
 * "Show more".
 */
function ThreadItem({ thread }: { thread: Thread }) {
	const n = thread.commentCount;
	const [open, setOpen] = useState(false);
	const codeBox = useRef<HTMLElement>(null);
	const commentBox = useRef<HTMLDivElement>(null);
	const codeMore = useOverflow(codeBox, !open, "both");
	const codeOverflowsOpen = useOverflow(codeBox, open, "both");
	const commentMore = useOverflow(commentBox, !open, "y");
	const commentId = useId();
	const codeId = useId();
	const rows = thread.code?.rows ?? [];
	const line = headerLine(thread);
	const more = codeMore || commentMore;
	const commentClipped = commentMore && !open;
	useEffect(() => {
		const el = commentBox.current;
		if (!el || !commentClipped) return;
		// A keyboard user never lands on a clipped link.
		const reveal = () => setOpen(true);
		el.addEventListener("focusin", reveal);
		return () => el.removeEventListener("focusin", reveal);
	}, [commentClipped]);
	// GitHub's text: its own raised surface, apart from the card and the code.
	const commentSurface =
		"min-w-0 rounded-md border border-edge bg-raised px-3 py-2";
	const comment = thread.unavailable ? (
		// Its text will never come: said so, plainly.
		<p
			id={commentId}
			data-testid="thread-body-unavailable"
			className={`${commentSurface} flex items-center gap-1.5 text-sm text-muted italic`}
		>
			<AlertIcon size={14} aria-hidden className="shrink-0 text-warn" />
			{thread.unavailable === "deleted"
				? "Deleted on GitHub"
				: "Couldn't be read from GitHub"}
		</p>
	) : !thread.loaded ? (
		// Its text is still on its way: the comment's frame.
		<div
			id={commentId}
			data-testid="thread-body-loading"
			aria-busy="true"
			className={`${commentSurface} space-y-2.5 py-3`}
		>
			<span className="sr-only">Loading…</span>
			<SkeletonBar className="w-full" />
			<SkeletonBar className="w-4/5" />
			<SkeletonBar className="w-2/3" />
		</div>
	) : thread.html.trim() ? (
		<div
			ref={commentBox}
			id={commentId}
			data-testid="thread-body"
			className={`relative ${commentSurface} ${open ? "" : "max-h-32 overflow-hidden"}`}
		>
			<CommentBody thread={thread} open={open} />
			{commentClipped && (
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-raised"
				/>
			)}
		</div>
	) : (
		<p
			ref={commentBox}
			id={commentId}
			data-testid="thread-body"
			className={`${commentSurface} text-sm break-words`}
		>
			{thread.excerpt}
		</p>
	);
	const session = useQuery(sessionQuery);
	const target = threadTarget(thread, session.data, line);
	const status = thread.resolved ? "Resolved" : "Unresolved";
	return (
		<li
			data-testid="thread"
			id={thread.id ? threadAnchor(thread.id) : undefined}
			// Focused when the timeline brings it into view.
			tabIndex={-1}
			className="min-w-0 scroll-mt-24 overflow-hidden rounded-lg border border-edge bg-surface focus-visible:outline-2 focus-visible:outline-accent"
		>
			<div
				data-testid="thread-head"
				className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-line bg-band px-2.5 py-1.5 text-xs text-muted"
			>
				{/*
				 * Each part draws its "·" before itself; the first part on a line
				 * has its dot in the clipped margin, so no line starts with one.
				 */}
				<div className="min-w-0 flex-[1_1_auto] overflow-hidden px-0.5">
					<p className="-ml-3 flex flex-wrap items-center gap-y-0.5">
						<span className={HEAD_PART}>
							{thread.resolved ? (
								<CheckCircleIcon
									size={14}
									aria-hidden
									className="mr-1.5 shrink-0 text-ok"
								/>
							) : (
								<CommentDiscussionIcon
									size={14}
									aria-hidden
									className="mr-1.5 shrink-0 text-warn"
								/>
							)}
							<span>
								<span className="font-semibold text-ink-soft">
									{status} thread
								</span>{" "}
								by{" "}
								<span className="inline-flex items-center gap-1 font-medium text-ink-soft">
									{thread.author}
									{thread.bot && <BotIcon />}
								</span>
							</span>
						</span>
						<span className={`${HEAD_PART} whitespace-nowrap`}>
							opened&nbsp;
							<RelativeTime iso={thread.createdAt} />
						</span>
						{thread.lastActivityAt !== thread.createdAt && (
							<span className={`${HEAD_PART} whitespace-nowrap`}>
								updated&nbsp;
								<RelativeTime iso={thread.lastActivityAt} />
							</span>
						)}
					</p>
				</div>
				<div className="ml-auto flex items-center gap-2 pl-1.5">
					<LabeledIcon
						icon={CommentIcon}
						label={plural(n, "comment")}
						text={String(n)}
						className="gap-1 text-muted"
					/>
					{!thread.hasReply && !thread.resolved && (
						<Badge tone="yellow" icon={ReplyIcon}>
							no reply
						</Badge>
					)}
					{thread.outdated && (
						<Badge tone="gray" icon={HistoryIcon}>
							outdated
						</Badge>
					)}
					{thread.code && <SnapshotChip code={thread.code} />}
				</div>
			</div>
			<div className="space-y-2 px-3 pt-1 pb-3">
				<ThreadPlace thread={thread} line={line} target={target} />
				{thread.code?.source === "pending" ? (
					<div className="grid gap-3 md:grid-cols-2 md:items-start">
						{/* The code is still being built: the pane's frame. */}
						<div
							data-testid="thread-code-loading"
							aria-busy="true"
							className="min-w-0 space-y-2 rounded-md border border-line bg-code px-3 py-3"
						>
							<span className="sr-only">Loading…</span>
							{["w-3/5", "w-4/5", "w-full", "w-2/3", "w-3/4"].map((w) => (
								<SkeletonBar key={w} className={w} />
							))}
						</div>
						{comment}
					</div>
				) : thread.code && rows.length > 0 ? (
					<div className="grid gap-3 md:grid-cols-2 md:items-start">
						<ThreadCodePane
							ref={codeBox}
							id={codeId}
							path={thread.path}
							lines={rows}
							source={thread.code.source}
							open={open}
							scrollable={open ? codeOverflowsOpen : codeMore}
						/>
						{comment}
					</div>
				) : (
					comment
				)}
				{more && (
					<button
						type="button"
						aria-expanded={open}
						aria-controls={rows.length ? `${codeId} ${commentId}` : commentId}
						onClick={() => setOpen((o) => !o)}
						className="-mb-2 flex min-h-10 items-center gap-1 rounded-md text-xs font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
					>
						<ChevronDownIcon
							size={16}
							aria-hidden
							className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
						/>
						{open ? "Show less" : "Show more"}
					</button>
				)}
			</div>
		</li>
	);
}

/**
 * Why the code pane may not be what the commenter saw, in one sentence:
 * the comment's commit and when, then the doubt.
 */
export function snapshotTip(code: CodeWindow, nowMs: number): string {
	const sha = code.anchor.commit.slice(0, 7);
	const at = new Date(code.anchor.at);
	const when = Number.isNaN(at.getTime()) ? "" : relativeTime(at, nowMs);
	// "Made on b19a0aa, 3 days ago"; "Made 3 days ago" without a commit.
	const where = sha
		? [`Made on ${sha}`, when].filter(Boolean).join(", ")
		: when && `Made ${when}`;
	const doubt = "the code shown may differ from what the commenter saw.";
	const reason = code.snapshot?.same === false ? code.snapshot.reason : null;
	if (!where) return `The code shown may differ from what the commenter saw.`;
	if (reason === "diff-differs") return `${where}, in another diff; ${doubt}`;
	if (reason === "no-host-diff") {
		return `${where}; GitHub kept no diff to check it against, so ${doubt}`;
	}
	// No verdict: say only what is known.
	return `${where}; ${doubt}`;
}

/**
 * A red chip when the code pane can't be shown to be what the commenter saw
 * (CodeWindow.snapshot): anything but "same" is flagged, a missing verdict
 * too. Only beside code that is shown.
 */
function SnapshotChip({ code }: { code: CodeWindow }) {
	const now = useNow();
	if (code.source === "pending" || code.rows.length === 0) return null;
	if (code.snapshot?.same === true) return null;
	return (
		<Chip
			tone="red"
			icon={FileDiffIcon}
			tip={snapshotTip(code, now)}
			testId="thread-snapshot"
		>
			different snapshot
		</Chip>
	);
}

/**
 * path:line, a link to that line in Files changed (files/landing.ts); where
 * the line is now, when it moved, in its tooltip.
 */
function ThreadPlace({
	thread,
	line,
	target,
}: {
	thread: Thread;
	line: number | null;
	target: FilesSearch;
}) {
	const moved =
		!thread.outdated &&
		thread.currentLine !== null &&
		line !== null &&
		thread.currentLine !== line;
	const open =
		line === null ? "Open the file in Files changed" : "Open in Files changed";
	return (
		<Tooltip content={moved ? `Now at line ${thread.currentLine}` : open}>
			{(trigger) => (
				<Link
					{...trigger}
					to="/files"
					search={target}
					data-testid="thread-place"
					className="inline-flex min-h-10 max-w-full items-center rounded-sm font-mono text-xs break-all text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
				>
					<code>
						{thread.path}
						{line !== null && `:${line}`}
					</code>
				</Link>
			)}
		</Tooltip>
	);
}

const ROW_BG: Record<HunkLine["kind"], string> = {
	context: "",
	add: "bg-add",
	del: "bg-del",
};
const NUMBER_BG: Record<HunkLine["kind"], string> = {
	context: "text-faint",
	add: "bg-add-gutter text-add-ink",
	del: "bg-del-gutter text-del-ink",
};
const SIGN: Record<HunkLine["kind"], string> = {
	context: " ",
	add: "+",
	del: "−",
};
const SIGN_COLOR: Record<HunkLine["kind"], string> = {
	context: "text-faint",
	add: "text-add-ink",
	del: "text-del-ink",
};

/**
 * The code a comment was written on: its range, marked by an accent rail,
 * and three rows before and after it. Clipped, it scrolls (sideways, and
 * down past seven lines); opened, it wraps and grows. Either way it keeps
 * the commented lines in view.
 */
function ThreadCodePane(props: {
	ref: Ref<HTMLElement>;
	id: string;
	path: string;
	lines: CodeRow[];
	source: CodeWindow["source"];
	open: boolean;
	/** It overflows while clipped: focusable so the keyboard can scroll it. */
	scrollable: boolean;
}) {
	const table = useRef<HTMLTableElement>(null);
	// The pane scrolls itself (never the window) to the marked range:
	// centred, or its start at the top when it doesn't fit. Again when it
	// opens or closes: its height and wrapping change.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reruns on open.
	useLayoutEffect(() => {
		const pane = table.current?.parentElement;
		const marked = table.current?.querySelectorAll("[data-marked]");
		const first = marked?.[0];
		const last = marked?.[marked.length - 1];
		if (!pane || !first || !last) return;
		const top = pane.getBoundingClientRect().top - pane.scrollTop;
		const firstTop = first.getBoundingClientRect().top - top;
		const lastBottom = last.getBoundingClientRect().bottom - top;
		const spare = pane.clientHeight - (lastBottom - firstTop);
		pane.scrollTop = Math.max(0, firstTop - Math.max(0, spare / 2));
	}, [props.open]);
	return (
		<figure
			ref={props.ref}
			id={props.id}
			aria-label={`Code at ${props.path}`}
			data-testid="thread-code"
			data-source={props.source}
			tabIndex={props.scrollable ? 0 : undefined}
			// Clipped: seven 20px lines, the border and a thin sideways
			// scrollbar fit without a vertical one. Opened: up to 24 lines (or
			// 60% of the screen), wrapped, so the comment stays beside its code.
			className={`min-w-0 overflow-auto rounded-md border border-line bg-code font-mono text-xs leading-5 text-code-ink [scrollbar-width:thin] focus-visible:outline-2 focus-visible:outline-accent ${props.open ? "max-h-[min(30.75rem,60vh)]" : "max-h-[10rem]"}`}
		>
			<table ref={table} className="w-full border-collapse">
				<CodeRows
					lines={props.lines}
					path={props.path}
					wrap={props.open}
					testId="thread-code-line"
				/>
			</table>
		</figure>
	);
}

/** The file's tab width (.editorconfig), once the review has loaded. */
function useTabWidth(path: string): number | undefined {
	const review = useQuery(reviewQuery);
	return review.data?.files.find((f) => f.path === path)?.tabWidth;
}

/**
 * Code lines as diff rows, one way for the code pane and suggested changes:
 * a rail (accent and tinted when marked), old and new numbers, the sign,
 * and the text through CodeLine (Shiki, invisibles, the file's tabs).
 */
function CodeRows(props: {
	lines: (HunkLine & { marked?: boolean })[];
	path: string;
	wrap: boolean;
	testId: string;
}) {
	const lang = languageFor(props.path);
	const tabWidth = useTabWidth(props.path);
	return (
		<tbody>
			{props.lines.map((line, i) => (
				<tr
					// The lines of one block never reorder.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above.
					key={i}
					data-testid={props.testId}
					data-marked={line.marked || undefined}
					className={`${ROW_BG[line.kind]} ${line.marked ? "mark-tint" : ""}`}
				>
					<td
						aria-hidden
						className={`w-1 min-w-1 p-0 ${line.marked ? "bg-accent" : ""}`}
					/>
					<td
						className={`w-px px-1.5 text-right align-top whitespace-nowrap select-none ${NUMBER_BG[line.kind]}`}
					>
						{line.oldNo}
					</td>
					<td
						className={`w-px px-1.5 text-right align-top whitespace-nowrap select-none ${NUMBER_BG[line.kind]}`}
					>
						{line.newNo}
					</td>
					<td
						aria-hidden
						className={`w-px pl-2 align-top select-none ${SIGN_COLOR[line.kind]}`}
					>
						{SIGN[line.kind]}
					</td>
					<td
						className={`pr-2 pl-1.5 ${props.wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}
					>
						<CodeLine
							text={line.text}
							lang={lang}
							tabWidth={tabWidth}
							newline={!line.noNewline}
						/>
					</td>
				</tr>
			))}
		</tbody>
	);
}

/**
 * A suggested change as a mini diff: the commented lines deleted, the
 * suggestion added (none: the lines go). Read-only, no "apply".
 */
function SuggestedChange(props: {
	path: string;
	removed: HunkLine[];
	added: HunkLine[];
	/** Wrapped once the comment is opened, like the code pane. */
	wrap: boolean;
}) {
	const lines = [...props.removed, ...props.added];
	return (
		<figure
			aria-label="Suggested change"
			data-testid="suggestion"
			className="my-2 min-w-0 overflow-hidden rounded-md border border-line bg-code font-mono text-xs leading-5 text-code-ink"
		>
			<figcaption className="flex min-h-8 items-center gap-1.5 border-b border-line bg-band px-2 font-sans text-xs font-medium text-ink-soft">
				<LightBulbIcon size={14} aria-hidden className="text-warn" />
				Suggested change
			</figcaption>
			<div className="overflow-x-auto [scrollbar-width:thin]">
				{lines.length > 0 ? (
					<table className="w-full border-collapse">
						<CodeRows
							lines={lines}
							path={props.path}
							wrap={props.wrap}
							testId="suggestion-line"
						/>
					</table>
				) : null}
			</div>
		</figure>
	);
}

/**
 * The deleted rows of a suggestion: the thread's commented lines on its own
 * side, numbered, when they are the lines GitHub's block replaces; GitHub's
 * own text without numbers when the thread has no code; null when the two
 * disagree (the caller then shows GitHub's HTML).
 */
export function suggestionRemoved(
	code: Thread["code"],
	removed: string[],
): HunkLine[] | null {
	const strip = (t: string) => t.replace(/\r$/, "");
	if (!code || code.rows.length === 0) {
		return removed.map((text) => ({
			kind: "del",
			oldNo: null,
			newNo: null,
			text,
		}));
	}
	const side = code.anchor.side;
	const own = code.rows.filter((l) => l.marked && numberOn(l, side) !== null);
	if (
		own.length !== removed.length ||
		own.some((l, i) => strip(l.text) !== strip(removed[i] ?? ""))
	) {
		return null;
	}
	return own.map((l) => ({
		kind: "del",
		oldNo: numberOn(l, side),
		newNo: null,
		text: l.text,
	}));
}

/**
 * The first comment as GitHub renders it, its suggested changes drawn as
 * mini diffs (suggestions.ts). Whenever that can't be done exactly, the
 * whole comment is GitHub's HTML, as it was: nothing is dropped.
 */
function CommentBody({ thread, open }: { thread: Thread; open: boolean }) {
	const parts = useMemo(() => {
		const split = splitSuggestions(thread.html, thread.body);
		if (!split) return null;
		const out: (
			| { kind: "html"; html: string }
			| { kind: "suggestion"; removed: HunkLine[]; added: HunkLine[] }
		)[] = [];
		for (const part of split) {
			if (part.kind === "html") {
				out.push(part);
				continue;
			}
			const removed = suggestionRemoved(thread.code, part.removed);
			if (!removed) return null;
			const first = removed[0]?.oldNo ?? null;
			out.push({
				kind: "suggestion",
				removed,
				added: part.added.map((text, i) => ({
					kind: "add",
					oldNo: null,
					newNo: first === null ? null : first + i,
					text,
				})),
			});
		}
		return out;
	}, [thread.html, thread.body, thread.code]);
	if (!parts) return <GithubHtml html={thread.html} />;
	return (
		<>
			{parts.map((part, i) =>
				part.kind === "html" ? (
					// Fixed order, never reordered.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above.
					<GithubHtml key={i} html={part.html} />
				) : (
					<SuggestedChange
						// biome-ignore lint/suspicious/noArrayIndexKey: see above.
						key={i}
						path={thread.path}
						removed={part.removed}
						added={part.added}
						wrap={open}
					/>
				),
			)}
		</>
	);
}
