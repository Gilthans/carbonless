import {
	AlertIcon,
	CheckCircleIcon,
	CheckIcon,
	ClockIcon,
	CommentIcon,
	FileDiffIcon,
	type Icon,
	InfoIcon,
	SkipIcon,
} from "@primer/octicons-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	type KeyboardEvent,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type {
	PrOverview,
	ReviewThread,
	ReviewVerdict,
	SessionInfo,
	VerdictEvent,
	VerdictFacts,
	VerdictSince,
} from "../../shared/types";
import { verdictQuery } from "../api";
import { Meter } from "../files/ProgressBar";
import { useReviewView } from "../files/useSetStates";
import { LabeledIcon } from "../overview/parts";
import { WriteWarnings } from "../overview/WriteWarnings";
import { RelativeTime } from "../RelativeTime";
import { useReviewId } from "../reviewId";
import { Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { useThreadWriter, useThreadWrites } from "../threads/threadWrites";
import { safeHref } from "../ui";
import { isViewer } from "./blockers";
import { useVerdictDraft, verdictDraftFor } from "./verdictDraft";

/** The owner's words for each verdict (verbatim): each button's tooltip. */
export const VERDICT_TIPS: Record<VerdictEvent, string> = {
	APPROVE: "Allow merging after remaining comments are resolved",
	COMMENT: "No approval, but approval by someone else acceptable",
	REQUEST_CHANGES: "Disallow merging without another review",
};

export const OWN_PR_TIP = "Authors can't approve their own PR";

/** The viewer's standing opinion, as Comment's tooltip and its notice name it. */
const OPINION_NAME = {
	APPROVED: "approval",
	CHANGES_REQUESTED: "request for changes",
} as const;

/**
 * The viewer's approval or change request standing on GitHub (Comment
 * withdraws it): the verdict read's, else the Overview's opinion.
 */
export function standingOpinion(
	facts: VerdictFacts | undefined,
	overview: PrOverview,
): keyof typeof OPINION_NAME | null {
	const state = facts
		? facts.reviews.find((r) => r.you)?.state
		: overview.reviews.find((r) => r.you)?.opinion;
	return state === "APPROVED" || state === "CHANGES_REQUESTED" ? state : null;
}

const BUTTONS: {
	event: VerdictEvent;
	label: string;
	short: string;
	icon: Icon;
	className: string;
}[] = [
	{
		event: "APPROVE",
		label: "Approve",
		short: "Approve",
		icon: CheckIcon,
		className: "border-ok/60 bg-ok/10 text-ok hover:bg-ok/20",
	},
	{
		event: "COMMENT",
		label: "Comment",
		short: "Comment",
		icon: CommentIcon,
		className: "border-line-strong bg-raised text-ink-soft hover:bg-overlay",
	},
	{
		event: "REQUEST_CHANGES",
		label: "Request changes",
		short: "Changes",
		icon: FileDiffIcon,
		className: "border-bad/60 bg-bad/10 text-bad hover:bg-bad/20",
	},
];

/** "You approved", as a verdict's state reads after the reviewer's name. */
const YOUR: Record<ReviewVerdict, { text: string; icon: Icon; tone: string }> =
	{
		APPROVED: { text: "You approved", icon: CheckIcon, tone: "text-ok" },
		CHANGES_REQUESTED: {
			text: "You requested changes",
			icon: FileDiffIcon,
			tone: "text-bad",
		},
		COMMENTED: { text: "You commented", icon: CommentIcon, tone: "text-muted" },
		DISMISSED: {
			text: "Your review was dismissed",
			icon: SkipIcon,
			tone: "text-muted",
		},
	};

const STATE_OF: Record<VerdictEvent, ReviewVerdict> = {
	APPROVE: "APPROVED",
	COMMENT: "COMMENTED",
	REQUEST_CHANGES: "CHANGES_REQUESTED",
};

/** Why every button is off here, if they are: as-of, another viewer, merged, closed. */
function offReason(overview: PrOverview): string | null {
	if (overview.writes === "as-of") return "Shown as of a past moment";
	if (overview.writes === "viewer") return "Viewing as someone else";
	if (overview.state === "MERGED") return "Merged: a verdict no longer counts";
	if (overview.state === "CLOSED") return "Closed: a verdict no longer counts";
	return null;
}

/** The reviewer's verdict on GitHub now: one on its way first, then the read's. */
function CurrentVerdict(props: {
	facts: VerdictFacts | undefined;
	overview: PrOverview;
}) {
	const { verdict } = useThreadWrites();
	if (verdict) {
		const shown = YOUR[STATE_OF[verdict.event]];
		return (
			<p
				data-testid="your-verdict"
				className={`flex flex-wrap items-center gap-x-1.5 text-sm ${shown.tone}`}
			>
				<shown.icon size={16} aria-hidden />
				{shown.text} just now
				<LabeledIcon icon={ClockIcon} label="Sending" className="text-warn" />
			</p>
		);
	}
	const since = props.facts?.since;
	if (since) {
		const shown = YOUR[since.state];
		const sha = since.head.slice(0, 7);
		const href = safeHref(since.url);
		return (
			<p
				data-testid="your-verdict"
				className={`flex flex-wrap items-center gap-x-1.5 text-sm ${shown.tone}`}
			>
				<shown.icon size={16} aria-hidden />
				<span className="min-w-0">
					{shown.text}{" "}
					{href ? (
						<a
							href={href}
							target="_blank"
							rel="noreferrer"
							data-testid="verdict-since-commit"
							className="font-mono text-xs text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
						>
							{sha}
						</a>
					) : (
						<span
							data-testid="verdict-since-commit"
							className="font-mono text-xs"
						>
							{sha}
						</span>
					)}{" "}
					<span className="text-muted">(PS{since.patchset}),</span>{" "}
					<RelativeTime iso={since.at} className="text-muted" />
				</span>
			</p>
		);
	}
	const fromFacts = props.facts?.reviews.find((r) => r.you);
	const mine = fromFacts ?? props.overview.reviews.find((r) => r.you);
	if (!mine) return null;
	const shown = YOUR[mine.state];
	const earlier =
		fromFacts && props.facts && fromFacts.commitId !== props.facts.head;
	return (
		<p
			data-testid="your-verdict"
			className={`flex flex-wrap items-center gap-x-1.5 text-sm ${shown.tone}`}
		>
			<shown.icon size={16} aria-hidden />
			{shown.text}
			<RelativeTime iso={mine.submittedAt} className="text-muted" />
			{earlier && <span className="text-muted">· on an earlier push</span>}
		</p>
	);
}

const plural = (n: number, word: string) =>
	`${n} ${n === 1 ? word : `${word}s`}`;

/** What happened to reach the head, for "Rebased, same diff". */
const SAME_DIFF: Record<string, string> = {
	S1: "New commits",
	S3: "Base merged in",
	S4a: "Rebased",
	S4b: "Rebased",
	S4c: "Rebased",
	S5: "Squashed",
	S6: "Head moved back",
	S7: "Retargeted",
};

type SinceDone = Extract<VerdictSince["changes"], { status: "done" }>;

/**
 * Nothing to re-read since the verdict: only an identical diff with no
 * reworked, new or gone cluster in the engine's answer (principle 2: an
 * unreviewed cluster the engine calls new still needs eyes).
 */
export function nothingToReread(changes: VerdictSince["changes"]): boolean {
	return (
		changes.status === "done" &&
		changes.identical &&
		changes.reworked === 0 &&
		changes.new === 0 &&
		changes.gone === 0
	);
}

/** "3 commits · 2 files · 1 reworked, 1 new cluster" (and "· 1 gone"). */
export function sinceLine(c: SinceDone): string {
	const parts = [plural(c.commits, "commit")];
	if (c.files > 0) parts.push(plural(c.files, "file"));
	const kinds = [
		c.reworked > 0 ? `${c.reworked} reworked` : "",
		c.new > 0 ? `${c.new} new` : "",
	].filter(Boolean);
	if (kinds.length > 0) {
		// The noun agrees with the count next to it: "1 reworked, 1 new cluster".
		const n = c.new > 0 ? c.new : c.reworked;
		parts.push(`${kinds.join(", ")} ${n === 1 ? "cluster" : "clusters"}`);
	}
	if (c.gone > 0) parts.push(`${c.gone} gone`);
	return parts.join(" · ");
}

/**
 * Under the reviewer's verdict, what changed since it (VerdictFacts.since):
 * a spinner while the engine computes, the counts with the target patch
 * set's meter, or "Rebased, same diff · nothing to re-read".
 */
function SinceVerdict(props: {
	since: VerdictSince;
	review: ReturnType<typeof useReviewView>["data"];
}) {
	const { since, review } = props;
	const { changes } = since;
	if (changes.status === "pending") {
		return (
			<p
				data-testid="verdict-since"
				data-state="pending"
				aria-busy="true"
				className="flex min-h-6 items-center gap-1.5 text-sm text-muted"
			>
				<b className="font-semibold text-ink-soft">Since then:</b>
				<Spinner label="Comparing with your verdict" size={14} />
			</p>
		);
	}
	if (changes.status === "failed") {
		return (
			<p
				data-testid="verdict-since"
				data-state="failed"
				className="flex min-h-6 items-start gap-1.5 text-sm text-bad"
			>
				<AlertIcon size={16} aria-hidden className="mt-0.5 shrink-0" />
				<span className="min-w-0 break-words">
					<b className="font-semibold">Since then:</b> couldn't be compared ·{" "}
					{changes.message}
				</span>
			</p>
		);
	}
	if (nothingToReread(changes)) {
		return (
			<p
				data-testid="verdict-since"
				data-state="same"
				className="flex min-h-6 flex-wrap items-center gap-1.5 text-sm text-ok"
			>
				<CheckCircleIcon size={16} aria-hidden />
				<span>
					<b className="font-semibold">
						{SAME_DIFF[changes.shape] ?? "Rebased"}, same diff
					</b>{" "}
					· nothing to re-read
				</span>
			</p>
		);
	}
	const target = since.to.patchset;
	const counts =
		target !== null && review?.patchset === target
			? review.progress.clusters
			: null;
	const left = counts ? counts.total - counts.crossedOff : 0;
	return (
		<div
			data-testid="verdict-since"
			data-state="changed"
			className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-warn"
		>
			<span className="min-w-0">
				<b className="font-semibold">Since then:</b>{" "}
				<span className="text-ink-soft">{sinceLine(changes)}</span>
			</span>
			{counts && (
				<Tooltip
					content={`${counts.reviewed} of ${left} reviewed on PS${target}`}
				>
					{(trigger) => (
						<span
							{...trigger}
							data-testid="verdict-since-meter"
							className="flex items-center gap-1.5"
						>
							<Meter
								counts={counts}
								incomplete={counts.reviewed < left}
								className="h-1.5 w-24 sm:w-40"
							/>
							<span className="font-mono text-xs text-muted">
								{counts.reviewed} / {left} on PS{target}
							</span>
						</span>
					)}
				</Tooltip>
			)}
		</div>
	);
}

/**
 * Asks for the verdict facts again when the head a verdict goes on moves
 * (the head check found a new one, a patch set started): the server works
 * out `since` when served, from its kept read of GitHub.
 */
function useSinceFollowsHead(session: SessionInfo) {
	const client = useQueryClient();
	const key = `${session.head?.oid ?? ""}:${session.patchset ?? ""}`;
	const first = useRef(key);
	useEffect(() => {
		if (first.current === key) return;
		first.current = key;
		void client.invalidateQueries({ queryKey: verdictQuery.queryKey });
	}, [client, key]);
}

/**
 * The reviewer's verdict: what they said last, Approve / Comment / Request
 * changes (each with the owner's tooltip), and "Include a message". Always
 * allowed whatever the review's progress (owner: "approving/requesting
 * changes can be done regardless of the state of the review"); progress
 * shows as information only. Comment and Request changes need a message
 * (GitHub refuses them without one): pressed with none, the box opens and
 * takes focus instead. One verdict at a time: the buttons wait while one
 * is on its way. On the Final Verdict tab under the blockers, and after
 * the last file in Files changed with a link to them (`blockers`).
 */
export function VerdictCard(props: {
	place: "tab" | "files";
	facts: VerdictFacts | undefined;
	overview: PrOverview;
	session: SessionInfo;
	threads: readonly ReviewThread[] | undefined;
	/** The Files end card: how many blockers (null while unknown). */
	blockers?: number | null;
}) {
	const { overview, session, place } = props;
	const reviewId = useReviewId();
	const client = useQueryClient();
	const writer = useThreadWriter();
	const writes = useThreadWrites();
	const draft = useVerdictDraft();
	const store = verdictDraftFor(client);
	const [checked, setChecked] = useState(() => store.text() !== "");
	// A refused verdict's message is back: the box opens on it.
	const hasText = draft.text !== "";
	useEffect(() => {
		if (hasText) setChecked(true);
	}, [hasText]);
	const editor = useRef<HTMLTextAreaElement>(null);
	const [focusAsk, setFocusAsk] = useState(0);
	useEffect(() => {
		if (focusAsk > 0) editor.current?.focus();
	}, [focusAsk]);
	useLayoutEffect(() => {
		const el = editor.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight + 2}px`;
	});
	const headingId = useId();
	const boxId = useId();
	const off = offReason(overview);
	// A verdict out (a resent or discarded one too) shows as sending: the
	// buttons wait for it, and say so.
	const sending = writes.verdict !== null;
	const reasonOf = (event: VerdictEvent) =>
		off ??
		(sending ? "Sending your verdict" : null) ??
		(overview.youAuthor && event !== "COMMENT" ? OWN_PR_TIP : null);
	const standing = standingOpinion(props.facts, overview);
	const tipOf = (event: VerdictEvent) =>
		event === "COMMENT" && standing ? (
			// Text nodes, not an element: a hidden tip's description keeps them.
			<>
				{VERDICT_TIPS.COMMENT}
				<br />
				{`Replaces your ${OPINION_NAME[standing]}`}
			</>
		) : (
			VERDICT_TIPS[event]
		);
	const stillStands = writes.verdictStillStands;
	useSinceFollowsHead(session);
	const since = props.facts?.since ?? null;
	// With a verdict to compare, every verdict goes on the head it is
	// compared with (the latest patch set's, or the PR's head past it,
	// which the verdict then starts); else on the snapshot's, as before.
	const commit = since ? since.to.head : session.snapshotHead;
	const again =
		since !== null &&
		since.state === "APPROVED" &&
		nothingToReread(since.changes);
	// The commit a verdict goes on is an older one: the snapshot's behind
	// the PR's head, or (with a since line) the head moved back onto an
	// earlier patch set's (S6).
	const latest = Math.max(0, ...session.patchsets.map((p) => p.number));
	const older =
		!off &&
		commit !== "" &&
		(since
			? since.to.patchset !== null && since.to.patchset < latest
			: session.snapshotHead !== session.currentHead);
	const press = (event: VerdictEvent) => {
		if (reasonOf(event)) return;
		const text = store.text();
		if (event === "APPROVE") {
			const body = checked && text.trim() ? text : undefined;
			if (writer.submitVerdict(event, body, commit) && body) {
				setChecked(false);
			}
			return;
		}
		if (!checked || !text.trim()) {
			// GitHub needs a message for these: the box, ready to type in.
			setChecked(true);
			setFocusAsk((n) => n + 1);
			return;
		}
		if (writer.submitVerdict(event, text, commit)) {
			setChecked(false);
		}
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.currentTarget.blur();
		}
	};

	// Information only: never a condition.
	const { data: review } = useReviewView();
	const lines = review?.progress.lines;
	const mine = (props.threads ?? []).filter(
		(t) => isViewer(t.author, session.viewer) && t.unavailable === undefined,
	);
	const open = mine.filter((t) => !t.resolved).length;
	const info: string[] = [];
	if (lines && lines.total > 0) {
		info.push(
			`You reviewed ${lines.reviewed} of ${lines.total - lines.crossedOff} lines`,
		);
	}
	if (mine.length > 0) {
		info.push(`${open} of your threads ${open === 1 ? "is" : "are"} open`);
	}

	return (
		<section
			aria-labelledby={headingId}
			data-testid={`verdict-card-${place}`}
			className={`space-y-3 rounded-xl border border-line-strong bg-surface p-4 ${place === "files" ? "mx-auto mt-6 max-w-3xl" : ""}`}
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h2 id={headingId} className="font-display text-base font-semibold">
					{place === "tab" ? "Your verdict" : "Final verdict"}
				</h2>
				<CurrentVerdict facts={props.facts} overview={overview} />
				{place === "files" && (
					<Link
						to="/r/$id/verdict"
						params={{ id: reviewId }}
						data-testid="verdict-blockers-link"
						className="ml-auto flex min-h-10 items-center rounded-md px-1 text-sm font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
					>
						{props.blockers === null || props.blockers === undefined
							? "Blockers"
							: `Blockers: ${props.blockers}`}
					</Link>
				)}
			</div>
			{since && !writes.verdict && (
				<SinceVerdict since={since} review={review} />
			)}
			{info.length > 0 && (
				<p data-testid="verdict-info" className="text-xs text-muted">
					{info.join(" · ")}
				</p>
			)}
			{overview.writes === "on" && overview.state === "OPEN" && (
				<WriteWarnings pr={overview} threads={undefined} />
			)}
			{stillStands && (
				<p
					data-testid="verdict-still-stands"
					role="status"
					className="flex items-start gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
				>
					<AlertIcon size={16} aria-hidden className="mt-0.5 shrink-0" />
					<span className="min-w-0 break-words">
						Commented; your {OPINION_NAME[stillStands.state]} still stands:{" "}
						{stillStands.message}
					</span>
				</p>
			)}
			{older && (
				<p
					data-testid="verdict-older"
					className="flex items-center gap-1.5 text-sm text-warn"
				>
					<InfoIcon size={16} aria-hidden />
					On {commit.slice(0, 7)}, an older commit
				</p>
			)}
			{/* Tick, type, press: the message comes before the buttons. */}
			<label className="inline-flex min-h-10 cursor-pointer items-center gap-2.5 text-sm text-ink-soft">
				<input
					type="checkbox"
					data-testid="verdict-include"
					checked={checked}
					aria-controls={checked ? boxId : undefined}
					onChange={(e) => setChecked(e.target.checked)}
					className="h-4.5 w-4.5 accent-accent"
				/>
				Include a message
			</label>
			{checked && (
				<textarea
					ref={editor}
					id={boxId}
					aria-label="Message"
					data-testid="verdict-message"
					placeholder="Message…"
					rows={3}
					value={draft.text}
					disabled={Boolean(off)}
					onChange={(e) => store.setText(e.target.value)}
					onKeyDown={onKeyDown}
					className="block max-h-80 min-h-20 w-full resize-none rounded-md border border-line-strong bg-raised px-3 py-2 text-sm leading-normal text-ink placeholder:text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
				/>
			)}
			<div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
				{BUTTONS.map((b) => {
					const reason = reasonOf(b.event);
					// "Approve again on 0c1d2e3": the same diff, approved before.
					const reapprove = again && b.event === "APPROVE";
					const sha = commit.slice(0, 7);
					const label = reapprove
						? `Approve again on ${sha}`
						: since && b.event === "APPROVE"
							? `${b.label} ${sha}`
							: b.label;
					return (
						<Tooltip key={b.event} content={reason ?? tipOf(b.event)}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									data-testid={`verdict-${b.event.toLowerCase()}`}
									aria-label={label}
									// Focusable still, so its tip says why.
									aria-disabled={reason ? true : undefined}
									onClick={() => press(b.event)}
									className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg border px-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent motion-reduce:transition-none sm:min-h-11 sm:flex-row sm:gap-2 sm:px-4 ${reapprove ? "col-span-3 min-h-11 flex-row gap-2 sm:col-auto" : ""} ${b.className} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
								>
									<b.icon size={16} aria-hidden />
									{reapprove ? (
										<span>
											Approve again on{" "}
											<span className="font-mono text-xs">{sha}</span>
										</span>
									) : (
										<>
											<span className="sm:hidden">{b.short}</span>
											<span className="hidden sm:inline">{b.label}</span>
											{since && b.event === "APPROVE" && (
												<span className="font-mono text-xs font-normal">
													{sha}
												</span>
											)}
										</>
									)}
								</button>
							)}
						</Tooltip>
					);
				})}
			</div>
		</section>
	);
}
