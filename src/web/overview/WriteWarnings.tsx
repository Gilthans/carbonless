import {
	AlertIcon,
	type Icon,
	LinkExternalIcon,
	LockIcon,
} from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { PrOverview, ReviewThread } from "../../shared/types";
import { useThreadWrites } from "../threads/threadWrites";
import { safeHref } from "../ui";

function Warning(props: { icon: Icon; testId: string; children: ReactNode }) {
	const IconEl = props.icon;
	return (
		<div
			role="alert"
			data-testid={props.testId}
			className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-ink"
		>
			<IconEl size={16} aria-hidden className="mt-0.5 shrink-0 text-warn" />
			<div className="min-w-0 flex-1 break-words">{props.children}</div>
		</div>
	);
}

/**
 * What stops the viewer writing on this PR, in "Who's on it": a pending
 * review of theirs on GitHub (replies can't be posted until it's submitted
 * or discarded; from the read, or a reply refused for it), and threads
 * GitHub won't let them reply to or resolve. Nothing when the session
 * doesn't write at all (as of a cutoff, as another viewer).
 */
export function WriteWarnings(props: {
	pr: PrOverview;
	/** As shown: a resolve on its way may have flipped `resolved`. */
	threads: ReviewThread[] | undefined;
}) {
	const { pr } = props;
	const writes = useThreadWrites();
	const refused = writes.pendingReview;
	if (pr.writes !== "on") return null;
	const pending = pr.pendingReview ?? refused;
	const href = safeHref(pending?.url);
	const threads = (props.threads ?? []).filter(
		(t) => t.id !== "" && t.unavailable === undefined,
	);
	const noReply = threads.some((t) => !t.viewerCan.reply);
	// GitHub says resolve only on open threads, unresolve only on resolved
	// ones (the other is always false), for the state it read. A thread
	// flipped here and not yet confirmed may show the other state: either
	// flag says the viewer may.
	const noResolve = threads.some((t) =>
		writes.threads.get(t.id)?.resolved !== undefined
			? !t.viewerCan.resolve && !t.viewerCan.unresolve
			: t.resolved
				? !t.viewerCan.unresolve
				: !t.viewerCan.resolve,
	);
	if (!pending && !noReply && !noResolve) return null;
	return (
		<div className="space-y-2">
			{pending && (
				<Warning icon={AlertIcon} testId="pending-review-warning">
					<p className="font-medium">
						Pending review on GitHub: replies can't be posted until it's
						submitted or discarded
					</p>
					{href && (
						<a
							href={href}
							target="_blank"
							rel="noreferrer"
							className="inline-flex min-h-10 items-center gap-1 font-semibold text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
						>
							Open on GitHub
							<LinkExternalIcon size={14} aria-hidden />
						</a>
					)}
				</Warning>
			)}
			{(noReply || noResolve) && (
				<Warning icon={LockIcon} testId="permission-warning">
					{noReply && <p>You can't reply in this repo</p>}
					{noResolve && <p>You can't resolve threads in this repo</p>}
				</Warning>
			)}
		</div>
	);
}
