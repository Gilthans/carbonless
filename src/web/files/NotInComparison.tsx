import { AlertIcon, CircleSlashIcon } from "@primer/octicons-react";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import type { ReviewThread } from "../../shared/types";
import { Badge } from "../overview/parts";
import { Spinner } from "../Spinner";
import { resolvedLast, threadsLabel, UnplacedRow } from "./ThreadFate";

/**
 * The trailing group of threads whose file is not in this comparison at
 * all (deleted, or no longer changed by the PR, in this or an earlier
 * patch set): by original path, fate ("file deleted"), the code they were
 * written on. It is there on every patch set until each thread is
 * resolved, so an unresolved thread never disappears with its file. A
 * spinner while the placements are on their way (never an empty group).
 * A resolved thread stays listed as a quiet line after the rest (UnplacedRow).
 */
export function NotInComparison(props: {
	threads: {
		thread: ReviewThread;
		placement: Extract<ThreadPlacement, { kind: "outside" }>;
	}[];
	readId: string;
	pending: boolean;
	/**
	 * The placements couldn't be computed: the threads not shown where they
	 * were made, listed here with the error and a retry (never dropped);
	 * resolved ones as quiet lines after the rest.
	 */
	failed?: {
		threads: ReviewThread[];
		error: Error | null;
		retry: () => void;
		/** A retry is under way: a spinner in its slot, the list kept. */
		retrying?: boolean;
	} | null;
}) {
	if (props.failed) {
		// Resolved ones too, as quiet lines after the rest, counted nowhere.
		const unresolved = props.failed.threads.filter((t) => !t.resolved).length;
		return (
			<section
				aria-label="Thread places couldn't be computed"
				aria-busy={props.failed.retrying || undefined}
				data-testid="placements-failed"
				className="space-y-2 rounded-lg border border-bad/40 bg-surface p-2"
			>
				<h3 className="flex min-h-10 flex-wrap items-center gap-2 px-1 text-sm font-semibold text-ink">
					<AlertIcon size={16} aria-hidden className="text-bad" />
					Thread places couldn't be computed
					{unresolved > 0 && (
						<Badge tone="red" icon={CircleSlashIcon}>
							{threadsLabel(unresolved)}
						</Badge>
					)}
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
				<ul className="space-y-1.5">
					{resolvedLast(props.failed.threads.map((thread) => ({ thread }))).map(
						({ thread }) => (
							<UnplacedRow
								key={thread.id}
								thread={thread}
								readId={props.readId}
								fate={null}
								path={thread.path}
							/>
						),
					)}
				</ul>
			</section>
		);
	}
	if (props.threads.length === 0 && !props.pending) return null;
	if (props.threads.length === 0) {
		return (
			<section
				aria-label="Not in this comparison"
				aria-busy="true"
				data-testid="not-in-comparison-loading"
				className="flex min-h-10 items-center px-1"
			>
				<Spinner label="Placing threads" size={12} />
			</section>
		);
	}
	// Resolved ones are quiet lines after the rest, counted nowhere.
	const open = props.threads.filter((t) => !t.thread.resolved).length;
	return (
		<section
			aria-label="Not in this comparison"
			data-testid="not-in-comparison"
			className="space-y-2 rounded-lg border border-line bg-surface p-2"
		>
			<h3 className="flex min-h-10 flex-wrap items-center gap-2 px-1 text-sm font-semibold text-ink">
				Not in this comparison
				{open > 0 && (
					<Badge tone="red" icon={CircleSlashIcon}>
						{threadsLabel(open)}
					</Badge>
				)}
			</h3>
			<ul className="space-y-1.5">
				{resolvedLast(props.threads).map(({ thread, placement }) => (
					<UnplacedRow
						key={thread.id}
						thread={thread}
						readId={props.readId}
						fate={placement.fate}
						path={placement.path}
					/>
				))}
			</ul>
		</section>
	);
}
