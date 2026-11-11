import { AlertIcon, SparkleFillIcon } from "@primer/octicons-react";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import { Spinner } from "../Spinner";
import { AgentUnplaced } from "./AgentUnplaced";
import type { AgentPlaceable } from "./placeable";

/**
 * The agent threads whose file is not in this comparison (principle 2:
 * never hidden), after the review threads' group, each in the review
 * threads' unplaced row (AgentUnplaced) under its original path: those the
 * tracer put outside it with their fate, and those on a path the diff
 * doesn't have with no place for them (a rename whose own trace failed)
 * with an unknown fate. While the placements load, a spinner for the
 * threads that wait; when they fail, the failure with a Retry and those
 * threads as unknown-fate rows (as review threads), never outdated in a
 * lead. Resolved ones last (the order given).
 */
export function AgentNotInComparison(props: {
	threads: readonly AgentPlaceable[];
	/** The viewed head: one asked on another is marked outdated. */
	snapshotHead: string;
	placements: ReadonlyMap<string, ThreadPlacement> | null;
	/** The placements are on their way. */
	pending?: boolean;
	/** How many agent threads wait for them (asked on another head). */
	waiting?: number;
	/** They couldn't be computed: said here, with a retry and the threads that wait. */
	failed?: {
		error: Error | null;
		retry: () => void;
		retrying?: boolean;
		threads?: readonly AgentPlaceable[];
	} | null;
}) {
	const outdatedOf = (commit: string) =>
		commit !== props.snapshotHead ? commit : undefined;
	const failed = props.failed && (
		<section
			aria-label="Agent thread places couldn't be computed"
			aria-busy={props.failed.retrying || undefined}
			data-testid="agent-placements-failed"
			className="space-y-2 rounded-lg border border-bad/40 bg-surface p-2"
		>
			<h3 className="flex min-h-10 flex-wrap items-center gap-2 px-1 text-sm font-semibold text-ink">
				<SparkleFillIcon size={16} aria-hidden className="text-agent-ink" />
				<AlertIcon size={16} aria-hidden className="text-bad" />
				Agent thread places couldn't be computed
				{/* One slot for the button and its spinner: nothing moves. */}
				<span className="ml-auto inline-flex min-h-10 min-w-20 items-center justify-center">
					{props.failed.retrying ? (
						<Spinner label="Retrying" />
					) : (
						<button
							type="button"
							onClick={props.failed.retry}
							className="inline-flex min-h-10 min-w-20 items-center justify-center rounded-md px-3 font-medium text-link hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
						>
							Retry
						</button>
					)}
				</span>
			</h3>
			{props.failed.error && (
				<p className="px-1 text-xs break-words text-muted">
					{props.failed.error.message}
				</p>
			)}
			{(props.failed.threads?.length ?? 0) > 0 && (
				<ul className="space-y-1.5">
					{props.failed.threads?.map(({ thread, commit }) => (
						<AgentUnplaced
							key={thread.id}
							thread={thread}
							fate={null}
							path={thread.anchor.path}
							outdated={outdatedOf(commit)}
						/>
					))}
				</ul>
			)}
		</section>
	);
	const loading = props.pending && (props.waiting ?? 0) > 0 && (
		<section
			aria-label="Placing agent threads"
			aria-busy="true"
			data-testid="agent-placements-loading"
			className="flex min-h-10 items-center gap-2 px-1"
		>
			<SparkleFillIcon size={12} aria-hidden className="text-agent-ink" />
			<Spinner label="Placing agent threads" size={12} />
		</section>
	);
	const list = props.threads.length > 0 && (
		<section
			aria-label="Agent threads not in this comparison"
			data-testid="agent-not-in-comparison"
			className="space-y-2 rounded-lg border border-agent-edge bg-surface p-2"
		>
			<h3 className="flex min-h-10 items-center gap-2 px-1 text-sm font-semibold text-ink">
				<SparkleFillIcon size={16} aria-hidden className="text-agent-ink" />
				Not in this comparison
			</h3>
			<ul className="space-y-1.5">
				{props.threads.map(({ thread, commit }) => {
					const placement = props.placements?.get(thread.id);
					return (
						<AgentUnplaced
							key={thread.id}
							thread={thread}
							fate={placement?.kind === "outside" ? placement.fate : null}
							path={thread.anchor.path}
							outdated={outdatedOf(commit)}
							testId="agent-outside"
						/>
					);
				})}
			</ul>
		</section>
	);
	if (!failed && !loading && !list) return null;
	return (
		<>
			{failed}
			{loading}
			{list}
		</>
	);
}
