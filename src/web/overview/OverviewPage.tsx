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
	LightBulbIcon,
	MarkGithubIcon,
	PeopleIcon,
	QuestionIcon,
	ReplyIcon,
	SkipIcon,
	TriangleDownIcon,
	XIcon,
} from "@primer/octicons-react";
import {
	type UseQueryResult,
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
import type { PrOverview, Progress } from "../../shared/types";
import { overviewQuery, reviewQuery, sessionQuery } from "../api";
import { CodeLine } from "../code/Invisibles";
import { languageFor } from "../files/highlight";
import { type FilesSearch, threadTarget } from "../files/landing";
import { GithubHtml, ImageErrorContext } from "../GithubHtml";
import { RelativeTime } from "../RelativeTime";
import { Tooltip } from "../Tooltip";
import { ErrorMessage, safeHref } from "../ui";
import { codeExcerpt, type HunkLine } from "./diffHunk";
import { createImageRefresher } from "./imageRefresh";
import { splitSuggestions } from "./suggestions";
import { threadKeys } from "./threadKeys";

type Review = PrOverview["reviews"][number];
type Check = PrOverview["checks"][number];
type Thread = PrOverview["threads"][number];

export function OverviewPage() {
	const overview = useQuery(overviewQuery);
	const queryClient = useQueryClient();
	const [refreshImages] = useState(() =>
		createImageRefresher({
			refetch: () =>
				void queryClient.invalidateQueries({
					queryKey: overviewQuery.queryKey,
				}),
		}),
	);
	const { dataUpdatedAt } = overview;
	const onImageError = useCallback(
		() => refreshImages(dataUpdatedAt),
		[refreshImages, dataUpdatedAt],
	);
	return (
		<ImageErrorContext value={onImageError}>
			<OverviewContent overview={overview} />
		</ImageErrorContext>
	);
}

function OverviewContent({
	overview,
}: {
	overview: UseQueryResult<PrOverview>;
}) {
	return (
		<div className="space-y-6">
			{overview.isPending && (
				<p className="text-muted">Loading the PR from GitHub…</p>
			)}
			{overview.isError && <ErrorMessage error={overview.error} />}
			{overview.data && (
				<>
					<WhatItDoes pr={overview.data} />
					<WhosOnIt pr={overview.data} />
					<IsItReady pr={overview.data} />
				</>
			)}
			<ReviewFilesButton />
		</div>
	);
}

function Section(props: { label: string; children: ReactNode }) {
	return (
		<section
			aria-label={props.label}
			className="rounded-xl border border-line bg-surface"
		>
			<h2 className="rounded-t-xl border-b border-line bg-raised px-4 py-3 text-center text-[0.8125rem] font-semibold tracking-[0.2em] text-label uppercase">
				{props.label}
			</h2>
			<div className="space-y-4 px-4 py-3">{props.children}</div>
		</section>
	);
}

type BadgeTone = "gray" | "red" | "yellow" | "green" | "purple";

function Badge(props: { tone: BadgeTone; icon?: Icon; children: ReactNode }) {
	const tones = {
		gray: "border-line-strong/60 bg-overlay text-ink-soft",
		red: "border-bad/40 bg-bad/10 text-bad",
		yellow: "border-warn/40 bg-warn/10 text-warn",
		green: "border-ok/40 bg-ok/10 text-ok",
		purple: "border-done/40 bg-done/10 text-done",
	};
	const IconEl = props.icon;
	return (
		<span
			className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tones[props.tone]}`}
		>
			{IconEl && <IconEl size={12} aria-hidden />}
			{props.children}
		</span>
	);
}

/**
 * An icon that carries meaning. Named for screen readers; its name shows in a
 * tooltip on hover, keyboard focus and tap (a 40px-tall hit area that stops at the usual 8px gap).
 */
function LabeledIcon(props: {
	icon: Icon;
	label: string;
	size?: 12 | 16;
	/** Shown after the icon (e.g. a count); the label stays the name. */
	text?: string;
	className?: string;
}) {
	const IconEl = props.icon;
	return (
		<Tooltip content={props.label} describe={false}>
			{(trigger) => (
				<span
					{...trigger}
					role="img"
					aria-label={props.label}
					// Focusable so keyboard and touch users can read the tooltip.
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className={`relative inline-flex shrink-0 cursor-help items-center rounded-sm after:absolute after:top-1/2 after:left-1/2 after:h-10 after:w-8 after:-translate-x-1/2 after:-translate-y-1/2 focus-visible:outline-2 focus-visible:outline-accent ${props.className ?? ""}`}
				>
					<IconEl size={props.size ?? 16} aria-hidden />
					{props.text && <span aria-hidden>{props.text}</span>}
				</span>
			)}
		</Tooltip>
	);
}

function BotIcon() {
	return <LabeledIcon icon={HubotIcon} label="bot" className="text-muted" />;
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

/** The PR on GitHub, as GitHub's mark (40×40 tap target). */
function GithubLink({ url }: { url: string }) {
	const href = safeHref(url);
	if (!href) return null;
	return (
		<Tooltip content="View on GitHub" describe={false}>
			{(trigger) => (
				<a
					{...trigger}
					href={href}
					target="_blank"
					rel="noreferrer noopener"
					aria-label="View on GitHub"
					className="-my-2 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
				>
					<MarkGithubIcon size={20} aria-hidden />
				</a>
			)}
		</Tooltip>
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

function WhatItDoes({ pr }: { pr: PrOverview }) {
	const stateBadge = pr.state === "OPEN" ? undefined : STATE_BADGE[pr.state];
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
					{pr.updatedAt && pr.updatedAt !== pr.createdAt && (
						<span>
							updated <RelativeTime iso={pr.updatedAt} />
						</span>
					)}
				</p>
			</div>
			<Description pr={pr} />
		</Section>
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

const REVIEW_ICON: Record<
	Review["state"],
	{ icon: Icon; label: string; className: string }
> = {
	APPROVED: { icon: CheckIcon, label: "Approved", className: "text-ok" },
	CHANGES_REQUESTED: {
		icon: FileDiffIcon,
		label: "Changes requested",
		className: "text-bad",
	},
	COMMENTED: {
		icon: CommentIcon,
		label: "Commented",
		className: "text-muted",
	},
	DISMISSED: {
		icon: SkipIcon,
		label: "Dismissed",
		className: "text-muted",
	},
};

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

function IsItReady({ pr }: { pr: PrOverview }) {
	return (
		<Section label="Is it ready">
			<Checks pr={pr} />
			<ThreadGroup
				label="Human reviews"
				icon={CommentDiscussionIcon}
				threads={pr.threads.filter((t) => !t.bot)}
				asOf={Boolean(pr.asOf)}
			/>
			<ThreadGroup
				label="Bot reviews"
				icon={HubotIcon}
				threads={pr.threads.filter((t) => t.bot)}
				asOf={Boolean(pr.asOf)}
			/>
		</Section>
	);
}

/**
 * A chip with a tooltip. Interactive (`onClick`) chips are buttons; the rest
 * take focus only so keyboard and touch users can read the tooltip. Either
 * way the hit area is 40px tall.
 */
function Chip(props: {
	tone: BadgeTone;
	icon: Icon;
	tip: string;
	children: ReactNode;
	testId?: string;
	/** A disclosure (`expanded`, with a caret) or a two-state button (`pressed`). */
	toggle?: {
		expanded?: boolean;
		pressed?: boolean;
		/** Inert but still focusable, so its tip can say why. */
		disabled?: boolean;
		controls?: string;
		onClick: () => void;
	};
	/** Keep the tip a description even on a toggle (it explains, not instructs). */
	describeTip?: boolean;
}) {
	const { toggle } = props;
	const className =
		"inline-flex min-h-10 items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
	const badge = (
		<Badge tone={props.tone} icon={props.icon}>
			{props.children}
			{toggle?.expanded !== undefined && (
				<TriangleDownIcon
					size={12}
					aria-hidden
					className={`-mr-0.5 transition-transform motion-reduce:transition-none ${toggle.expanded ? "rotate-180" : ""}`}
				/>
			)}
		</Badge>
	);
	return (
		// A toggle's tip only says what pressing does; its state is aria-expanded.
		<Tooltip
			content={props.tip}
			hoverDelay={400}
			describe={props.describeTip ?? !toggle}
		>
			{(trigger) =>
				toggle ? (
					<button
						type="button"
						{...trigger}
						data-testid={props.testId}
						aria-expanded={toggle.expanded}
						aria-pressed={toggle.pressed}
						aria-disabled={toggle.disabled || undefined}
						aria-controls={toggle.controls}
						onClick={toggle.disabled ? undefined : toggle.onClick}
						className={`${className} ${toggle.disabled ? "cursor-default" : "cursor-pointer hover:brightness-125"} ${toggle.pressed ? "[&>span]:ring-2 [&>span]:ring-current" : ""}`}
					>
						{badge}
					</button>
				) : (
					<span
						{...trigger}
						data-testid={props.testId}
						// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
						tabIndex={0}
						className={className}
					>
						{badge}
					</span>
				)
			}
		</Tooltip>
	);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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

/** Threads listed at first, and added by each "Load more". */
const THREAD_PAGE = 5;

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
	threads: Thread[];
	asOf: boolean;
}) {
	const { threads, asOf } = props;
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
				{threads.length === 0 ? (
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
	const clipped = thread.code ? codeExcerpt(thread.code).lines : [];
	const whole = thread.code
		? codeExcerpt(thread.code, Number.POSITIVE_INFINITY).lines
		: [];
	const excerpt = open ? whole : clipped;
	const line = headerLine(thread, clipped);
	// Opening also shows the hunk's earlier lines.
	const more = codeMore || commentMore || whole.length > clipped.length;
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
	const comment = thread.html.trim() ? (
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
			className="min-w-0 overflow-hidden rounded-lg border border-edge bg-surface"
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
				</div>
			</div>
			<div className="space-y-2 px-3 pt-1 pb-3">
				<ThreadPlace thread={thread} line={line} target={target} />
				{excerpt.length > 0 ? (
					<div className="grid gap-3 md:grid-cols-2 md:items-start">
						<ThreadCodePane
							ref={codeBox}
							id={codeId}
							path={thread.path}
							lines={excerpt}
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
						aria-controls={
							excerpt.length ? `${codeId} ${commentId}` : commentId
						}
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
 * The line number the header shows: the marked line's own number when the
 * code is shown (even if the range fell back to the hunk's last line),
 * else the server's.
 */
function headerLine(
	thread: Thread,
	clipped: (HunkLine & { marked: boolean })[],
): number | null {
	const { code } = thread;
	if (!code) return thread.line;
	// The comment's own side: the last shown line numbered on it (the marked
	// end, unless the range fell back to a line of the other side).
	const own = (l: HunkLine) => (code.side === "LEFT" ? l.oldNo : l.newNo);
	for (let i = clipped.length - 1; i >= 0; i--) {
		const l = clipped[i];
		const n = l ? own(l) : null;
		if (n !== null) return n;
	}
	return thread.line;
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
 * The code a comment was written on: the end of GitHub's diff hunk, the
 * commented lines marked by an accent rail. Clipped, it scrolls (sideways,
 * and down past six lines); opened, it shows the whole hunk, wrapped, and
 * keeps the commented lines in view.
 */
function ThreadCodePane(props: {
	ref: Ref<HTMLElement>;
	id: string;
	path: string;
	lines: (HunkLine & { marked: boolean })[];
	open: boolean;
	/** It overflows while clipped: focusable so the keyboard can scroll it. */
	scrollable: boolean;
}) {
	const table = useRef<HTMLTableElement>(null);
	// Opened, the pane scrolls itself (never the window) to the marked range:
	// its end at the bottom, or its start at the top when it doesn't fit.
	useLayoutEffect(() => {
		const pane = table.current?.parentElement;
		const marked = table.current?.querySelectorAll("[data-marked]");
		const first = marked?.[0];
		const last = marked?.[marked.length - 1];
		if (!props.open || !pane || !first || !last) return;
		const top = pane.getBoundingClientRect().top - pane.scrollTop;
		const firstTop = first.getBoundingClientRect().top - top;
		const lastBottom = last.getBoundingClientRect().bottom - top;
		pane.scrollTop = Math.max(
			0,
			Math.min(firstTop, lastBottom - pane.clientHeight),
		);
	}, [props.open]);
	return (
		<figure
			ref={props.ref}
			id={props.id}
			aria-label={`Code at ${props.path}`}
			data-testid="thread-code"
			tabIndex={props.scrollable ? 0 : undefined}
			// Clipped: six 20px lines, the border and a thin sideways scrollbar
			// fit without a vertical one. Opened: up to 24 lines (or 60% of
			// the screen), wrapped, so the comment stays beside its code.
			className={`min-w-0 overflow-auto rounded-md border border-line bg-code font-mono text-xs leading-5 text-code-ink [scrollbar-width:thin] focus-visible:outline-2 focus-visible:outline-accent ${props.open ? "max-h-[min(30.75rem,60vh)]" : "max-h-[8.75rem]"}`}
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
	if (!code) {
		return removed.map((text) => ({
			kind: "del",
			oldNo: null,
			newNo: null,
			text,
		}));
	}
	const own = codeExcerpt(code)
		.lines.filter((l) => l.marked)
		.filter((l) => (code.side === "LEFT" ? l.oldNo : l.newNo) !== null);
	if (
		own.length !== removed.length ||
		own.some((l, i) => strip(l.text) !== strip(removed[i] ?? ""))
	) {
		return null;
	}
	return own.map((l) => ({
		kind: "del",
		oldNo: code.side === "LEFT" ? l.oldNo : l.newNo,
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
