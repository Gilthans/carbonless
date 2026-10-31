import {
	ArrowRightIcon,
	BellIcon,
	CheckCircleIcon,
	CheckIcon,
	ClockIcon,
	CommentIcon,
	DotFillIcon,
	FileDiffIcon,
	GitCommitIcon,
	GitMergeIcon,
	GitPullRequestClosedIcon,
	LinkExternalIcon,
	NoteIcon,
	PinIcon,
	XCircleIcon,
	ZapIcon,
} from "@primer/octicons-react";
import { type ReactNode, useState } from "react";
import type {
	Coverage,
	HomeRow,
	Person,
	RowReview,
	SectionId,
} from "../../shared/home";
import { Meter } from "../files/ProgressBar";
import { fullDate, RelativeTime } from "../RelativeTime";
import { Tooltip } from "../Tooltip";
import { hashTint, TINTS } from "../threads/people";
import { safeHref } from "../ui";
import { useMedia } from "../useMedia";
import { prPath } from "./homeApi";

/** An icon (or a few) that means something: a tooltip and an accessible name. */
export function Sign(props: {
	label: string;
	className?: string;
	children: ReactNode;
	testId?: string;
	/**
	 * Takes focus, so a tap or the keyboard opens the tooltip: for signs
	 * whose tooltip says more than the icon (a snooze's full date).
	 */
	focusable?: boolean;
}) {
	return (
		<Tooltip content={props.label} describe={false}>
			{(trigger) => (
				<span
					{...trigger}
					role="img"
					aria-label={props.label}
					data-testid={props.testId}
					tabIndex={props.focusable ? 0 : undefined}
					// Above the row's stretched link, so its tooltip shows on hover.
					className={`relative z-10 inline-flex shrink-0 items-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-accent ${props.className ?? ""}`}
				>
					{props.children}
				</span>
			)}
		</Tooltip>
	);
}

