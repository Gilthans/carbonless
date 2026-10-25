import {
	CheckCircleIcon,
	CheckIcon,
	ChevronRightIcon,
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
	MarkGithubIcon,
	PeopleIcon,
	PersonIcon,
	QuestionIcon,
	SkipIcon,
	XIcon,
} from "@primer/octicons-react";
import {
	type UseQueryResult,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useState } from "react";
import type { PrOverview, Progress } from "../../shared/types";
import { overviewQuery, reviewQuery } from "../api";
import { GithubHtml, ImageErrorContext } from "../GithubHtml";
import { RelativeTime } from "../RelativeTime";
import { Tooltip } from "../Tooltip";
import { ErrorMessage, safeHref } from "../ui";
import { createImageRefresher } from "./imageRefresh";

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
			<ReviewFilesButton />
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
		</div>
	);
}

function Section(props: { label: string; children: ReactNode }) {
	return (
		<section
			aria-label={props.label}
			className="rounded-xl border border-line bg-surface"
		>
			<h2 className="border-b border-line px-4 py-2.5 text-xs font-semibold tracking-[0.18em] text-label uppercase">
				{props.label}
			</h2>
			<div className="space-y-4 px-4 py-3">{props.children}</div>
		</section>
	);
}

function Badge(props: {
	tone: "gray" | "red" | "yellow" | "green" | "purple";
	icon?: Icon;
	children: ReactNode;
}) {
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
		<div className="flex flex-wrap items-center gap-3">
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
			<ul className="flex flex-wrap gap-2">
				{pr.isDraft && (
					<li>
						<Badge tone="yellow" icon={GitPullRequestDraftIcon}>
							Draft
						</Badge>
					</li>
				)}
				<li>
					{pr.mergeable === "CONFLICTING" ? (
						<Badge tone="red" icon={XIcon}>
							Merge conflicts
						</Badge>
					) : pr.mergeable === "MERGEABLE" ? (
						<Badge tone="green" icon={CheckIcon}>
							No conflicts
						</Badge>
					) : (
						<Badge tone="gray" icon={QuestionIcon}>
							Conflicts unknown
						</Badge>
					)}
				</li>
			</ul>
			<Checks checks={pr.checks} />
			<Threads threads={pr.threads} />
		</Section>
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

function Checks({ checks }: { checks: Check[] }) {
	const of = (status: Check["status"]) =>
		checks.filter((c) => c.status === status);
	const failing = of("failing");
	const pending = of("pending");
	const passing = of("passing");
	return (
		<div>
			<h3 className="text-sm font-semibold text-ink-soft">Checks</h3>
			{checks.length === 0 ? (
				<None />
			) : (
				<div className="mt-1 space-y-1 text-sm">
					{failing.length + pending.length > 0 && (
						<ul aria-label="Failing and pending checks" className="space-y-1">
							{[...failing, ...pending].map((c) => (
								<CheckItem key={`${c.status}:${c.name}`} check={c} />
							))}
						</ul>
					)}
					{passing.length > 0 && (
						<details>
							<summary className="flex min-h-10 cursor-pointer items-center gap-2 text-muted sm:min-h-0">
								<CheckIcon size={16} aria-hidden className="text-ok" />
								{passing.length} passing
							</summary>
							<ul aria-label="Passing checks" className="mt-1 space-y-1 pl-4">
								{passing.map((c) => (
									<CheckItem key={c.name} check={c} />
								))}
							</ul>
						</details>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * One unresolved thread: where, who, when, and the first comment as a short
 * plain-text preview that expands to the comment as GitHub renders it.
 */
function ThreadItem({ thread }: { thread: Thread }) {
	return (
		<li className="min-w-0 rounded-lg border border-line bg-raised px-3 py-2">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
				<code className="break-all text-ink-soft">
					{thread.path}
					{thread.line !== null && `:${thread.line}`}
				</code>
				<span className="inline-flex items-center gap-1">
					{thread.author}
					{thread.bot && <BotIcon />}
				</span>
				<RelativeTime iso={thread.createdAt} />
				{thread.outdated && (
					<Badge tone="gray" icon={HistoryIcon}>
						outdated
					</Badge>
				)}
			</div>
			{thread.html.trim() ? (
				<details className="group mt-1">
					<summary className="flex min-h-10 cursor-pointer list-none items-center gap-1 text-sm [&::-webkit-details-marker]:hidden">
						<ChevronRightIcon
							size={16}
							aria-hidden
							className="shrink-0 text-muted transition-transform group-open:rotate-90"
						/>
						<span className="line-clamp-2 min-w-0 break-words group-open:hidden">
							{thread.excerpt}
						</span>
						<span className="sr-only hidden group-open:inline">
							Hide comment
						</span>
					</summary>
					<GithubHtml html={thread.html} className="pb-1 pl-5" />
				</details>
			) : (
				<p className="mt-1 text-sm break-words">{thread.excerpt}</p>
			)}
		</li>
	);
}

function ThreadList(props: { label: string; icon: Icon; threads: Thread[] }) {
	const IconEl = props.icon;
	return (
		<div className="min-w-0">
			<h4 className="flex items-center gap-1.5 text-sm font-medium">
				<IconEl size={16} aria-hidden className="text-muted" />
				{props.label}
				<span className="text-muted">({props.threads.length})</span>
			</h4>
			{props.threads.length ? (
				<ul aria-label={props.label} className="mt-1 space-y-2">
					{props.threads.map((t, i) => (
						// Threads have no id; their order is stable per response.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above.
						<ThreadItem key={i} thread={t} />
					))}
				</ul>
			) : (
				<None />
			)}
		</div>
	);
}

function Threads({ threads }: { threads: Thread[] }) {
	return (
		<div>
			<h3 className="text-sm font-semibold text-ink-soft">
				Unresolved threads
			</h3>
			{threads.length === 0 ? (
				<None />
			) : (
				<div className="mt-1 space-y-3">
					<div className="grid gap-3 sm:grid-cols-2">
						<ThreadList
							label="Bots"
							icon={HubotIcon}
							threads={threads.filter((t) => t.bot)}
						/>
						<ThreadList
							label="Humans"
							icon={PersonIcon}
							threads={threads.filter((t) => !t.bot)}
						/>
					</div>
					<ThreadList
						label="No reply"
						icon={CommentDiscussionIcon}
						threads={threads.filter((t) => !t.hasReply)}
					/>
				</div>
			)}
		</div>
	);
}
