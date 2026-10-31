import {
	AlertIcon,
	ChevronDownIcon,
	LinkExternalIcon,
	SyncIcon,
	TrashIcon,
} from "@primer/octicons-react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type {
	ReviewThread,
	ThreadComments,
	ThreadsView,
} from "../../shared/types";
import { headerLine } from "../overview/parts";
import { Tooltip } from "../Tooltip";
import { type DraftStore, NEW_THREAD, useDrafts } from "../threads/drafts";
import { newThreadError } from "../threads/NewThread";
import { closeComposer } from "../threads/newThreads";
import {
	dropLosesText,
	type RefusedWrite,
	useThreadWriter,
	useThreadWrites,
} from "../threads/threadWrites";
import { safeHref } from "../ui";

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

/** A write's thread, as a notice names it: a new thread by its draft's place. */
export function writeWhere(
	client: QueryClient,
	drafts: DraftStore,
	threadId: string,
): string {
	if (threadId.startsWith(NEW_THREAD)) {
		const c = drafts.newThread(threadId.slice(NEW_THREAD.length))?.create;
		if (c) {
			return c.subject === "file" || c.line === undefined
				? c.path
				: `${c.path}:${c.line}`;
		}
		return "New comment";
	}
	return threadLabel(findThread(client, threadId));
}

/** The comment's text as last read, for a refused delete's preview. */
function commentText(client: QueryClient, commentId: string): string {
	const reads = client.getQueriesData<ThreadComments>({
		queryKey: ["comments"],
	});
	for (const [, data] of reads) {
		const found = data?.comments.find((c) => c.id === commentId);
		if (found) return found.text;
	}
	return "";
}

/** What the refused write said: the box, edit or new thread's text now (what Retry sends). */
function previewOf(
	client: QueryClient,
	drafts: DraftStore,
	f: RefusedWrite,
): string {
	const text =
		f.action === "Reply"
			? drafts.text(f.threadId)
			: f.action === "Edit"
				? (drafts.edit(f.commentId ?? "")?.text ?? "")
				: f.action === "New comment"
					? (drafts.newThread(f.threadId.slice(NEW_THREAD.length))?.text ?? "")
					: f.action === "Delete"
						? commentText(client, f.commentId ?? "")
						: "";
	return text.replace(/\s+/g, " ").trim();
}

/** GitHub's reason, in a few words. */
function reasonOf(drafts: DraftStore, f: RefusedWrite): string {
	if (f.action === "New comment") {
		const c = drafts.newThread(f.threadId.slice(NEW_THREAD.length))?.create;
		return newThreadError(f, c);
	}
	if (f.code === "pending-review") {
		return "A pending review on GitHub blocks replies";
	}
	if (f.action === "Edit" && f.code === "changed") {
		return "Changed on GitHub since you opened it";
	}
	return f.error.message;
}

const ICON_BUTTON =
	"flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint disabled:hover:bg-transparent";
const TEXT_BUTTON =
	"flex min-h-10 items-center rounded-md px-1 font-semibold text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent";

/** When this page started: refusals from before (restored) don't open the list. */
const pageStart = new Date().toISOString();

/**
 * Every write GitHub refused, in one place that stays on screen until each
 * is settled (owner: "an always on thing that allows to either retry or
 * drop"): a red chip with the count, at the bottom of SyncNotices on both
 * pages, opening their list. Each says what it was and where, its text,
 * GitHub's reason, Retry (listed until GitHub takes it; refused again,
 * with the new reason) and Drop, which asks in place first. It opens by
 * itself when a write is newly refused; restored ones (from before a
 * reload) wait for the reviewer.
 */
