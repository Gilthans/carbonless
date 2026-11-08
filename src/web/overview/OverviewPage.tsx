import {
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
	PencilIcon,
	PeopleIcon,
	QuestionIcon,
	ReplyIcon,
	XIcon,
} from "@primer/octicons-react";
import {
	type UseQueryResult,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
	type CSSProperties,
	type ReactNode,
	type Ref,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type CodeRow,
	type CodeWindow,
	type PrOverview,
	type Progress,
	type ReviewThread,
	THREAD_PAGE,
	type ThreadComment,
	type ThreadsView,
} from "../../shared/types";
import {
	OVERVIEW_FRESH_MS,
	overviewAge,
	overviewQuery,
	revalidateOverviewQuery,
	sessionQuery,
} from "../api";
import { type FilesSearch, threadTarget } from "../files/landing";
import {
	ChangedSince,
	OpenedOnChip,
	PlacementChip,
	PlacementProvider,
	usePlacementInfo,
	useSessionPlacements,
} from "../files/ThreadFate";
import { useReviewView } from "../files/useSetStates";
import { GithubHtml, ImageErrorContext } from "../GithubHtml";
import { usePageActive } from "../pageActive";
import { RelativeTime, relativeTime, useNow } from "../RelativeTime";
import { useReviewId } from "../reviewId";
import { Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { CodeRows, CommentBody } from "../threads/CommentBody";
import {
	CommentActions,
	DeletedRow,
	EditedMark,
	EditForm,
	SavingText,
	useCommentCan,
	useCommentWrite,
} from "../threads/CommentEdit";
import {
	COMMENT_SURFACE,
	commentSurface,
	ThreadActions,
	ThreadComments,
	UnavailableText,
	useCanAct,
} from "../threads/Conversation";
import { kept, useDrafts } from "../threads/drafts";
import { MoreToggle, useReplyCount } from "../threads/MoreToggle";
import { OrphanDraft } from "../threads/OrphanDraft";
import { Avatar, PeopleProvider, TINTS, usePerson } from "../threads/people";
import { canToggle } from "../threads/ResolveButton";
import { withSpanMarks } from "../threads/spanMarks";
import { ThreadStatus } from "../threads/ThreadStatus";
import {
	FADE_MS,
	useThreadWriter,
	useThreadWrites,
	useWritesOn,
} from "../threads/threadWrites";
import {
	usePrefetchComments,
	useThreadComments,
} from "../threads/useThreadComments";
import { useThreads } from "../threads/useThreads";
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
import { prefetchOrder, type ShownThreads } from "./prefetchOrder";
import { Timeline } from "./Timeline";
import { threadKeys } from "./threadKeys";
import type { OverviewSearch } from "./threadLink";
import { WriteWarnings } from "./WriteWarnings";

type Review = PrOverview["reviews"][number];
type Check = PrOverview["checks"][number];
type Thread = ReviewThread;

/** A thread to bring into view; `seq` is new for each request. */
interface ThreadFocus {
	id: string;
	seq: number;
}

/** The thread lists, in screen order. */
const THREAD_GROUPS = ["Human reviews", "Bot reviews"] as const;

/** A thread list says what it shows and would show next. */
type OnShown = (group: string, ids: ShownThreads) => void;

/** A thread card's element id. */
const threadAnchor = (id: string) => `thread-${id}`;

/** How old the overview's HTML may be before a broken image reads it again. */
const IMAGE_MAX_AGE_MS = 60_000;

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
	// Where each unresolved thread sits in the session's snapshot: the
	// cards' "changed since" and fate chips.
	const placementInfo = useSessionPlacements(threads.readId);
	// What each thread list shows, for the order comments are read in.
	const [shown, setShown] = useState<Record<string, ShownThreads>>({});
	const onShown = useCallback(
		(group: string, ids: ShownThreads) =>
			setShown((all) => ({ ...all, [group]: ids })),
		[],
	);
	// The one prefetch for the page, from the summary on: what is on screen,
	// then the next pages, then the rest.
	const order = useMemo(
		() =>
			prefetchOrder(
				threads.view?.threads ?? [],
				THREAD_GROUPS.flatMap((g) => shown[g] ?? []),
			),
		[threads.view, shown],
	);
	usePrefetchComments(threads.readId, order);
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
			<PeopleProvider threads={threads.view?.threads}>
				<PlacementProvider value={placementInfo}>
					<OverviewContent
						overview={overview}
						threads={threads}
						onShown={onShown}
						updateError={revalidate.isError ? revalidate.error : null}
					/>
				</PlacementProvider>
			</PeopleProvider>
		</ImageErrorContext>
	);
}

