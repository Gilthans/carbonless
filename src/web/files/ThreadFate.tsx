import {
	AlertIcon,
	ArrowSwitchIcon,
	CheckCircleIcon,
	ChevronUpIcon,
	CircleSlashIcon,
	DiffRemovedIcon,
	FileRemovedIcon,
	GitCompareIcon,
	GrabberIcon,
	HistoryIcon,
	type Icon,
	VersionsIcon,
} from "@primer/octicons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	createContext,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useContext,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { HunkLine } from "../../shared/diffHunk";
import { openedOn } from "../../shared/rereview/openedOn";
import type { Fate, ThreadPlacement } from "../../shared/rereview/placement";
import type {
	CodeRow,
	PlacementsAnswer,
	ReviewThread,
	ThreadAnchorRef,
} from "../../shared/types";
import {
	ApiError,
	placementsQuery,
	postPlacement,
	type RereviewTo,
	sessionQuery,
} from "../api";
import { Badge, BotIcon, Chip, SkeletonBar } from "../overview/parts";
import { RelativeTime } from "../RelativeTime";
import { useReviewId } from "../reviewId";
import { Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { CodeRows, CommentBody } from "../threads/CommentBody";
import {
	COMMENT_SURFACE,
	commentSurface,
	ThreadActions,
	ThreadComments,
	UnavailableText,
	useCanAct,
} from "../threads/Conversation";
import { MoreToggle, useReplyCount } from "../threads/MoreToggle";
import { Avatar, usePerson } from "../threads/people";
import type { Placements } from "./threadPlacement";

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
	/** Asks for them again. */
	retry: () => void;
	/** A retry after an error is under way. */
	retrying?: boolean;
	/** The read and target they are for (a placement write updates them). */
	readId: string | null;
	to: RereviewTo | null;
	/** The patch set a drag stores into; null: none (a head, an earlier patch set). */
	placeOn: number | null;
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
	placeOn: null,
	openedOn: () => null,
});

export const PlacementProvider = PlacementContext.Provider;
export const usePlacementInfo = () => useContext(PlacementContext);

/** A fate's word, icon, tone and tooltip. */
export const FATES: Record<
	Fate,
	{
		label: string;
		icon: Icon;
		tone: "red" | "yellow";
		tip: string;
		/** An unplaced row's top line (owner, 2026-11-08). */
		sentence: string;
		/** A resolved row's quiet line: the sentence shortened. */
		short: string;
	}
> = {
	deleted: {
		label: "deleted",
		icon: DiffRemovedIcon,
		tone: "red",
		tip: "Its lines were deleted",
		sentence: "Commented line has been deleted since the review",
		short: "Line deleted",
	},
	rewritten: {
		label: "rewritten",
		icon: AlertIcon,
		tone: "yellow",
		tip: "Rewritten beyond tracing: its lines can't be followed here",
		sentence: "Commented line has been rewritten since the review",
		short: "Line rewritten",
	},
	"file-gone": {
		label: "file deleted",
		icon: FileRemovedIcon,
		tone: "red",
		tip: "Its file was deleted",
		sentence: "Commented file has been deleted since the review",
		short: "File deleted",
	},
	moved: {
		label: "moved?",
		icon: ArrowSwitchIcon,
		tone: "yellow",
		tip: "Its file was renamed and its lines didn't follow: maybe moved",
		sentence: "Commented line may have moved",
		short: "Line may have moved",
	},
	reverted: {
		label: "reverted",
		icon: HistoryIcon,
		tone: "yellow",
		tip: "The PR no longer changes this place",
		sentence: "The commented change has been reverted since the review",
		short: "Change reverted",
	},
	"base-changed": {
		label: "base changed",
		icon: GitCompareIcon,
		tone: "yellow",
		tip: "The base branch changed this line since",
		sentence: "The base changed under the commented line since the review",
		short: "Base changed",
	},
};