export function RefusedWrites() {
	const { refused } = useThreadWrites();
	const [open, setOpen] = useState(false);
	const listId = useId();
	// Opened in the same render as a new refusal, so the notices measure
	// their full reach at once (useClearOfNotices scrolls a box above it).
	// A Retry refused again is news too (its `last` moves on).
	const id = (f: RefusedWrite) => `${f.threadId}\n${f.key}\n${f.last ?? f.at}`;
	const keys = refused.map(id).join("\0");
	const [seen, setSeen] = useState("");
	const [news, setNews] = useState<{ text: string; n: number } | null>(null);
	if (keys !== seen) {
		const before = new Set(seen.split("\0"));
		const fresh = refused.filter(
			(f) => !before.has(id(f)) && (f.last ?? f.at) >= pageStart,
		);
		setSeen(keys);
		const latest = fresh.at(-1);
		if (latest) {
			if (!open) setOpen(true);
			setNews({
				text: `${latest.action} not posted: ${latest.error.message}`,
				n: (news?.n ?? 0) + 1,
			});
		}
	}
	if (refused.length === 0) return null;
	const n = refused.length;
	const label = `${n} not posted`;
	return (
		<div className="pointer-events-none flex flex-col items-end gap-2">
			{news && (
				// Inserted anew for each refusal, so it's announced every time.
				<p
					key={news.n}
					role="alert"
					data-testid="refused-news"
					className="sr-only"
				>
					{news.text}
				</p>
			)}
			{open && <RefusedList id={listId} refused={refused} />}
			<Tooltip content="Not posted" describe={false}>
				{(trigger) => (
					<button
						type="button"
						{...trigger}
						data-testid="refused-bar"
						aria-label={label}
						aria-expanded={open}
						aria-controls={open ? listId : undefined}
						onClick={() => setOpen(!open)}
						className="pointer-events-auto flex h-10 min-w-10 items-center gap-1.5 rounded-full border border-bad/60 bg-raised px-3 text-sm font-semibold text-bad shadow-float hover:bg-bad/10 focus-visible:outline-2 focus-visible:outline-accent"
					>
						<AlertIcon size={16} aria-hidden />
						<span aria-hidden className="tabular-nums">
							{n}
						</span>
						<ChevronDownIcon
							size={16}
							aria-hidden
							className={open ? "" : "rotate-180"}
						/>
					</button>
				)}
			</Tooltip>
		</div>
	);
}

function RefusedList(props: { id: string; refused: readonly RefusedWrite[] }) {
	const writer = useThreadWriter();
	const { refused } = props;
	const retriable = refused.filter(
		(f) =>
			!f.retrying && f.code !== "changed" && writer.sendable(f.threadId, f),
	);
	const list = useRef<HTMLUListElement>(null);
	/** A dropped item's place goes to the next one, else the chip. */
	const dropped = (index: number) =>
		requestAnimationFrame(() => {
			const items = list.current?.querySelectorAll<HTMLElement>(
				'[data-testid="refused-write"]',
			);
			const next = items?.[index]?.querySelector<HTMLButtonElement>(
				"button:not(:disabled)",
			);
			const chip = document.querySelector<HTMLButtonElement>(
				'[data-testid="refused-bar"]',
			);
			(next ?? chip)?.focus();
		});
	return (
		<section
			id={props.id}
			aria-label="Not posted"
			data-testid="refused-list"
			className="pointer-events-auto w-full overflow-hidden rounded-lg border border-bad/50 bg-raised shadow-float"
		>
			{retriable.length > 1 && (
				<div className="flex justify-end border-b border-line bg-bad/10 pr-1">
					<button
						type="button"
						data-testid="refused-retry-all"
						onClick={() => writer.retryAll()}
						className="flex min-h-10 items-center gap-1.5 rounded-md px-2 text-sm font-semibold text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
					>
						<SyncIcon size={16} aria-hidden />
						Retry all
					</button>
				</div>
			)}
			<ul
				ref={list}
				className="max-h-[50vh] divide-y divide-line overflow-y-auto"
			>
				{refused.map((f, i) => (
					<RefusedItem
						key={`${f.threadId}\n${f.key}`}
						write={f}
						onDropped={() => dropped(i)}
					/>
				))}
			</ul>
		</section>
	);
}

