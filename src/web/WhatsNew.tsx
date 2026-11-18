import {
	AlertIcon,
	ArrowUpIcon,
	ChevronDownIcon,
	DownloadIcon,
	LinkExternalIcon,
	PlusCircleIcon,
	PlusIcon,
	ToolsIcon,
	XIcon,
} from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import type { NoteKind, ReleaseNote } from "../shared/releaseNotes";
import { releaseUrl, type UpdateInfo } from "../shared/update";
import {
	compareUrl,
	type NotesSection,
	noteParts,
	prUrl,
	RELEASES_URL,
	splitNote,
	type UpdateNotes,
} from "../shared/whatsNew";
import { fetchJson } from "./api";
import { RelativeTime } from "./RelativeTime";
import { SkeletonBar, Spinner } from "./Spinner";
import { Tooltip, TooltipLayer } from "./Tooltip";
import { ByHandWhy } from "./UpdateByHand";
import { Command } from "./UpdateCommand";
import { NOT_PHONE, useMedia } from "./useMedia";

/** The notes of the version on offer (`/api/update/notes`), by version. */
export const notesKey = (version: string) =>
	["update", "notes", version] as const;

const KIND: Record<NoteKind, { label: string; Icon: typeof PlusCircleIcon }> = {
	new: { label: "New", Icon: PlusCircleIcon },
	improved: { label: "Improved", Icon: ArrowUpIcon },
	fixed: { label: "Fixed", Icon: ToolsIcon },
};

const ICON_LINK =
	"flex size-10 shrink-0 items-center justify-center rounded-md text-faint hover:bg-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent";
const TEXT_BUTTON =
	"flex h-10 shrink-0 items-center gap-1 rounded-md px-3 text-sm font-semibold text-ink hover:bg-pressed focus-visible:outline-2 focus-visible:outline-accent";

/** A note's text: plain text and `code` spans, as React text (never HTML). */
export function NoteText(props: { text: string }) {
	let at = 0;
	const parts = noteParts(props.text).map((part) => {
		const key = at;
		at += part.text.length + 1;
		return { ...part, key };
	});
	return (
		<>
			{parts.map((part) =>
				part.code ? (
					<code
						key={part.key}
						className="rounded bg-code px-1 font-mono text-[0.9em] text-code-ink"
					>
						{part.text}
					</code>
				) : (
					<span key={part.key}>{part.text}</span>
				),
			)}
		</>
	);
}

/** Show more / Show less, in place: a 40px toggle with a chevron that turns. */
export function MoreToggle(props: {
	open: boolean;
	onToggle: () => void;
	className?: string;
}) {
	return (
		<button
			type="button"
			aria-expanded={props.open}
			onClick={props.onToggle}
			className={`inline-flex min-h-10 shrink-0 items-center gap-1 rounded-md text-sm font-semibold text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent ${props.className ?? ""}`}
		>
			{props.open ? "Show less" : "Show more"}
			<ChevronDownIcon
				size={16}
				aria-hidden
				className={`transition-transform motion-reduce:transition-none ${props.open ? "rotate-180" : ""}`}
			/>
		</button>
	);
}

/**
 * One note: its kind's icon (neutral: a kind is no review state), its
 * text, and the PRs that shipped it. `summary`: the first sentence only;
 * `expandable`: the rest behind its own Show more.
 */
export function NoteRow(props: {
	note: ReleaseNote;
	summary?: boolean;
	expandable?: boolean;
}) {
	const { note } = props;
	const [open, setOpen] = useState(false);
	const { first, rest } = splitNote(note.text);
	const short = (props.summary || props.expandable) && rest !== "" && !open;
	const { label, Icon } = KIND[note.kind];
	return (
		<li
			data-testid="release-note"
			data-kind={note.kind}
			className="flex gap-2.5 py-0.5"
		>
			<Tooltip content={label} describe={false}>
				{(trigger) => (
					<span
						{...trigger}
						role="img"
						aria-label={label}
						className="flex h-10 w-4 shrink-0 items-center text-muted"
					>
						<Icon size={16} aria-hidden />
					</span>
				)}
			</Tooltip>
			<div className="min-w-0 flex-1 py-2.5 [overflow-wrap:anywhere]">
				<span data-testid="release-note-text">
					<NoteText text={short ? first : note.text} />
				</span>
				{props.expandable && rest !== "" && (
					<MoreToggle
						open={open}
						onToggle={() => setOpen((o) => !o)}
						className="-my-2.5 ml-2 align-middle"
					/>
				)}
			</div>
			{note.prs.length > 0 && (
				<span className="flex shrink-0 flex-wrap justify-end gap-x-1">
					{note.prs.map((pr) => {
						const href = prUrl(pr);
						return href ? (
							<a
								key={pr}
								href={href}
								target="_blank"
								rel="noreferrer"
								className="inline-flex min-h-10 items-center text-xs text-faint underline hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
							>
								#{pr}
							</a>
						) : null;
					})}
				</span>
			)}
		</li>
	);
}

