import { CommentIcon } from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import {
	type MouseEvent,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { LineRanges } from "../../shared/lineRanges";
import {
	crossOffChange,
	type SincePiece,
	sinceToggleChange,
	toggleChange,
} from "../../shared/pieces";
import type {
	ClusterView,
	FileView,
	SinceMark,
	StateChange,
} from "../../shared/types";
import { hunksQuery, overviewQuery, sessionQuery } from "../api";
import { Spinner } from "../Spinner";
import { Tooltip, TooltipPath, type TooltipTriggerProps } from "../Tooltip";
import { newThreadKey, useDrafts } from "../threads/drafts";
import { NewThread } from "../threads/NewThread";
import {
	closeComposer,
	newThreadItems,
	openComposer,
	useComposers,
} from "../threads/newThreads";
import { OrphanDraft } from "../threads/OrphanDraft";
import { useThreadWriter } from "../threads/threadWrites";
import { ChangeKindIcon, changeKindLabel } from "./changeKind";
import {
	DiffBody,
	type DiffThreads,
	type FileLead,
	READ_ONLY_TIP,
} from "./DiffBody";
import { KindChip } from "./KindChip";
import type { Landing } from "./landing";
import { Meter } from "./ProgressBar";
import { type CodeSpan, commentAvailable } from "./selectionActions";
import type { FileSince } from "./since";
import { isStale } from "./stateSync";
import {
	ChangeCount,
	clusterCount,
	fileProgress as fileStatus,
	lineCount,
	StatusIcon,
} from "./status";
import { ThreadBubble } from "./ThreadBubble";
import { UnplacedThreads } from "./ThreadFate";
import { TailRow, ThreadBlock } from "./ThreadRow";
import { fileThreads, placeThreads } from "./threadPlacement";
import {
	describeFileProgress,
	fileUnitProgress,
	formatFileProgress,
	type Unit,
} from "./unit";
import { useSetStates } from "./useSetStates";

const tones = {
	purple: {
		idle: "border-crossed text-done group-[:enabled:hover]:bg-crossed/20",
		pressed:
			"border-crossed bg-crossed-strong text-ink group-[:enabled:hover]:border-crossed-light group-[:enabled:hover]:bg-crossed",
	},
	green: {
		idle: "border-ok-fill text-ok group-[:enabled:hover]:bg-ok/15",
		pressed: "",
	},
};

/**
 * A file-wide action shown as an outlined icon, named by `label` and
 * explained by `tooltip` (a tooltip, also its accessible description).
 * 40×40 on touch and in a narrow header.
 */
/** How long "Undo cross-off" ignores clicks after replacing "Cross off file". */
export const UNDO_ARM_MS = 500;

/** Whether any of `el` lies within the viewport. */
function onScreen(el: Element | null): boolean {
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.bottom >= 0 && r.top <= window.innerHeight;
}

function HeaderIconButton(props: {
	label: string;
	tooltip: string;
	icon: string;
	tone: keyof typeof tones;
	pressed?: boolean;
	disabled: boolean;
	onClick: () => void;
	/** Clicks before this `performance.now()` time are ignored. */
	ignoreClicksUntil?: number;
}) {
	const tone = tones[props.tone];
	const onClick = () => {
		if (performance.now() < (props.ignoreClicksUntil ?? 0)) return;
		props.onClick();
	};
	return (
		<Tooltip content={props.tooltip}>
			{({ ref, onMouseEnter, onMouseLeave, ...rest }) => (
				// The wrapper takes the hover so a disabled button still explains
				// itself; focus (and so tap) goes to the button.
				// biome-ignore lint/a11y/noStaticElementInteractions: hover only; the button inside is the control.
				<span
					ref={ref}
					onMouseEnter={onMouseEnter}
					onMouseLeave={onMouseLeave}
					className="flex shrink-0 [&>button:disabled]:pointer-events-none"
				>
					<button
						type="button"
						{...rest}
						aria-label={props.label}
						aria-pressed={props.pressed}
						disabled={props.disabled}
						onClick={onClick}
						className="group flex h-10 w-10 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed @lg:h-8 @lg:w-8 pointer-coarse:@lg:h-10 pointer-coarse:@lg:w-10"
					>
						<span
							aria-hidden
							className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-2 font-sans text-base leading-none transition-colors group-disabled:border-line group-disabled:bg-transparent group-disabled:text-faint motion-reduce:transition-none ${
								props.pressed ? tone.pressed : tone.idle
							}`}
						>
							{props.icon}
						</span>
					</button>
				</span>
			)}
		</Tooltip>
	);
}

/**
 * Whether this session can start a comment on the whole file: true, or why
 * not.
 */
function useFileComment(file: FileView, commit: string) {
	const overview = useQuery({ ...overviewQuery, enabled: false }).data;
	const span: CodeSpan = { path: file.path, commit, subject: "file" };
	const ok = overview
		? commentAvailable(span, {
				writes: overview.writes,
				commentLeft: overview.commentLeft !== false,
				file,
			})
		: "Comment on file";
	return { span, ok };
}

/**
 * "Comment on file": opens a new thread on the whole file (any kind of
 * file), in the composer of the file bubble's row; disabled with the
 * reason when this session can't comment.
 */
function FileCommentButton(props: { file: FileView; commit: string }) {
	const { span, ok } = useFileComment(props.file, props.commit);
	return (
		<Tooltip content={ok === true ? "Comment on file" : ok}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					data-testid="file-comment"
					aria-label="Comment on file"
					aria-disabled={ok !== true || undefined}
					onClick={() => {
						if (ok === true && props.commit) openComposer(span);
					}}
					className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-disabled:cursor-not-allowed aria-disabled:text-faint aria-disabled:hover:bg-transparent"
				>
					<CommentIcon size={16} aria-hidden />
				</button>
			)}
		</Tooltip>
	);
}

/**
 * The file bubble's row (on the diff's first row): the file's threads, the
 * file comments being written and Comment on file, across the table's
 * `columns` (both views) at the diff's visible width like a line's ThreadRow.
 */
function FileThreadsRow(props: {
	id: string;
	columns: number;
	rail?: string;
	threads: ReactNode;
	composers: ReactNode;
	comment: ReactNode;
}) {
	return (
		<TailRow
			testId="file-threads"
			id={props.id}
			place={{ columns: props.columns }}
			rail={props.rail}
		>
			{props.threads}
			{props.composers}
			{props.comment}
		</TailRow>
	);
}

/**
 * The path in its own horizontal scroller, kept scrolled fully right so the
 * file name shows; scrolling left reveals the rest. Re-pinned when the path
 * or the available width changes.
 */
function PathScroller({
	text,
	kind,
	className = "",
	fade = "from-raised",
}: {
	text: string;
	/** The fade's start color: the header's background. */
	fade?: string;
	/** The kind of change, first in the tooltip (touch and keyboard get it here). */
	kind: string;
	className?: string;
}) {
	const box = useRef<HTMLDivElement>(null);
	const inner = useRef<HTMLSpanElement>(null);
	// More of the path sits to the left: fade the left edge to say so.
	const [clipped, setClipped] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on a new path.
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		const toEnd = () => {
			el.scrollLeft = el.scrollWidth;
			setClipped(el.scrollLeft > 0);
		};
		toEnd();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(toEnd);
		observer.observe(el);
		if (inner.current) observer.observe(inner.current);
		return () => observer.disconnect();
	}, [text]);
	return (
		<div className={`relative min-w-0 flex-1 ${className}`}>
			<Tooltip
				content={
					<>
						{kind} · <TooltipPath>{text}</TooltipPath>
					</>
				}
				describe={false}
			>
				{(trigger) => (
					// biome-ignore lint/a11y/useSemanticElements: a named group; a fieldset is for form controls, not a path.
					<div
						{...trigger}
						ref={(el) => {
							box.current = el;
							trigger.ref(el);
						}}
						role="group"
						aria-label={`Path: ${text}`}
						// A scroll box must be reachable by keyboard to scroll it (WCAG 2.1.1).
						// biome-ignore lint/a11y/noNoninteractiveTabindex: see above.
						tabIndex={0}
						data-testid="file-path"
						onScroll={(event) => setClipped(event.currentTarget.scrollLeft > 0)}
						className="overflow-x-auto rounded font-mono text-sm whitespace-nowrap text-ink [scrollbar-width:thin] focus-visible:outline-2 focus-visible:outline-accent"
					>
						<span ref={inner} className="inline-block py-1">
							{text}
						</span>
					</div>
				)}
			</Tooltip>
			{clipped && (
				<span
					aria-hidden
					data-testid="path-fade"
					className={`pointer-events-none absolute inset-y-0 left-0 flex w-6 items-center bg-gradient-to-r ${fade} from-40% to-transparent font-mono text-sm text-faint`}
				>
					…
				</span>
			)}
		</div>
	);
}

/**
 * The header's chips for a comparison: "1 reworked · 1 new · 4 carried",
 * "gone" and "conflict" when any (KindChip, each with its tooltip).
 */
function SinceChips(props: { info?: FileSince; since?: number }) {
	const { info } = props;
	if (!info) return null;
	const { counts } = info;
	return (
		<>
			{info.conflict && <KindChip kind="conflict" />}
			{counts.reworked > 0 && (
				<KindChip kind="reworked" count={counts.reworked} from={props.since} />
			)}
			{counts.new > 0 && (
				<KindChip kind="new" count={counts.new} from={props.since} />
			)}
			{counts.gone > 0 && (
				<KindChip kind="gone" count={counts.gone} from={props.since} />
			)}
			{counts.reverted > 0 && (
				<KindChip kind="reverted" count={counts.reverted} from={props.since} />
			)}
			{counts.removed > 0 && (
				<KindChip kind="removed" count={counts.removed} from={props.since} />
			)}
			{counts.carried > 0 && (
				<KindChip kind="carried" count={counts.carried} from={props.since} />
			)}
		</>
	);
}

/**
 * The file's progress in the unit: fixed size, pinned right, so headers line
 * up. It is the header's one focusable summary (status, count and progress in
 * one tooltip sentence), so keyboard and tap users get it in a single stop.
 */
function FileProgress(props: {
	file: FileView;
	unit: Unit;
	summary: string;
	trigger: TooltipTriggerProps;
}) {
	const { file, unit, summary, trigger } = props;
	const p = fileUnitProgress(file, unit);
	const { counts } = p;
	// The since view's count of a file it has nothing of (all carried):
	// its own state, never the snapshot's numbers.
	if (file.clusters.length === 0) {
		return (
			<div
				{...trigger}
				role="progressbar"
				aria-label="File progress"
				aria-valuetext="Nothing to read"
				data-state="empty"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
				tabIndex={0}
				className="flex h-9 w-28 shrink-0 items-center justify-end rounded-sm text-xs text-muted focus-visible:outline-2 focus-visible:outline-accent @lg:order-6 @2xl:w-48"
			>
				Nothing to read
			</div>
		);
	}
	return (
		<div
			{...trigger}
			role="progressbar"
			aria-label="File progress"
			aria-valuenow={p.percent}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuetext={summary}
			// Focusable so keyboard and touch users can read the tooltip.
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
			tabIndex={0}
			className="flex h-9 w-28 shrink-0 flex-col justify-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-accent @lg:order-6 @2xl:w-48"
		>
			<span className="truncate text-right text-xs text-muted tabular-nums">
				<span className="@2xl:hidden">
					{formatFileProgress(p, unit, { short: true })}
				</span>
				<span className="hidden @2xl:inline">
					{formatFileProgress(p, unit, { withUnit: true })}
				</span>
			</span>
			<Meter
				counts={counts}
				incomplete={p.clustersLeft > 0}
				className="h-1.5"
			/>
		</div>
	);
}

/**
 * One file of the diff: header with review status and bulk actions, and the
 * diff once expanded. Every file starts collapsed; collapsing is only a view
 * setting. The owner may control it (`expanded`, `onExpandedChange`). An open
 * file's header sticks below the app header and the page's progress bar
 * (`--app-header`, `--files-bar`) while
 * its diff scrolls. State actions show at once; useSetStates syncs them.
 */
/**
 * A click on a closed file's header opens it, unless it was on one of its
 * controls (they do their own thing; the thread count opens it too) or
 * ended a text selection of the path.
 */
function opensFile(event: MouseEvent<HTMLElement>): boolean {
	const target = event.target as Element | null;
	if (target?.closest("button, a, input, select, textarea, label")) {
		return false;
	}
	const selection = window.getSelection();
	return (
		!selection ||
		selection.isCollapsed ||
		!event.currentTarget.contains(selection.anchorNode)
	);
}

export function FileDiff(props: {
	file: FileView;
	revision: string;
	unit: Unit;
	expanded?: boolean;
	/**
	 * `auto`: not the reviewer's doing (a failed save reopening the file), so
	 * it doesn't count as opening it.
	 */
	onExpandedChange?: (expanded: boolean, auto?: boolean) => void;
	/**
	 * Another file is open (FilesPage keeps one open at a time). Read only to
	 * decide whether a failed file-wide save may reopen this file.
	 */
	otherOpen?: boolean;
	/** A thread link landing in this file (FilesPage). */
	landing?: Landing;
	/** The PR's review threads, placed on this file's diff. */
	threads?: DiffThreads;
	/** The threads are still on their way: the file's bubble spins. */
	threadsLoading?: boolean;
	/** The diff shown is the viewed head's (useHeadSure). */
	headSure?: boolean;
	/**
	 * A comparison the engine answers (since.ts): what happened to the
	 * file's clusters, for the header's chips; with `since`, the since
	 * view: the interdiff from that patch set is what the body shows.
	 */
	since?: number;
	sinceInfo?: FileSince;
	/** The patch set's marks on since-only pieces (ReviewView.sinceMarks). */
	sinceMarks?: SinceMark[];
	/**
	 * The since view: the file as its units count it (since.ts unitsFile),
	 * for the header's meter and sentence; the full diff counts clusters.
	 */
	counted?: FileView;
	/** The engine is still computing: the chips' slot spins. */
	sincePending?: boolean;
	/** An earlier patch set, as reviewed: the marks are locked. */
	readOnly?: boolean;
}) {
	const { file, revision, readOnly } = props;
	const [ownExpanded, setOwnExpanded] = useState(false);
	const expanded = props.expanded ?? ownExpanded;
	const setExpanded = (next: boolean, auto = false) => {
		if (props.expanded === undefined) setOwnExpanded(next);
		props.onExpandedChange?.(next, auto);
	};
	// Read after an await: the reviewer may have reopened this file, or opened
	// another, while a file-wide save ran.
	const expandedNow = useRef(expanded);
	expandedNow.current = expanded;
	const headerEl = useRef<HTMLElement>(null);
	const toggleButton = useRef<HTMLButtonElement>(null);
	const otherOpenNow = useRef(props.otherOpen ?? false);
	otherOpenNow.current = props.otherOpen ?? false;
	const { save: saveStates } = useSetStates();
	const save = (changes: StateChange[]) =>
		saveStates(revision, file.path, changes);
	/**
	 * Marking the rest reviewed or crossing it off finishes the file: it closes
	 * at once, like "Collapse file" does (its header stays where it is, the
	 * next file below). A save that fails for good (the error notice, not a
	 * transient retry) reopens it, unless the reviewer has moved on (opened
	 * another file, or scrolled its header off screen). A stale refusal
	 * doesn't reopen it: the page is reloading a new snapshot.
	 */
	const finishAll = (changes: StateChange[]) => {
		const closing = expanded;
		if (closing) {
			setExpanded(false);
			// The clicked button disables (nothing left to do); keep focus in the header.
			toggleButton.current?.focus({ preventScroll: true });
		}
		save(changes).catch((error: unknown) => {
			if (
				closing &&
				!isStale(error) &&
				!expandedNow.current &&
				!otherOpenNow.current &&
				onScreen(headerEl.current)
			) {
				setExpanded(true, true);
			}
		});
	};
	// Only an unreviewed cluster's box marks it reviewed: unchecking a reviewed
	// one or undoing a cross-off makes it unreviewed (R21).
	// The whole cluster (mixed or unreviewed → reviewed, reviewed →
	// unreviewed), or in the since view one piece of it (pieces.ts).
	const toggle = (cluster: ClusterView, piece?: LineRanges) => {
		save([toggleChange(cluster, piece)]).catch(() => {});
	};
	// Crossing off a cluster (or a piece of it), or undoing it to
	// unreviewed (never reviewed).
	const crossOff = (cluster: ClusterView, piece?: LineRanges) => {
		save([crossOffChange(cluster, piece)]).catch(() => {});
	};
	// A since-view piece that owns no line of this snapshot: its own mark.
	const sinceMark = (piece: SincePiece, cross: boolean) => {
		if (props.since === undefined) return;
		save([
			sinceToggleChange(props.sinceMarks, props.since, file.path, piece, cross),
		]).catch(() => {});
	};
	const unreviewed = file.clusters.filter((c) => c.state === "unreviewed");
	const crossed = file.clusters.filter((c) => c.state === "crossed-off");
	// One toggle: cross off what's unreviewed; once nothing is, undo the
	// cross-offs; with neither (all reviewed) there is nothing to do.
	const crossToggle = {
		undo: unreviewed.length === 0 && crossed.length > 0,
		none: unreviewed.length === 0 && crossed.length === 0,
	};
	// "Undo cross-off" swaps in under the pointer on the cross-off's click
	// itself (the UI doesn't wait for the save): a double click's second click
	// was meant for the cross-off, not undo.
	const undoArmedAt = useRef(0);
	const wasUndo = useRef(crossToggle.undo);
	if (crossToggle.undo && !wasUndo.current) {
		undoArmedAt.current = performance.now() + UNDO_ARM_MS;
	}
	wasUndo.current = crossToggle.undo;
	const path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
	// One sentence for the header's status, counts and progress. The counts
	// are the same in every unit; only the progress follows it.
	const status = fileStatus(file);
	const sentence = describeFileProgress(props.counted ?? file, props.unit);
	const summary = [
		sentence.startsWith(status) ? null : status,
		lineCount(file),
		clusterCount(file),
		sentence,
	]
		.filter(Boolean)
		.join(" · ");
	const idle =
		file.clusters.length === 0
			? "No clusters in this file"
			: "Nothing unreviewed";

	// Every thread of the file on the viewed head, hunks or not: a closed
	// file's header counts them all.
	const mine = props.threads
		? fileThreads(props.threads.threads, file.path, props.threads.snapshotHead)
		: [];
	// The header's threads: file comments, and lines the diff can't show,
	// never dropped. A closed file's hunks aren't read (first open stays
	// light): a binary or submodule file's line threads are flagged from the
	// file alone; a line past the end shows once the file is opened.
	const hunks = useQuery({
		...hunksQuery(revision, file.index, props.since),
		enabled: expanded,
	});
	const filePlacement = props.threads
		? placeThreads({
				threads: props.threads.threads,
				path: file.path,
				snapshotHead: props.threads.snapshotHead,
				hunks: hunks.data ?? null,
				loadedContext: [],
				noLines: file.binary || file.submodule,
				placements: props.threads.placements,
			})
		: null;
	const header = filePlacement?.header ?? [];
	// The threads the tracer couldn't place here: listed under the header.
	const fates = filePlacement?.fates ?? [];
	// The file bubble's row is open (its threads and Comment on file).
	const [fileOpen, setFileOpen] = useState(false);
	// The closed header's count was used: once the file's hunks are in (and
	// with them which lines the diff can't show), open the file bubble if it
	// has threads, and focus it (the header's count is gone).
	const [fromHeader, setFromHeader] = useState(false);
	const [focusFile, setFocusFile] = useState(false);
	const hunksSettled = !expanded || !hunks.isPending;
	useEffect(() => {
		if (!fromHeader || !expanded || !hunksSettled) return;
		setFromHeader(false);
		if (header.length > 0) setFileOpen(true);
	}, [fromHeader, expanded, hunksSettled, header.length]);
	const fileThreadsId = useId();
	// The file bubble flags a line it holds that the diff can't show; the
	// closed header, any thread of the file that isn't on a line.
	const headerFlag = header.some((h) => h.reason === "unplaced");
	// A resolved thread asks for nothing (a quiet line): the closed header
	// flags unresolved ones only, wherever they ended up.
	const unplaced =
		header.some((h) => h.reason === "unplaced" && !h.thread.resolved) ||
		fates.some((f) => !f.thread.resolved);
	// New comments on the whole file, open or closed: under the header,
	// where file threads show; on another head (gone): kept as orphans.
	const session = useQuery({ ...sessionQuery, enabled: false }).data;
	const snapshotHead =
		props.threads?.snapshotHead ?? session?.snapshotHead ?? "";
	const drafts = useDrafts();
	const composers = useComposers();
	const fileItems = useMemo(
		() =>
			newThreadItems(drafts, composers).filter(
				(i) => i.span.subject === "file" && i.span.path === file.path,
			),
		[drafts, composers, file.path],
	);
	const writer = useThreadWriter();
	// The head moved under a file comment being written: it moves along (a
	// file comment doesn't depend on lines); one only opened just closes.
	useEffect(() => {
		if (!snapshotHead) return;
		for (const item of fileItems) {
			if (item.span.commit === snapshotHead || item.sending) continue;
			if (writer.drafts.newThread(item.clientId)) {
				writer.drafts.retarget(item.clientId, snapshotHead);
			} else closeComposer(item.clientId);
		}
	}, [fileItems, snapshotHead, writer]);

	const fileComment = useFileComment(file, snapshotHead);
	// File comments being written, and drafts from an earlier head.
	const newItems = (
		<div data-testid="file-new-threads" className="space-y-2">
			{fileItems.map((item) =>
				item.span.commit === snapshotHead ? (
					<NewThread
						key={item.clientId}
						item={item}
						quote={file.path}
						onPosted={() => setFileOpen(true)}
					/>
				) : (
					<OrphanDraft
						key={item.clientId}
						label="Written on an earlier version"
						text={item.text}
						onDiscard={() => writer.discard(newThreadKey(item.clientId))}
					/>
				),
			)}
		</div>
	);
	/**
	 * The file bubble, on the diff's first row: file comments and lines the
	 * diff can't show. Opened, its row has their threads and Comment on
	 * file; with none it is an outline that starts a comment at once.
	 */
	const lead: FileLead = {
		bubble: (
			<ThreadBubble
				inline
				file
				threads={header.map((h) => h.thread)}
				loading={props.threadsLoading && !props.threads}
				where="on this file"
				label={
					fileComment.ok === true
						? "Comment on file"
						: `Comment on file — ${fileComment.ok}`
				}
				flagged={headerFlag}
				focus={focusFile}
				onFocused={() => setFocusFile(false)}
				open={fileOpen}
				controls={fileOpen ? fileThreadsId : undefined}
				onToggle={() => {
					if (!fileOpen && header.length === 0 && fileComment.ok === true) {
						openComposer(fileComment.span);
					}
					setFileOpen(!fileOpen);
				}}
			/>
		),
		// With no threads the bubble itself is the composer entry: the row's
		// button shows only beside threads, or to say why commenting is off.
		row: (columns, rail) =>
			(fileOpen && (header.length > 0 || fileComment.ok !== true)) ||
			fileItems.length > 0 ? (
				<FileThreadsRow
					id={fileThreadsId}
					columns={columns}
					rail={rail}
					threads={
						fileOpen && props.threads
							? header.map((h, i) => (
									<ThreadBlock
										key={h.thread.id || `#${i}`}
										readId={props.threads?.readId ?? ""}
										thread={h.thread}
										unplaced={h.reason === "unplaced"}
									/>
								))
							: null
					}
					composers={fileItems.length > 0 ? newItems : null}
					comment={
						fileOpen && fileItems.length === 0 ? (
							<FileCommentButton file={file} commit={snapshotHead} />
						) : null
					}
				/>
			) : null,
	};

	return (
		<section
			id={`file-${file.index}`}
			data-file-index={file.index}
			data-path={file.path}
			aria-label={file.path}
			className={`overflow-clip rounded-lg border bg-surface ${
				file.done ? "border-ok-fill/50" : "border-line"
			}`}
		>
			{/* The ▸ button is the keyboard's way; a click anywhere else opens a closed file too. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: see above. */}
			<header
				ref={headerEl}
				data-finished={file.done || undefined}
				onClick={(event) => {
					if (expanded || !opensFile(event)) return;
					setExpanded(true);
				}}
				// Square corners: the section clips them at the top, and a stuck
				// header must not let lines show through. Finished (every cluster
				// reviewed or crossed off): an opaque green wash and a green left
				// edge, so unreviewed files stand out while scrolling.
				className={`@container border-b border-line px-1.5 ${
					file.done
						? "bg-ok-wash shadow-[inset_3px_0_0_var(--color-ok-fill)]"
						: "bg-raised"
				} ${
					expanded
						? "sticky top-[calc(var(--app-header,0px)+var(--files-bar,0px))] z-10"
						: ""
				}`}
			>
				{/*
				 * DOM (and tab) order is the narrow layout's: the path and counts on
				 * their own row, everything else below it. Wide headers are one row, reordered
				 * to toggle, status, path and counts, actions, progress.
				 */}
				<Tooltip content={summary} describe={false}>
					{(summaryTrigger) => (
						<div className="flex min-h-11 flex-wrap items-center gap-x-1.5 pt-1 @lg:flex-nowrap @lg:pt-0 @2xl:gap-x-3">
							<div className="flex min-w-0 flex-1 basis-full items-center gap-1.5 @lg:order-3 @lg:basis-0">
								<ChangeKindIcon file={file} tooltip />
								<PathScroller
									text={path}
									fade={file.done ? "from-ok-wash" : "from-raised"}
									kind={
										file.status === "renamed"
											? "Renamed"
											: changeKindLabel(file)
									}
								/>
								{/* Beside the path, so a phone's second row keeps its room. */}
								<ChangeCount file={file} hover={summaryTrigger} />
							</div>
							{/* What happened since the compared patch set; a spinner
							    while the engine computes (never no chips that read as
							    nothing changed). A row of its own below @lg, so the path
							    keeps its width on a phone (principle 5). */}
							{(props.sinceInfo || props.sincePending) && (
								<span
									data-testid="since-chips"
									aria-busy={props.sincePending || undefined}
									className="flex min-h-5 basis-full flex-wrap items-center gap-1 @lg:order-4 @lg:basis-auto"
								>
									{props.sincePending && !props.sinceInfo ? (
										<Spinner label="Computing what changed" size={12} />
									) : (
										<SinceChips info={props.sinceInfo} since={props.since} />
									)}
								</span>
							)}
							<button
								ref={toggleButton}
								type="button"
								aria-expanded={expanded}
								aria-label={expanded ? "Collapse file" : "Expand file"}
								onClick={() => setExpanded(!expanded)}
								className="flex h-10 w-10 shrink-0 items-center justify-center rounded text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent @lg:order-1"
							>
								{expanded ? "▾" : "▸"}
							</button>
							<span className="flex shrink-0 @lg:order-2">
								<StatusIcon file={file} hover={summaryTrigger} />
							</span>
							<div className="ml-auto flex shrink-0 items-center gap-1.5 @lg:order-5">
								{!expanded && mine.length > 0 && (
									// Closed: every thread in the file; opening it shows
									// them (the file bubble's opened when it has some).
									<ThreadBubble
										threads={mine}
										where="in this file"
										flagged={unplaced}
										open={false}
										onToggle={() => {
											setFromHeader(true);
											setFocusFile(true);
											setExpanded(true);
										}}
									/>
								)}
								{crossToggle.undo ? (
									<HeaderIconButton
										ignoreClicksUntil={undoArmedAt.current}
										label="Undo cross-off"
										tooltip={
											readOnly
												? READ_ONLY_TIP
												: "Set crossed-off clusters back to unreviewed"
										}
										icon="⊘"
										tone="purple"
										pressed
										disabled={readOnly === true}
										onClick={() => {
											// Back to unreviewed, never reviewed (R21).
											save(
												crossed.map((c) => ({
													key: c.key,
													state: "unreviewed",
												})),
											).catch(() => {});
										}}
									/>
								) : (
									<HeaderIconButton
										label="Cross off file"
										tooltip={
											readOnly
												? READ_ONLY_TIP
												: crossToggle.none
													? idle
													: "Mark all unreviewed clusters as not needing review"
										}
										icon="⊘"
										tone="purple"
										pressed={false}
										disabled={readOnly || crossToggle.none}
										onClick={() => {
											// What the reviewer already read stays reviewed (R21).
											finishAll(
												unreviewed.map((c) => ({
													key: c.key,
													state: "crossed-off",
												})),
											);
										}}
									/>
								)}
								<HeaderIconButton
									label="Mark remaining reviewed"
									tooltip={
										readOnly
											? READ_ONLY_TIP
											: unreviewed.length === 0
												? idle
												: "Mark all unreviewed clusters as reviewed"
									}
									icon="✓"
									tone="green"
									disabled={readOnly || unreviewed.length === 0}
									onClick={() => {
										finishAll(
											unreviewed.map((c) => ({
												key: c.key,
												state: "reviewed",
											})),
										);
									}}
								/>
							</div>
							<FileProgress
								file={props.counted ?? file}
								unit={props.unit}
								summary={summary}
								trigger={summaryTrigger}
							/>
						</div>
					)}
				</Tooltip>
			</header>
			{!expanded && fileItems.length > 0 && (
				// Closed: a file comment being written stays in sight.
				<div className="border-b border-line bg-canvas p-2">{newItems}</div>
			)}
			{expanded && props.threads && (
				<UnplacedThreads
					fates={fates}
					readId={props.threads.readId}
					path={file.path}
					fileIndex={file.index}
				/>
			)}
			{expanded && (
				<DiffBody
					lead={lead}
					file={file}
					revision={revision}
					onToggle={toggle}
					onCrossOff={crossOff}
					landing={props.landing}
					threads={props.threads}
					headSure={props.headSure}
					from={props.since}
					kinds={props.sinceInfo?.kinds}
					onSinceMark={sinceMark}
					sinceMarks={props.sinceMarks}
					readOnly={readOnly}
				/>
			)}
		</section>
	);
}