function RefusedItem({
	write: f,
	onDropped,
}: {
	write: RefusedWrite;
	onDropped: () => void;
}) {
	const client = useQueryClient();
	const writer = useThreadWriter();
	// Previews follow the drafts (what Retry would send now).
	useDrafts();
	const [confirming, setConfirming] = useState(false);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const dropButton = useRef<HTMLButtonElement>(null);
	const askId = useId();
	useEffect(() => {
		if (confirming) cancelButton.current?.focus({ preventScroll: true });
	}, [confirming]);
	const where = writeWhere(client, writer.drafts, f.threadId);
	const preview = previewOf(client, writer.drafts, f);
	const changed = f.action === "Edit" && f.code === "changed";
	// A cleared box, a gone draft: nothing to send, only Drop.
	const nothing = !f.retrying && !writer.sendable(f.threadId, f);
	const href = f.code === "pending-review" ? safeHref(f.url) : undefined;
	const what = f.action.toLowerCase();
	const cancel = () => {
		setConfirming(false);
		requestAnimationFrame(() => dropButton.current?.focus());
	};
	const drop = () => {
		writer.drop(f.threadId, f.key);
		if (f.action === "New comment") {
			closeComposer(f.threadId.slice(NEW_THREAD.length));
		}
		onDropped();
	};
	return (
		<li data-testid="refused-write" data-retrying={f.retrying || undefined}>
			<div className="flex items-start gap-2 py-1 pr-1 pl-3">
				<div className="min-w-0 flex-1 py-2 text-sm">
					<p className="break-words font-medium text-ink">
						{f.action} · <span className="font-mono text-xs">{where}</span>
					</p>
					{preview ? (
						<p
							data-testid="refused-preview"
							className="truncate text-muted"
							title={preview}
						>
							{preview}
						</p>
					) : (
						dropLosesText(f) && (
							<p
								data-testid="refused-preview-empty"
								className="text-muted italic"
							>
								No text
							</p>
						)
					)}
					<p className="break-words text-bad">{reasonOf(writer.drafts, f)}</p>
					{changed && !f.retrying && (
						<div className="flex flex-wrap gap-x-3">
							{f.current && (
								<button
									type="button"
									data-testid="edit-show-theirs"
									onClick={() =>
										writer.showTheirs(f.threadId, f.commentId ?? "")
									}
									className={TEXT_BUTTON}
								>
									Show theirs
								</button>
							)}
							<button
								type="button"
								data-testid="edit-save-anyway"
								onClick={() =>
									writer.saveEdit(f.threadId, f.commentId ?? "", true)
								}
								className={TEXT_BUTTON}
							>
								Save anyway
							</button>
						</div>
					)}
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
				</div>
				{!confirming && (
					<div className="flex">
						{(!changed || !f.current) && (
							<Tooltip
								content={
									f.retrying
										? "Retrying"
										: nothing
											? "Nothing to send"
											: "Retry"
								}
								describe={false}
							>
								{(trigger) => (
									<button
										type="button"
										{...trigger}
										aria-label={
											f.retrying
												? `Retrying ${what}`
												: nothing
													? `Retry ${what}: nothing to send`
													: `Retry ${what}`
										}
										disabled={f.retrying}
										// Focusable still, so its tip says why.
										aria-disabled={nothing || undefined}
										onClick={() => {
											if (!nothing) writer.retry(f.threadId, f.key);
										}}
										className={`${ICON_BUTTON} aria-disabled:text-faint aria-disabled:hover:bg-transparent`}
									>
										<SyncIcon
											aria-hidden
											className={
												f.retrying
													? "animate-spin motion-reduce:animate-none"
													: ""
											}
										/>
									</button>
								)}
							</Tooltip>
						)}
						<Tooltip content="Drop" describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									ref={(el) => {
										dropButton.current = el;
										trigger.ref(el);
									}}
									aria-label={`Drop ${what}`}
									disabled={f.retrying}
									onClick={() => setConfirming(true)}
									className={ICON_BUTTON}
								>
									<TrashIcon aria-hidden />
								</button>
							)}
						</Tooltip>
					</div>
				)}
			</div>
			{confirming && (
				<div
					role="alertdialog"
					aria-labelledby={askId}
					data-testid="refused-drop-confirm"
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							e.preventDefault();
							e.stopPropagation();
							cancel();
						}
					}}
					className="flex flex-wrap items-center justify-end gap-2 border-t border-bad/30 bg-bad/10 px-3 py-1"
				>
					<p id={askId} className="mr-auto text-sm font-semibold text-ink">
						{dropLosesText(f) ? "Drop this? Its text is lost" : "Drop this?"}
					</p>
					<button
						ref={cancelButton}
						type="button"
						onClick={cancel}
						className="flex h-10 items-center rounded-md px-3 text-sm font-medium text-ink-soft hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="refused-drop-yes"
						onClick={drop}
						className="flex h-10 items-center gap-1.5 rounded-md border border-bad/60 bg-bad/15 px-4 text-sm font-semibold text-bad hover:bg-bad/25 focus-visible:outline-2 focus-visible:outline-accent"
					>
						<TrashIcon size={16} aria-hidden />
						Drop
					</button>
				</div>
			)}
		</li>
	);
}
