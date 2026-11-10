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
import { AgentBubble } from "../agent/AgentBubble";
import { AgentComposer } from "../agent/AgentComposer";
import { agentThreadsQuery } from "../agent/api";
import { useAgentComposers } from "../agent/askAgentAction";
import {
	agentWaiting,
	shownAgentPlaceables,
	useAgentPlacing,
} from "../agent/placeable";
import { hunksQuery, overviewQuery, sessionQuery } from "../api";
import type { FindMark } from "../code/Invisibles";
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
	type DiffFind,
	type DiffThreads,
	type FileLead,
	READ_ONLY_TIP,
} from "./DiffBody";
import { finishes, resetChanges } from "./fileFinish";
import { MarkedText } from "./find/MarkedText";
import { displayPath } from "./find/pathMarks";
import { KindChip } from "./KindChip";
import type { Landing } from "./landing";
import { Meter } from "./ProgressBar";
import { type CodeSpan, commentAvailable } from "./selectionActions";
import { type FileSince, goneFileView } from "./since";
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
import { AgentThreadRow, TailRow, ThreadBlock } from "./ThreadRow";
import { fileThreads, placeThreads, sinceLeftToNew } from "./threadPlacement";
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
		pressed:
			"border-ok-fill bg-ok-fill/35 text-ink group-[:enabled:hover]:bg-ok-fill/50",
	},
};
/** Asking "remove all …?": pending the second click. */
const ARMED_TONE = "border-warn bg-warn/20 text-warn";

/**
 * How long a file action ignores clicks after it changes under the pointer
 * (another action swapped in, or its question just showed): a double
 * click's second click was meant for what was there before.
 */
export const UNDO_ARM_MS = 500;

/** Whether any of `el` lies within the viewport. */
function onScreen(el: Element | null): boolean {
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.bottom >= 0 && r.top <= window.innerHeight;
}

/**
 * A file-wide action shown as an outlined icon, named by `label` and
 * explained by `tooltip` (a tooltip, also its accessible description).
 * 40×40 on touch and in a narrow header.
 *
 * With `confirm` it asks first: the first click shows the question (as its
 * name and an open tooltip), a second click acts. Escape, leaving it
 * (blur) or a press anywhere else drops the question.
 */
