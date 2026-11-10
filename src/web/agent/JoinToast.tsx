import { PlugIcon, XIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { AgentStatus, JoinLeave } from "../../shared/agent";
import { boundReviewId } from "../api";
import { RelativeTime } from "../RelativeTime";
import { Tooltip } from "../Tooltip";
import { agentStatusQuery, useAgentOn } from "./api";

/** How long the toast shows. */
export const TOAST_MS = 6000;

/** What the toast says after the session's name. */
export function leftWord(why: JoinLeave): string {
	switch (why) {
		case "lost":
			return "disconnected";
		case "replaced":
			return "replaced";
		default:
			// Its own detach, or the reviewer's Disconnect.
			return "left";
	}
}

type Left = NonNullable<AgentStatus["left"]>;

/**
 * Per page load (module state, so a remount doesn't toast again): each
 * review's `left.at` from the first status this load read (it happened
 * before the tab was looking: no toast), and the ones already toasted.
 */
const baseline = new Map<string, string | null>();
const toasted = new Set<string>();

/** Test hook: forgets what this "tab" has seen. */
export function resetJoinToasts(): void {
	baseline.clear();
	toasted.clear();
}

/**
 * The leave to toast for `review` given the latest status, at most once per
 * `left.at` per tab: none for the leave already there on this tab's first
 * read. Marks it toasted.
 */
export function takeLeft(
	review: string,
	status: AgentStatus | undefined,
): Left | null {
	if (!status) return null;
	const at = status.left?.at ?? null;
	if (!baseline.has(review)) {
		baseline.set(review, at);
		return null;
	}
	if (!status.left || at === baseline.get(review)) return null;
	const key = `${review}|${at}`;
	if (toasted.has(key)) return null;
	toasted.add(key);
	return status.left;
}

const visible = () =>
	typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * "carbonless · devbox left": a joined session left this review (its
 * detach, your Disconnect, its watcher gone, a newer join). Shown for
 * TOAST_MS once the tab is seen (a leave read while hidden waits for the
 * tab to come back), under the sticky header, over the page (no layout
 * shift), announced politely.
 */
export function JoinToast() {
	const on = useAgentOn();
	const review = boundReviewId() ?? "";
	const status = useQuery({ ...agentStatusQuery, enabled: on });
	const [queued, setQueued] = useState<Left | null>(null);
	const [shown, setShown] = useState<Left | null>(null);
	const data = on ? status.data : undefined;
	useEffect(() => {
		const left = takeLeft(review, data);
		if (left) setQueued(left);
	}, [review, data]);
	// Waits for the tab to be seen.
	useEffect(() => {
		if (!queued) return;
		const show = () => {
			if (!visible()) return;
			setShown(queued);
			setQueued(null);
		};
		show();
		document.addEventListener("visibilitychange", show);
		return () => document.removeEventListener("visibilitychange", show);
	}, [queued]);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => {
		if (!shown) return;
		timer.current = setTimeout(() => setShown(null), TOAST_MS);
		return () => clearTimeout(timer.current);
	}, [shown]);
	if (!shown) return null;
	return (
		<div
			role="status"
			aria-live="polite"
			className="pointer-events-none fixed inset-x-3 z-40 flex justify-end sm:left-auto"
			style={{ top: "calc(var(--app-header, 0px) + 0.5rem)" }}
		>
			{
				<div
					data-testid="join-toast"
					data-why={shown.why}
					className="pointer-events-auto flex min-h-10 max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-agent-edge bg-overlay py-1 pr-1 pl-3 text-sm text-ink-soft shadow-float"
				>
					<PlugIcon size={16} aria-hidden className="shrink-0 text-agent-ink" />
					<span className="min-w-0 truncate">
						<b className="font-semibold text-ink">{shown.name}</b>{" "}
						{leftWord(shown.why)}
					</span>
					<RelativeTime iso={shown.at} className="shrink-0 text-muted" />
					<Tooltip content="Dismiss" describe={false}>
						{(trigger) => (
							<button
								type="button"
								{...trigger}
								aria-label="Dismiss"
								onClick={() => setShown(null)}
								className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
							>
								<XIcon aria-hidden />
							</button>
						)}
					</Tooltip>
				</div>
			}
		</div>
	);
}