/** "N more changes, no notes yet": an RC's merged PRs without a note, linking the compare view. */
export function Uncovered(props: { count: number; href: string }) {
	if (props.count === 0) return null;
	return (
		<a
			data-testid="notes-uncovered"
			href={props.href}
			target="_blank"
			rel="noreferrer"
			className="flex min-h-10 items-center gap-2.5 text-sm text-muted underline hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
		>
			<PlusIcon size={16} aria-hidden className="shrink-0" />
			{props.count} more {props.count === 1 ? "change" : "changes"}, no notes
			yet
		</a>
	);
}

/** A version's heading: the version, its date, and its release on GitHub. */
export function VersionHead(props: { section: NotesSection }) {
	const { section } = props;
	return (
		<div className="flex min-h-10 items-center gap-2">
			<span className="font-mono text-[15px] font-bold">
				v{section.version}
			</span>
			{section.date && (
				<RelativeTime iso={section.date} className="text-xs text-faint" />
			)}
			<span className="flex-1" />
			{section.released && (
				<Tooltip content="Release on GitHub" describe={false}>
					{(trigger) => (
						<a
							{...trigger}
							href={releaseUrl(section.version)}
							target="_blank"
							rel="noreferrer"
							aria-label="Release on GitHub"
							className={ICON_LINK}
						>
							<LinkExternalIcon size={16} aria-hidden />
						</a>
					)}
				</Tooltip>
			)}
		</div>
	);
}

/** One version's notes in the modal. */
function Section(props: { section: NotesSection; compare: string }) {
	const { section } = props;
	return (
		<section
			data-testid="notes-version"
			data-version={section.version}
			className="py-2 [&+&]:border-t [&+&]:border-line"
		>
			<VersionHead section={section} />
			{section.notes.length > 0 ? (
				<ul className="m-0 list-none p-0">
					{section.notes.map((n) => (
						<NoteRow key={`${n.id}:${n.text}`} note={n} expandable />
					))}
				</ul>
			) : (
				section.uncovered.length === 0 && (
					<p className="py-2 text-sm text-muted">No user-facing changes</p>
				)
			)}
			<Uncovered count={section.uncovered.length} href={props.compare} />
		</section>
	);
}

/** "N notes couldn't be read" (flag uncertainty: a part is missing). */
export function Dropped(props: { count: number }) {
	if (props.count === 0) return null;
	return (
		<p
			data-testid="notes-dropped"
			className="flex min-h-10 items-center gap-2 text-sm text-warn"
		>
			<AlertIcon size={16} aria-hidden className="shrink-0" />
			{props.count === 1
				? "1 note couldn't be read"
				: `${props.count} notes couldn't be read`}
		</p>
	);
}

/** The range: "v0.3.0 → v0.5.0"; from an RC of the same release, "rc.3 → …". */
function range(current: string, available: string): string {
	const [cur, curPre] = current.split(/-(.*)/s);
	const [av] = available.split("-");
	return curPre && cur === av ? curPre : `v${current}`;
}

/**
 * What's new (CAR-201): every version between the running crb and the one
 * on offer, newest first, from the notes the offered version carries;
 * Update below. A centred dialog on a desktop, a bottom sheet on a phone;
 * Escape, the backdrop and ✕ close it, focus going back where it was.
 * Notes never gate the update: Update works while they load and after
 * they fail.
 */
