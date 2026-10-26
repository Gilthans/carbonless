import type { SessionInfo } from "../shared/types";
import { safeHref } from "./ui";

/**
 * Shown when the PR has new commits. A started review is pinned to its
 * snapshot, so it says so; an unstarted one follows the PR's head and only
 * needs a Refresh (never automatic: the diff must not change under the reader).
 * A head pinned by `crb --head` never moves: it names the commit shown.
 */
export function HeadBanner({ info }: { info: SessionInfo }) {
	if (!info.headMoved) return null;
	if (info.pinnedHead !== null) {
		return (
			<div
				role="status"
				className="border-y border-warn/30 bg-warn/10 text-sm text-ink"
			>
				<p className="mx-auto max-w-5xl px-4 py-2 break-words sm:px-6">
					Viewing{" "}
					<code className="font-mono">{info.snapshotHead.slice(0, 7)}</code>
					{"; "}this PR has newer commits.
				</p>
			</div>
		);
	}
	if (info.patchset === null) {
		return (
			<div
				role="status"
				className="border-y border-accent/30 bg-accent/10 text-sm text-ink"
			>
				<p className="mx-auto max-w-5xl px-4 py-2 break-words sm:px-6">
					New commits were pushed to this PR. Press Refresh to load them.
				</p>
			</div>
		);
	}
	const href = safeHref(info.pr.url);
	return (
		<div
			role="status"
			className="border-y border-warn/30 bg-warn/10 text-sm text-ink"
		>
			<p className="mx-auto max-w-5xl px-4 py-2 break-words sm:px-6">
				<span>
					New commits were pushed to this PR. You're reviewing the snapshot from{" "}
					<code className="font-mono">{info.snapshotHead.slice(0, 7)}</code>
					{"; "}there's no way to move to the new head yet.
				</span>
				{href && (
					<>
						{" "}
						<a
							href={href}
							target="_blank"
							rel="noreferrer"
							className="font-medium text-link underline"
						>
							Open the PR on GitHub
						</a>
					</>
				)}
			</p>
		</div>
	);
}