/** A person's avatar; their initials on their tint while it loads or fails. */
export function Avatar(props: { person: Person; me?: boolean; size?: number }) {
	const { login, avatarUrl } = props.person;
	const [failed, setFailed] = useState(false);
	const size = props.size ?? 18;
	const src = safeHref(avatarUrl);
	return (
		<span
			data-testid={`avatar-${login}`}
			data-me={props.me || undefined}
			style={{ width: size, height: size }}
			className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full text-[9px] font-bold text-ink ${
				TINTS[hashTint(login)]?.fill
			} ${props.me ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""}`}
		>
			{src && !failed ? (
				<img
					src={src}
					alt=""
					width={size}
					height={size}
					onError={() => setFailed(true)}
				/>
			) : (
				<span aria-hidden>{login.slice(0, 2).toUpperCase()}</span>
			)}
		</span>
	);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const personOf = (row: HomeRow, login: string): Person =>
	row.people[login] ??
	(same(row.author.login, login) ? row.author : { login, avatarUrl: "" });

/** Checks, review decision, open threads and author, each only when it applies. */
function StatusIcons({ row, section }: { row: HomeRow; section: SectionId }) {
	return (
		<span className="flex shrink-0 items-center gap-1.5">
			{row.state === "MERGED" && (
				<Sign label="Merged" className="text-done">
					<GitMergeIcon size={14} aria-hidden />
				</Sign>
			)}
			{row.state === "CLOSED" && (
				<Sign label="Closed" className="text-bad">
					<GitPullRequestClosedIcon size={14} aria-hidden />
				</Sign>
			)}
			{row.checks === "passing" && (
				<Sign label="Checks passing" className="text-ok">
					<CheckCircleIcon size={14} aria-hidden />
				</Sign>
			)}
			{row.checks === "failing" && (
				<Sign label="Checks failing" className="text-bad">
					<XCircleIcon size={14} aria-hidden />
				</Sign>
			)}
			{row.checks === "running" && (
				<Sign label="Checks running" className="text-warn">
					<DotFillIcon size={14} aria-hidden />
				</Sign>
			)}
			{row.decision === "approved" && (
				<Sign label="Approved" className="text-ok">
					<CheckIcon size={14} aria-hidden />
				</Sign>
			)}
			{row.decision === "changes-requested" && (
				<Sign label="Changes requested" className="text-bad">
					<FileDiffIcon size={14} aria-hidden />
				</Sign>
			)}
			{row.unresolvedThreads > 0 && (
				<Sign
					label={`${row.unresolvedThreads} unresolved ${row.unresolvedThreads === 1 ? "thread" : "threads"}`}
					className="text-warn tabular-nums"
				>
					<CommentIcon size={14} aria-hidden />
					{row.unresolvedThreads}
				</Sign>
			)}
			{section !== "mine" && (
				<Sign label={`Author: ${row.author.login}`}>
					<Avatar person={row.author} />
				</Sign>
			)}
		</span>
	);
}

/** Whose turn the facts say it is: an arrow and their avatars, "you" ringed. */
function TurnCell({ row, viewer }: { row: HomeRow; viewer: string }) {
	const { turn } = row;
	if (turn.kind === "none") return null;
	if (turn.kind === "no-reviewer") {
		return <span className="shrink-0 text-muted">no reviewer</span>;
	}
	const names = turn.logins.map((l) => (same(l, viewer) ? "you" : l));
	const label =
		turn.label === "request"
			? "No reviewer: request one"
			: `Turn: ${names.join(", ")}${turn.label === "merge" ? ", merge" : ""}`;
	const first = names[0] ?? "";
	return (
		<Sign
			label={label}
			className={names.includes("you") ? "font-semibold text-ink" : ""}
		>
			<ArrowRightIcon size={14} aria-hidden className="text-accent" />
			{turn.logins.slice(0, 3).map((l) => (
				<Avatar key={l} person={personOf(row, l)} me={same(l, viewer)} />
			))}
			<span
				aria-hidden
				className="hidden min-w-0 truncate sm:inline lg:max-w-16"
			>
				{turn.label === "merge"
					? "merge"
					: `${first}${names.length > 1 ? ` +${names.length - 1}` : ""}`}
			</span>
		</Sign>
	);
}

const UNIT_WORDS: Record<Coverage["unit"], [string, string]> = {
	lines: ["line", "lines"],
	clusters: ["cluster", "clusters"],
	files: ["file", "files"],
};

/** A review whose PR got commits past its patch set's head. */
function HeadMoved() {
	return (
		<Sign focusable label="New commits since your review" className="text-warn">
			<GitCommitIcon size={14} aria-hidden />
		</Sign>
	);
}

/** A started review's coverage: a short bar and "37 / 120". */
export function CoverageCell({ coverage }: { coverage: Coverage }) {
	const { done, total, unit } = coverage;
	const word = UNIT_WORDS[unit][total === 1 ? 0 : 1];
	const complete = total > 0 && done >= total;
	return (
		<Sign
			label={`${done} of ${total} ${word} reviewed`}
			className={`tabular-nums ${complete ? "text-ok" : ""}`}
		>
			<Meter
				counts={{ reviewed: done, crossedOff: 0, total }}
				className="h-1.5 w-10"
			/>
			{done} / {total}
		</Sign>
	);
}

/** "Thu" within the week, "Mon 3 Nov" further out: the snooze's date. */
export function shortDate(iso: string, nowMs = Date.now()): string {
	const date = new Date(iso);
	const days = (date.getTime() - nowMs) / 86_400_000;
	return new Intl.DateTimeFormat(
		"en",
		days < 6
			? { weekday: "short" }
			: { weekday: "short", day: "numeric", month: "short" },
	).format(date);
}

/** Why a hidden row is hidden: its snooze date (a bolt when activity wakes it) or whom it waits on. */
function Reason({ row }: { row: HomeRow }) {
	const { snooze, waiting } = row.annotations;
	if (row.hidden === "snoozed" && snooze) {
		const full = fullDate(new Date(snooze.until));
		return (
			<Sign
				focusable
				label={`Snoozed until ${full}${snooze.wakeOnActivity ? ", or sooner on activity" : ""}`}
				className="rounded-full border border-edge bg-raised px-2 text-xs text-muted"
			>
				<ClockIcon size={12} aria-hidden />
				{shortDate(snooze.until)}
				{snooze.wakeOnActivity && <ZapIcon size={12} aria-hidden />}
			</Sign>
		);
	}
	if (row.hidden === "waiting" && waiting) {
		return (
			<Sign
				focusable
				label={`Waiting on ${waiting.who}`}
				className="rounded-full border border-edge bg-raised px-2 text-xs text-muted"
			>
				<ArrowRightIcon size={12} aria-hidden />
				<Avatar person={personOf(row, waiting.who)} size={16} />
				<span className="hidden sm:inline">{waiting.who}</span>
			</Sign>
		);
	}
	return null;
}

/** The review a click on the PR's row opens: the only one, else the plain one. */
function mainReview(reviews: RowReview[]): RowReview | undefined {
	if (reviews.length === 1) return reviews[0];
	return reviews.find((r) => r.pinnedHead === null);
}

export const byLastActed = (reviews: RowReview[]) =>
	[...reviews].sort(
		(a, b) => Date.parse(b.lastActedAt) - Date.parse(a.lastActedAt),
	);

const closedTip = (row: HomeRow) =>
	`${row.state === "MERGED" ? "Merged" : "Closed"}, nothing to review here. Open on GitHub`;

/** The row's title, a link over the whole row (`after:inset-0`). */
function TitleLink({ row }: { row: HomeRow }) {
	// A hidden row is dimmed: its title in ink-soft, regular weight.
	const tone = row.hidden
		? "font-normal text-ink-soft"
		: "font-medium text-ink";
	// Whole, wrapping inside the row: a long unbroken word breaks too.
	const linkClass = `${tone} min-w-0 [overflow-wrap:anywhere] rounded-sm after:absolute after:inset-0 after:content-[''] hover:text-link focus-visible:outline-2 focus-visible:outline-accent`;
	const inner = (
		<>
			<span className="mr-1.5 font-normal text-faint tabular-nums">
				#{row.number}
			</span>
			{row.title}
		</>
	);
	if (!row.openable) {
		return (
			<Tooltip content={closedTip(row)}>
				{(trigger) => (
					<a
						{...trigger}
						href={safeHref(row.url)}
						target="_blank"
						rel="noreferrer"
						className={linkClass}
					>
						{inner}
						<LinkExternalIcon
							size={12}
							aria-hidden
							className="ml-1.5 inline text-faint"
						/>
					</a>
				)}
			</Tooltip>
		);
	}
	const review = mainReview(row.reviews);
	return (
		<a href={review ? `/r/${review.id}` : prPath(row)} className={linkClass}>
			{inner}
		</a>
	);
}

/**
 * The row's columns from lg up (one line; below it a row stacks), shared
 * by the rows and the header that names them (ColumnHeader): the last
 * one ends at the row's right edge, the actions float over it.
 */
export const COLUMNS = {
	repo: "lg:w-32 lg:shrink-0",
	title: "lg:flex-1",
	status: "lg:w-32 lg:shrink-0",
	turn: "lg:w-36 lg:shrink-0",
	coverage: "lg:w-36 lg:shrink-0",
	updated: "lg:w-28 lg:shrink-0 lg:justify-end",
} as const;
export type Column = keyof typeof COLUMNS;

const COLUMN_TITLES: Record<Column, string> = {
	repo: "Repo",
	title: "Pull request",
	status: "Status",
	turn: "Turn",
	coverage: "Reviewed",
	updated: "Updated",
};

/**
 * The names of the rows' columns, over the page's lists: from lg up only,
 * where the rows are columns (a phone's stacked rows have nothing to line
 * up with). Its padding is a row's plus the list's border. Sticky, so it
 * names the columns of whichever section is in view.
 */
export function ColumnHeader() {
	// The rows' room for the touch "⋯" (PrRow).
	const touch = !useMedia("(hover: hover)");
	return (
		<div
			data-testid="home-columns"
			aria-hidden
			// Sticks at the top: whichever section is in view, its columns are named.
			className={`sticky top-0 z-30 hidden items-center gap-x-3 border-b border-line bg-canvas px-[calc(0.75rem+1px)] py-1.5 text-xs font-bold tracking-[0.12em] text-faint uppercase lg:flex ${touch ? "pr-[calc(3rem+1px)]" : ""}`}
		>
			{(Object.keys(COLUMNS) as Column[]).map((c) => (
				<span key={c} data-col={c} className={`flex ${COLUMNS[c]}`}>
					{COLUMN_TITLES[c]}
				</span>
			))}
		</div>
	);
}

/** A row's cell of column `col`; below lg, an empty one takes no room. */
function Cell(props: {
	col: Column;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<span
			data-col={props.col}
			className={`flex min-w-0 items-center max-lg:empty:hidden ${COLUMNS[props.col]} ${props.className ?? ""}`}
		>
			{props.children}
		</span>
	);
}

/**
 * One PR: repo, number and title, pills, status icons, turn, coverage and
 * age, in columns from lg up; stacked below (title; repo and the rest). A
 * hidden row is dimmed and carries its reason; its Wake up is among the
 * actions, which float over the row's end.
 */
export function PrRow(props: {
	row: HomeRow;
	section: SectionId;
	viewer: string;
	actions?: ReactNode;
}) {
	const { row, section, viewer } = props;
	const hidden = row.hidden !== null;
	const single = row.reviews.length === 1 ? row.reviews[0] : undefined;
	const subs = row.reviews.length > 1 ? byLastActed(row.reviews) : [];
	// On touch the actions' "⋯" floats at the row's top right: room for it
	// at the title line's end (stacked), or the row's (one line).
	const touch = !useMedia("(hover: hover)");
	return (
		<>
			<li
				data-testid={hidden ? "home-row-hidden" : "home-row"}
				className={`group relative flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-sm first:border-t-0 hover:bg-raised focus-within:bg-raised lg:flex-nowrap ${touch ? "lg:pr-12" : ""}`}
			>
				<span
					data-col="repo"
					className={`order-2 max-w-[40%] min-w-0 truncate text-xs text-muted lg:order-none lg:max-w-none lg:text-sm ${COLUMNS.repo}`}
				>
					{row.owner}/{row.repo}
				</span>
				<span
					data-col="title"
					className={`order-1 flex min-w-0 basis-full items-center gap-2 lg:order-none lg:basis-auto ${COLUMNS.title} ${touch ? "max-lg:pr-8" : ""}`}
				>
					<TitleLink row={row} />
					{row.draft && (
						<span className="shrink-0 rounded-full bg-overlay px-1.5 text-xs font-semibold text-muted">
							Draft
						</span>
					)}
					{row.annotations.note && (
						<Sign
							focusable
							label={`Note: ${row.annotations.note}`}
							className="max-w-48 min-w-0 shrink rounded-full border border-dashed border-line-strong px-1.5 text-xs text-muted"
						>
							<NoteIcon size={12} aria-hidden />
							<span className="truncate">{row.annotations.note}</span>
						</Sign>
					)}
					{row.woke && (
						<Sign
							focusable
							label={`Woke: ${row.woke.by}`}
							className="text-warn"
						>
							<BellIcon size={12} aria-hidden />
						</Sign>
					)}
				</span>
				<span
					data-testid="row-meta"
					// Wraps while stacked: a started row's icons, turn, coverage and
					// age are wider than 360px.
					className="order-3 flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-muted lg:order-none lg:flex-none lg:flex-nowrap lg:justify-start lg:text-sm"
				>
					<Cell col="status">
						<StatusIcons row={row} section={section} />
					</Cell>
					<Cell col="turn">
						{hidden ? (
							<Reason row={row} />
						) : (
							<TurnCell row={row} viewer={viewer} />
						)}
					</Cell>
					<Cell col="coverage" className="gap-1.5">
						{single?.headMoved && <HeadMoved />}
						{single && <CoverageCell coverage={single.coverage} />}
					</Cell>
					<Cell col="updated">
						<span className="relative z-10 shrink-0 whitespace-nowrap">
							<RelativeTime iso={row.updatedAt} />
						</span>
					</Cell>
				</span>
				{props.actions}
			</li>
			{subs.map((review) => (
				<SubRow key={review.id} review={review} />
			))}
		</>
	);
}

/** One of a PR's several started reviews, under its row. */
function SubRow({ review }: { review: RowReview }) {
	return (
		<li
			data-testid="home-subrow"
			className="relative flex min-h-10 items-center gap-3 py-1 pr-3 pl-8 text-xs text-muted hover:bg-raised focus-within:bg-raised lg:pl-38 lg:text-sm"
		>
			<a
				href={`/r/${review.id}`}
				className="flex min-w-0 items-center gap-1.5 rounded-sm text-ink-soft after:absolute after:inset-0 after:content-[''] hover:text-link focus-visible:outline-2 focus-visible:outline-accent"
			>
				{review.pinnedHead ? (
					<Sign label={`Pinned head ${review.label}`}>
						<PinIcon size={12} aria-hidden />
						<span className="font-mono">{review.label}</span>
					</Sign>
				) : (
					review.label
				)}
			</a>
			{/* Under the PR row's Reviewed and Updated columns. */}
			<span className="ml-auto flex items-center gap-3">
				<Cell col="coverage" className="gap-1.5">
					{review.headMoved && <HeadMoved />}
					<CoverageCell coverage={review.coverage} />
				</Cell>
				<Cell col="updated">
					<span className="relative z-10 whitespace-nowrap">
						<RelativeTime iso={review.lastActedAt} />
					</span>
				</Cell>
			</span>
		</li>
	);
}