function HeaderIconButton(props: {
	label: string;
	tooltip: string;
	icon: string;
	tone: keyof typeof tones;
	pressed?: boolean;
	disabled: boolean;
	onClick: () => void;
	confirm?: string;
	/** Clicks before this `performance.now()` time are ignored. */
	ignoreClicksUntil?: number;
}) {
	const tone = tones[props.tone];
	const button = useRef<HTMLButtonElement | null>(null);
	// A reset swapped in (under the pointer, on the mark's own click: the UI
	// doesn't wait for the save): ignore clicks a moment.
	const lastLabel = useRef(props.label);
	const swappedUntil = useRef(0);
	if (lastLabel.current !== props.label) {
		lastLabel.current = props.label;
		if (props.pressed) swappedUntil.current = performance.now() + UNDO_ARM_MS;
	}
	// The question asked, for this action. Another action in its place, or
	// none to ask (the file isn't finished, e.g. after another tab's write),
	// drops it: coming back, it asks afresh.
	const [askedFor, setAskedFor] = useState<string | null>(null);
	const askedAt = useRef(0);
	const question =
		props.confirm !== undefined && !props.disabled ? props.confirm : null;
	const asking = question === null ? null : `${props.label}\n${question}`;
	if (askedFor !== null && askedFor !== asking) setAskedFor(null);
	const armed = asking !== null && askedFor === asking;
	const shown = armed && question !== null ? question : null;
	// When it takes clicks again (`performance.now()`), for tests to wait on.
	const clicksFrom = Math.max(
		swappedUntil.current,
		props.ignoreClicksUntil ?? 0,
		armed ? askedAt.current + UNDO_ARM_MS : 0,
	);
	useEffect(() => {
		if (!armed) return;
		const outside = (event: Event) => {
			if (!button.current?.contains(event.target as Node)) setAskedFor(null);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [armed]);
	const onClick = () => {
		const now = performance.now();
		if (now < swappedUntil.current || now < (props.ignoreClicksUntil ?? 0)) {
			return;
		}
		if (question === null) {
			props.onClick();
			return;
		}
		if (!armed) {
			askedAt.current = now;
			setAskedFor(asking);
			return;
		}
		if (now < askedAt.current + UNDO_ARM_MS) return;
		setAskedFor(null);
		props.onClick();
	};
	return (
		<Tooltip
			content={shown ?? props.tooltip}
			describe={!armed}
			forceOpen={armed}
			onDismiss={() => setAskedFor(null)}
		>
			{({ ref, onMouseEnter, onMouseLeave, onBlur, onKeyDown, ...rest }) => (
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
						ref={button}
						type="button"
						{...rest}
						onBlur={() => {
							setAskedFor(null);
							onBlur();
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") setAskedFor(null);
							onKeyDown(event);
						}}
						aria-label={shown ?? props.label}
						aria-pressed={props.pressed}
						disabled={props.disabled}
						data-armed={armed || undefined}
						data-clicks-from={
							clicksFrom > 0 ? Math.ceil(clicksFrom) : undefined
						}
						onClick={onClick}
						className="group flex h-10 w-10 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed @lg:h-8 @lg:w-8 pointer-coarse:@lg:h-10 pointer-coarse:@lg:w-10"
					>
						<span
							aria-hidden
							className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-2 font-sans text-base leading-none transition-colors group-disabled:border-line group-disabled:bg-transparent group-disabled:text-faint motion-reduce:transition-none ${
								armed ? ARMED_TONE : props.pressed ? tone.pressed : tone.idle
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
function useFileComment(file: FileView, commit: string, readOnly = false) {
	const overview = useQuery({ ...overviewQuery, enabled: false }).data;
	const span: CodeSpan = { path: file.path, commit, subject: "file" };
	const ok = overview
		? commentAvailable(span, {
				writes: overview.writes,
				commentLeft: overview.commentLeft !== false,
				file,
				readOnly,
			})
		: "Comment on file";
	return { span, ok };
}

/**
 * "Comment on file": opens a new thread on the whole file (any kind of
 * file), in the composer of the file bubble's row; disabled with the
 * reason when this session can't comment.
 */
function FileCommentButton(props: {
	file: FileView;
	commit: string;
	readOnly?: boolean;
}) {
	const { span, ok } = useFileComment(props.file, props.commit, props.readOnly);
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
	marks = [],
	className = "",
	fade = "from-raised",
}: {
	text: string;
	/** The find's hits on the text. */
	marks?: readonly FindMark[];
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
							<MarkedText text={text} marks={marks} />
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
	/** The find's hits on the header's path (headerPathMarks). */
	pathFind?: readonly FindMark[];
	/** The find's view of this file's diff (DiffBody). */
	find?: DiffFind;
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
	/**
	 * The reviewer's own mark just finished this open file (nothing left
	 * unreviewed): the owner closes it and moves on (FilesPage opens the
	 * next file). Without it, the file just closes.
	 */
	onFinished?: () => void;
	/**
	 * Marks (the header's actions, the clusters' boxes and cross-offs) are
	 * ignored before this `performance.now()` time: the file just opened
	 * under the pointer as the one before it finished, so a double click's
	 * second click was meant for that one (principle 2). Its lines arriving
	 * later restart the wait (UNDO_ARM_MS from then).
	 */
	ignoreMarksUntil?: number;
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
	const hunks = useQuery({
		...hunksQuery(revision, file.index, props.since),
		enabled: expanded,
	});
	// Opened by a move-on, its lines (or what shows instead) arrive under the
	// pointer once read: just as unseen, so they restart the wait for marks.
	const bodyIn = expanded && !hunks.isPending;
	const [bodyInAt, setBodyInAt] = useState<number | null>(null);
	const guarded = props.ignoreMarksUntil !== undefined;
	useLayoutEffect(() => {
		if (!guarded) setBodyInAt(null);
		else if (bodyIn) setBodyInAt((at) => at ?? performance.now());
	}, [guarded, bodyIn]);
	const ignoreMarksUntil =
		props.ignoreMarksUntil === undefined
			? undefined
			: Math.max(
					props.ignoreMarksUntil,
					bodyInAt === null ? 0 : bodyInAt + UNDO_ARM_MS,
				);
	const { save: saveStates } = useSetStates();
	const save = (changes: StateChange[]) =>
		saveStates(revision, file.path, changes);
	/**
	 * A mark that leaves nothing unreviewed (a cluster's, or the rest of the
	 * file's) finishes the file: an open one closes at once and the page
	 * moves on (`onFinished`), or it just closes, like "Collapse file" does
	 * (its header stays where it is, the next file below). Only a finished
	 * file closes (principle 2). A save that fails for good (the error
	 * notice, not a transient retry) reopens it, unless the reviewer has
	 * moved on (another file open, or its header scrolled off screen). A
	 * stale refusal doesn't reopen it: the page is reloading a new snapshot.
	 */
	const marksIgnored = () => performance.now() < (ignoreMarksUntil ?? 0);
	const mark = (changes: StateChange[]) => {
		// An earlier patch set, as reviewed, takes no marks.
		if (readOnly || marksIgnored()) return;
		const closing = expanded && finishes(file.clusters, changes);
		if (closing) {
			// The clicked control is gone or swaps; keep focus in the header.
			toggleButton.current?.focus({ preventScroll: true });
			if (props.onFinished) props.onFinished();
			else setExpanded(false);
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
	// unreviewed), or in the since view one piece of it (pieces.ts). A
	// piece's change keeps the cluster unreviewed until every line is
	// marked, so only the last piece finishes the file (fileFinish.ts).
	const toggle = (cluster: ClusterView, piece?: LineRanges) => {
		mark([toggleChange(cluster, piece)]);
	};
	// Crossing off a cluster (or a piece of it), or undoing it to
	// unreviewed (never reviewed).
	const crossOff = (cluster: ClusterView, piece?: LineRanges) => {
		mark([crossOffChange(cluster, piece)]);
	};
	// A since-view piece that owns no line of this snapshot: its own mark,
	// never a cluster's, so it never finishes the file; guarded like one.
	const sinceMark = (piece: SincePiece, cross: boolean) => {
		if (props.since === undefined || readOnly || marksIgnored()) return;
		save([
			sinceToggleChange(props.sinceMarks, props.since, file.path, piece, cross),
		]).catch(() => {});
	};
	const unreviewed = file.clusters.filter((c) => c.state === "unreviewed");
	// Each action is a toggle: it marks what's unreviewed; once nothing is
	// (the file is finished), it resets its own kind of mark, asking first;
	// with none of its kind there is nothing to do. A file finished by both
	// kinds resets each kind from its own button.
	const unCross = resetChanges(file.clusters, "crossed-off");
	const unReview = resetChanges(file.clusters, "reviewed");
	const crossToggle = {
		undo: unCross.length > 0,
		none: unreviewed.length === 0 && unCross.length === 0,
	};
	const reviewToggle = {
		undo: unReview.length > 0,
		none: unreviewed.length === 0 && unReview.length === 0,
	};
	// A reset is never a finish: it only adds unreviewed clusters.
	const reset = (changes: StateChange[]) => {
		if (readOnly) return;
		save(changes).catch(() => {});
	};
	const path = displayPath(file);
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
	const filePlacement = props.threads
		? placeThreads({
				threads: props.threads.threads,
				path: file.path,
				snapshotHead: props.threads.snapshotHead,
				hunks: hunks.data ?? null,
				loadedContext: [],
				noLines: file.binary || file.submodule,
				placements: props.threads.placements,
				// The since view: as its DiffBody places them (LEFT through
				// the full diff), so the header holds what no row can.
				...(props.since === undefined
					? {}
					: { leftToNew: sinceLeftToNew(file.clusters) }),
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

	const fileComment = useFileComment(file, snapshotHead, readOnly);

	// The reviewer's agent threads on the file (FilesPage reads them): those
	// on the whole file, and lines the diff can't show, beside the file's
	// comment threads with their own bubble; and Ask agent on the file.
	const agentAll = useQuery({ ...agentThreadsQuery, enabled: false }).data
		?.threads;
	// Each where the tracer put it in the viewed head (as GitHub's threads
	// are), else where it was asked.
	const agentPlacing = useAgentPlacing();
	const agentPlacements = agentPlacing.placements;
	const agentPlaceables = useMemo(
		() => shownAgentPlaceables(agentAll ?? [], snapshotHead, agentPlacing),
		[agentAll, snapshotHead, agentPlacing],
	);
	// Every agent thread on the file: those the tracer couldn't place in
	// it listed with their fate; those it has no place for (not in yet,
	// failed) and asked on an earlier head in the lead row, outdated.
	// One the tracer put outside the comparison is listed after the files
	// (AgentNotInComparison), never here.
	const agentMineP = agentPlaceables.filter(
		(p) =>
			p.path === file.path && agentPlacements?.get(p.id)?.kind !== "outside",
	);
	const agentMine = agentMineP.map((p) => p.thread);
	const agentOutdated = snapshotHead
		? agentMineP.filter((p) => p.commit !== snapshotHead).map((p) => p.thread)
		: [];
	const agentPlaced = snapshotHead
		? placeThreads({
				threads: agentPlaceables,
				path: file.path,
				snapshotHead,
				hunks: hunks.data ?? null,
				loadedContext: [],
				noLines: file.binary || file.submodule,
				placements: agentPlacements,
				...(props.since === undefined
					? {}
					: { leftToNew: sinceLeftToNew(file.clusters) }),
			})
		: null;
	const agentHeader = agentPlaced?.header ?? [];
	// Resolved ones after the rest (shownAgentPlaceables' order), muted.
	const agentFates = new Map(
		(agentPlaced?.fates ?? []).map(
			(f) => [f.thread.thread, f.placement] as const,
		),
	);
	const agentGroups = [
		{ reason: "fate" as const, threads: [...agentFates.keys()] },
		...(["file", "unplaced"] as const).map((reason) => ({
			reason,
			threads: agentHeader
				.filter((h) => h.reason === reason)
				.map((h) => h.thread.thread),
		})),
		{ reason: "outdated" as const, threads: agentOutdated },
	].filter((g) => g.threads.length > 0);
	const agentLead = agentGroups.flatMap((g) => g.threads);
	// While the placements load: this file's agent threads asked on
	// another head wait, and its agent bubble spins where they will show.
	const agentWaitingHere = useMemo(
		() =>
			agentPlacing.pending && snapshotHead
				? agentWaiting(agentAll ?? [], snapshotHead, agentPlacing).filter(
						(p) => p.path === file.path || p.path === file.oldPath,
					)
				: [],
		[agentPlacing, agentAll, snapshotHead, file.path, file.oldPath],
	);
	const agentLoading = agentWaitingHere.length > 0;
	const [agentOpen, setAgentOpen] = useState(false);
	const agentThreadsId = useId();
	const agentFileItems = useAgentComposers().filter(
		(c) => c.span.subject === "file" && c.span.path === file.path,
	);
	const agentComposers = agentFileItems.length > 0 && (
		<div data-testid="file-agent-composers" className="space-y-2">
			{agentFileItems.map((c) => (
				<AgentComposer
					key={c.clientId}
					clientId={c.clientId}
					span={c.span}
					quote={file.path}
				/>
			))}
		</div>
	);
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
		count: agentLead.length > 0 || agentLoading ? 2 : 1,
		bubble: (
			<>
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
				{(agentLead.length > 0 || agentLoading) && (
					<AgentBubble
						inline
						threads={agentLead}
						loading={agentLoading && agentLead.length === 0}
						where="on this file"
						open={agentOpen}
						controls={agentOpen ? agentThreadsId : undefined}
						onToggle={() => setAgentOpen(!agentOpen)}
					/>
				)}
			</>
		),
		// With no threads the bubble itself is the composer entry: the row's
		// button shows only beside threads, or to say why commenting is off.
		row: (columns, rail) => (
			<>
				{(fileOpen && (header.length > 0 || fileComment.ok !== true)) ||
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
								<FileCommentButton
									file={file}
									commit={snapshotHead}
									readOnly={readOnly}
								/>
							) : null
						}
					/>
				) : null}
				{agentOpen &&
					agentGroups.map((g, i) => (
						<AgentThreadRow
							key={g.reason}
							id={i === 0 ? agentThreadsId : undefined}
							threads={g.threads}
							place={{ columns }}
							rail={rail}
							unplaced={g.reason === "unplaced"}
							outdated={g.reason === "outdated"}
							fates={g.reason === "fate" ? agentFates : undefined}
						/>
					))}
				{agentComposers && (
					<TailRow testId="agent-composer-row" place={{ columns }} rail={rail}>
						{agentComposers}
					</TailRow>
				)}
			</>
		),
	};

	return (
		<section
			id={`file-${file.index}`}
			data-file-index={file.index}
			data-path={file.path}
			aria-label={file.path}
			// When it takes marks again (`performance.now()`), for tests to wait on.
			data-marks-from={
				ignoreMarksUntil === undefined ? undefined : Math.ceil(ignoreMarksUntil)
			}
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
									marks={props.pathFind}
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
								onClick={() => {
									// Just opened by a move-on under the pointer: a double
									// click's second click mustn't close it unseen.
									if (expanded && marksIgnored()) return;
									setExpanded(!expanded);
								}}
								className="flex h-10 w-10 shrink-0 items-center justify-center rounded text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent @lg:order-1"
							>
								{expanded ? "▾" : "▸"}
							</button>
							<span className="flex shrink-0 @lg:order-2">
								<StatusIcon file={file} hover={summaryTrigger} />
							</span>
							<div className="ml-auto flex shrink-0 items-center gap-1.5 @lg:order-5">
								{!expanded && (agentMine.length > 0 || agentLoading) && (
									<AgentBubble
										threads={agentMine}
										loading={agentLoading && agentMine.length === 0}
										where="in this file"
										open={false}
										onToggle={() => {
											if (agentLead.length > 0) setAgentOpen(true);
											setExpanded(true);
										}}
									/>
								)}
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
										ignoreClicksUntil={ignoreMarksUntil}
										label="Undo cross-off"
										tooltip={
											readOnly
												? READ_ONLY_TIP
												: "Set crossed-off clusters back to unreviewed"
										}
										confirm="Remove all crossed-off markings from this file?"
										icon="⊘"
										tone="purple"
										pressed
										disabled={readOnly === true}
										// Back to unreviewed, never reviewed (R21).
										onClick={() => reset(unCross)}
									/>
								) : (
									<HeaderIconButton
										ignoreClicksUntil={ignoreMarksUntil}
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
											mark(
												unreviewed.map((c) => ({
													key: c.key,
													state: "crossed-off",
												})),
											);
										}}
									/>
								)}
								{reviewToggle.undo ? (
									<HeaderIconButton
										ignoreClicksUntil={ignoreMarksUntil}
										label="Unmark reviewed"
										tooltip={
											readOnly
												? READ_ONLY_TIP
												: "Set reviewed clusters back to unreviewed"
										}
										confirm="Remove all reviewed markings from this file?"
										icon="✓"
										tone="green"
										pressed
										disabled={readOnly === true}
										onClick={() => reset(unReview)}
									/>
								) : (
									<HeaderIconButton
										ignoreClicksUntil={ignoreMarksUntil}
										label="Mark remaining reviewed"
										tooltip={
											readOnly
												? READ_ONLY_TIP
												: reviewToggle.none
													? idle
													: "Mark all unreviewed clusters as reviewed"
										}
										icon="✓"
										tone="green"
										pressed={false}
										disabled={readOnly || reviewToggle.none}
										onClick={() => {
											mark(
												unreviewed.map((c) => ({
													key: c.key,
													state: "reviewed",
												})),
											);
										}}
									/>
								)}
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
			{!expanded && agentComposers && (
				<div className="border-b border-line bg-canvas p-2">
					{agentComposers}
				</div>
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
					find={props.find}
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
	/** Controlled open state (the page's open file: a find's step opens it). */
	expanded?: boolean;
	onExpandedChange?: (expanded: boolean) => void;
	/** The find's hits on the path, and in the lines (FilesPage). */
	pathFind?: readonly FindMark[];
	find?: DiffFind;
}) {
	const [ownExpanded, setOwnExpanded] = useState(false);
	const expanded = props.expanded ?? ownExpanded;
	const setExpanded = (next: boolean) => {
		if (props.expanded === undefined) setOwnExpanded(next);
		props.onExpandedChange?.(next);
	};
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
	const file = goneFileView(props);
	return (
		<section
			id={`file-${props.index}`}
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
				<PathScroller
					text={props.path}
					marks={props.pathFind}
					kind="Reviewed work gone"
				/>
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
					find={props.find}
				/>
			)}
		</section>
	);
}
