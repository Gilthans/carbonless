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
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { PrOverview, Progress } from "../../shared/types";
import { overviewQuery, reviewQuery } from "../api";
import { GithubHtml } from "../GithubHtml";
import { RelativeTime } from "../RelativeTime";
import { ErrorMessage, safeHref } from "../ui";

type Review = PrOverview["reviews"][number];
type Check = PrOverview["checks"][number];
type Thread = PrOverview["threads"][number];

export function OverviewPage() {
	const overview = useQuery(overviewQuery);
	return (
		<div className="space-y-6">
			<ReviewFilesButton />
			{overview.isPending && (
				<p className="text-slate-500">Loading the PR from GitHub…</p>
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
			className="rounded-lg border border-slate-200"
		>
			<h2 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-base font-semibold">
				{props.label}
			</h2>
			<div className="space-y-4 px-4 py-3">{props.children}</div>
		</section>
	);
}

function Badge(props: {
	tone: "gray" | "red" | "yellow" | "green" | "purple";
	icon?: Icon;
	/** Tooltip, when the badge's text alone is terse. */
	title?: string;
	children: ReactNode;
}) {
	const tones = {
		gray: "border-slate-300 bg-slate-100 text-slate-700",
		red: "border-red-200 bg-red-50 text-red-800",
		yellow: "border-amber-200 bg-amber-50 text-amber-800",
		green: "border-green-200 bg-green-50 text-green-800",
		purple: "border-purple-200 bg-purple-50 text-purple-800",
	};
	const IconEl = props.icon;
	return (
		<span
			title={props.title}
			className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tones[props.tone]}`}
		>
			{IconEl && <IconEl size={12} aria-hidden />}
			{props.children}
		</span>
	);
}

/** An icon that carries meaning: named for screen readers, titled for the mouse. */
function LabeledIcon(props: { icon: Icon; label: string; className?: string }) {
	const IconEl = props.icon;
	return (
		<span
			role="img"
			aria-label={props.label}
			title={props.label}
			className={`inline-flex shrink-0 items-center ${props.className ?? ""}`}
		>
			<IconEl size={16} aria-hidden />
		</span>
	);
}

function BotIcon() {
	return (
		<LabeledIcon icon={HubotIcon} label="bot" className="text-slate-500" />
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
			className="text-blue-700 hover:underline"
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
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			aria-label="View on GitHub"
			title="View on GitHub"
			className="-my-2 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-slate-700 hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-blue-600"
		>
			<MarkGithubIcon size={20} aria-hidden />
		</a>
	);
}

function ReviewFilesButton() {
	const review = useQuery(reviewQuery);
	return (
		<div className="flex flex-wrap items-center gap-3">
			<Link
				to="/files"
				className="inline-flex items-center gap-2 rounded-md bg-green-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
			>
				Review files
				{review.data && (
					<span className="rounded-full bg-white/20 px-2 text-xs">
						{progressText(review.data.progress)}
					</span>
				)}
			</Link>
			{review.isPending && (
				<span className="text-sm text-slate-500">Loading progress…</span>
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
					<h3 className="min-w-0 flex-1 text-lg font-semibold break-words">
						{pr.title}
					</h3>
					<GithubLink url={pr.url} />
				</div>
				<p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600">
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
					<span className="font-medium text-slate-900">{pr.author}</span>
					<code
						title={`Merge ${pr.headBranch} into ${pr.baseBranch}`}
						className="rounded bg-slate-100 px-1 [overflow-wrap:anywhere]"
					>
						{pr.baseBranch} ← {pr.headBranch}
					</code>
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
	return <p className="text-sm text-slate-500 italic">No description</p>;
}

// ---- Who's on it ----

const REVIEW_ICON: Record<
	Review["state"],
	{ icon: Icon; label: string; className: string }
> = {
	APPROVED: { icon: CheckIcon, label: "Approved", className: "text-green-700" },
	CHANGES_REQUESTED: {
		icon: FileDiffIcon,
		label: "Changes requested",
		className: "text-red-700",
	},
	COMMENTED: {
		icon: CommentIcon,
		label: "Commented",
		className: "text-slate-500",
	},
	DISMISSED: {
		icon: SkipIcon,
		label: "Dismissed",
		className: "text-slate-500",
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
				<LabeledIcon
					icon={then.icon}
					label={`then ${then.label.toLowerCase()}`}
					className="text-slate-400"
				/>
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
			<h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
				<IconEl size={16} aria-hidden className="text-slate-500" />
				{props.title}
			</h3>
			{props.children}
		</div>
	);
}

function None() {
	return <p className="mt-1 text-sm text-slate-400">None</p>;
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
						<EyeIcon size={16} aria-hidden className="text-amber-600" />
						{`${names.length ? names.join(", ") : "Someone else"} already started`}
					</>
				) : (
					<>
						<CheckCircleIcon size={16} aria-hidden className="text-green-700" />
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
										className="text-xs text-slate-500"
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
											className="text-slate-500"
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
									<RelativeTime
										iso={c.lastAt}
										className="text-xs text-slate-500"
									/>
								</li>
							))}
						</ul>
					) : (
						<None />
					)}
				</Column>
			</div>
			<p className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
				<span className="font-semibold">You</span>
				{yourReview ? (
					<>
						<ReviewState review={yourReview} />
						<RelativeTime
							iso={yourReview.submittedAt}
							className="text-xs text-slate-500"
						/>
					</>
				) : youCommented ? (
					<LabeledIcon
						icon={CommentIcon}
						label="Commented"
						className="text-slate-500"
					/>
				) : (
					<span className="text-slate-500">not started on GitHub</span>
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
						<Badge
							tone="gray"
							icon={QuestionIcon}
							title="GitHub hasn't computed mergeability yet"
						>
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
	failing: { icon: XIcon, className: "text-red-700" },
	pending: { icon: DotFillIcon, className: "text-amber-600" },
	passing: { icon: CheckIcon, className: "text-green-700" },
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
			<h3 className="text-sm font-semibold text-slate-700">Checks</h3>
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
							<summary className="flex min-h-10 cursor-pointer items-center gap-2 text-slate-600 sm:min-h-0">
								<CheckIcon size={16} aria-hidden className="text-green-700" />
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
		<li className="min-w-0 rounded-md border border-slate-200 px-3 py-2">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
				<code className="break-all">
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
							className="shrink-0 text-slate-500 transition-transform group-open:rotate-90"
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
				<IconEl size={16} aria-hidden className="text-slate-500" />
				{props.label}
				<span className="text-slate-500">({props.threads.length})</span>
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
			<h3 className="text-sm font-semibold text-slate-700">
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
