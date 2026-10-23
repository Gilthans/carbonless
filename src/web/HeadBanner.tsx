import type { SessionInfo } from "../shared/types";
import { safeHref } from "./ui";

/**
 * Shown when the PR has new commits. A started review is pinned to its
 * snapshot, so it says so; an unstarted one follows the PR's head and only
 * needs a Refresh (never automatic: the diff must not change under the reader).
 */
export function HeadBanner({ info }: { info: SessionInfo }) {
	if (!info.headMoved) return null;
	if (info.patchset === null) {
		return (
			<div
				role="status"
				className="border-y border-sky-200 bg-sky-50 text-sm text-sky-900"
			>
				<p className="mx-auto max-w-5xl px-6 py-2">
					New commits were pushed to this PR. Press Refresh to load them.
				</p>
			</div>
		);
	}
	const href = safeHref(info.pr.url);
	return (
		<div
			role="status"
			className="border-y border-amber-200 bg-amber-50 text-sm text-amber-900"
		>
			<p className="mx-auto max-w-5xl px-6 py-2">
				<span>
					New commits were pushed to this PR. You're reviewing the snapshot from{" "}
					{info.snapshotHead.slice(0, 7)}; there's no way to move to the new
					head yet.
				</span>
				{href && (
					<>
						{" "}
						<a
							href={href}
							target="_blank"
							rel="noreferrer"
							className="font-medium underline"
						>
							Open the PR on GitHub
						</a>
					</>
				)}
			</p>
		</div>
	);
}