export function WhatsNewModal(props: {
	open: boolean;
	onClose: () => void;
	info: UpdateInfo | undefined;
	onUpdate: (version: string) => void;
}) {
	const { open, onClose, info } = props;
	const version = info?.available ?? null;
	const wide = useMedia(NOT_PHONE);
	const client = useQueryClient();
	const notes = useQuery({
		queryKey: notesKey(version ?? ""),
		queryFn: () =>
			fetchJson<UpdateNotes>("/api/update/notes", { cache: "no-store" }),
		enabled: open && version !== null,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	const retry = useMutation({
		mutationFn: () =>
			fetchJson<UpdateNotes>("/api/update/notes", {
				method: "POST",
				cache: "no-store",
			}),
		onSuccess: (answer) =>
			client.setQueryData(notesKey(answer.available), answer),
	});
	const dialog = useRef<HTMLDialogElement | null>(null);
	const [layer, setLayer] = useState<HTMLDialogElement | null>(null);
	const setDialog = useCallback((el: HTMLDialogElement | null) => {
		dialog.current = el;
		setLayer(el);
	}, []);
	const closeButton = useRef<HTMLButtonElement | null>(null);
	const returnTo = useRef<Element | null>(null);
	const titleId = useId();
	const shown = open && version !== null;
	useEffect(() => {
		const d = dialog.current;
		if (!d) return;
		if (!shown) {
			if (!d.hasAttribute("open")) return;
			if (typeof d.close === "function") d.close();
			else d.removeAttribute("open");
			const back = returnTo.current;
			returnTo.current = null;
			if (back instanceof HTMLElement && back.isConnected) back.focus();
			return;
		}
		if (d.hasAttribute("open")) return;
		returnTo.current = document.activeElement;
		if (typeof d.showModal === "function") d.showModal();
		else d.setAttribute("open", "");
		closeButton.current?.focus();
	}, [shown]);
	const trap = (e: KeyboardEvent<HTMLDialogElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
			return;
		}
		if (e.key !== "Tab") return;
		const d = dialog.current;
		if (!d) return;
		const focusable = [
			...d.querySelectorAll<HTMLElement>(
				'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
			),
		];
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) return;
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	};
	const loading = shown && (notes.isPending || retry.isPending);
	const failure =
		!loading &&
		(retry.isError ? retry.error : notes.isError ? notes.error : null);
	const data = !loading && !failure ? notes.data : undefined;
	let body: ReactNode = null;
	if (shown && version) {
		if (loading) {
			body = (
				<div data-testid="notes-loading">
					<div className="flex min-h-10 items-center font-mono text-[15px] font-bold">
						v{version}
					</div>
					<SkeletonBar className="my-3 w-[85%]" />
					<SkeletonBar className="my-3 w-[70%]" />
					<SkeletonBar className="my-3 w-[78%]" />
				</div>
			);
		} else if (failure) {
			body = (
				<div
					role="alert"
					data-testid="notes-failed"
					className="my-3 flex flex-wrap items-center gap-2 rounded-lg border border-warn bg-warn/10 py-1 pr-1 pl-3"
				>
					<AlertIcon size={16} aria-hidden className="shrink-0 text-warn" />
					<Tooltip content={failure.message} describe={false}>
						{(trigger) => (
							<span
								{...trigger}
								// Focusable so a tap or a key opens the reason on a phone.
								// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
								tabIndex={0}
								className="flex min-h-10 min-w-0 flex-1 items-center rounded-sm [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-accent"
							>
								Notes didn't load
								<span className="max-sm:sr-only">: {failure.message}</span>
							</span>
						)}
					</Tooltip>
					<button
						type="button"
						onClick={() => retry.mutate()}
						className={TEXT_BUTTON}
					>
						Retry
					</button>
					<Tooltip content="Release on GitHub" describe={false}>
						{(trigger) => (
							<a
								{...trigger}
								href={releaseUrl(version)}
								target="_blank"
								rel="noreferrer"
								aria-label="Release on GitHub"
								className={`${ICON_LINK} text-link`}
							>
								<LinkExternalIcon size={16} aria-hidden />
							</a>
						)}
					</Tooltip>
				</div>
			);
		} else if (data) {
			const compare = compareUrl(data.current, data.available);
			body = (
				<>
					<Dropped count={data.dropped} />
					{data.sections.length === 0 ? (
						<p className="py-3 text-sm text-muted">No user-facing changes</p>
					) : (
						data.sections.map((s) => (
							<Section key={s.version} section={s} compare={compare} />
						))
					)}
					{data.older && (
						<a
							href={RELEASES_URL}
							target="_blank"
							rel="noreferrer"
							className="flex min-h-10 items-center gap-1 border-t border-line text-sm text-link underline"
						>
							Older versions
							<LinkExternalIcon size={12} aria-hidden />
						</a>
					)}
				</>
			);
		}
	}
	return (
		<dialog
			ref={setDialog}
			aria-labelledby={titleId}
			data-testid="whats-new"
			data-state={
				!shown ? undefined : loading ? "loading" : failure ? "failed" : "loaded"
			}
			onCancel={(e) => {
				e.preventDefault();
				onClose();
			}}
			onKeyDown={trap}
			onClick={(e) => {
				if (e.target === dialog.current) onClose();
			}}
			className={`max-w-none overflow-hidden border-edge bg-surface p-0 text-ink backdrop:bg-canvas/70 backdrop:backdrop-blur-[2px] open:flex open:flex-col ${
				wide
					? // Top-anchored: notes arriving grow it downwards, the header stays.
						"mx-auto mt-[8dvh] mb-auto max-h-[84dvh] w-[min(34rem,calc(100vw-2rem))] rounded-xl border shadow-float"
					: // A fixed height: notes arriving never move the header.
						"m-0 mt-auto h-[86dvh] max-h-[86dvh] w-full rounded-t-2xl border-t shadow-sheet"
			}`}
		>
			<TooltipLayer.Provider value={layer}>
				{!wide && (
					<div
						aria-hidden
						className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-edge"
					/>
				)}
				<div className="flex shrink-0 items-center gap-2 border-b border-line py-2 pr-2 pl-4">
					<DownloadIcon
						size={16}
						aria-hidden
						className="shrink-0 text-accent"
					/>
					<h2 id={titleId} className="shrink-0 text-xl font-bold text-ink">
						What's new
					</h2>
					{info && version && (
						<span
							data-testid="whats-new-range"
							className="min-w-0 truncate font-mono text-[13px] text-muted"
						>
							<span className="max-[400px]:hidden">
								{range(info.current, version)}{" "}
							</span>
							→ v{version}
						</span>
					)}
					<span className="flex-1" />
					{/* The spinner's slot: kept, so showing it moves nothing. */}
					<span
						data-testid="whats-new-spinner-slot"
						className="flex size-10 shrink-0 items-center justify-center"
					>
						{loading && (
							<Spinner label="Loading notes" className="text-accent" />
						)}
					</span>
					<Tooltip content="Close" describe={false}>
						{(trigger) => (
							<button
								{...trigger}
								ref={(el) => {
									closeButton.current = el;
									trigger.ref(el);
								}}
								type="button"
								aria-label="Close"
								onClick={onClose}
								className="flex size-10 shrink-0 items-center justify-center rounded-md text-faint hover:bg-pressed hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
							>
								<XIcon size={16} aria-hidden />
							</button>
						)}
					</Tooltip>
				</div>
				<div
					data-testid="whats-new-body"
					aria-busy={loading || undefined}
					className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-2"
				>
					{body}
				</div>
				{shown && info && version && (
					<div
						data-testid="whats-new-footer"
						className={`flex shrink-0 gap-2 border-t border-line ${
							wide
								? "items-center py-2 pr-2 pl-4"
								: "flex-col items-stretch px-3 pt-2 pb-3"
						}`}
					>
						{info.oneClick ? (
							<>
								{wide && <span className="flex-1" />}
								<Tooltip
									content={`Install v${version} and restart crb`}
									describe={false}
								>
									{(trigger) => (
										<button
											{...trigger}
											type="button"
											onClick={() => {
												onClose();
												props.onUpdate(version);
											}}
											className={`cta flex shrink-0 items-center justify-center rounded-md px-[18px] text-sm font-semibold text-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
												wide ? "h-10" : "h-11 w-full"
											}`}
										>
											Update to v{version}
										</button>
									)}
								</Tooltip>
							</>
						) : (
							info.command && (
								<div className="min-w-0 flex-1">
									{info.byHand && (
										<ByHandWhy
											info={info}
											prefix="No auto-update"
											className="text-muted"
										/>
									)}
									<Command command={info.command} />
								</div>
							)
						)}
					</div>
				)}
			</TooltipLayer.Provider>
		</dialog>
	);
}
