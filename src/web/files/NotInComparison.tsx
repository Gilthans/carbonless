import { CircleSlashIcon } from "@primer/octicons-react";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import type { ReviewThread } from "../../shared/types";
import { Badge } from "../overview/parts";
import { Spinner } from "../Spinner";
import { threadsLabel, UnplacedRow } from "./ThreadFate";

/**
 * The trailing group of threads whose file is not in this comparison at
 * all (deleted, or no longer changed by the PR, in this or an earlier
 * patch set): by original path, fate ("file deleted"), the code they were
 * written on. It is there on every patch set until each thread is
 * resolved, so an unresolved thread never disappears with its file. A
 * spinner while the placements are on their way (never an empty group).
 */
export function NotInComparison(props: {
	threads: {
		thread: ReviewThread;
		placement: Extract<ThreadPlacement, { kind: "outside" }>;
	}[];
	readId: string;
	pending: boolean;
}) {
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
	return (
		<section
			aria-label="Not in this comparison"
			data-testid="not-in-comparison"
			className="space-y-2 rounded-lg border border-line bg-surface p-2"
		>
			<h3 className="flex min-h-10 flex-wrap items-center gap-2 px-1 text-sm font-semibold text-ink">
				Not in this comparison
				<Badge tone="red" icon={CircleSlashIcon}>
					{threadsLabel(props.threads.length)}
				</Badge>
			</h3>
			<ul className="space-y-1.5">
				{props.threads.map(({ thread, placement }) => (
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
