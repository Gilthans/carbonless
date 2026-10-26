import { AlertIcon, ClockIcon, SyncIcon } from "@primer/octicons-react";
import { LabeledIcon } from "../overview/parts";
import { Tooltip } from "../Tooltip";
import { describePending, pendingFiles } from "./stateSync";
import { useSetStates, useSyncState } from "./useSetStates";

const changes = (n: number) => `${n} ${n === 1 ? "change" : "changes"}`;

/**
 * Unsaved review state, fixed at the bottom of the window (above the phone's
 * floating Files button): a yellow "Saving N changes…" once a change has
 * waited over 5 s (retries included), gone by itself once all are stored;
 * a red notice when a save failed for good, with what failed, the error and
 * Retry. The changes stay on screen either way.
 */
export function SyncNotices() {
	const { pending, delayed, failure } = useSyncState();
	const { retry } = useSetStates();
	// Nothing unsaved: nothing here. With something unsaved the status region
	// is in place (empty) before the delayed notice fills it, so it's announced.
	if (pending.size === 0 && !failure) return null;
	const what = describePending(pending);
	const showDelayed = !failure && delayed && pending.size > 0;
	return (
		<div
			data-testid="sync-notices"
			className="pointer-events-none fixed inset-x-3 bottom-20 z-40 flex flex-col gap-2 sm:inset-x-auto sm:bottom-4 sm:left-4 sm:w-96"
		>
			{failure && (
				<div
					role="alert"
					data-testid="save-failed"
					className="pointer-events-auto overflow-hidden rounded-lg border border-bad/50 bg-raised shadow-float"
				>
					<div className="flex items-start gap-2 bg-bad/10 py-1 pr-1 pl-3">
						<LabeledIcon
							icon={AlertIcon}
							label="Not saved"
							className="mt-2.5 text-bad"
						/>
						<div className="min-w-0 flex-1 py-2 text-sm">
							<p className="break-words font-medium text-ink">
								{pending.size > 0 ? what : "Not saved"}
							</p>
							<p className="break-words text-bad">{failure.message}</p>
						</div>
						<Tooltip content="Retry" describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									aria-label="Retry saving"
									onClick={retry}
									className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
								>
									<SyncIcon aria-hidden />
								</button>
							)}
						</Tooltip>
					</div>
				</div>
			)}
			<div role="status">
				{showDelayed && (
					<div
						data-testid="save-delayed"
						className="pointer-events-auto overflow-hidden rounded-lg border border-warn/50 bg-raised shadow-float"
					>
						<div className="flex min-h-10 items-center gap-2 bg-warn/10 px-3 py-2 text-sm">
							<LabeledIcon
								icon={ClockIcon}
								label="Saving is delayed"
								className="text-warn"
							/>
							<p className="min-w-0 flex-1 break-words text-ink">
								Saving {changes(pending.size)}…
								<span className="block font-mono text-xs break-all text-muted">
									{pendingFiles(pending)}
								</span>
							</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