/**
 * A file of the since view that the viewed snapshot no longer changes:
 * everything the reviewer saw of it on the compared patch set was undone,
 * so its clusters are gone. Its header names it; its body is the interdiff,
 * each piece marked on its own (since marks: pieces.ts).
 */
export function GoneFile(props: {
	index: number;
	path: string;
	revision: string;
	since: number;
	info?: FileSince;
	sinceMarks?: SinceMark[];
	/** An earlier patch set, as reviewed: the marks are locked. */
	readOnly?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const { save } = useSetStates();
	const sinceMark = (piece: SincePiece, cross: boolean) => {
		save(props.revision, props.path, [
			sinceToggleChange(
				props.sinceMarks,
				props.since,
				props.path,
				piece,
				cross,
			),
		]).catch(() => {});
	};
	const file: FileView = {
		index: props.index,
		path: props.path,
		status: "modified",
		binary: false,
		submodule: false,
		additions: 0,
		deletions: 0,
		clusters: [],
		done: false,
		reviewed: false,
		crossedOff: false,
	};
	return (
		<section
			data-gone-file={props.path}
			aria-label={props.path}
			className="overflow-clip rounded-lg border border-bad/40 bg-surface"
		>
			<header className="flex min-h-11 flex-wrap items-center gap-1.5 border-b border-line bg-raised px-1.5">
				<button
					type="button"
					aria-expanded={expanded}
					aria-label={expanded ? "Collapse file" : "Expand file"}
					onClick={() => setExpanded(!expanded)}
					className="flex h-10 w-10 shrink-0 items-center justify-center rounded text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
				>
					{expanded ? "▾" : "▸"}
				</button>
				<PathScroller text={props.path} kind="Reviewed work gone" />
				<span data-testid="since-chips" className="flex items-center gap-1">
					<KindChip
						kind="gone"
						count={props.info?.counts.gone}
						from={props.since}
					/>
				</span>
			</header>
			{expanded && (
				<DiffBody
					file={file}
					revision={props.revision}
					onToggle={() => {}}
					onCrossOff={() => {}}
					from={props.since}
					kinds={props.info?.kinds}
					onSinceMark={sinceMark}
					sinceMarks={props.sinceMarks}
					readOnly={props.readOnly}
				/>
			)}
		</section>
	);
}
