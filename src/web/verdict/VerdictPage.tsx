import {
	CheckCircleIcon,
	CheckIcon,
	ChevronDownIcon,
	CommentDiscussionIcon,
	DotFillIcon,
	GitBranchIcon,
	GitMergeIcon,
	HistoryIcon,
	type Icon,
	LinkExternalIcon,
	PersonIcon,
	QuestionIcon,
	StopIcon,
	XIcon,
} from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { PrOverview, SessionInfo, VerdictFacts } from "../../shared/types";
import { overviewQuery, sessionQuery, verdictQuery } from "../api";
import {
	BotIcon,
	LabeledIcon,
	REVIEW_ICON,
	SkeletonBar,
} from "../overview/parts";
import { RelativeTime } from "../RelativeTime";
import { Tooltip } from "../Tooltip";
import { useThreads } from "../threads/useThreads";
import { ErrorMessage, safeHref } from "../ui";
import {
	type BlockerRow,
	blockerCount,
	blockers,
	type GithubStatus,
	githubStatus,
} from "./blockers";
import { VerdictCard } from "./VerdictCard";

const TONE_TEXT = {
	bad: "text-bad",
	warn: "text-warn",
	unknown: "text-muted",
	ok: "text-ok",
} as const;

/** A row's icon: its kind (and a check's state), its color the tone. */
function rowIcon(row: BlockerRow): { icon: Icon; label: string } {
	switch (row.kind) {
		case "check":
			return row.text.endsWith("failing")
				? { icon: XIcon, label: "Check failing" }
				: { icon: DotFillIcon, label: "Check running" };
		case "thread":
			return { icon: CommentDiscussionIcon, label: "Unresolved thread" };
		case "person":
			return row.tone === "unknown"
				? { icon: QuestionIcon, label: "Unknown" }
				: { icon: PersonIcon, label: "Review" };
		case "branch":
			return { icon: GitBranchIcon, label: "Branch" };
		case "ready":
			return { icon: GitMergeIcon, label: "Ready to merge" };
		default:
			return { icon: CheckIcon, label: "Fine" };
	}
}

const LINK =
	"rounded-sm text-ink hover:text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent";

/** "Required by GitHub": the merge waits for it. */
function RequiredTag() {
	return (
		<Tooltip content="GitHub won't merge without it">
			{(trigger) => (
				<span
					{...trigger}
					data-testid="required-tag"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className="inline-flex min-h-10 shrink-0 items-center focus-visible:outline-2 focus-visible:outline-accent"
				>
					<span className="rounded-full border border-bad/50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-bad">
						Required by GitHub
					</span>
				</span>
			)}
		</Tooltip>
	);
}

function RowText({ row }: { row: BlockerRow }) {
	const href = safeHref(row.href);
	const body = (
		<>
			{row.detail && row.kind === "thread" && (
				<span className="block font-mono text-xs break-all text-link">
					{row.detail}
				</span>
			)}
			<span className="break-words">{row.text}</span>
		</>
	);
	if (row.threadId) {
		return (
			<Link to="/" search={{ thread: row.threadId }} className={LINK}>
				{body}
			</Link>
		);
	}
	if (href) {
		return (
			<a
				href={href}
				target="_blank"
				rel="noreferrer noopener"
				className={`${LINK} inline-flex items-center gap-1`}
			>
				{body}
				<LinkExternalIcon size={12} aria-hidden className="text-muted" />
			</a>
		);
	}
	return <span>{body}</span>;
}

function Row({ row }: { row: BlockerRow }) {
	const { icon, label } = rowIcon(row);
	const muted = row.kind === "summary";
	return (
		<li
			data-testid="blocker"
			data-kind={row.kind}
			data-tone={row.tone}
			data-required={row.required || undefined}
			className="flex min-h-11 items-center gap-2.5 px-4 py-1.5 text-sm"
		>
			<LabeledIcon icon={icon} label={label} className={TONE_TEXT[row.tone]} />
			<div
				className={`min-w-0 flex-1 ${muted ? "text-muted" : ""} ${row.kind === "ready" ? "font-semibold text-ok" : ""}`}
			>
				<RowText row={row} />
				{row.detail && row.kind !== "thread" && (
					<span className="block text-xs text-muted">{row.detail}</span>
				)}
			</div>
			{(row.who || row.at) && (
				<span className="shrink-0 text-xs whitespace-nowrap text-muted">
					{row.who}
					{row.who && row.at ? " · " : ""}
					{row.at && <RelativeTime iso={row.at} />}
				</span>
			)}
			{row.required && <RequiredTag />}
		</li>
	);
}

