import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PrOverview, Progress } from "../../shared/types";
import { overviewQuery, reviewQuery } from "../api";
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
	tone: "gray" | "red" | "yellow" | "green";
	children: ReactNode;
}) {
	const tones = {
		gray: "border-slate-300 bg-slate-100 text-slate-700",
		red: "border-red-200 bg-red-50 text-red-800",
		yellow: "border-amber-200 bg-amber-50 text-amber-800",
		green: "border-green-200 bg-green-50 text-green-800",
	};
	return (
		<span
			className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${tones[props.tone]}`}
		>
			{props.children}
		</span>
	);
}

function When({ iso }: { iso: string }) {
	const date = new Date(iso);
	if (!iso || Number.isNaN(date.getTime())) return null;
	return <time dateTime={iso}>{date.toLocaleString()}</time>;
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
			rel="noreferrer"
			className="text-blue-700 hover:underline"
		>
			{props.children}
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
	return `${reviewed} / ${denominator} · ${percent}%`;
}

// ---- What it does ----

/**
 * The description is untrusted: no raw HTML (react-markdown drops it without
 * rehype-raw), its default urlTransform strips javascript: URLs, links go
 * through safeHref, and images become links so nothing loads on its own.
 */
const markdownComponents: Components = {
	a: ({ href, children }) => (
		<ExternalLink href={href}>{children}</ExternalLink>
	),
	img: ({ src, alt }) => (
		<ExternalLink href={typeof src === "string" ? src : undefined}>
			{alt ? `[image: ${alt}]` : "[image]"}
		</ExternalLink>
	),
};

const markdownClass =
	"max-w-none overflow-x-auto break-words text-sm leading-6 [&_blockquote]:border-l-4 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:text-slate-600 [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-slate-100 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:border-collapse [&_td]:border [&_td]:border-slate-300 [&_td]:px-2 [&_th]:border [&_th]:border-slate-300 [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ul.contains-task-list]:list-none [&_ul.contains-task-list]:pl-1";

function WhatItDoes({ pr }: { pr: PrOverview }) {
	return (
		<Section label="What it does">
			<div>
				<h3 className="text-lg font-semibold break-words">{pr.title}</h3>
				<p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600">
					{pr.isDraft && <Badge tone="gray">Draft</Badge>}
					{pr.state !== "OPEN" && (
						<Badge tone="gray">
							{pr.state === "MERGED" ? "Merged" : "Closed"}
						</Badge>
					)}
					<span>
						<span className="font-medium text-slate-900">{pr.author}</span>{" "}
						wants to merge{" "}
						<code className="rounded bg-slate-100 px-1 [overflow-wrap:anywhere]">
							{pr.baseBranch} ← {pr.headBranch}
						</code>
					</span>
					<span>
						opened <When iso={pr.createdAt} />, updated{" "}
						<When iso={pr.updatedAt} />
					</span>
					<ExternalLink href={pr.url}>View on GitHub</ExternalLink>
				</p>
			</div>
			{pr.body.trim() ? (
				<div className={markdownClass}>
					<Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
						{pr.body}
					</Markdown>
				</div>
			) : (
				<p className="text-sm text-slate-500 italic">
					No description provided.
				</p>
			)}
		</Section>
	);
}

// ---- Who's on it ----

const REVIEW_LABEL: Record<Review["state"], string> = {
	APPROVED: "Approved",
	CHANGES_REQUESTED: "Changes requested",
	COMMENTED: "Commented",
	DISMISSED: "Dismissed",
};
const REVIEW_TONE = {
	APPROVED: "green",
	CHANGES_REQUESTED: "red",
	COMMENTED: "gray",
	DISMISSED: "gray",
} as const;

/** Approval or change request first: a later plain comment doesn't hide it. */
function ReviewBadge({ review }: { review: Review }) {
	const shown = review.opinion ?? review.state;
	return (
		<>
			<Badge tone={REVIEW_TONE[shown]}>{REVIEW_LABEL[shown]}</Badge>
			{review.opinion && review.state !== review.opinion && (
				<span className="text-xs text-slate-500">
					then {REVIEW_LABEL[review.state].toLowerCase()}
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
			<p className="font-medium">
				{pr.humanStarted
					? `${names.length ? names.join(", ") : "Someone else"} already started`
					: "No one else has started reviewing"}
			</p>
			<div className="grid gap-4 sm:grid-cols-3">
				<div>
					<h3 className="text-sm font-semibold text-slate-700">Reviews</h3>
					{reviewers.length ? (
						<ul aria-label="Reviews" className="mt-1 space-y-1 text-sm">
							{reviewers.map((r) => (
								<li
									key={r.author}
									className="flex flex-wrap items-center gap-2"
								>
									<span>{r.author}</span>
									{r.bot && <Badge tone="gray">bot</Badge>}
									<ReviewBadge review={r} />
									<span className="text-xs text-slate-500">
										<When iso={r.submittedAt} />
									</span>
								</li>
							))}
						</ul>
					) : (
						<p className="mt-1 text-sm text-slate-500">No reviews yet</p>
					)}
				</div>
				<div>
					<h3 className="text-sm font-semibold text-slate-700">
						Requested, not reviewed yet
					</h3>
					{waiting.length ? (
						<ul
							aria-label="Requested reviewers"
							className="mt-1 space-y-1 text-sm"
						>
							{waiting.map((r) => (
								<li key={r.name}>
									{r.name}
									{r.team && <span className="text-slate-500"> (team)</span>}
								</li>
							))}
						</ul>
					) : (
						<p className="mt-1 text-sm text-slate-500">No one</p>
					)}
				</div>
				<div>
					<h3 className="text-sm font-semibold text-slate-700">Commented</h3>
					{commenters.length ? (
						<ul aria-label="Commenters" className="mt-1 space-y-1 text-sm">
							{commenters.map((c) => (
								<li
									key={c.author}
									className="flex flex-wrap items-center gap-2"
								>
									<span>{c.author}</span>
									{c.bot && <Badge tone="gray">bot</Badge>}
									<span className="text-xs text-slate-500">
										<When iso={c.lastAt} />
									</span>
								</li>
							))}
						</ul>
					) : (
						<p className="mt-1 text-sm text-slate-500">No one</p>
					)}
				</div>
			</div>
			<p className="text-sm text-slate-700">
				<span className="font-semibold">You: </span>
				{yourReview ? (
					<span className="inline-flex items-center gap-2">
						<ReviewBadge review={yourReview} />
					</span>
				) : youCommented ? (
					"commented"
				) : (
					"not started on GitHub"
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
						<Badge tone="yellow">Draft</Badge>
					</li>
				)}
				<li>
					{pr.mergeable === "CONFLICTING" ? (
						<Badge tone="red">Has merge conflicts</Badge>
					) : pr.mergeable === "MERGEABLE" ? (
						<Badge tone="green">No merge conflicts</Badge>
					) : (
						<Badge tone="gray">Merge conflicts unknown</Badge>
					)}
				</li>
			</ul>
			<Checks checks={pr.checks} />
			<Threads threads={pr.threads} />
		</Section>
	);
}

const CHECK_ICON = { failing: "✗", pending: "●", passing: "✓" } as const;
const CHECK_COLOR = {
	failing: "text-red-700",
	pending: "text-amber-600",
	passing: "text-green-700",
} as const;

function CheckItem({ check }: { check: Check }) {
	return (
		<li data-testid="check" className="flex items-center gap-2">
			<span aria-hidden className={CHECK_COLOR[check.status]}>
				{CHECK_ICON[check.status]}
			</span>
			<ExternalLink href={check.url}>{check.name}</ExternalLink>
			<span className="text-xs text-slate-500">{check.status}</span>
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
				<p className="mt-1 text-sm text-slate-500">No checks</p>
			) : (
				<div className="mt-1 space-y-1 text-sm">
					<ul aria-label="Failing and pending checks" className="space-y-1">
						{[...failing, ...pending].map((c) => (
							<CheckItem key={`${c.status}:${c.name}`} check={c} />
						))}
					</ul>
					{passing.length > 0 && (
						<details>
							<summary className="cursor-pointer text-slate-600">
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

function ThreadItem({ thread }: { thread: Thread }) {
	return (
		<li className="rounded-md border border-slate-200 px-3 py-2">
			<div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
				<code className="break-all">
					{thread.path}
					{thread.line !== null && `:${thread.line}`}
				</code>
				<span>{thread.author}</span>
				{thread.outdated && <Badge tone="gray">outdated</Badge>}
			</div>
			<p className="mt-1 text-sm break-words whitespace-pre-wrap">
				{thread.excerpt}
			</p>
		</li>
	);
}

function ThreadList(props: { label: string; threads: Thread[] }) {
	return (
		<div>
			<h4 className="text-sm font-medium">
				{props.label}{" "}
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
				<p className="mt-1 text-sm text-slate-500">None</p>
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
				<p className="mt-1 text-sm text-slate-500">No unresolved threads</p>
			) : (
				<div className="mt-1 space-y-3">
					<div className="grid gap-3 sm:grid-cols-2">
						<ThreadList
							label="Bots/AI threads"
							threads={threads.filter((t) => t.bot)}
						/>
						<ThreadList
							label="Human threads"
							threads={threads.filter((t) => !t.bot)}
						/>
					</div>
					<ThreadList
						label="No reply"
						threads={threads.filter((t) => !t.hasReply)}
					/>
				</div>
			)}
		</div>
	);
}