function OverviewContent({
	overview,
	threads,
	onShown,
	updateError,
}: {
	overview: UseQueryResult<PrOverview>;
	threads: ReturnType<typeof useThreads>;
	onShown: OnShown;
	/** The overview shown couldn't be brought up to date. */
	updateError: Error | null;
}) {
	// A thread to bring into view (the timeline's "Go to the thread").
	const [focus, setFocus] = useState<ThreadFocus | null>(null);
	const showThread = useCallback(
		(id: string) => setFocus((f) => ({ id, seq: (f?.seq ?? 0) + 1 })),
		[],
	);
	// A thread's link from elsewhere (the Final Verdict tab): its card in
	// view. The param is dropped once read, so the same link works again.
	const search = useSearch({ strict: false }) as OverviewSearch;
	const navigate = useNavigate();
	const active = usePageActive();
	const reviewId = useReviewId();
	useEffect(() => {
		if (!active || !search.thread) return;
		showThread(search.thread);
		void navigate({
			to: "/r/$id",
			params: { id: reviewId },
			search: {},
			replace: true,
			resetScroll: false,
		});
	}, [active, search.thread, showThread, navigate, reviewId]);
	return (
		<div className="space-y-6">
			{overview.isPending && <OverviewSkeleton />}
			{overview.isError && <ErrorMessage error={overview.error} />}
			{updateError && <ErrorMessage error={updateError} />}
			{overview.data && (
				<>
					<WhatItDoes pr={overview.data} threads={threads.view} />
					<WhosOnIt pr={overview.data} threads={threads.view} />
					<IsItReady
						pr={overview.data}
						threads={threads.view}
						error={threads.error}
						previous={threads.previous}
						readId={threads.readId ?? ""}
						onShown={onShown}
						focus={focus}
					/>
					<Timeline
						pr={overview.data}
						threads={threads.view}
						threadsLoading={!threads.view && !threads.error}
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
	const bar = (width: string) => <SkeletonBar className={width} />;
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
	const { review, data } = useReviewView();
	const id = useReviewId();
	return (
		<div className="flex flex-col items-center gap-3">
			<Link
				to="/r/$id/files"
				params={{ id }}
				className="cta inline-flex min-h-10 items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-ink transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
			>
				Review files
				{data && (
					<span className="rounded-full bg-canvas/35 px-2 text-xs tabular-nums">
						{progressText(data.progress)}
					</span>
				)}
			</Link>
			{review.isPending && <Spinner label="Loading review progress" />}
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

/**
 * As GitHub shows it; the markdown source only if GitHub sent no HTML.
 * Clipped at 280px (a height, not a line count: headings, lists, code and
 * images have no common line) with a fade and "Show more"; shorter, whole.
 */
function Description({ pr }: { pr: PrOverview }) {
	const [open, setOpen] = useState(false);
	// State, not a ref: the box mounts only once there is a description.
	const [box, setBox] = useState<HTMLDivElement | null>(null);
	const id = useId();
	const html = pr.bodyHtml.trim() !== "";
	const text = !html && pr.body.trim() !== "";
	const over = useOverflow(box, !open && (html || text), "y");
	const clipped = over && !open;
	useEffect(() => {
		const el = box;
		if (!el || !clipped) return;
		// A keyboard user never lands on a clipped link.
		const reveal = () => setOpen(true);
		el.addEventListener("focusin", reveal);
		return () => el.removeEventListener("focusin", reveal);
	}, [box, clipped]);
	if (!html && !text) {
		return <p className="text-sm text-muted italic">No description</p>;
	}
	return (
		<div>
			<div
				ref={setBox}
				id={id}
				data-testid="description"
				className={`relative ${open ? "" : "max-h-[17.5rem] overflow-hidden"}`}
			>
				{html ? (
					<GithubHtml html={pr.bodyHtml} className="text-sm" />
				) : (
					<p className="text-sm break-words whitespace-pre-wrap">{pr.body}</p>
				)}
				{clipped && (
					<div
						aria-hidden
						className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-surface"
					/>
				)}
			</div>
			{over && (
				<div className="flex justify-center">
					<button
						type="button"
						aria-expanded={open}
						aria-controls={id}
						data-testid="description-more"
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
				</div>
			)}
		</div>
	);
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

/**
 * The viewer is reviewing: a GitHub review or comment of theirs (unless
 * they opened the PR: an author answers, they don't review), or anything
 * reviewed or crossed off here. Until the review data loads, the GitHub
 * facts alone decide.
 */
function viewerReviewing(pr: PrOverview, progress: Progress | undefined) {
	const marked = progress
		? progress.clusters.reviewed + progress.clusters.crossedOff > 0
		: false;
	const onGitHub =
		!pr.youAuthor &&
		(pr.reviews.some((r) => r.you) || pr.commenters.some((c) => c.you));
	return marked || onGitHub;
}

function StartedLine({ pr }: { pr: PrOverview }) {
	const { data } = useReviewView();
	const you = viewerReviewing(pr, data?.progress);
	const names = startedNames(pr);
	if (pr.humanStarted) {
		const others = names.length ? names.join(", ") : undefined;
		return (
			<>
				<EyeIcon size={16} aria-hidden className="text-warn" />
				{you
					? `You and ${others ?? "someone else"} are reviewing`
					: `${others ?? "Someone else"} already started`}
			</>
		);
	}
	if (you) {
		return (
			<>
				<EyeIcon size={16} aria-hidden className="text-ok" />
				You're reviewing this change
			</>
		);
	}
	return (
		<>
			<CheckCircleIcon size={16} aria-hidden className="text-ok" />
			No one else has started reviewing
		</>
	);
}

function WhosOnIt({
	pr,
	threads,
}: {
	pr: PrOverview;
	threads: ThreadsView | undefined;
}) {
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
				<StartedLine pr={pr} />
			</p>
			<WriteWarnings pr={pr} threads={threads?.threads} />
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
	readId,
	onShown,
	focus,
}: {
	pr: PrOverview;
	/** Undefined until every thread's summary is in. */
	threads: ThreadsView | undefined;
	/** The threads couldn't all be read. */
	error: Error | null;
	/** `threads` are the previous read's, until this one's land. */
	previous: boolean;
	/** The read `threads` come from. */
	readId: string;
	onShown: OnShown;
	focus: ThreadFocus | null;
}) {
	const list = threads?.threads;
	const unreadable =
		list?.filter((t) => t.unavailable === "unreadable").length ?? 0;
	// Failed with nothing to show: the error alone, no frames left busy.
	const failed = Boolean(error) && !list;
	const drafts = useDrafts();
	// Drafts no card can show (their thread isn't listed, or this session
	// doesn't write): listed with the human threads' drafts, never lost.
	const orphans = useMemo(() => {
		if (!list || previous) return [];
		const listed = new Set(list.map((t) => t.id));
		const writesOn = pr.writes === "on";
		const byThread = new Map<string, string[]>();
		for (const d of drafts) {
			if (!kept(d)) continue;
			if (writesOn && listed.has(d.threadId)) continue;
			byThread.set(d.threadId, [...(byThread.get(d.threadId) ?? []), d.text]);
		}
		return [...byThread].map(([threadId, texts]) => {
			// A new thread being written: where it goes (it starts in Files changed).
			const c = drafts.find((d) => d.threadId === threadId)?.create;
			const label = c
				? `New comment · ${c.subject === "file" || c.line === undefined ? c.path : `${c.path}:${c.line}`}`
				: "Thread not listed";
			return { threadId, texts, label };
		});
	}, [drafts, list, previous, pr.writes]);
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
				label={THREAD_GROUPS[0]}
				readId={readId}
				onShown={onShown}
				icon={CommentDiscussionIcon}
				threads={list?.filter((t) => !t.bot)}
				orphans={orphans}
				writesOn={pr.writes === "on"}
				failed={failed}
				previous={previous}
				asOf={Boolean(pr.asOf)}
				focus={focus}
			/>
			<ThreadGroup
				label={THREAD_GROUPS[1]}
				readId={readId}
				onShown={onShown}
				icon={HubotIcon}
				threads={list?.filter((t) => t.bot)}
				writesOn={pr.writes === "on"}
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

type ThreadFilter = "unresolved" | "resolved" | "drafts";

/**
 * Cards resolved or unresolved here, fading in place for FADE_MS before
 * they move to the other list: the list each stays in meanwhile, by id.
 * Toggling back during the fade (undo) keeps the card where it is.
 */
function useFade() {
	const [fading, setFading] = useState<ReadonlyMap<string, boolean>>(
		() => new Map(),
	);
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	useEffect(() => {
		const all = timers.current;
		return () => {
			for (const t of all.values()) clearTimeout(t);
			all.clear();
		};
	}, []);
	const toggled = useCallback((id: string, next: boolean) => {
		const timer = timers.current.get(id);
		if (timer !== undefined) {
			// Undone: it stays, no longer fading.
			clearTimeout(timer);
			timers.current.delete(id);
			setFading((m) => {
				const n = new Map(m);
				n.delete(id);
				return n;
			});
			return;
		}
		timers.current.set(
			id,
			setTimeout(() => {
				timers.current.delete(id);
				setFading((m) => {
					const n = new Map(m);
					n.delete(id);
					return n;
				});
			}, FADE_MS),
		);
		setFading((m) => new Map(m).set(id, !next));
	}, []);
	/** Every fade ends now: each card moves to its new list at once. */
	const settle = useCallback(() => {
		for (const t of timers.current.values()) clearTimeout(t);
		timers.current.clear();
		setFading((m) => (m.size ? new Map() : m));
	}, []);
	return { fading, toggled, settle };
}

const CHOICE_TONES = {
	yellow: "text-warn has-checked:border-warn/50 has-checked:bg-warn/15",
	green: "text-ok has-checked:border-ok/50 has-checked:bg-ok/15",
	gray: "text-ink-soft has-checked:border-line-strong has-checked:bg-overlay",
};

/**
 * Unresolved or resolved: one two-way choice, each side with its count,
 * either chosen whatever its count. With Drafts shown neither is chosen.
 */
function ResolvedChoice(props: {
	shown: ThreadFilter;
	unresolved: number;
	resolved: number;
	asOf: boolean;
	controls: string;
	onChoose: (filter: "unresolved" | "resolved") => void;
}) {
	const name = useId();
	const options = [
		{
			id: "unresolved" as const,
			count: props.unresolved,
			tone: "yellow" as const,
			icon: CommentDiscussionIcon,
			tip: "Show unresolved threads",
		},
		{
			id: "resolved" as const,
			count: props.resolved,
			tone: "green" as const,
			icon: CheckIcon,
			// As of a cutoff, none is known resolved: the tip says why.
			tip: props.asOf
				? "Resolution history isn't known for a past moment: every thread counts as unresolved"
				: "Show resolved threads",
		},
	];
	return (
		<div
			role="radiogroup"
			aria-label="Threads shown"
			className="inline-flex rounded-full border border-line p-px"
		>
			{options.map((o) => {
				const IconEl = o.icon;
				return (
					<Tooltip
						key={o.id}
						content={o.tip}
						hoverDelay={400}
						describe={o.id === "resolved" && props.asOf}
					>
						{({ "aria-describedby": describedBy, ...trigger }) => (
							<label
								{...trigger}
								className={`relative inline-flex min-h-10 cursor-pointer items-center gap-1 rounded-full border border-transparent px-2.5 text-xs font-medium transition-colors hover:bg-overlay has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-accent motion-reduce:transition-none ${CHOICE_TONES[o.count ? o.tone : "gray"]}`}
							>
								<input
									type="radio"
									name={name}
									value={o.id}
									checked={props.shown === o.id}
									onChange={() => props.onChoose(o.id)}
									aria-controls={props.controls}
									aria-describedby={describedBy}
									className="sr-only"
								/>
								<IconEl size={12} aria-hidden />
								{o.count} {o.id}
							</label>
						)}
					</Tooltip>
				);
			})}
		</div>
	);
}

/**
 * One group's review threads, inside "Is it ready": unresolved ones listed,
 * or resolved ones when chosen; five at a time. As of a
 * cutoff no thread is known to be resolved.
 */
function ThreadGroup(props: {
	label: string;
	/** The read `threads` come from. */
	readId: string;
	/** Says what the list shows and would show next, as that changes. */
	onShown: OnShown;
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
	/** Drafts whose thread no card here shows (one group lists them). */
	orphans?: OrphanDraftItem[];
	/** This session writes: a card can show its draft. */
	writesOn: boolean;
}) {
	const { asOf, focus, readId, onShown, label } = props;
	const orphans = props.orphans ?? [];
	const loading = props.threads === undefined && !props.failed;
	const threads = props.threads ?? [];
	const [filter, setFilter] = useState<ThreadFilter>("unresolved");
	const [limit, setLimit] = useState(THREAD_PAGE);
	const listId = useId();
	const headingId = useId();
	const fade = useFade();
	const writer = useThreadWriter();
	// Threads whose last comment was deleted here fade, then leave.
	const { gone } = useThreadWrites();
	// Another list chosen: no card keeps fading in the old one.
	const switchTo = (f: ThreadFilter) => {
		fade.settle();
		writer.settleGone(threads.map((t) => t.id));
		setFilter(f);
		setLimit(THREAD_PAGE);
	};
	// A card resolved or unresolved stays in its list while it fades.
	const inResolved = (t: Thread) => fade.fading.get(t.id) ?? t.resolved;
	const unresolved = threads.filter((t) => !inResolved(t));
	const resolved = threads.filter(inResolved);
	const drafts = useDrafts();
	const drafted = useMemo(() => {
		const ids = new Set(drafts.filter(kept).map((d) => d.threadId));
		return props.writesOn ? threads.filter((t) => ids.has(t.id)) : [];
	}, [drafts, threads, props.writesOn]);
	const draftCount = drafted.length + orphans.length;
	// The drafts sent or cleared: back to the open threads, for good (a new
	// draft later doesn't bring the Drafts list back by itself).
	if (filter === "drafts" && draftCount === 0) setFilter("unresolved");
	const shownFilter =
		filter === "drafts" && draftCount === 0 ? "unresolved" : filter;
	const showResolved = shownFilter === "resolved";
	const listed =
		shownFilter === "drafts" ? drafted : showResolved ? resolved : unresolved;
	const IconEl = props.icon;
	const visible = listed
		.slice(0, limit)
		.map((t) => t.id)
		.join(",");
	const next = listed
		.slice(limit, limit + THREAD_PAGE)
		.map((t) => t.id)
		.join(",");
	useEffect(() => {
		onShown(label, {
			visible: visible.split(",").filter(Boolean),
			next: next.split(",").filter(Boolean),
		});
	}, [onShown, label, visible, next]);
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
		setFilter(thread.resolved ? "resolved" : "unresolved");
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
				) : props.threads === undefined ? null : threads.length === 0 &&
					draftCount === 0 ? (
					<p className="text-sm text-faint">No threads</p>
				) : (
					<ul
						aria-label="Thread counts"
						className="flex flex-wrap items-center gap-x-2"
					>
						{threads.length > 0 && (
							<li>
								<ResolvedChoice
									shown={shownFilter}
									unresolved={unresolved.length}
									resolved={resolved.length}
									asOf={asOf}
									controls={listId}
									onChoose={switchTo}
								/>
							</li>
						)}
						{draftCount > 0 && (
							<li>
								<Chip
									tone="yellow"
									icon={PencilIcon}
									testId="drafts-filter"
									tip={
										shownFilter === "drafts"
											? "Show unresolved threads"
											: "Show threads with a draft"
									}
									toggle={{
										pressed: shownFilter === "drafts",
										controls: listId,
										onClick: () =>
											switchTo(
												shownFilter === "drafts" ? "unresolved" : "drafts",
											),
									}}
								>
									{plural(draftCount, "draft")}
								</Chip>
							</li>
						)}
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
				{threads.length > 0 &&
					listed.length === 0 &&
					shownFilter !== "drafts" && (
						<p className="text-sm text-faint">
							{showResolved ? "No resolved threads" : "No unresolved threads"}
						</p>
					)}
				{listed.length > 0 && (
					<ul
						aria-label={
							shownFilter === "drafts"
								? "Threads with a draft"
								: showResolved
									? "Resolved threads"
									: "Unresolved threads"
						}
						// The previous read's, until this one's land (a Refresh).
						aria-busy={props.previous || undefined}
						className="space-y-3"
					>
						{threadKeys(listed.slice(0, limit)).map(([key, t]) => (
							<ThreadItem
								key={key}
								thread={t}
								readId={readId}
								fading={
									gone.has(t.id) ||
									(shownFilter !== "drafts" && fade.fading.has(t.id))
								}
								gone={gone.has(t.id)}
								draftsShown={shownFilter === "drafts"}
								onToggle={(next) => fade.toggled(t.id, next)}
							/>
						))}
					</ul>
				)}
				{shownFilter === "drafts" && orphans.length > 0 && (
					<ul
						aria-label="Drafts on threads not listed"
						className={`space-y-3 ${listed.length > 0 ? "mt-3" : ""}`}
					>
						{orphans.map((o) => (
							<OrphanDraft
								key={o.threadId}
								label={o.label}
								text={o.texts.join("\n\n")}
								onDiscard={() => writer.discard(o.threadId)}
							/>
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

interface OrphanDraftItem {
	threadId: string;
	/** Its box text and its replies not yet confirmed. */
	texts: string[];
	/** Why it shows here: "Thread not listed", or a new comment and where. */
	label: string;
}

/**
 * Overflowing `el` (when `axis` is "both", sideways too), re-measured as it
 * resizes. `el` is the element itself (a callback ref's state), not a ref
 * object: the box can mount after the card (the code pane replaces its
 * frame once the code arrives), and is measured again whenever it does.
 */
function useOverflow(
	el: HTMLElement | null,
	active: boolean,
	axis: "y" | "both",
): boolean {
	const [over, setOver] = useState(false);
	useLayoutEffect(() => {
		const box = el;
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
 * comment as GitHub renders it (stacked on a phone), both clipped. One
 * "Show more" for the whole thread: opened, the code and the first comment
 * in full, every reply, then the reply box and the Resolve button.
 */
function ThreadItem({
	thread,
	readId,
	fading,
	onToggle,
	draftsShown,
	gone,
}: {
	thread: Thread;
	/** The read the thread was listed in: its comments are read by it. */
	readId: string;
	/** Just resolved or unresolved: fading, about to move to the other list. */
	fading?: boolean;
	onToggle?: (resolved: boolean) => void;
	/** Listed for its draft: its replies open, the draft in view. */
	draftsShown?: boolean;
	/** Its last comment deleted here: gone on GitHub, fading out. */
	gone?: boolean;
}) {
	const drafts = useDrafts();
	// A thread with a draft opens on it.
	const [open, setOpen] = useState(() =>
		drafts.some((d) => d.threadId === thread.id),
	);
	useEffect(() => {
		if (draftsShown) setOpen(true);
	}, [draftsShown]);
	// State, not refs: either box can mount later than the card.
	const [codeBox, setCodeBox] = useState<HTMLElement | null>(null);
	const [commentBox, setCommentBox] = useState<HTMLDivElement | null>(null);
	const codeMore = useOverflow(codeBox, !open, "both");
	const codeOverflowsOpen = useOverflow(codeBox, open, "both");
	const commentMore = useOverflow(commentBox, !open, "y");
	const commentId = useId();
	const codeId = useId();
	const repliesId = useId();
	// The span's exact characters painted on its lines, when they fit.
	const rows = useMemo(
		() => withSpanMarks(thread.code?.rows ?? [], thread.anchor),
		[thread.code, thread.anchor],
	);
	const line = headerLine(thread);
	const opener = usePerson(thread.author, thread.avatarUrl);
	const replies = useReplyCount(thread, readId);
	const canAct = useCanAct(thread);
	// The opener as a comment (its id, what the viewer may do, edited):
	// read once the card opens, usually prefetched before.
	const known = useThreadComments(readId, thread.id, {
		enabled: open && !thread.unavailable && thread.id !== "",
	}).data;
	const first =
		known?.threadId === thread.id &&
		known.comments[0] &&
		!known.comments[0].pending
			? known.comments[0]
			: undefined;
	const write = useCommentWrite(thread.id, first ?? NO_COMMENT);
	const can = useCommentCan(first ?? NO_COMMENT);
	// Anything more to see: clipped text or code, a reply, or something to do.
	const more =
		codeMore ||
		commentMore ||
		(!thread.unavailable &&
			(replies.n > 0 || canAct || can.update || can.delete));
	const writesOn = useWritesOn();
	const kind = toggleKind({
		clipped: codeMore || commentMore,
		replies: replies.n,
		canReply: writesOn && thread.viewerCan.reply,
		canResolve: canToggle(thread, writesOn),
	});
	const commentClipped = commentMore && !open;
	useEffect(() => {
		const el = commentBox;
		if (!el || !commentClipped) return;
		// A keyboard user never lands on a clipped link.
		const reveal = () => setOpen(true);
		el.addEventListener("focusin", reveal);
		return () => el.removeEventListener("focusin", reveal);
	}, [commentBox, commentClipped]);
	const comment = thread.unavailable ? (
		// Its text will never come: said so, plainly.
		<UnavailableText id={commentId} reason={thread.unavailable} />
	) : write.deleting ? (
		<div id={commentId}>
			<DeletedRow
				threadId={thread.id}
				commentId={write.deleting.commentId}
				undo={write.deleting.undo}
				done={write.deleting.done}
			/>
		</div>
	) : open && write.editing && first ? (
		<div id={commentId}>
			<EditForm
				threadId={thread.id}
				comment={first}
				thread={thread}
				onClose={() => write.setEditing(false)}
			/>
		</div>
	) : write.saving !== undefined ? (
		<div
			id={commentId}
			data-testid="thread-body"
			data-tint={opener.tint}
			className={`${commentSurface(opener.tint)} break-words`}
		>
			<SavingText text={write.saving} />
		</div>
	) : !thread.loaded ? (
		// Its text is still on its way: the comment's frame.
		<div
			id={commentId}
			data-testid="thread-body-loading"
			aria-busy="true"
			className={`${COMMENT_SURFACE} space-y-2.5 py-3`}
		>
			<span className="sr-only">Loading…</span>
			<SkeletonBar className="w-full" />
			<SkeletonBar className="w-4/5" />
			<SkeletonBar className="w-2/3" />
		</div>
	) : thread.html.trim() ? (
		<div
			ref={setCommentBox}
			id={commentId}
			data-testid="thread-body"
			data-tint={opener.tint}
			className={`relative ${commentSurface(opener.tint)} ${open ? "" : "max-h-32 overflow-hidden"}`}
		>
			<CommentBody
				html={thread.html}
				body={thread.body}
				code={thread.code}
				path={thread.path}
				open={open}
			/>
			{commentClipped && (
				<div
					aria-hidden
					className={`pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent ${TINTS[opener.tint]?.fade ?? ""}`}
				/>
			)}
		</div>
	) : (
		<p
			ref={setCommentBox}
			id={commentId}
			data-testid="thread-body"
			data-tint={opener.tint}
			className={`${commentSurface(opener.tint)} text-sm break-words`}
		>
			{thread.excerpt}
		</p>
	);
	// The opener's own Edit and Delete, inside Show more.
	const openerBar =
		open &&
		first &&
		!write.deleting &&
		!write.editing &&
		(write.saving !== undefined || can.update || can.delete) ? (
			<div className="flex min-h-10 items-center justify-end gap-1.5 text-xs text-muted">
				{write.saving !== undefined ? (
					<LabeledIcon icon={ClockIcon} label="Saving" className="text-warn" />
				) : (
					<CommentActions
						threadId={thread.id}
						comment={first}
						onEdit={() => write.setEditing(true)}
						keepsPlace={known?.comments.slice(1).some((r) => !r.pending)}
					/>
				)}
			</div>
		) : null;
	const commentCell = openerBar ? (
		<div className="min-w-0 space-y-1">
			{comment}
			{openerBar}
		</div>
	) : (
		comment
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
			data-fading={fading || undefined}
			style={
				fading ? ({ "--fade-ms": `${FADE_MS}ms` } as CSSProperties) : undefined
			}
			className={`min-w-0 scroll-mt-24 overflow-hidden rounded-lg border border-edge bg-surface focus-visible:outline-2 focus-visible:outline-accent ${fading ? "thread-fading" : ""}`}
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
									{/* Resolved is unmistakable: the word in green too. */}
									<span className={thread.resolved ? "text-ok" : undefined}>
										{status}
									</span>{" "}
									thread
								</span>{" "}
								by{" "}
								<span className="inline-flex items-center gap-1 align-middle font-medium text-ink-soft">
									<Avatar
										login={thread.author}
										url={thread.avatarUrl}
										size={16}
									/>
									{thread.author}
									{thread.bot && <BotIcon />}
								</span>
							</span>
						</span>
						<span className={`${HEAD_PART} whitespace-nowrap`}>
							opened&nbsp;
							<RelativeTime iso={thread.createdAt} />
						</span>
						{first?.editedAt && (
							<span className={`${HEAD_PART} whitespace-nowrap`}>
								<EditedMark iso={first.editedAt} />
							</span>
						)}
						{thread.lastActivityAt !== thread.createdAt && (
							<span className={`${HEAD_PART} whitespace-nowrap`}>
								updated&nbsp;
								<RelativeTime iso={thread.lastActivityAt} />
							</span>
						)}
					</p>
				</div>
				<div className="ml-auto flex items-center gap-2 pl-1.5">
					{fading && (
						// The still form of the fade (reduced motion).
						<span
							role="status"
							data-testid="thread-moving"
							className="hidden text-warn motion-reduce:inline"
						>
							{gone ? "Deleted" : "Moving…"}
						</span>
					)}
					<OpenedOnChip thread={thread} />
					<PlacementChip thread={thread} />
					<ThreadStatus thread={thread} mark={false} />
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
				<ThreadFateLine thread={thread} />
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
						{commentCell}
					</div>
				) : thread.code && rows.length > 0 ? (
					<div className="grid gap-3 md:grid-cols-2 md:items-start">
						<ThreadCodePane
							ref={setCodeBox}
							id={codeId}
							path={thread.path}
							lines={rows}
							source={thread.code.source}
							open={open}
							scrollable={open ? codeOverflowsOpen : codeMore}
						/>
						{commentCell}
					</div>
				) : (
					commentCell
				)}
				{open && !thread.unavailable && (
					<div id={repliesId} className="space-y-2">
						{replies.n > 0 && (
							<div
								data-testid="thread-replies"
								// The replies hang off the opener on a rail.
								className="ml-2 border-l-2 border-line pl-3"
							>
								<ThreadComments readId={readId} thread={thread} skipFirst />
							</div>
						)}
						<ThreadActions thread={thread} onToggle={onToggle} />
					</div>
				)}
				{more && (
					// Its own row, centred under the card.
					<div data-testid="thread-more-row" className="flex justify-center">
						<MoreToggle
							open={open}
							onClick={() => setOpen((o) => !o)}
							controls={[
								rows.length ? codeId : "",
								commentId,
								open ? repliesId : "",
							]
								.filter(Boolean)
								.join(" ")}
							replies={replies}
							kind={kind}
						/>
					</div>
				)}
			</div>
		</li>
	);
}

/** A changed thread's fate line ("Line rewritten since PS1 · See on PS1"). */
function ThreadFateLine({ thread }: { thread: Thread }) {
	const placement = usePlacementInfo().placements?.get(thread.id);
	if (placement?.kind !== "changed") return null;
	return <ChangedSince thread={thread} placement={placement} lines={false} />;
}

/** No comment (the opener's not read yet): no writes to it. */
const NO_COMMENT: ThreadComment = {
	id: "",
	author: "",
	bot: false,
	avatarUrl: "",
	publishedAt: null,
	pending: false,
	html: "",
	body: "",
	text: "",
	editedAt: null,
	viewerCan: { update: false, delete: false },
	deleted: false,
};

/** "1 reply", "2 replies". */
/**
 * What a card's toggle opens to: "more" when there's something to read
 * (clipped code or text, a reply, the viewer's pending or sending ones);
 * otherwise only the reply box and Resolve, so it says "reply", or
 * "resolve" where the viewer may resolve but not reply.
 */
export function toggleKind(p: {
	clipped: boolean;
	/** Replies, the viewer's pending and sending ones included. */
	replies: number;
	canReply: boolean;
	canResolve: boolean;
}): "more" | "reply" | "resolve" {
	if (p.clipped || p.replies > 0) return "more";
	if (p.canReply) return "reply";
	if (p.canResolve) return "resolve";
	return "more";
}

/** The toggle's words, closed and open, by what it opens to. */
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
	const id = useReviewId();
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
					to="/r/$id/files"
					params={{ id }}
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
