import {
	AlertIcon,
	ClockIcon,
	LinkExternalIcon,
	SyncIcon,
	TrashIcon,
	XIcon,
} from "@primer/octicons-react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";
import type { ReviewThread, ThreadsView } from "../../shared/types";
import { headerLine, LabeledIcon } from "../overview/parts";
import { Tooltip } from "../Tooltip";
import { NEW_THREAD } from "../threads/drafts";
import { newThreadError } from "../threads/NewThread";
import {
	type ThreadWriteView,
	useThreadWriter,
	useThreadWrites,
} from "../threads/threadWrites";
import { safeHref } from "../ui";
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
 * The changes stay on screen either way. Thread writes (replies, resolve,
 * unresolve, edits, deletes) show the same way, one notice per thread, naming the thread
 * and the action (ThreadWriteNotices).
 */
export function SyncNotices() {
	const { pending, rejected, delayed, failure, waiting, stalled } =
		useSyncState();
	const { retry } = useSetStates();
	const writes = useThreadWrites();
	const stack = useRef<HTMLDivElement>(null);
	const writeNotices = [...writes.threads.values()].filter(
		(t) => t.failed || t.stalled || t.delayed || t.resumed,
	);
	const shown = pending.size > 0 || writeNotices.length > 0;
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
	if (!shown) return null;
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
			<ThreadWriteNotices threads={writeNotices} />
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

/**
 * Where a thread is, in a few words: its file and line, the file for a
 * file comment, "PR comment" when it has neither (or isn't listed).
 */
export function threadLabel(thread: ReviewThread | undefined): string {
	if (!thread?.path) return "PR comment";
	const line = thread.subject === "file" ? null : headerLine(thread);
	return line === null ? thread.path : `${thread.path}:${line}`;
}

/** The thread as the page's latest thread list has it. */
function findThread(
	client: QueryClient,
	threadId: string,
): ReviewThread | undefined {
	const lists = client.getQueriesData<ThreadsView>({ queryKey: ["threads"] });
	for (let i = lists.length - 1; i >= 0; i--) {
		const found = lists[i]?.[1]?.threads.find((t) => t.id === threadId);
		if (found) return found;
	}
	return undefined;
}

const NOTICE_RED =
	"pointer-events-auto overflow-hidden rounded-lg border border-bad/50 bg-raised shadow-float";

/**
 * Thread writes not yet on GitHub, one notice per thread: red with Retry
 * when refused (a pending review: its link) or after STALL_ATTEMPTS
 * transient failures, yellow once one has waited over 5 s.
 */
function ThreadWriteNotices({ threads }: { threads: ThreadWriteView[] }) {
	const client = useQueryClient();
	const writer = useThreadWriter();
	if (threads.length === 0) return null;
	const iconButton = (
		label: string,
		tip: string,
		Icon: typeof XIcon,
		onClick: () => void,
	) => (
		<Tooltip content={tip} describe={false}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					aria-label={label}
					onClick={onClick}
					className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
				>
					<Icon aria-hidden />
				</button>
			)}
		</Tooltip>
	);
	// A reply or edit resent from an earlier page: only it goes, never the
	// box or a newer write.
	const what = (t: ThreadWriteView) =>
		t.action === "Edit"
			? "edit"
			: t.action === "New comment"
				? "comment"
				: "reply";
	const discardButton = (t: ThreadWriteView) =>
		iconButton(`Discard ${what(t)}`, "Discard", TrashIcon, () =>
			writer.discardResumed(t.threadId),
		);
	const retryButton = (t: ThreadWriteView, action: string) => (
		<Tooltip content="Retry" describe={false}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					aria-label={`Retry ${action.toLowerCase()}`}
					onClick={() => writer.retry(t.threadId)}
					className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
				>
					<SyncIcon aria-hidden />
				</button>
			)}
		</Tooltip>
	);
	return (
		<>
			{threads.map((t) => {
				const created = t.threadId.startsWith(NEW_THREAD)
					? writer.drafts.newThread(t.threadId.slice(NEW_THREAD.length))?.create
					: undefined;
				const where = created
					? created.subject === "file" || created.line === undefined
						? created.path
						: `${created.path}:${created.line}`
					: threadLabel(findThread(client, t.threadId));
				if (t.failed) {
					const blocked = t.failed.code === "pending-review";
					const changed =
						t.failed.action === "Edit" && t.failed.code === "changed";
					const commentId = t.failed.commentId ?? "";
					const textButton = (
						label: string,
						testId: string,
						onClick: () => void,
					) => (
						<button
							type="button"
							data-testid={testId}
							onClick={onClick}
							className="flex min-h-10 items-center rounded-md px-1 font-semibold text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
						>
							{label}
						</button>
					);
					const href = safeHref(t.failed.url);
					return (
						<div
							key={t.threadId}
							role="alert"
							data-testid="write-failed"
							className={NOTICE_RED}
						>
							<div className="flex items-start gap-2 bg-bad/10 py-1 pr-1 pl-3">
								<LabeledIcon
									icon={AlertIcon}
									label="Not posted"
									className="mt-2.5 text-bad"
								/>
								<div className="min-w-0 flex-1 py-2 text-sm">
									<p className="break-words font-medium text-ink">
										{t.failed.action} ·{" "}
										<span className="font-mono text-xs">{where}</span>
									</p>
									<p className="break-words text-bad">
										{t.failed.action === "New comment"
											? newThreadError(t.failed, created)
											: blocked
												? "A pending review on GitHub blocks replies"
												: changed
													? "Changed on GitHub since you opened it"
													: t.failed.error.message}
									</p>
									{changed && (
										<div className="flex flex-wrap gap-x-3">
											{textButton("Show theirs", "edit-show-theirs", () =>
												writer.showTheirs(t.threadId),
											)}
											{textButton("Save anyway", "edit-save-anyway", () =>
												writer.saveEdit(t.threadId, commentId, true),
											)}
										</div>
									)}
									{blocked && href && (
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
								</div>
								<div className="flex flex-col">
									{!changed && retryButton(t, t.failed.action)}
									{iconButton(
										`Dismiss ${t.failed.action.toLowerCase()}`,
										t.failed.action === "Reply"
											? "Dismiss (the text stays in the box)"
											: t.failed.action === "Edit"
												? "Dismiss (the text stays in the editor)"
												: "Dismiss",
										XIcon,
										() => writer.dismiss(t.threadId),
									)}
								</div>
							</div>
						</div>
					);
				}
				if (t.stalled) {
					return (
						<div
							key={t.threadId}
							role="alert"
							data-testid="write-stalled"
							className={NOTICE_RED}
						>
							<div className="flex items-start gap-2 bg-bad/10 py-1 pr-1 pl-3">
								<LabeledIcon
									icon={AlertIcon}
									label="Not posted yet, still retrying"
									className="mt-2.5 text-bad"
								/>
								<div className="min-w-0 flex-1 py-2 text-sm">
									<p className="break-words font-medium text-ink">
										{t.action} ·{" "}
										<span className="font-mono text-xs">{where}</span>
									</p>
									<p className="break-words text-bad">{t.stalled.message}</p>
								</div>
								<div className="flex flex-col">
									{retryButton(t, t.action ?? "write")}
									{t.resumed && discardButton(t)}
								</div>
							</div>
						</div>
					);
				}
				if (t.resumed && !t.delayed) {
					// Left unconfirmed by an earlier page: resent (the server finds
					// one that landed); the reviewer may let it go.
					return (
						<div
							key={t.threadId}
							role="status"
							data-testid="write-resumed"
							className="pointer-events-auto overflow-hidden rounded-lg border border-warn/50 bg-raised shadow-float"
						>
							<div className="flex items-center gap-2 bg-warn/10 py-1 pr-1 pl-3 text-sm">
								<LabeledIcon
									icon={SyncIcon}
									label={`Resending ${t.action === "Edit" ? "an edit" : t.action === "New comment" ? "a comment" : "a reply"} from before`}
									className="text-warn"
								/>
								<p className="min-w-0 flex-1 break-words text-ink">
									{t.action ?? "Reply"} ·{" "}
									<span className="font-mono text-xs">{where}</span>
								</p>
								{discardButton(t)}
							</div>
						</div>
					);
				}
				return (
					<div
						key={t.threadId}
						role="status"
						data-testid="write-delayed"
						className="pointer-events-auto overflow-hidden rounded-lg border border-warn/50 bg-raised shadow-float"
					>
						<div
							className={`flex min-h-10 items-center gap-2 bg-warn/10 py-2 pl-3 text-sm ${t.resumed ? "pr-1" : "pr-3"}`}
						>
							<LabeledIcon
								icon={ClockIcon}
								label="Posting is delayed"
								className="text-warn"
							/>
							<p className="min-w-0 flex-1 break-words text-ink">
								{t.action}…
								{t.waiting && (
									<span className="block text-xs break-words text-muted">
										{t.waiting}
									</span>
								)}
								<span className="block font-mono text-xs break-words text-muted">
									{where}
								</span>
							</p>
							{t.resumed && discardButton(t)}
						</div>
					</div>
				);
			})}
		</>
	);
}
