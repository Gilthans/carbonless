import type { SessionInfo } from "../shared/types";
import { safeHref } from "./ui";

/** Shown when the PR has new commits past the snapshot being reviewed. */
export function HeadBanner({ info }: { info: SessionInfo }) {
	if (!info.headMoved) return null;
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