function MoreRow({ row }: { row: BlockerRow }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	return (
		<>
			<li className="px-2">
				<button
					type="button"
					aria-expanded={open}
					aria-controls={id}
					onClick={() => setOpen(!open)}
					className="flex min-h-10 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
				>
					<ChevronDownIcon
						size={16}
						aria-hidden
						className={open ? "rotate-180" : ""}
					/>
					{row.text}
				</button>
			</li>
			{open && (
				<li id={id}>
					<ul className="divide-y divide-line border-t border-line">
						{row.more?.map((r) => (
							<Row key={r.id} row={r} />
						))}
					</ul>
				</li>
			)}
		</>
	);
}

const STATUS_STYLE: Record<GithubStatus["tone"], { box: string; icon: Icon }> =
	{
		ok: { box: "border-ok/40 bg-ok/10 text-ok", icon: CheckCircleIcon },
		bad: { box: "border-bad/40 bg-bad/10 text-bad", icon: StopIcon },
		warn: { box: "border-warn/40 bg-warn/10 text-warn", icon: DotFillIcon },
		unknown: {
			box: "border-line-strong bg-overlay text-ink-soft",
			icon: QuestionIcon,
		},
		asof: { box: "border-warn/40 bg-warn/10 text-warn", icon: HistoryIcon },
		done: { box: "border-done/40 bg-done/10 text-done", icon: GitMergeIcon },
	};

