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
	MarkGithubIcon,
	PeopleIcon,
	QuestionIcon,
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
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
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
			{overview.isPending && (
				<p className="text-muted">Loading the PR from GitHub…</p>
			)}
			{overview.isError && <ErrorMessage error={overview.error} />}
			{overview.data && (
				<>
					<WhatItDoes pr={overview.data} />
					<WhosOnIt pr={overview.data} />
					<IsItReady pr={overview.data} />
					<ThreadGroup
						label="Human reviews"
						threads={overview.data.threads.filter((t) => !t.bot)}
						resolved={overview.data.resolved.human}
					/>
					<ThreadGroup
						label="Bot reviews"
						threads={overview.data.threads.filter((t) => t.bot)}
						resolved={overview.data.resolved.bot}
					/>
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
			<h2 className="border-b border-line px-4 py-2.5 text-xs font-semibold tracking-[0.18em] text-label uppercase">
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
	toggle?: { expanded: boolean; controls: string; onClick: () => void };
}) {
	const { toggle } = props;
	const className =
		"inline-flex min-h-10 items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
	const badge = (
		<Badge tone={props.tone} icon={props.icon}>
			{props.children}
			{toggle && (
				<TriangleDownIcon
					size={12}
					aria-hidden
					className={`-mr-0.5 transition-transform motion-reduce:transition-none ${toggle.expanded ? "rotate-180" : ""}`}
				/>
			)}
		</Badge>
	);
	return (
		<Tooltip content={props.tip} hoverDelay={400}>
			{(trigger) =>
				toggle ? (
					<button
						type="button"
						{...trigger}
						data-testid={props.testId}
						aria-expanded={toggle.expanded}
						aria-controls={toggle.controls}
						onClick={toggle.onClick}
						className={`${className} cursor-pointer hover:brightness-125`}
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
				<h3 className="mr-1 text-sm font-semibold text-ink-soft">Checks</h3>
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
				<ul id={listId} aria-label="Checks" className="mt-1 space-y-1 text-sm">
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
			tip="GitHub hasn't worked out whether it merges cleanly"
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

/** One group's review threads: resolved ones counted, unresolved ones listed. */
function ThreadGroup(props: {
	label: string;
	threads: Thread[];
	resolved: number;
}) {
	const { threads, resolved } = props;
	return (
		<Section label={props.label}>
			{threads.length === 0 && resolved === 0 ? (
				<p className="text-sm text-faint">No threads</p>
			) : (
				<ul aria-label="Thread counts" className="flex flex-wrap gap-2">
					{threads.length > 0 && (
						<li>
							<Badge tone="yellow" icon={CommentDiscussionIcon}>
								{threads.length} unresolved
							</Badge>
						</li>
					)}
					<li>
						<Badge tone={resolved ? "green" : "gray"} icon={CheckIcon}>
							{resolved} resolved
						</Badge>
					</li>
				</ul>
			)}
			{threads.length > 0 && (
				<ul aria-label="Unresolved threads" className="space-y-3">
					{threads.map((t, i) => (
						// Threads have no id; their order is stable per response.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above.
						<ThreadItem key={i} thread={t} />
					))}
				</ul>
			)}
		</Section>
	);
}

/**
 * One unresolved thread: where, who, when, how many comments, whether anyone
 * answered, and the first comment as GitHub renders it, clipped.
 */
function ThreadItem({ thread }: { thread: Thread }) {
	const n = thread.commentCount;
	return (
		<li
			data-testid="thread"
			className="min-w-0 space-y-2 rounded-lg border border-line bg-raised px-3 py-3"
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
				<code className="font-mono break-all text-ink-soft">
					{thread.path}
					{thread.line !== null && `:${thread.line}`}
				</code>
				<span className="inline-flex items-center gap-1 text-ink-soft">
					{thread.author}
					{thread.bot && <BotIcon />}
				</span>
				<RelativeTime iso={thread.createdAt} />
				<LabeledIcon
					icon={CommentIcon}
					label={plural(n, "comment")}
					text={String(n)}
					className="gap-1 text-muted"
				/>
				{!thread.hasReply && (
					<Badge tone="yellow" icon={CommentIcon}>
						no reply
					</Badge>
				)}
				{thread.outdated && (
					<Badge tone="gray" icon={HistoryIcon}>
						outdated
					</Badge>
				)}
			</div>
			{thread.html.trim() ? (
				<ClippedHtml html={thread.html} />
			) : (
				<p className="text-sm break-words">{thread.excerpt}</p>
			)}
		</li>
	);
}

/**
 * GitHub's HTML cut to about six lines with a fade, and a toggle to show it
 * all (only when there is more). Focus moving inside opens it, so a keyboard
 * user never lands on a clipped link.
 */
function ClippedHtml({ html }: { html: string }) {
	const [open, setOpen] = useState(false);
	const [more, setMore] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	const id = useId();
	useLayoutEffect(() => {
		const el = box.current;
		if (!el || open) return;
		const measure = () => setMore(el.scrollHeight > el.clientHeight + 1);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		const inner = el.firstElementChild;
		if (inner) observer.observe(inner);
		return () => observer.disconnect();
	}, [open]);
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const reveal = () => setOpen(true);
		el.addEventListener("focusin", reveal);
		return () => el.removeEventListener("focusin", reveal);
	}, []);
	const clipped = more && !open;
	return (
		<div>
			<div
				ref={box}
				id={id}
				data-testid="thread-body"
				className={`relative ${open ? "" : "max-h-32 overflow-hidden"}`}
			>
				<GithubHtml html={html} />
				{clipped && (
					<div
						aria-hidden
						className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-raised"
					/>
				)}
			</div>
			{(more || open) && (
				<button
					type="button"
					aria-expanded={open}
					aria-controls={id}
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
	);
}
