import { AlertIcon, SparkleFillIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { AgentThread } from "../../shared/agent";
import { ApiError, reviewQuery, sessionQuery } from "../api";
import type { FilesSearch } from "../files/landing";
import { useReviewId } from "../reviewId";
import { SkeletonBar, Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { agentDot, agentTip } from "./AgentChip";
import { AgentThreadCard } from "./AgentThreadCard";
import { agentStatusQuery, agentThreadsQuery } from "./api";
import { openAgentSetup } from "./setupStore";

/**
 * The reviewer's agent threads in "Is it ready", one band after the thread
 * groups: how many are open and how many wait for an answer, with the
 * chip's dot; with no agent set up, the button that sets one up. A
 * skeleton while they load, never a 0. None where the review has no agent.
 * Threads asked on an earlier head about a file no longer in the diff have
 * nowhere else to show: their cards are listed under the band, outdated.
 */
export function AgentOverviewRow() {
	// The chip polls the status; here it is only read.
	const status = useQuery({ ...agentStatusQuery, enabled: false });
	const threads = useQuery(agentThreadsQuery);
	const head = useQuery({ ...sessionQuery, enabled: false }).data?.snapshotHead;
	// A thread conversation shows with its GitHub thread, never as a card here.
	const earlier = (threads.data?.threads ?? []).filter(
		(t) =>
			t.anchor.subject !== "thread" &&
			head !== undefined &&
			t.anchor.commit !== head,
	);
	// Which files the diff has: read only when an earlier thread needs it.
	const review = useQuery({ ...reviewQuery(), enabled: earlier.length > 0 });
	const paths = review.data
		? new Set(review.data.files.map((f) => f.path))
		: null;
	const gone = paths ? earlier.filter((t) => !paths.has(t.anchor.path)) : [];
	if (
		(status.error instanceof ApiError && status.error.status === 404) ||
		(threads.error instanceof ApiError && threads.error.status === 404)
	) {
		return null;
	}
	const list = threads.data?.threads;
	const open = list?.filter((t) => !t.resolved).length ?? 0;
	const waiting = list?.filter((t) => !t.resolved && t.waiting).length ?? 0;
	const s = status.data;
	return (
		<div className="space-y-2">
			<section
				aria-label="Agent threads"
				data-testid="agent-overview-row"
				className="-mx-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-line bg-band px-4 py-1"
			>
				<h3 className="flex min-h-10 items-center gap-2 text-base font-semibold text-ink">
					<SparkleFillIcon size={18} aria-hidden className="text-agent-ink" />
					Agent threads
				</h3>
				{list === undefined ? (
					threads.isError ? (
						<span role="alert" className="text-sm text-bad">
							{threads.error.message}
						</span>
					) : (
						<span
							data-testid="agent-overview-loading"
							aria-busy="true"
							aria-label="Loading agent threads"
							role="status"
							className="flex"
						>
							<SkeletonBar className="w-32" />
						</span>
					)
				) : (
					<span
						data-testid="agent-overview-counts"
						className="text-sm text-muted"
					>
						{open} open · {waiting} waiting
					</span>
				)}
				{list && <UnreadLink threads={list} />}
				{s?.configured ? (
					<Tooltip content={agentTip(s)} describe={false}>
						{(trigger) => (
							<button
								type="button"
								{...trigger}
								aria-label={`Your agent: ${agentTip(s)}`}
								onClick={openAgentSetup}
								className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
							>
								<span
									aria-hidden
									className={`h-2 w-2 rounded-full ${agentDot(s)}`}
								/>
							</button>
						)}
					</Tooltip>
				) : s ? (
					<button
						type="button"
						onClick={openAgentSetup}
						className="ml-auto flex h-10 items-center gap-1.5 rounded-md border border-agent-edge bg-agent px-3 text-sm font-medium text-agent-ink hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
					>
						<SparkleFillIcon size={16} aria-hidden />
						Set up an agent
					</button>
				) : null}
			</section>
			{earlier.length > 0 && review.isPending && (
				<div aria-busy="true">
					<Spinner label="Loading files" />
				</div>
			)}
			{earlier.length > 0 && review.isError && (
				// Not "none gone": which threads sit on a gone file is unknown.
				<p
					role="alert"
					data-testid="agent-overview-gone-error"
					className="flex min-w-0 items-center gap-1.5 break-words text-sm text-bad"
				>
					<AlertIcon size={14} aria-hidden className="shrink-0" />
					{review.error.message}
				</p>
			)}
			{gone.length > 0 && (
				<ul
					aria-label="Agent threads on files no longer in the diff"
					data-testid="agent-overview-gone"
					className="space-y-2"
				>
					{gone.map((t) => (
						<li key={t.id} className="space-y-1">
							<p className="truncate font-mono text-xs text-muted">
								{t.anchor.path}
							</p>
							<AgentThreadCard
								thread={t}
								status={s}
								outdated={t.anchor.commit}
							/>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** Where an agent thread's lines are in Files changed (a file's top without lines). */
function landingOf(thread: AgentThread): FilesSearch {
	const a = thread.anchor;
	if (a.subject === "file" || a.line === undefined || a.side === undefined) {
		return { path: a.path };
	}
	return { path: a.path, line: a.line, side: a.side };
}

/**
 * How many agent threads (thread conversations and span threads alike)
 * hold a message the reviewer hasn't seen, in `accent`, linking to the
 * first of them. Nothing while none does.
 */
function UnreadLink(props: { threads: readonly AgentThread[] }) {
	const unread = props.threads.filter((t) => t.unread);
	const first = unread[0];
	if (!first) return null;
	return <UnreadLinkTo first={first} n={unread.length} />;
}

function UnreadLinkTo({ first, n }: { first: AgentThread; n: number }) {
	const id = useReviewId();
	return (
		<Link
			to="/r/$id/files"
			params={{ id }}
			search={landingOf(first)}
			data-testid="agent-overview-unread"
			aria-label={`${n} agent ${n === 1 ? "thread" : "threads"} with new messages`}
			className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-1 text-sm font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
		>
			<span aria-hidden className="h-2 w-2 rounded-full bg-accent" />
			{n} new
		</Link>
	);
}
