import {
	AlertIcon,
	ArrowSwitchIcon,
	CheckCircleIcon,
	ChevronUpIcon,
	CircleSlashIcon,
	DiffRemovedIcon,
	FileRemovedIcon,
	GitBranchIcon,
	GitCompareIcon,
	HistoryIcon,
	type Icon,
	MoveToBottomIcon,
	QuestionIcon,
	StopIcon,
	UnverifiedIcon,
	VersionsIcon,
} from "@primer/octicons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { MovedInfo } from "../../shared/rereview/moves";
import { openedOn } from "../../shared/rereview/openedOn";
import type { Fate, ThreadPlacement } from "../../shared/rereview/placement";
import type {
	CodeRow,
	DiffSide,
	PlacementsAnswer,
	ReviewThread,
} from "../../shared/types";
import { CentredWithHandle } from "../agent/ThreadAgentButton";
import { AgentCover } from "../agent/ThreadAgentPanel";
import { ThreadAgentContext, useThreadAgent } from "../agent/threadAgent";
import { placementsQuery, type RereviewTo, sessionQuery } from "../api";
import { useMessageCopy } from "../messageCopy";
import { Badge, BotIcon, Chip, SkeletonBar } from "../overview/parts";
import { RelativeTime } from "../RelativeTime";
import { useReviewId } from "../reviewId";
import { Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { CodeRows, CommentBody } from "../threads/CommentBody";
import {
	AgentHandleRow,
	COMMENT_SURFACE,
	commentSurface,
	ThreadActions,
	ThreadComments,
	UnavailableText,
	useCanAct,
} from "../threads/Conversation";
import { MoreToggle, useReplyCount } from "../threads/MoreToggle";
import { Avatar, usePerson } from "../threads/people";
import { FullDiffLink } from "./FullDiffLink";
import { type ThreadFocus, useFocusCard } from "./threadFocus";
import {
	firstWords,
	MovedChip,
	MoveFailureLine,
	MoveHandle,
	movesOf,
	useMovable,
} from "./threadMove";
import { madeOnHead, type NotHere, type Placements } from "./threadPlacement";

/**
 * What the page knows of the threads' places in the viewed snapshot
 * (GET /placements), for the cards and lists that show them.
 */
export interface PlacementInfo {
	/** By thread id; null until they are in (or not asked). */
	placements: Placements | null;
	/** Asked and not in yet: a spinner in each card's chip slot. */
	pending: boolean;
	/** They couldn't be computed (each card says so; the page offers a retry). */
	error: Error | null;
	/**
	 * Asking again after a partial answer failed (CAR-8): the threads still
	 * `pending` in it say so instead of spinning.
	 */
	stalled?: Error | null;
	/** Asks for them again. */
	retry: () => void;
	/** A retry after an error is under way. */
	retrying?: boolean;
	/** The read and target they are for (a move updates them). */
	readId: string | null;
	to: RereviewTo | null;
	/**
	 * The reviewer's moves the threads stand on (CAR-139), by thread id;
	 * null until the placements are in.
	 */
	moves?: ReadonlyMap<string, MovedInfo> | null;
	/**
	 * Where a move writes (the latest patch set, or a head that is no
	 * earlier patch set, in the full diff); null: moves are off here.
	 */
	moveTo: RereviewTo | null;
	/** The head of the snapshot viewed (a thread opened on it isn't moved). */
	viewedHead?: string | null;
	/** The patch set a thread was opened on (openedOn); null without patch sets. */
	openedOn: (t: Pick<ReviewThread, "createdAt">) => number | null;
}

const PlacementContext = createContext<PlacementInfo>({
	placements: null,
	pending: false,
	error: null,
	retry: () => {},
	readId: null,
	to: null,
	moveTo: null,
	openedOn: () => null,
});

export const PlacementProvider = PlacementContext.Provider;
export const usePlacementInfo = () => useContext(PlacementContext);

/** A fate's word, icon, tone and tooltip. */
const FATES: Record<
	Fate,
	{
		label: string;
		icon: Icon;
		tone: "red" | "yellow";
		tip: string;
		/**
		 * An unplaced row's top line (owner, 2026-11-08), and its quiet line
		 * once resolved: one wording for both (CAR-158).
		 */
		sentence: string;
	}
> = {
	deleted: {
		label: "deleted",
		icon: DiffRemovedIcon,
		tone: "red",
		tip: "Its lines were deleted",
		sentence: "Commented line has been deleted since the review",
	},
	rewritten: {
		label: "rewritten",
		icon: AlertIcon,
		tone: "yellow",
		tip: "Rewritten beyond tracing: its lines can't be followed here",
		sentence: "Commented line has been rewritten since the review",
	},
	outdated: {
		label: "outdated",
		// The icon of the "outdated" badge: one sign for one flag.
		icon: HistoryIcon,
		tone: "yellow",
		tip: "Outdated on GitHub; its own commit can't be traced",
		sentence: "GitHub marks the commented line outdated",
	},
	untraced: {
		label: "untraced",
		icon: QuestionIcon,
		tone: "yellow",
		tip: "Couldn't trace the commented line here",
		sentence: "Couldn't trace the commented line here",
	},
	"file-gone": {
		label: "file deleted",
		icon: FileRemovedIcon,
		tone: "red",
		tip: "Its file was deleted",
		sentence: "Commented file has been deleted since the review",
	},
	moved: {
		label: "moved?",
		icon: ArrowSwitchIcon,
		tone: "yellow",
		tip: "Its file was renamed and its lines didn't follow: maybe moved",
		sentence: "Commented line may have moved",
	},
	reverted: {
		label: "reverted",
		icon: HistoryIcon,
		tone: "yellow",
		tip: "The PR no longer changes this place",
		sentence: "The commented change has been reverted since the review",
	},
	"base-changed": {
		label: "base changed",
		icon: GitCompareIcon,
		tone: "yellow",
		tip: "The base branch changed this line since",
		sentence: "The base changed under the commented line since the review",
	},
	"base-unknown": {
		label: "base unknown",
		icon: GitBranchIcon,
		tone: "yellow",
		tip: "Its old line isn't where GitHub showed it",
		sentence: "Couldn't find the base the commented old line was on",
	},
	"check-failed": {
		label: "couldn't check",
		icon: StopIcon,
		tone: "red",
		tip: "GitHub's copy of its line couldn't be read",
		sentence: "Couldn't check the commented old line against GitHub",
	},
};

/** No fate known: the placements couldn't be computed. */
const UNKNOWN_FATE = {
	label: "not placed",
	icon: AlertIcon,
	tone: "red" as const,
	tip: "Where this thread sits now couldn't be computed",
	sentence: "Couldn't work out where this thread is now",
};

/** "PS2", or nothing without a patch set. */
const psLabel = (n: number | null) => (n === null ? "" : `PS${n}`);

/**
 * A thread card's placement chip: a spinner while the placements are on
 * their way (the card shows where it was made meanwhile), "changed since"
 * on a rewritten line, the fate of an unplaced one; nothing when placed
 * as it was.
 */
export function PlacementChip({ thread }: { thread: ReviewThread }) {
	const placement = usePlacementInfo().placements?.get(thread.id);
	return (
		<>
			<MovedChip
				thread={{ source: "github", id: thread.id }}
				github={{ line: thread.currentLine, outdated: thread.outdated }}
			/>
			{placement || !thread.resolved ? <FateChip thread={thread} /> : null}
		</>
	);
}

/** The tracer's word on a thread's place (PlacementChip). */
function FateChip({ thread }: { thread: ReviewThread }) {
	const info = usePlacementInfo();
	const placement = info.placements?.get(thread.id);
	const failed =
		placement?.kind === "pending" ? (info.error ?? info.stalled) : info.error;
	// Made on the viewed head, it is shown where it was made: nothing to
	// place, so never unknown (CAR-271).
	if (
		(!placement || placement.kind === "pending") &&
		failed &&
		!thread.resolved &&
		!madeOnHead(thread, info.viewedHead)
	) {
		return (
			<Chip
				tone="red"
				icon={AlertIcon}
				tip={`Where this thread sits now couldn't be computed: ${failed.message}`}
				testId="placement-error"
			>
				place unknown
			</Chip>
		);
	}
	// Placing: all of them on their way, or this one (an old-side thread
	// waiting for GitHub's hunk, CAR-8).
	if (
		placement?.kind === "pending" ||
		(!placement && info.pending && !thread.resolved)
	) {
		return (
			<span className="flex h-4 w-4 items-center" data-testid="placement-slot">
				<Spinner label="Placing threads" size={12} />
			</span>
		);
	}
	if (!placement) return null;
	// A resolved thread is placed so it never vanishes, never to ask for
	// attention: its chip is muted.
	const quiet = thread.resolved;
	if (placement.kind === "changed") {
		return (
			<>
				<ChangedChip thread={thread} inFileMove={placement.inFileMove} />
				{placement.unchecked && <UncheckedChip quiet={quiet} />}
			</>
		);
	}
	if (placement.kind === "placed" && placement.unchecked) {
		return <UncheckedChip quiet={quiet} />;
	}
	if (placement.kind === "unplaced" || placement.kind === "outside") {
		// GitHub's outdated already has its badge on the card: no second sign.
		if (placement.fate === "outdated" && thread.outdated) return null;
		const fate = FATES[placement.fate];
		return (
			<Chip
				tone={quiet ? "gray" : fate.tone}
				icon={fate.icon}
				tip={fate.tip}
				testId="placement-fate"
			>
				{fate.label}
			</Chip>
		);
	}
	return null;
}

/**
 * An old-side line placed with nothing from GitHub to check it by, from a
 * base other than today's merge base (CAR-8): a flag of uncertainty.
 */
function UncheckedChip({ quiet }: { quiet: boolean }) {
	return (
		<Chip
			tone={quiet ? "gray" : "yellow"}
			icon={UnverifiedIcon}
			tip="Its old line couldn't be checked against GitHub"
			testId="placement-unchecked"
		>
			unchecked
		</Chip>
	);
}

/**
 * "changed since": a thread's line was rewritten since it was made;
 * "moved since": it went elsewhere in its file with its block (the
 * placement's `inFileMove`). Muted once resolved.
 */
export function ChangedChip({
	thread,
	inFileMove,
}: {
	thread: Pick<ReviewThread, "createdAt" | "resolved">;
	inFileMove?: boolean;
}) {
	const info = usePlacementInfo();
	const ps = psLabel(info.openedOn(thread));
	return (
		<Chip
			tone={thread.resolved ? "gray" : "yellow"}
			icon={inFileMove ? MoveToBottomIcon : GitCompareIcon}
			tip={`The ${inFileMove ? "code moved" : "line changed"} since ${ps || "the thread was made"}`}
			testId="placement-changed"
		>
			{inFileMove ? "moved since" : "changed since"}
		</Chip>
	);
}

/**
 * A changed thread's code as it was written on (its own patch set's lines,
 * never the ones it sits on now: those are the diff's own row above), and
 * the fate line with a way to its patch set.
 */
export function ChangedSince({
	thread,
	placement,
	lines = true,
	moved,
}: {
	/** A review thread, or an agent thread seen the same way. */
	thread: Pick<ReviewThread, "createdAt" | "path" | "code">;
	placement: Extract<ThreadPlacement, { kind: "changed" }>;
	/** Its original code too (the Overview's card shows its own). */
	lines?: boolean;
	/** The reviewer's move it was followed from (CAR-139): the moved-to lines are its original. */
	moved?: MovedInfo;
}) {
	const info = usePlacementInfo();
	const movedOriginal = moved ? movedOriginalOf(moved) : undefined;
	const ps = movedOriginal ? movedOriginal.ps : info.openedOn(thread);
	const id = useReviewId();
	const { old } = placement;
	return (
		<div data-testid="placement-changed-pane" className="space-y-1">
			{lines && (
				<OriginalCode thread={thread} fallback={old} moved={movedOriginal} />
			)}
			<p
				data-testid="placement-fate-line"
				className="flex min-h-10 flex-wrap items-center gap-x-2 text-xs text-muted"
			>
				<span>
					Line {placement.inFileMove ? "moved" : "rewritten"}
					{ps === null ? "" : ` since PS${ps}`}
				</span>
				{ps !== null && (
					<Link
						to="/r/$id/files"
						params={{ id }}
						search={{
							ps,
							path:
								movedOriginal?.path ?? thread.code?.anchor.path ?? thread.path,
							line: old.line,
							side: old.side,
						}}
						className="ml-auto inline-flex min-h-10 items-center rounded-sm px-1 font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
					>
						See on PS{ps}
					</Link>
				)}
			</p>
		</div>
	);
}

/** Where a moved thread's original lines are: the move's patch set (none for a head) and file. */
const movedOriginalOf = (m: MovedInfo) => ({
	ps: "patchset" in m.on ? m.on.patchset : null,
	path: m.path,
});

/** A moved, unplaced thread's original: the lines it was moved to, when known. */
export function movedOriginalFor(
	moved: MovedInfo | undefined,
	placement: ThreadPlacement | undefined,
): { old: OldLines; ps: number | null; path: string } | undefined {
	if (!moved || placement?.kind !== "unplaced" || !placement.old)
		return undefined;
	return { old: placement.old, ...movedOriginalOf(moved) };
}

/** A changed placement's commented lines as the tracer read them in the thread's own patch set. */
export type OldLines = Extract<ThreadPlacement, { kind: "changed" }>["old"];

/**
 * The code a thread was written on, cut to its commented lines and two
 * lines either side, the commented ones highlighted; labelled with its
 * patch set, path and line numbers. A frame while the code is still on
 * its way. With no code to show (none, or none of it marked), the
 * commented lines from `fallback` (a changed placement's `old`: the same
 * patch set's lines, never where the thread sits now); else nothing.
 */
function OriginalCode({
	thread,
	fallback,
	moved,
}: {
	/** A review thread, or an agent thread seen the same way. */
	thread: Pick<ReviewThread, "code" | "path" | "createdAt">;
	fallback?: OldLines;
	/**
	 * Moved by the reviewer (CAR-139): the lines it was moved to
	 * (`fallback`) are its original, on the move's patch set and path.
	 */
	moved?: { ps: number | null; path: string };
}) {
	const info = usePlacementInfo();
	const own = moved && oldRows(fallback) ? null : thread.code;
	const code = own;
	const path = moved && !own ? moved.path : (code?.anchor.path ?? thread.path);
	if (code?.source === "pending") {
		return (
			<div
				data-testid="original-code-loading"
				aria-busy="true"
				className="space-y-2 rounded-md border border-line bg-code px-3 py-2"
			>
				<span className="sr-only">Loading…</span>
				<SkeletonBar className="w-3/5" />
				<SkeletonBar className="w-4/5" />
			</div>
		);
	}
	const shown = codeRows(code) ?? oldRows(fallback);
	if (!shown) return null;
	const { rows, side } = shown;
	const numberOf = (r: CodeRow) => (side === "LEFT" ? r.oldNo : r.newNo);
	const nums = rows
		.filter((r) => r.marked)
		.map(numberOf)
		.filter((n): n is number => n !== null);
	const a = nums[0];
	const b = nums.at(-1);
	const lines =
		a === undefined ? "" : a === b ? ` · line ${a}` : ` · lines ${a}–${b}`;
	const ps = psLabel(moved && !own ? moved.ps : info.openedOn(thread));
	const label = [ps, path].filter(Boolean).join(" · ") + lines;
	return (
		<figure
			data-testid="original-code"
			aria-label={`Original Reviewed Change: ${label}`}
			className="min-w-0 overflow-hidden rounded-md border-2 border-line-strong bg-code"
		>
			<figcaption className="border-b border-line-strong bg-band px-2 py-1">
				<span
					data-testid="original-code-title"
					className="block text-xs font-semibold text-ink"
				>
					Original Reviewed Change
				</span>
				<span
					data-testid="original-code-label"
					className="block truncate font-mono text-[11px] text-muted"
				>
					{label}
				</span>
			</figcaption>
			<div className="overflow-x-auto font-mono text-xs leading-5 text-code-ink [scrollbar-width:thin]">
				<table className="w-full border-collapse">
					<CodeRows
						lines={rows}
						path={path}
						wrap={false}
						testId="original-code-line"
					/>
				</table>
			</div>
		</figure>
	);
}

/** A code window cut to its marked rows ±2; null with none marked. */
function codeRows(
	code: ReviewThread["code"],
): { rows: CodeRow[]; side: DiffSide } | null {
	if (!code) return null;
	const marked = code.rows.flatMap((r, i) => (r.marked ? [i] : []));
	if (marked.length === 0) return null;
	const first = Math.max(0, (marked[0] as number) - 2);
	const last = Math.min(code.rows.length - 1, (marked.at(-1) as number) + 2);
	return { rows: code.rows.slice(first, last + 1), side: code.anchor.side };
}

/** A changed placement's old lines as marked rows on their side; null with no text. */
function oldRows(
	old: OldLines | undefined,
): { rows: CodeRow[]; side: DiffSide } | null {
	if (!old || old.text.length === 0) return null;
	const rows = old.text.map(
		(text, i): CodeRow => ({
			kind: "context",
			oldNo: old.side === "LEFT" ? old.startLine + i : null,
			newNo: old.side === "RIGHT" ? old.startLine + i : null,
			text,
			marked: true,
		}),
	);
	return { rows, side: old.side };
}

/**
 * One unplaced thread's row: its fate in a sentence on the top line, the
 * code it was written on in a titled box, its first comment at once (as
 * the Overview's card shows it), and Show more for the replies and the
 * reply box.
 */
export function UnplacedRow(props: {
	thread: ReviewThread;
	readId: string;
	/** Its fate; null: unknown (the placements couldn't be computed). */
	fate: Fate | null;
	/** Under the fate: the original path (the trailing group). */
	path?: string;
	movedTo?: string;
	/** A link beside the row ("near 88"). */
	link?: ReactNode;
	/** The file it is listed in (a drag's drop targets); none outside the comparison. */
	dropPath?: string;
}) {
	const { thread, readId } = props;
	const [more, setMore] = useState(false);
	const showMore = useCallback(() => setMore(true), []);
	// Its agent conversation: opening it shows the composer row too.
	const agent = useThreadAgent(thread, { onOpen: showMore });
	const ref = { source: "github" as const, id: thread.id };
	const movable = useMovable({
		thread: ref,
		commit: thread.madeOn ?? thread.commit,
		lines: thread.anchor !== null,
	});
	const info = usePlacementInfo();
	const original = movedOriginalFor(
		info.moves?.get(thread.id),
		info.placements?.get(thread.id),
	);
	return (
		<ThreadAgentContext.Provider value={agent}>
			<UnplacedShell
				thread={thread}
				who={thread.author}
				ready={(f) =>
					!f.conversation || agent?.conversation?.id === f.conversation
				}
				fate={props.fate}
				path={props.path}
				movedTo={props.movedTo}
				link={props.link}
				handle={
					movable && (
						<MoveHandle
							thread={ref}
							words={firstWords(thread.excerpt)}
							path={props.dropPath ?? thread.path}
							avatar={
								<Avatar
									login={thread.author}
									url={thread.avatarUrl}
									size={16}
								/>
							}
						/>
					)
				}
				moved={
					<MovedChip
						thread={ref}
						github={{ line: thread.currentLine, outdated: thread.outdated }}
					/>
				}
				failure={<MoveFailureLine thread={ref} />}
				original={original}
			>
				<UnplacedReplies
					thread={thread}
					readId={readId}
					open={more}
					setOpen={setMore}
					asking={agent?.open === true}
				/>
			</UnplacedShell>
		</ThreadAgentContext.Provider>
	);
}

/**
 * The frame of a thread the tracer couldn't place, the same for a review
 * thread and an agent thread (only the body differs): its fate in a
 * sentence on the top line, the code it was written on in the "Original
 * Reviewed Change" box, then `children`. Resolved, one quiet line (the
 * resolved icon, the same fate sentence, `who`) until expanded; resolving it
 * collapses it again (owner, 2026-11-08).
 */
export function UnplacedShell(props: {
	thread: Pick<ReviewThread, "id" | "resolved" | "code" | "path" | "createdAt">;
	/** Who opened it, for the quiet line ("you" for an agent thread). */
	who: string;
	/** Its fate; null: unknown (the placements couldn't be computed). */
	fate: Fate | null;
	path?: string;
	movedTo?: string;
	link?: ReactNode;
	handle?: ReactNode;
	/** The `moved` chip and its Undo (threadMove.tsx), on a line of their own. */
	moved?: ReactNode;
	/** A moved thread's original: the lines it was moved to (CAR-139). */
	original?: { old: OldLines; ps: number | null; path: string };
	/** A move refused, under the header. */
	failure?: ReactNode;
	testId?: string;
	/** Whether it can serve a request yet (useFocusCard's `ready`). */
	ready?: (focus: ThreadFocus) => boolean;
	children: ReactNode;
}) {
	const { thread } = props;
	const testId = props.testId ?? "unplaced-thread";
	const [expanded, setExpanded] = useState(false);
	// Asked for by the Threads tab: expanded and scrolled into view.
	const card = useRef<HTMLLIElement>(null);
	useFocusCard(thread.id, card, () => setExpanded(true), {
		ready: props.ready,
	});
	const [wasResolved, setWasResolved] = useState(thread.resolved);
	if (wasResolved !== thread.resolved) {
		setWasResolved(thread.resolved);
		if (thread.resolved) setExpanded(false);
	}
	const fate = props.fate ? FATES[props.fate] : UNKNOWN_FATE;
	const sentence =
		props.fate === "moved" && props.movedTo
			? `${fate.sentence} to ${props.movedTo}`
			: fate.sentence;
	if (thread.resolved && !expanded) {
		return (
			<li
				ref={card}
				data-testid={testId}
				data-fate={props.fate ?? "unknown"}
				data-thread={thread.id}
				data-resolved="true"
				className="min-w-0"
			>
				{/* As the open row: the sentence truncates on its line, who wrote
				    it never shrinks, and the path has a line of its own, so two
				    resolved rows on a phone still tell apart (CAR-158). */}
				<Tooltip content={sentence} describe={false}>
					{(trigger) => (
						<button
							{...trigger}
							type="button"
							aria-expanded={false}
							aria-label={`Resolved thread by ${props.who}: ${sentence}${props.path ? ` · ${props.path}` : ""}. Expand`}
							data-testid="unplaced-collapsed"
							onClick={() => setExpanded(true)}
							className="flex min-h-10 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
						>
							<CheckCircleIcon size={14} aria-hidden className="shrink-0" />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="flex min-w-0">
									<span
										data-testid="unplaced-collapsed-fate"
										className="min-w-0 truncate"
									>
										{sentence}
									</span>
									<span
										data-testid="unplaced-collapsed-who"
										className="shrink-0 whitespace-pre"
									>
										{" · "}
										{props.who}
									</span>
								</span>
								{props.path && (
									<code
										data-testid="unplaced-collapsed-path"
										className="truncate font-mono"
									>
										{props.path}
									</code>
								)}
							</span>
						</button>
					)}
				</Tooltip>
			</li>
		);
	}
	return (
		<li
			ref={card}
			data-testid={testId}
			data-fate={props.fate ?? "unknown"}
			data-thread={thread.id}
			data-resolved={thread.resolved || undefined}
			className="min-w-0 space-y-1.5 rounded-md border border-line bg-surface p-2"
		>
			<div className="flex min-h-10 min-w-0 items-center gap-2">
				{props.handle}
				<fate.icon
					size={16}
					aria-hidden
					className={`shrink-0 ${fate.tone === "red" ? "text-bad" : "text-warn"}`}
				/>
				<span className="flex min-w-0 flex-1 flex-col">
					<Tooltip content={sentence} describe={false}>
						{(trigger) => (
							<span
								{...trigger}
								data-testid="unplaced-fate"
								className="truncate text-sm font-semibold text-ink"
							>
								{sentence}
							</span>
						)}
					</Tooltip>
					{props.path && (
						<code className="truncate font-mono text-xs text-ink-soft">
							{props.path}
						</code>
					)}
				</span>
				{props.link}
				{thread.resolved && (
					<Tooltip content="Collapse" describe={false}>
						{(trigger) => (
							<button
								{...trigger}
								type="button"
								aria-label="Collapse"
								aria-expanded
								data-testid="unplaced-collapse"
								onClick={() => setExpanded(false)}
								className="flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
							>
								<ChevronUpIcon size={16} aria-hidden />
							</button>
						)}
					</Tooltip>
				)}
			</div>
			{props.moved && (
				<div className="flex flex-wrap items-center gap-2 empty:hidden">
					{props.moved}
				</div>
			)}
			{props.failure}
			<OriginalCode
				thread={thread}
				fallback={props.original?.old}
				moved={props.original}
			/>
			{props.children}
		</li>
	);
}

/**
 * An unplaced review thread's opener, then its replies and actions behind
 * Show more; its agent conversation slides over the opener and replies,
 * the composer row below it.
 */
function UnplacedReplies({
	thread,
	readId,
	open,
	setOpen,
	asking,
}: {
	thread: ReviewThread;
	readId: string;
	open: boolean;
	setOpen: (update: (open: boolean) => boolean) => void;
	/** Its agent conversation is open: the composer row shows. */
	asking: boolean;
}) {
	const repliesId = useId();
	const replies = useReplyCount(thread, readId);
	const canAct = useCanAct(thread);
	const readable = thread.unavailable === undefined && thread.id !== "";
	const actions = (open || asking) && readable;
	const more = readable && (replies.n > 0 || canAct);
	return (
		<>
			<AgentCover>
				<Opener thread={thread} />
				{open && readable && replies.n > 0 && (
					<div
						id={repliesId}
						data-testid="thread-replies"
						className="ml-2 border-l-2 border-line pl-3"
					>
						<ThreadComments readId={readId} thread={thread} skipFirst />
					</div>
				)}
			</AgentCover>
			{actions && <ThreadActions thread={thread} />}
			{more ? (
				// The agent's handle at the row's right end while the actions row is closed.
				<CentredWithHandle handle={!actions}>
					<MoreToggle
						open={open}
						onClick={() => setOpen((o) => !o)}
						controls={open && replies.n > 0 ? repliesId : ""}
						replies={replies}
						kind="more"
					/>
				</CentredWithHandle>
			) : (
				!actions && <AgentHandleRow />
			)}
		</>
	);
}

/**
 * A thread's first comment as the Overview's card shows it: its author,
 * when, and its text as GitHub renders it (sanitized), on the author's
 * tint; its frame while the text is on its way.
 */
function Opener({ thread }: { thread: ReviewThread }) {
	const opener = usePerson(thread.author, thread.avatarUrl);
	// A long press on a phone: Copy message (its Markdown, as written).
	const copy = useMessageCopy(thread.body || thread.excerpt);
	if (thread.unavailable !== undefined || (thread.id === "" && thread.loaded))
		return <UnavailableText reason={thread.unavailable ?? "unreadable"} />;
	return (
		<div data-testid="unplaced-opener" className="min-w-0 space-y-1">
			<p className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
				<Avatar login={thread.author} url={thread.avatarUrl} size={16} />
				<span className="truncate font-medium text-ink-soft">
					{thread.author}
				</span>
				{thread.bot && <BotIcon />}
				<RelativeTime iso={thread.createdAt} className="shrink-0" />
			</p>
			{!thread.loaded ? (
				<div
					aria-busy="true"
					data-testid="thread-body-loading"
					className={`${COMMENT_SURFACE} space-y-2.5 py-3`}
				>
					<span className="sr-only">Loading…</span>
					<SkeletonBar className="w-full" />
					<SkeletonBar className="w-4/5" />
				</div>
			) : thread.html.trim() ? (
				<div
					data-testid="thread-body"
					className={`${commentSurface(opener.tint)} break-words`}
					{...copy.press}
				>
					<CommentBody
						html={thread.html}
						body={thread.body}
						code={thread.code}
						path={thread.path}
						open={false}
					/>
				</div>
			) : (
				<p
					data-testid="thread-body"
					className={`${commentSurface(opener.tint)} text-sm break-words`}
					{...copy.press}
				>
					{thread.excerpt}
				</p>
			)}
			{copy.menu}
		</div>
	);
}

/**
 * The threads the tracer couldn't place in this file, under its header,
 * fate first; each shows its original code, a "near N" link to the
 * closest surviving line and, where moves go, the handle to move it.
 */
export function UnplacedThreads(props: {
	fates: {
		thread: ReviewThread;
		placement: Extract<ThreadPlacement, { kind: "unplaced" }>;
	}[];
	readId: string;
	path: string;
	fileIndex: number;
}) {
	if (props.fates.length === 0) return null;
	// Resolved ones last, quiet, and counted nowhere.
	const fates = resolvedLast(props.fates);
	const open = fates.filter((f) => !f.thread.resolved).length;
	return (
		<div
			data-testid="unplaced-threads"
			className="space-y-1.5 border-b border-line bg-canvas p-2"
		>
			{open > 0 && (
				<p className="flex items-center gap-2 text-xs text-muted">
					<Badge tone="red" icon={CircleSlashIcon}>
						{open} unplaced
					</Badge>
				</p>
			)}
			<ul className="space-y-1.5">
				{fates.map(({ thread, placement }) => (
					<UnplacedRow
						key={thread.id}
						thread={thread}
						readId={props.readId}
						fate={placement.fate}
						{...(placement.movedTo ? { movedTo: placement.movedTo } : {})}
						link={
							placement.nearest && (
								<NearLink
									path={props.path}
									line={placement.nearest.line}
									side={placement.nearest.side}
								/>
							)
						}
						dropPath={props.path}
					/>
				))}
			</ul>
		</div>
	);
}

/**
 * Threads still being placed (CAR-8: an old-side thread waiting for
 * GitHub's hunk): a spinner pill each, laid over the top of the file's
 * lines, so showing or hiding it moves nothing; counted nowhere. When
 * asking again failed, each says so instead of spinning.
 */
export function WaitingThreads(props: { waiting: readonly ReviewThread[] }) {
	const info = usePlacementInfo();
	if (props.waiting.length === 0) return null;
	const failed = info.error ?? info.stalled ?? null;
	return (
		<div className="relative h-0">
			<ul
				data-testid="placing-threads"
				aria-busy={failed ? undefined : true}
				className="absolute top-1 right-2 z-10 flex max-w-[calc(100%-1rem)] flex-col items-end gap-1"
			>
				{props.waiting.map((t) => (
					<li
						key={t.id}
						data-testid="placing-thread"
						data-thread={t.id}
						className="flex min-h-10 max-w-full min-w-0 items-center gap-2 rounded-full border border-line bg-surface px-3 text-xs text-muted shadow-sm"
					>
						{failed ? (
							<Tooltip
								content={`Where this thread sits now couldn't be computed: ${failed.message}`}
							>
								{(trigger) => (
									<span
										{...trigger}
										role="img"
										aria-label="Place unknown"
										data-testid="placing-thread-error"
										className="flex shrink-0 text-bad"
									>
										<AlertIcon size={14} aria-hidden />
									</span>
								)}
							</Tooltip>
						) : (
							<Spinner label="Placing thread" size={14} />
						)}
						<span className="min-w-0 truncate">
							{t.author}
							{t.excerpt ? ` · ${t.excerpt}` : ""}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** Unresolved threads first, resolved ones after, each in the order given. */
export function resolvedLast<T extends { thread: ReviewThread }>(
	rows: readonly T[],
): T[] {
	return [
		...rows.filter((r) => !r.thread.resolved),
		...rows.filter((r) => r.thread.resolved),
	];
}

/** "near 88": lands on the closest surviving line, the comparison kept. */
export function NearLink(props: {
	path: string;
	line: number;
	side: "LEFT" | "RIGHT";
}) {
	const id = useReviewId();
	return (
		<Tooltip content={`Nearest surviving line: ${props.line}`}>
			{(trigger) => (
				<Link
					{...trigger}
					to="/r/$id/files"
					params={{ id }}
					search={(prev) => ({
						...prev,
						path: props.path,
						line: props.line,
						side: props.side,
					})}
					data-testid="near-line"
					className="inline-flex min-h-10 shrink-0 items-center rounded-sm px-1 text-xs font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-accent"
				>
					near {props.line}
				</Link>
			)}
		</Tooltip>
	);
}

/** The patch set a thread was opened on, as a chip ("PS2"); nothing without one. */
export function OpenedOnChip({ thread }: { thread: ReviewThread }) {
	const n = usePlacementInfo().openedOn(thread);
	if (n === null) return null;
	return (
		<Chip
			tone="gray"
			icon={VersionsIcon}
			tip={`Opened on patch set ${n}`}
			testId="opened-on"
		>
			PS{n}
		</Chip>
	);
}

/**
 * The placements of the session's own snapshot (its latest patch set, or
 * its head before any) for read `readId`: what the Overview's cards say.
 */
export function useSessionPlacements(
	readId: string | undefined,
): PlacementInfo {
	const session = useQuery(sessionQuery).data;
	const latest = session?.patchsets.at(-1)?.number ?? null;
	const to: RereviewTo | null = !session
		? null
		: latest !== null
			? { patchset: latest }
			: { head: session.snapshotHead };
	const asked = readId !== undefined && to !== null;
	const query = useQuery({
		...placementsQuery(readId ?? "", to ?? { patchset: 1 }),
		enabled: asked,
	});
	const answer =
		asked && query.data && !("pending" in query.data) ? query.data : null;
	// A failure stays shown while the query asks again by itself (a refetch
	// clears its error), until an answer lands (CAR-271).
	const key = asked ? JSON.stringify([readId, to]) : "";
	const [held, setHeld] = useState<{ key: string; error: Error } | null>(null);
	useEffect(() => {
		if (query.error) setHeld({ key, error: query.error });
		else if (answer) setHeld(null);
	}, [query.error, answer, key]);
	const error =
		asked && answer === null
			? (query.error ?? (held?.key === key ? held.error : null))
			: null;
	const placements = usePlacementMap(answer);
	const moves = useMemo(() => movesOf(answer), [answer]);
	const patchsets = session?.patchsets;
	const toKey = to ? JSON.stringify(to) : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: `to` by value.
	return useMemo(
		() => ({
			placements,
			pending: asked && answer === null && error === null,
			error,
			retry: () => void query.refetch(),
			readId: readId ?? null,
			to,
			moves,
			// The Overview shows that a thread is moved, never the controls.
			moveTo: null,
			viewedHead: session?.snapshotHead ?? null,
			openedOn: (t: Pick<ReviewThread, "createdAt">) =>
				openedOn(t.createdAt, patchsets ?? []),
		}),
		[
			placements,
			moves,
			asked,
			answer,
			error,
			query,
			readId,
			toKey,
			patchsets,
			session,
		],
	);
}

/** "1 thread", "2 threads". */
export const threadsLabel = (n: number) => `${n} thread${n === 1 ? "" : "s"}`;

/** Placements as a Map, from the answer (stable while the answer is). */
export function usePlacementMap(
	answer: PlacementsAnswer | null,
): Placements | null {
	return useMemo(
		() =>
			answer ? new Map(answer.threads.map((t) => [t.id, t.placement])) : null,
		[answer],
	);
}

/**
 * NotHere's word and tooltip, by why (since: the compared patch set). A
 * file unchanged since is the same fact (the line was deleted before),
 * said in the tooltip only. One wording wherever the since view says why
 * a line isn't in it (CAR-255; CAR-253's landing hint).
 */
export function notHereText(
	why: NotHere["why"],
	since: number | undefined,
): { label: string; tip: string } {
	const ps = since === undefined ? "the compared patch set" : `PS${since}`;
	switch (why) {
		case "deleted-before":
			return {
				label: `deleted before ${ps}`,
				tip: `Its line was deleted before ${ps}: not in this comparison`,
			};
		case "unchanged":
			return {
				label: `deleted before ${ps}`,
				tip: `Its line was deleted before ${ps}, and the file is unchanged since ${ps}`,
			};
		default:
			return {
				label: "not in this comparison",
				tip: "Its line isn't in this comparison",
			};
	}
}

/**
 * The since view's word on a thread whose line it has no row for
 * (CAR-255): why (NotHere, never a tracer fate: the line is where the
 * thread says), and a link to the full diff on that line, its card opened
 * there (FullDiffLink). Muted once resolved.
 */
export function NotHereNote(props: {
	notHere: NotHere;
	path: string;
	since?: number;
	resolved?: boolean;
	/** The card to open there: a review thread's id, or an agent conversation's. */
	open: { thread: string } | { conversation: string };
}) {
	const { label, tip } = notHereText(props.notHere.why, props.since);
	return (
		<span data-testid="not-here" className="inline-flex items-center gap-1">
			<Chip
				tone={props.resolved ? "gray" : "yellow"}
				icon={CircleSlashIcon}
				tip={tip}
				testId="not-here-why"
			>
				{label}
			</Chip>
			<FullDiffLink
				testId="not-here-full-diff"
				target={{
					path: props.path,
					line: props.notHere.line,
					side: props.notHere.side,
					open: props.open,
				}}
			/>
		</span>
	);
}