/** No fate known: the placements couldn't be computed. */
const UNKNOWN_FATE = {
	label: "not placed",
	icon: AlertIcon,
	tone: "red" as const,
	tip: "Where this thread sits now couldn't be computed",
	sentence: "Couldn't work out where this thread is now",
	short: "Place unknown",
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
	const info = usePlacementInfo();
	const placement = info.placements?.get(thread.id);
	if (!placement && info.error && !thread.resolved) {
		return (
			<Chip
				tone="red"
				icon={AlertIcon}
				tip={`Where this thread sits now couldn't be computed: ${info.error.message}`}
				testId="placement-error"
			>
				place unknown
			</Chip>
		);
	}
	if (!placement) {
		return info.pending && !thread.resolved ? (
			<span className="flex h-4 w-4 items-center" data-testid="placement-slot">
				<Spinner label="Placing threads" size={12} />
			</span>
		) : null;
	}
	// A resolved thread is placed so it never vanishes, never to ask for
	// attention: its chip is muted.
	const quiet = thread.resolved;
	if (placement.kind === "changed") {
		return <ChangedChip thread={thread} />;
	}
	if (placement.kind === "unplaced" || placement.kind === "outside") {
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

/** "changed since": a thread's line was rewritten since it was made (muted once resolved). */
export function ChangedChip({
	thread,
}: {
	thread: Pick<ReviewThread, "createdAt" | "resolved">;
}) {
	const info = usePlacementInfo();
	const ps = psLabel(info.openedOn(thread));
	return (
		<Chip
			tone={thread.resolved ? "gray" : "yellow"}
			icon={GitCompareIcon}
			tip={`The line changed since ${ps || "the thread was made"}`}
			testId="placement-changed"
		>
			changed since
		</Chip>
	);
}

/**
 * A changed thread's old lines (from its own patch set) above the lines
 * that replaced them, and the fate line with a way to its patch set.
 */
export function ChangedSince({
	thread,
	placement,
	lines = true,
}: {
	/** A review thread, or an agent thread seen the same way. */
	thread: Pick<ReviewThread, "createdAt" | "path" | "code">;
	placement: Extract<ThreadPlacement, { kind: "changed" }>;
	/** The old and new lines too (the Overview's card shows its own code). */
	lines?: boolean;
}) {
	const info = usePlacementInfo();
	const ps = info.openedOn(thread);
	const id = useReviewId();
	const { old, now, anchor } = placement;
	const rows: (HunkLine & { marked?: boolean })[] = [
		...old.text.map((text, i) => ({
			kind: "del" as const,
			oldNo: old.startLine + i,
			newNo: null,
			text,
		})),
		...now.map((text, i) => ({
			kind: "add" as const,
			oldNo: null,
			newNo: anchor.line - now.length + 1 + i,
			text,
		})),
	];
	return (
		<div data-testid="placement-changed-pane" className="space-y-1">
			{lines && rows.length > 0 && (
				<figure
					aria-label={`Lines as they were${ps === null ? "" : ` on PS${ps}`}, and now`}
					className="overflow-x-auto rounded-md border border-line bg-code font-mono text-xs leading-5 text-code-ink [scrollbar-width:thin]"
				>
					<table className="w-full border-collapse">
						<CodeRows
							lines={rows}
							path={anchor.path}
							wrap={false}
							testId="placement-changed-line"
						/>
					</table>
				</figure>
			)}
			<p
				data-testid="placement-fate-line"
				className="flex min-h-10 flex-wrap items-center gap-x-2 text-xs text-muted"
			>
				<span>Line rewritten{ps === null ? "" : ` since PS${ps}`}</span>
				{ps !== null && (
					<Link
						to="/r/$id/files"
						params={{ id }}
						search={{
							ps,
							path: thread.code?.anchor.path ?? thread.path,
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

/**
 * The code a thread was written on, cut to its commented lines and two
 * lines either side, the commented ones highlighted; labelled with its
 * patch set, path and line numbers. A frame while the code is still on
 * its way; nothing when there is none.
 */
export function OriginalCode({
	thread,
}: {
	/** A review thread, or an agent thread seen the same way. */
	thread: Pick<ReviewThread, "code" | "path" | "createdAt">;
}) {
	const info = usePlacementInfo();
	const code = thread.code;
	const path = code?.anchor.path ?? thread.path;
	if (!code) return null;
	if (code.source === "pending") {
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
	const marked = code.rows.flatMap((r, i) => (r.marked ? [i] : []));
	if (marked.length === 0) return null;
	const first = Math.max(0, (marked[0] as number) - 2);
	const last = Math.min(code.rows.length - 1, (marked.at(-1) as number) + 2);
	const rows = code.rows.slice(first, last + 1);
	const side = code.anchor.side;
	const numberOf = (r: CodeRow) => (side === "LEFT" ? r.oldNo : r.newNo);
	const nums = code.rows
		.filter((r) => r.marked)
		.map(numberOf)
		.filter((n): n is number => n !== null);
	const a = nums[0];
	const b = nums.at(-1);
	const lines =
		a === undefined ? "" : a === b ? ` · line ${a}` : ` · lines ${a}–${b}`;
	const ps = psLabel(info.openedOn(thread));
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
	/** A drag handle, when the thread can be placed by hand. */
	handle?: ReactNode;
}) {
	const { thread } = props;
	return (
		<UnplacedShell
			thread={thread}
			who={thread.author}
			fate={props.fate}
			path={props.path}
			movedTo={props.movedTo}
			link={props.link}
			handle={props.handle}
		>
			<Opener thread={thread} />
			<UnplacedReplies thread={thread} readId={props.readId} />
		</UnplacedShell>
	);
}

/**
 * The frame of a thread the tracer couldn't place, the same for a review
 * thread and an agent thread (only the body differs): its fate in a
 * sentence on the top line, the code it was written on in the "Original
 * Reviewed Change" box, then `children`. Resolved, one quiet line (the
 * resolved icon, the fate shortened, `who`) until expanded; resolving it
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
	testId?: string;
	children: ReactNode;
}) {
	const { thread } = props;
	const testId = props.testId ?? "unplaced-thread";
	const [expanded, setExpanded] = useState(false);
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
				data-testid={testId}
				data-fate={props.fate ?? "unknown"}
				data-thread={thread.id}
				data-resolved="true"
				className="min-w-0"
			>
				<button
					type="button"
					aria-expanded={false}
					aria-label={`Resolved thread by ${props.who}: ${fate.short}${props.path ? ` · ${props.path}` : ""}. Expand`}
					data-testid="unplaced-collapsed"
					onClick={() => setExpanded(true)}
					className="flex min-h-10 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
				>
					<CheckCircleIcon size={14} aria-hidden className="shrink-0" />
					<span className="truncate">
						{fate.short}
						{props.path && (
							<>
								{" · "}
								<code className="font-mono">{props.path}</code>
							</>
						)}
						{" · "}
						{props.who}
					</span>
				</button>
			</li>
		);
	}
	return (
		<li
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
			<OriginalCode thread={thread} />
			{props.children}
		</li>
	);
}

/** An unplaced review thread's replies and actions, behind Show more. */
function UnplacedReplies({
	thread,
	readId,
}: {
	thread: ReviewThread;
	readId: string;
}) {
	const [open, setOpen] = useState(false);
	const repliesId = useId();
	const replies = useReplyCount(thread, readId);
	const canAct = useCanAct(thread);
	const readable = thread.unavailable === undefined && thread.id !== "";
	return (
		<>
			{open && readable && (
				<div id={repliesId} className="space-y-2">
					{replies.n > 0 && (
						<div
							data-testid="thread-replies"
							className="ml-2 border-l-2 border-line pl-3"
						>
							<ThreadComments readId={readId} thread={thread} skipFirst />
						</div>
					)}
					<ThreadActions thread={thread} />
				</div>
			)}
			{readable && (replies.n > 0 || canAct) && (
				<div className="flex justify-center">
					<MoreToggle
						open={open}
						onClick={() => setOpen((o) => !o)}
						controls={open ? repliesId : ""}
						replies={replies}
						kind="more"
					/>
				</div>
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
				>
					{thread.excerpt}
				</p>
			)}
		</div>
	);
}

/** The row a point is over, in this file's diff, as a one-line anchor. */
function lineAt(
	x: number,
	y: number,
	section: Element | null,
	path: string,
): { row: HTMLElement; anchor: ThreadAnchorRef } | null {
	const row = document
		.elementFromPoint(x, y)
		?.closest<HTMLElement>('tr[data-testid="diff-line"]');
	if (!row || !section?.contains(row)) return null;
	const newNo = Number(row.dataset.newNo);
	const oldNo = Number(row.dataset.oldNo);
	const [side, line] =
		Number.isInteger(newNo) && newNo > 0
			? (["RIGHT", newNo] as const)
			: Number.isInteger(oldNo) && oldNo > 0
				? (["LEFT", oldNo] as const)
				: [null, 0];
	if (!side) return null;
	return {
		row,
		anchor: { path, startSide: side, startLine: line, side, line },
	};
}

/**
 * Writes a placement (POST /threads/:id/placement), shown at once on the
 * placements it updates, and rolled back when refused (400, 409).
 */
export function usePlaceThread() {
	const info = usePlacementInfo();
	const client = useQueryClient();
	return useMutation({
		mutationFn: (v: { threadId: string; anchor: ThreadAnchorRef }) => {
			if (info.placeOn === null) throw new Error("No patch set to place in");
			return postPlacement(v.threadId, info.placeOn, v.anchor);
		},
		onMutate: async (v) => {
			if (!info.readId || !info.to) return undefined;
			const { queryKey } = placementsQuery(info.readId, info.to);
			await client.cancelQueries({ queryKey });
			const before = client.getQueryData(queryKey);
			client.setQueryData(queryKey, (old) => {
				if (!old || "pending" in old) return old;
				const placed: PlacementsAnswer["threads"][number] = {
					id: v.threadId,
					placement: { kind: "placed", anchor: v.anchor, changed: false },
				};
				return {
					...old,
					threads: old.threads.map((t) => (t.id === v.threadId ? placed : t)),
				};
			});
			return { queryKey, before };
		},
		onError: (_error, _v, context) => {
			if (context) client.setQueryData(context.queryKey, context.before);
		},
		onSettled: () => client.invalidateQueries({ queryKey: ["placements"] }),
	});
}

/**
 * The handle that places a thread by dragging it onto a line of its file
 * (pointer capture: a mouse and a finger alike). The row under the
 * pointer is outlined while dragging.
 */
function DragHandle(props: {
	thread: ReviewThread;
	path: string;
	sectionId: string;
	onPlace: (anchor: ThreadAnchorRef) => void;
}) {
	const over = useRef<HTMLElement | null>(null);
	const [dragging, setDragging] = useState(false);
	const mark = (row: HTMLElement | null) => {
		if (over.current === row) return;
		over.current?.removeAttribute("data-drop-line");
		over.current = row;
		row?.setAttribute("data-drop-line", "true");
	};
	const section = () => document.getElementById(props.sectionId);
	const end = (e: ReactPointerEvent, place: boolean) => {
		if (!dragging) return;
		setDragging(false);
		const hit = lineAt(e.clientX, e.clientY, section(), props.path);
		mark(null);
		if (place && hit) props.onPlace(hit.anchor);
	};
	return (
		<Tooltip content="Drag onto a line to place it there" describe={false}>
			{(trigger) => (
				<button
					{...trigger}
					type="button"
					aria-label="Place on a line (drag)"
					data-testid="place-handle"
					onPointerDown={(e) => {
						e.preventDefault();
						e.currentTarget.setPointerCapture(e.pointerId);
						setDragging(true);
					}}
					onPointerMove={(e) => {
						if (!dragging) return;
						mark(
							lineAt(e.clientX, e.clientY, section(), props.path)?.row ?? null,
						);
					}}
					onPointerUp={(e) => end(e, true)}
					onPointerCancel={(e) => end(e, false)}
					className={`flex h-10 w-10 shrink-0 touch-none items-center justify-center rounded text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
				>
					<GrabberIcon size={16} aria-hidden />
				</button>
			)}
		</Tooltip>
	);
}

/**
 * The threads the tracer couldn't place in this file, under its header,
 * fate first; each shows its original code, a "near N" link to the
 * closest surviving line and, on the reviewer's latest patch set, a
 * handle to drag it onto a line.
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
	const info = usePlacementInfo();
	const place = usePlaceThread();
	const sectionId = `file-${props.fileIndex}`;
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
			{place.isError && (
				<p role="alert" className="text-xs text-bad">
					Couldn't place it:{" "}
					{place.error instanceof ApiError
						? place.error.message
						: String(place.error)}
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
						handle={
							info.placeOn !== null && (
								<DragHandle
									thread={thread}
									path={props.path}
									sectionId={sectionId}
									onPlace={(anchor) =>
										place.mutate({ threadId: thread.id, anchor })
									}
								/>
							)
						}
					/>
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
	const placements = usePlacementMap(answer);
	const patchsets = session?.patchsets;
	const toKey = to ? JSON.stringify(to) : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: `to` by value.
	return useMemo(
		() => ({
			placements,
			pending: asked && answer === null && !query.error,
			error: asked && answer === null ? query.error : null,
			retry: () => void query.refetch(),
			readId: readId ?? null,
			to,
			placeOn: null,
			openedOn: (t: Pick<ReviewThread, "createdAt">) =>
				openedOn(t.createdAt, patchsets ?? []),
		}),
		[placements, asked, answer, query, readId, toKey, patchsets],
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
