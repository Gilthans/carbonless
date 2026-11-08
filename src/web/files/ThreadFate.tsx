import {
	AlertIcon,
	ArrowSwitchIcon,
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
import { Badge, Chip, SkeletonBar } from "../overview/parts";
import { useReviewId } from "../reviewId";
import { Spinner } from "../Spinner";
import { Tooltip } from "../Tooltip";
import { CodeRows } from "../threads/CommentBody";
import { Avatar } from "../threads/people";
import { ThreadBlock } from "./ThreadRow";
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
	/** The read and target they are for (a placement write updates them). */
	readId: string | null;
	to: RereviewTo | null;
	/** The patch set a drag stores into; null: none (a head, an earlier patch set). */
	placeOn: number | null;
	/** The patch set a thread was opened on (openedOn); null without patch sets. */
	openedOn: (t: ReviewThread) => number | null;
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
	{ label: string; icon: Icon; tone: "red" | "yellow"; tip: string }
> = {
	deleted: {
		label: "deleted",
		icon: DiffRemovedIcon,
		tone: "red",
		tip: "Its lines were deleted",
	},
	rewritten: {
		label: "rewritten",
		icon: AlertIcon,
		tone: "yellow",
		tip: "Rewritten beyond tracing: its lines can't be followed here",
	},
	"file-gone": {
		label: "file deleted",
		icon: FileRemovedIcon,
		tone: "red",
		tip: "Its file was deleted",
	},
	moved: {
		label: "moved?",
		icon: ArrowSwitchIcon,
		tone: "yellow",
		tip: "Its file was renamed and its lines didn't follow: maybe moved",
	},
	reverted: {
		label: "reverted",
		icon: HistoryIcon,
		tone: "yellow",
		tip: "The PR no longer changes this place",
	},
	"base-changed": {
		label: "base changed",
		icon: GitCompareIcon,
		tone: "yellow",
		tip: "The base branch changed this line since",
	},
};

/** No fate known: the placements couldn't be computed. */
const UNKNOWN_FATE = {
	label: "not placed",
	icon: AlertIcon,
	tone: "red" as const,
	tip: "Where this thread sits now couldn't be computed",
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
	if (placement.kind === "changed") {
		const ps = psLabel(info.openedOn(thread));
		return (
			<Chip
				tone="yellow"
				icon={GitCompareIcon}
				tip={`The line changed since ${ps || "the thread was made"}`}
				testId="placement-changed"
			>
				changed since
			</Chip>
		);
	}
	if (placement.kind === "unplaced" || placement.kind === "outside") {
		const fate = FATES[placement.fate];
		return (
			<Chip
				tone={fate.tone}
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
 * A changed thread's old lines (from its own patch set) above the lines
 * that replaced them, and the fate line with a way to its patch set.
 */
export function ChangedSince({
	thread,
	placement,
	lines = true,
}: {
	thread: ReviewThread;
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
export function OriginalCode({ thread }: { thread: ReviewThread }) {
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
			aria-label={label}
			className="min-w-0 overflow-hidden rounded-md border border-line bg-code"
		>
			<figcaption
				data-testid="original-code-label"
				className="truncate border-b border-line px-2 py-0.5 font-mono text-[11px] text-muted"
			>
				{label}
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

/** One unplaced thread's row: who, its fate, its text, its code; opens to the thread. */
export function UnplacedRow(props: {
	thread: ReviewThread;
	readId: string;
	/** Its fate; null: unknown (the placements couldn't be computed). */
	fate: Fate | null;
	/** Before the fate: the original path (the trailing group). */
	path?: string;
	movedTo?: string;
	/** A link beside the row ("near 88"). */
	link?: ReactNode;
	/** A drag handle, when the thread can be placed by hand. */
	handle?: ReactNode;
}) {
	const { thread } = props;
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	const fate = props.fate ? FATES[props.fate] : UNKNOWN_FATE;
	return (
		<li
			data-testid="unplaced-thread"
			data-fate={props.fate ?? "unknown"}
			data-thread={thread.id}
			className="min-w-0 space-y-1.5 rounded-md border border-line bg-surface p-2"
		>
			<div className="flex min-h-10 min-w-0 items-center gap-2">
				{props.handle}
				<Avatar login={thread.author} url={thread.avatarUrl} />
				<button
					type="button"
					aria-expanded={open}
					aria-controls={bodyId}
					onClick={() => setOpen(!open)}
					className="flex min-h-10 min-w-0 flex-1 flex-col items-start justify-center rounded-sm text-left text-sm focus-visible:outline-2 focus-visible:outline-accent"
				>
					<span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5">
						{props.path && (
							<code className="min-w-0 font-mono text-xs break-all text-ink-soft">
								{props.path}
							</code>
						)}
						<span className="inline-flex items-center gap-1 font-semibold text-ink">
							<fate.icon
								size={12}
								aria-hidden
								className={fate.tone === "red" ? "text-bad" : "text-warn"}
							/>
							{fate.label}
						</span>
						{props.movedTo && (
							<span className="text-muted">
								to{" "}
								<code className="font-mono text-xs break-all">
									{props.movedTo}
								</code>
							</span>
						)}
					</span>
					<span className="line-clamp-2 max-w-full text-xs break-words text-muted">
						{thread.excerpt}
					</span>
				</button>
				{props.link}
			</div>
			<OriginalCode thread={thread} />
			{open && (
				<div id={bodyId}>
					<ThreadBlock readId={props.readId} thread={thread} />
				</div>
			)}
		</li>
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
	return (
		<div
			data-testid="unplaced-threads"
			className="space-y-1.5 border-b border-line bg-canvas p-2"
		>
			<p className="flex items-center gap-2 text-xs text-muted">
				<Badge tone="red" icon={CircleSlashIcon}>
					{props.fates.length} unplaced
				</Badge>
			</p>
			{place.isError && (
				<p role="alert" className="text-xs text-bad">
					Couldn't place it:{" "}
					{place.error instanceof ApiError
						? place.error.message
						: String(place.error)}
				</p>
			)}
			<ul className="space-y-1.5">
				{props.fates.map(({ thread, placement }) => (
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

/** "near 88": lands on the closest surviving line, the comparison kept. */
function NearLink(props: {
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
			openedOn: (t: ReviewThread) => openedOn(t.createdAt, patchsets ?? []),
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
