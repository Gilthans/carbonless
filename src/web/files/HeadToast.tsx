import { GitCommitIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";
import type { SessionInfo } from "../../shared/types";
import { Tooltip } from "../Tooltip";
import { headIsNewer } from "./PatchsetGraph";

/** How long the toast stays before it goes by itself. */
export const TOAST_MS = 20_000;

/**
 * Where the toast sits: fixed at the bottom of the window, left of the
 * save notices (SyncNotices' NOTICE_STACK sits right from md up), above
 * the floating Files button on a phone.
 */
const TOAST_PLACE =
	"pointer-events-none fixed inset-x-3 bottom-20 z-40 flex sm:inset-x-auto sm:left-4 sm:w-96 md:bottom-4";

/**
 * The head the toast would be about: the PR's head when it is newer than
 * the newest patch set (or the snapshot before any) and not the head this
 * crb last opened the review on (the reviewer has seen that one); null
 * otherwise (a merged or closed PR, an as-of view and a pinned head report
 * no head at all).
 */
export function toastHead(session: SessionInfo): SessionInfo["head"] {
	if (!session.head || !headIsNewer(session)) return null;
	if (session.lastSeen?.head === session.head.oid) return null;
	return session.head;
}

/**
 * New commits arrived (design doc, "New commits arriving"): "3 new commits ·
 * f9e8d7c" with View (the viewing marker onto the head dot) and a dismiss,
 * at the bottom of the window. A status, never focused: the review in
 * progress is not interrupted. Goes by itself after TOAST_MS; a head
 * dismissed stays dismissed, a newer one shows again.
 */
export function HeadToast(props: {
	session: SessionInfo;
	onView: () => void;
	onDismiss?: () => void;
}) {
	const head = toastHead(props.session);
	const oid = head?.oid ?? null;
	const [dismissed, setDismissed] = useState<string | null>(null);
	useEffect(() => {
		if (oid === null || dismissed === oid) return;
		const timer = window.setTimeout(() => setDismissed(oid), TOAST_MS);
		return () => window.clearTimeout(timer);
	}, [oid, dismissed]);
	if (!head || dismissed === head.oid) return null;
	const commits = head.commits;
	const dismiss = () => {
		setDismissed(head.oid);
		props.onDismiss?.();
	};
	return (
		<div className={TOAST_PLACE}>
			<div
				role="status"
				data-testid="head-toast"
				className="pointer-events-auto flex min-h-12 w-full items-center gap-2 rounded-lg border border-edge bg-overlay py-1 pr-1 pl-3 text-sm text-ink shadow-float"
			>
				<GitCommitIcon size={16} aria-hidden className="shrink-0 text-warn" />
				<span className="min-w-0 flex-1 truncate">
					<b className="font-semibold">
						{commits} new {commits === 1 ? "commit" : "commits"}
					</b>{" "}
					·{" "}
					<code className="font-mono text-ink-soft">
						{head.oid.slice(0, 7)}
					</code>
				</span>
				<Tooltip
					content="View the new head (nothing is stored until your first mark)"
					describe={false}
				>
					{(trigger) => (
						<button
							type="button"
							{...trigger}
							onClick={() => {
								dismiss();
								props.onView();
							}}
							className="flex h-10 shrink-0 items-center rounded-md px-3 text-sm font-semibold text-ink hover:bg-pressed focus-visible:outline-2 focus-visible:outline-accent"
						>
							View
						</button>
					)}
				</Tooltip>
				<Tooltip content="Dismiss" describe={false}>
					{(trigger) => (
						<button
							type="button"
							{...trigger}
							aria-label="Dismiss"
							onClick={dismiss}
							className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-faint hover:bg-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
						>
							<XIcon size={16} aria-hidden />
						</button>
					)}
				</Tooltip>
			</div>
		</div>
	);
}
