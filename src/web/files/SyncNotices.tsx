import { AlertIcon, ClockIcon, SyncIcon } from "@primer/octicons-react";
import { useLayoutEffect, useRef } from "react";
import { LabeledIcon } from "../overview/parts";
import { Tooltip } from "../Tooltip";
import { describePending, pendingFiles } from "./stateSync";
import { useSetStates, useSyncState } from "./useSetStates";

const changes = (n: number) => `${n} ${n === 1 ? "change" : "changes"}`;

/**
 * Unsaved review state, fixed at the bottom of the window: above the
 * floating Files button while there is one (narrow), bottom right once the
 * file tree is a sidebar on the left (md+), so neither is covered.
 * - Yellow: "Saving N changes…" once a change being synced has waited over
 *   5 s (retries included), why it waits, and the files; gone by itself once
 *   all are stored.
 * - Red: changes the server refused, the error and Retry. The other changes
 *   keep syncing. Also red once 5 transient failures in a row kept changes
 *   waiting (the last error and Retry), while retrying goes on.
 * The changes stay on screen either way.
 */
export function SyncNotices() {
	const { pending, rejected, delayed, failure, waiting, stalled } =
		useSyncState();
	const { retry } = useSetStates();
	const stack = useRef<HTMLDivElement>(null);
	const shown = pending.size > 0;
	// How far up from the window's bottom the notices reach, as
	// --sync-notices, so the file list can pad its end by it.
	useLayoutEffect(() => {
		const root = document.documentElement;
		const el = stack.current;
		if (!shown || !el) {
			root.style.removeProperty("--sync-notices");
			return;
		}
		const measure = () => {
			const r = el.getBoundingClientRect();
			if (r.height === 0) root.style.removeProperty("--sync-notices");
			else {
				const reach = window.innerHeight - r.top + 8;
				root.style.setProperty("--sync-notices", `${Math.ceil(reach)}px`);
			}
		};
		measure();
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(measure);
		observer?.observe(el);
		window.addEventListener("resize", measure);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", measure);
			root.style.removeProperty("--sync-notices");
		};
	}, [shown]);
	// Nothing unsaved: nothing here. With something unsaved the status region
	// is in place (empty) before the delayed notice fills it, so it's announced.
	if (pending.size === 0) return null;
	const syncing = new Map([...pending].filter(([key]) => !rejected.has(key)));
	const showStalled = stalled !== null && syncing.size > 0;
	const showDelayed = delayed && syncing.size > 0 && !showStalled;
	const retryButton = (
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
	);
	return (
		<div
			ref={stack}
			data-testid="sync-notices"
			className="pointer-events-none fixed inset-x-3 bottom-20 z-40 flex flex-col gap-2 sm:inset-x-auto sm:left-4 sm:w-96 md:right-4 md:bottom-4 md:left-auto md:w-80"
		>
			{failure && rejected.size > 0 && (
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
								{describePending(rejected)}
							</p>
							{rejected.size > 1 && (
								<p className="font-mono text-xs break-words text-muted">
									{pendingFiles(rejected)}
								</p>
							)}
							<p className="break-words text-bad">{failure.message}</p>
						</div>
						{retryButton}
					</div>
				</div>
			)}
			{showStalled && (
				// Transient failures that kept on: red, though retrying goes on.
				<div
					role="alert"
					data-testid="save-stalled"
					className="pointer-events-auto overflow-hidden rounded-lg border border-bad/50 bg-raised shadow-float"
				>
					<div className="flex items-start gap-2 bg-bad/10 py-1 pr-1 pl-3">
						<LabeledIcon
							icon={AlertIcon}
							label="Not saved yet, still retrying"
							className="mt-2.5 text-bad"
						/>
						<div className="min-w-0 flex-1 py-2 text-sm">
							<p className="break-words font-medium text-ink">
								{describePending(syncing)}
							</p>
							{syncing.size > 1 && (
								<p className="font-mono text-xs break-words text-muted">
									{pendingFiles(syncing)}
								</p>
							)}
							<p className="break-words text-bad">{stalled.message}</p>
						</div>
						{retryButton}
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
								Saving {changes(syncing.size)}…
								{waiting && (
									<span
										data-testid="save-waiting"
										className="block text-xs break-words text-muted"
									>
										{waiting}
									</span>
								)}
								<span className="block font-mono text-xs break-words text-muted">
									{pendingFiles(syncing)}
								</span>
							</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