/** GitHub's own verdict, first and prominent: why is the list under it. */
function StatusLine(props: { status: GithubStatus; required: number }) {
	const { status } = props;
	const style = STATUS_STYLE[status.tone];
	const IconEl = style.icon;
	return (
		<p
			data-testid="github-status"
			data-tone={status.tone}
			className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-3 ${style.box}`}
		>
			<IconEl size={20} aria-hidden className="shrink-0" />
			<span className="font-display text-lg font-semibold">
				{status.tone === "asof" ? (
					<>
						As of <RelativeTime iso={status.asOf} />
					</>
				) : (
					status.text
				)}
			</span>
			{status.tone === "bad" && props.required > 0 && (
				<span className="text-sm text-ink-soft">{props.required} required</span>
			)}
		</p>
	);
}

function Blockers(props: {
	facts: VerdictFacts;
	overview: PrOverview;
	session: SessionInfo;
	threads: ReturnType<typeof useThreads>;
}) {
	const { facts, overview } = props;
	const rows = blockers(
		facts,
		overview,
		props.threads.view?.threads,
		props.session.viewer,
	);
	const status = githubStatus(facts, overview);
	const required = rows.filter((r) => r.required && r.tone === "bad").length;
	const headingId = useId();
	const n = blockerCount(rows);
	return (
		<>
			<StatusLine status={status} required={required} />
			{rows.length > 0 && (
				<section
					aria-labelledby={headingId}
					className="overflow-hidden rounded-xl border border-line bg-surface"
				>
					<h2
						id={headingId}
						className="border-b border-line bg-raised px-4 py-3 text-[0.8125rem] font-semibold tracking-[0.2em] text-label uppercase"
					>
						{n > 0 ? `Blockers · ${n}` : "Blockers"}
					</h2>
					{props.threads.error && (
						<div className="px-4 pt-2">
							<ErrorMessage error={props.threads.error} />
						</div>
					)}
					{!props.threads.view && !props.threads.error && (
						<div className="px-4 pt-3">
							<SkeletonBar className="w-1/2" />
						</div>
					)}
					<ul aria-label="Blockers" className="divide-y divide-line">
						{rows.map((r) =>
							r.kind === "more" ? (
								<MoreRow key={r.id} row={r} />
							) : (
								<Row key={r.id} row={r} />
							),
						)}
					</ul>
				</section>
			)}
		</>
	);
}

type ReviewRow = VerdictFacts["reviews"][number];

/**
 * Every reviewer's verdict, one row each (owner: "verdict screen should
 * list all existing approvals separately, as well as my own verdict"):
 * the viewer's first, marked "you", then the others newest first, bots
 * apart at the end. Each row: the state's icon and colour, the name
 * (linking to the review on GitHub when known), when, and "earlier push"
 * when it was on another commit than the head. None at all: no section.
 */
export function Reviews({ facts }: { facts: VerdictFacts }) {
	const headingId = useId();
	if (facts.reviews.length === 0) return null;
	const people = [
		...facts.reviews.filter((r) => r.you),
		...facts.reviews.filter((r) => !r.you && !r.bot),
	];
	const bots = facts.reviews.filter((r) => !r.you && r.bot);
	const count = (state: ReviewRow["state"]) =>
		facts.reviews.filter((r) => r.state === state).length;
	const approved = count("APPROVED");
	const changes = count("CHANGES_REQUESTED");
	return (
		<section
			aria-labelledby={headingId}
			data-testid="verdict-reviews"
			className="overflow-hidden rounded-xl border border-line bg-surface"
		>
			<div className="flex flex-wrap items-center gap-x-3 border-b border-line bg-raised px-4 py-1.5">
				<h2
					id={headingId}
					className="py-1.5 text-[0.8125rem] font-semibold tracking-[0.2em] text-label uppercase"
				>
					Reviews
				</h2>
				{approved > 0 && (
					<LabeledIcon
						icon={REVIEW_ICON.APPROVED.icon}
						label={`${approved} approved`}
						text={String(approved)}
						className={`gap-1 text-sm font-semibold ${REVIEW_ICON.APPROVED.className}`}
					/>
				)}
				{changes > 0 && (
					<LabeledIcon
						icon={REVIEW_ICON.CHANGES_REQUESTED.icon}
						label={`${changes} requested changes`}
						text={String(changes)}
						className={`gap-1 text-sm font-semibold ${REVIEW_ICON.CHANGES_REQUESTED.className}`}
					/>
				)}
			</div>
			<ul aria-label="Reviews" className="divide-y divide-line">
				{people.map((r) => (
					<ReviewLine key={r.author} review={r} head={facts.head} />
				))}
			</ul>
			{bots.length > 0 && (
				<ul
					aria-label="Bot reviews"
					className="divide-y divide-line border-t border-line-strong"
				>
					{bots.map((r) => (
						<ReviewLine key={r.author} review={r} head={facts.head} />
					))}
				</ul>
			)}
		</section>
	);
}

function ReviewLine({ review, head }: { review: ReviewRow; head: string }) {
	const shown = REVIEW_ICON[review.state];
	const href = safeHref(review.url);
	const dismissed = review.state === "DISMISSED";
	const name = <span className="break-all">{review.author}</span>;
	return (
		<li
			data-testid="review-row"
			data-state={review.state}
			data-you={review.you || undefined}
			className={`flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-0.5 px-4 py-1 text-sm ${dismissed ? "text-muted" : ""}`}
		>
			<LabeledIcon
				icon={shown.icon}
				label={shown.label}
				className={shown.className}
			/>
			{href ? (
				<a
					href={href}
					target="_blank"
					rel="noreferrer noopener"
					className={`${LINK} inline-flex min-h-10 min-w-0 items-center gap-1`}
				>
					{name}
					<LinkExternalIcon size={12} aria-hidden className="text-muted" />
				</a>
			) : (
				name
			)}
			{review.you && (
				<span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-ink-soft">
					you
				</span>
			)}
			{review.bot && <BotIcon />}
			<span className="ml-auto flex items-center gap-1.5 text-xs whitespace-nowrap text-muted">
				<RelativeTime iso={review.submittedAt} />
				{review.commitId !== "" && review.commitId !== head && (
					<span data-testid="review-earlier">· earlier push</span>
				)}
			</span>
		</li>
	);
}

/**
 * The Final Verdict tab (owner: "It should have all blockers to merging
 * the PR … This should allow us to approve or request changes"): GitHub's
 * status first, then one list of what stands in the way, every reviewer's
 * verdict, then the reviewer's own. Its GitHub read (`/api/verdict`) is made only once
 * this page shows; Refresh reads it again.
 */
export function VerdictPage() {
	const session = useQuery({ ...sessionQuery, enabled: false }).data;
	const overview = useQuery(overviewQuery);
	const facts = useQuery(verdictQuery);
	const threads = useThreads(overview.data?.readId);
	const pr = overview.data;
	return (
		<div data-testid="verdict-page" className="mx-auto max-w-3xl space-y-5">
			<h1 className="sr-only">Final verdict</h1>
			{overview.isError && <ErrorMessage error={overview.error} />}
			{facts.isError && <ErrorMessage error={facts.error} />}
			{(facts.isPending || overview.isPending) && !facts.isError && (
				<div
					data-testid="verdict-loading"
					aria-busy="true"
					className="space-y-2.5 rounded-xl border border-line bg-surface px-4 py-4"
				>
					<p className="sr-only">Reading GitHub…</p>
					<SkeletonBar className="w-1/3" />
					<SkeletonBar className="w-2/3" />
				</div>
			)}
			{facts.data && pr && session && (
				<Blockers
					facts={facts.data}
					overview={pr}
					session={session}
					threads={threads}
				/>
			)}
			{facts.data && <Reviews facts={facts.data} />}
			{pr && session && (
				<VerdictCard
					place="tab"
					facts={facts.data}
					overview={pr}
					session={session}
					threads={threads.view?.threads}
				/>
			)}
		</div>
	);
}
