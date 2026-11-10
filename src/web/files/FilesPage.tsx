import { AlertIcon, InfoIcon } from "@primer/octicons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AgentThread } from "../../shared/agent";
import { openedOn } from "../../shared/rereview/openedOn";
import type { ReviewThread, SessionInfo } from "../../shared/types";
import { AgentNotInComparison } from "../agent/AgentNotInComparison";
import {
	agentThreadsQuery,
	useAgentOn,
	useAgentPlacementsFor,
} from "../agent/api";
import {
	AgentPlacingProvider,
	agentOutside,
	agentWaiting,
	shownAgentPlaceables,
} from "../agent/placeable";
import {
	hunksQuery,
	overviewQuery,
	placementsQuery,
	type RereviewTo,
	sessionQuery,
} from "../api";
import { LabeledIcon } from "../overview/parts";
import { useForgetPageScroll, usePageActive } from "../pageActive";
import { useReviewId } from "../reviewId";
import { SkeletonBar, Spinner } from "../Spinner";
import { useAppHeaderHeight, useHeight } from "../sticky";
import { Tooltip } from "../Tooltip";
import { PeopleProvider } from "../threads/people";
import { dropLosesText, useThreadWrites } from "../threads/threadWrites";
import { usePrefetchComments } from "../threads/useThreadComments";
import { useThreads } from "../threads/useThreads";
import { ErrorMessage } from "../ui";
import { useMedia, WIDE } from "../useMedia";
import { FilesVerdict } from "../verdict/FilesVerdict";
import { ignoreWhitespace, showInvisibles, sideBySide } from "../viewSettings";
import { type Comparison, useComparison } from "./comparison";
import type { DiffThreads } from "./DiffBody";
import { FileDiff, GoneFile, UNDO_ARM_MS } from "./FileDiff";
import { FileTree } from "./FileTree";
import { nextFile } from "./fileFinish";
import { treeOrder } from "./fileOrder";
import { filesPrefetchOrder } from "./filesPrefetch";
import { foldsKey } from "./folderFold";
import { useHeadSure } from "./headSure";
import {
	type FilesSearch,
	type Landing,
	landingFile,
	parseFilesSearch,
} from "./landing";
import { NotInComparison } from "./NotInComparison";
import { PatchsetGraph } from "./PatchsetGraph";
import { ProgressBar } from "./ProgressBar";
import { SelectionBar } from "./SelectionBar";
import {
	captureAnchor,
	restoreAnchor,
	type ScrollAnchor,
} from "./scrollAnchor";
import {
	carriedCount,
	eyesOf,
	goneFiles,
	liveToRead,
	nothingSince,
	sinceProgress,
	toReadClusters,
	toReadCount,
	unitsFile,
	unitsOf,
} from "./since";
import {
	type PlacementInfo,
	PlacementProvider,
	usePlacementMap,
} from "./ThreadFate";
import { TreeColumn } from "./TreeResizer";
import { outsideThreads, shownThread, shownThreads } from "./threadPlacement";
import { useSince } from "./useSince";

const NO_THREADS: ReviewThread[] = [];
const NO_AGENT_THREADS: AgentThread[] = [];

import { type Unit, useUnit } from "./unit";
import { STALE_MESSAGE, useReviewView, useSyncState } from "./useSetStates";
import { useViewShortcuts } from "./viewShortcuts";

/**
 * The file tree on narrow screens: a modal sheet over the diffs, closed by
 * picking a file, the close button, the backdrop or Escape.
 */
function FilesSheet(props: {
	open: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const d = dialog.current;
		if (!d) return;
		if (props.open && !d.open) {
			if (typeof d.showModal === "function") d.showModal();
			else d.setAttribute("open", "");
		} else if (!props.open && d.open) {
			if (typeof d.close === "function") d.close();
			else d.removeAttribute("open");
		}
	}, [props.open]);
	// The page behind the sheet doesn't scroll while it's open.
	useEffect(() => {
		if (!props.open) return;
		const root = document.documentElement;
		const before = root.style.overflow;
		root.style.overflow = "hidden";
		return () => {
			root.style.overflow = before;
		};
	}, [props.open]);
	return (
		<dialog
			ref={dialog}
			aria-labelledby="files-sheet-title"
			onClose={props.onClose}
			onClick={(event) => {
				// A click on the backdrop lands on the dialog itself.
				if (event.target === dialog.current) props.onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") props.onClose();
			}}
			className="m-0 mt-auto h-[85dvh] max-h-none w-full max-w-none overflow-hidden rounded-t-2xl border-t border-edge bg-surface p-0 text-ink shadow-sheet backdrop:bg-canvas/70 backdrop:backdrop-blur-[2px]"
		>
			<div className="flex h-full flex-col">
				<div className="flex items-center justify-between border-b border-line px-4 py-1">
					<h2
						id="files-sheet-title"
						className="text-xs font-semibold tracking-[0.18em] text-label uppercase"
					>
						Files
					</h2>
					<button
						type="button"
						onClick={props.onClose}
						className="h-10 rounded-md px-3 text-sm font-medium hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
					>
						Close
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [--tree-bg:var(--color-surface)]">
					{props.children}
				</div>
			</div>
		</dialog>
	);
}

/**
 * Tracks the file in view: the first file section (in page order) crossing the band just
 * below the sticky app header and progress bar (`top` px tall together).
 * Not while the page is hidden (`active` false): nothing is in view then,
 * and the file in view when it shows again is the one it was left on.
 */
export function useCurrentFile(
	container: RefObject<HTMLElement | null>,
	sections: string,
	top: number,
	active: boolean,
) {
	const [current, setCurrent] = useState<number | null>(null);
	// `sections` changes when the rendered file sections do: observe the new ones.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above.
	useEffect(() => {
		const root = container.current;
		if (!active || !root || typeof IntersectionObserver === "undefined") {
			return;
		}
		const visible = new Set<number>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const index = Number((entry.target as HTMLElement).dataset.fileIndex);
					if (entry.isIntersecting) visible.add(index);
					else visible.delete(index);
				}
				// The first in the page's order (fileOrder), not the lowest index.
				const first = [
					...root.querySelectorAll<HTMLElement>("[data-file-index]"),
				]
					.map((el) => Number(el.dataset.fileIndex))
					.find((index) => visible.has(index));
				if (first !== undefined) setCurrent(first);
			},
			{
				// The top 40% of what is left under the sticky stack: a taller
				// header above the bar (the patch set graph at the top of the
				// page) never leaves the first file out of the band on load.
				rootMargin: `-${Math.round(top) + 1}px 0px -${Math.round(
					(window.innerHeight - top) * 0.6,
				)}px 0px`,
			},
		);
		for (const section of root.querySelectorAll("[data-file-index]")) {
			observer.observe(section);
		}
		return () => observer.disconnect();
	}, [container, sections, top, active]);
	return [current, setCurrent] as const;
}

/**
 * The PR's review threads for the diff: the furthest stage in (the summary
 * places them; later stages add the code suggestions are drawn against),
 * with the read they come from and the head being viewed, each where the
 * tracer placed it in the viewed snapshot (`to`; shownThreads), those
 * outside the comparison apart. After a Refresh the previous read's stay
 * until the new one's land (useThreads). Also when Files changed is the
 * first page. `failed`: no threads could be read.
 */
function useDiffThreads(
	viewedHead: string | undefined,
	to: RereviewTo | null,
	latest: number | null,
	/** Threads published from then on (ms) are left out (an earlier patch set). */
	until: number | null,
	/** The full diff (the base on the branch): the only view a drag places in. */
	fullDiff: boolean,
): {
	threads: DiffThreads | undefined;
	/** Every thread of the read, on this head or not (people's tints). */
	all: ReviewThread[] | undefined;
	failed: Error | null;
	/** Still on their way: nothing failed and none are in yet. */
	loading: boolean;
	/** The threads whose file is not in the comparison (the trailing group). */
	outside: ReturnType<typeof outsideThreads>;
	/**
	 * The placements couldn't be computed: the threads not shown where they
	 * were made (resolved ones too), listed so none goes missing; null
	 * otherwise.
	 */
	unplacedOnError: ReviewThread[] | null;
	/** What the cards and lists know of the placements (PlacementProvider). */
	placement: PlacementInfo;
} {
	const overview = useQuery(overviewQuery);
	const session = useQuery(sessionQuery);
	const { view, readId, error } = useThreads(overview.data?.readId);
	const snapshotHead = viewedHead ?? session.data?.snapshotHead;
	// A thread whose last comment was deleted here: its bubble goes at once.
	const { gone } = useThreadWrites();
	const asked = readId !== undefined && to !== null;
	// Only an answer, an error, or (after a failure) a retry under way
	// re-render the page: a "still pending" reply and the polls behind it
	// change nothing it shows (the spinners come from `asked` alone), and a
	// render of every file at those moments, under load, can hold the main
	// thread for a landing's whole highlight.
	const failedBefore = useRef(false);
	const placed = useQuery({
		...placementsQuery(readId ?? "", to ?? { patchset: 1 }),
		enabled: asked,
		select: (d) => ("pending" in d ? undefined : d),
		notifyOnChangeProps: () =>
			failedBefore.current
				? ["data", "error", "isFetching"]
				: ["data", "error"],
	});
	const answer = asked && placed.data ? placed.data : null;
	const placements = usePlacementMap(answer);
	const visible = useMemo(
		() =>
			view
				? gone.size > 0 || until !== null
					? view.threads.filter(
							(t) =>
								!gone.has(t.id) &&
								(until === null || Date.parse(t.createdAt) < until),
						)
					: view.threads
				: undefined,
		[view, gone, until],
	);
	const threads = useMemo(
		() =>
			readId && visible && snapshotHead
				? {
						readId,
						snapshotHead,
						threads: shownThreads(visible, snapshotHead, placements),
						placements,
					}
				: undefined,
		[readId, visible, snapshotHead, placements],
	);
	const outside = useMemo(
		() => (visible ? outsideThreads(visible, placements) : []),
		[visible, placements],
	);
	// A failure stays until an answer lands: a Retry (whose refetch clears
	// the query's error, then may poll a pending job) keeps the list, with a
	// spinner in its slot, rather than dropping it for a plain pending state.
	const placingKey = asked ? JSON.stringify([readId, to]) : "";
	const [lastFailure, setLastFailure] = useState<{
		key: string;
		error: Error;
	} | null>(null);
	useEffect(() => {
		if (placed.error) setLastFailure({ key: placingKey, error: placed.error });
		else if (answer !== null) setLastFailure(null);
	}, [placed.error, answer, placingKey]);
	const failedPlacing =
		asked && answer === null
			? (placed.error ??
				(lastFailure?.key === placingKey ? lastFailure.error : null))
			: null;
	failedBefore.current = failedPlacing !== null;
	const retryingPlacing =
		failedPlacing !== null && (placed.isFetching || placed.error === null);
	const unplacedOnError = useMemo(
		() =>
			failedPlacing && visible && snapshotHead
				? visible.filter(
						(t) =>
							t.unavailable !== "deleted" &&
							shownThread(t, snapshotHead, null) === null,
					)
				: null,
		[failedPlacing, visible, snapshotHead],
	);
	const { refetch: refetchPlacements } = placed;
	const patchsets = session.data?.patchsets;
	const placement = useMemo<PlacementInfo>(
		() => ({
			placements,
			pending: asked && answer === null && !placed.error,
			error: failedPlacing,
			retry: () => void refetchPlacements(),
			retrying: retryingPlacing,
			readId: readId ?? null,
			to,
			// A drag stores into the latest patch set only (earlier ones are
			// read-only; a head is no patch set yet), from the full diff only:
			// the since view's old-side numbers are the interdiff's, no file's.
			placeOn:
				fullDiff &&
				answer?.patchset !== null &&
				answer?.patchset !== undefined &&
				answer.patchset === latest
					? answer.patchset
					: null,
			openedOn: (t) => openedOn(t.createdAt, patchsets ?? []),
		}),
		[
			placements,
			asked,
			answer,
			placed.error,
			retryingPlacing,
			failedPlacing,
			refetchPlacements,
			readId,
			to,
			latest,
			patchsets,
			fullDiff,
		],
	);
	// No overview or session, no threads: that's their failure too. Only
	// with nothing kept: a refetch failing over a kept one (a Refresh)
	// leaves its threads loading.
	const failed = view
		? null
		: (error ??
			(overview.data ? null : overview.error) ??
			(session.data ? null : session.error) ??
			null);
	return {
		threads,
		all: view?.threads,
		failed,
		loading: !threads && !failed,
		outside,
		unplacedOnError,
		placement,
	};
}

/** A text box on the page has focus (a comment or a reply being written). */
function useWritingHere(): boolean {
	const [writing, setWriting] = useState(false);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const update = () =>
			setWriting(document.activeElement instanceof HTMLTextAreaElement);
		// Focus moving between two boxes: read where it lands.
		const left = () => {
			clearTimeout(timer);
			timer = setTimeout(update, 0);
		};
		document.addEventListener("focusin", update);
		document.addEventListener("focusout", left);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("focusin", update);
			document.removeEventListener("focusout", left);
		};
	}, []);
	return writing;
}

/**
 * The page's frame while the diff loads (principle 8): the progress bar's
 * row with a spinner, and file cards' headers, never "no files" or 0%.
 */
function FilesSkeleton() {
	return (
		<div data-testid="files-loading" aria-busy="true" className="space-y-3">
			<div className="flex min-h-10 items-center gap-3 border-b border-line py-2">
				<Spinner label="Loading the diff" />
				<SkeletonBar className="flex-1" />
			</div>
			{["w-1/2", "w-2/3", "w-2/5"].map((w) => (
				<div
					key={w}
					aria-hidden
					className="flex min-h-12 items-center rounded-lg border border-line bg-surface px-3"
				>
					<SkeletonBar className={w} />
				</div>
			))}
		</div>
	);
}

const headerOf = (index: number) =>
	document.querySelector<HTMLElement>(`#file-${index} > header`);

/** At most this long after a move-on, the file it opened takes marks again. */
const MOVE_ON_MAX_MS = 10_000;

/** The gap kept above the verdict a finished review scrolls to. */
const VERDICT_GAP = 12;

/**
 * What a move-on shows (`FilesPage`'s `finished`): the file it opened (or
 * the verdict) rises into place, quickly; none with reduced motion.
 * Resolves once it is in place.
 */
export const ARRIVE_MS = 200;
async function arrive(el: HTMLElement): Promise<void> {
	if (
		typeof el.animate !== "function" ||
		(typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches)
	) {
		return;
	}
	el.dataset.arriving = "";
	const animation = el.animate(
		[
			{ opacity: 0.3, transform: "translateY(2.5rem)" },
			{ opacity: 1, transform: "none" },
		],
		{ duration: ARRIVE_MS, easing: "ease-out" },
	);
	await animation.finished.catch(() => {});
	delete el.dataset.arriving;
}

/** How long "<path> isn't in this diff" stays. */
export const MISSING_HINT_MS = 8000;

/** The same target object while its value is the same (memos keyed on it hold). */
function useStableTo(to: RereviewTo | null): RereviewTo | null {
	const key = to ? JSON.stringify(to) : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: by value.
	return useMemo(() => to, [key]);
}

/**
 * An earlier patch set shows the threads published before the next one
 * started (ms); null: every thread.
 */
function threadsUntil(
	comparison: Comparison,
	session: SessionInfo | undefined,
): number | null {
	const { viewing } = comparison;
	if (viewing?.kind !== "patchset" || !session) return null;
	return (
		session.patchsets.find((p) => p.number > viewing.number)?.startedAt ?? null
	);
}

/** What the threads are placed into: the viewed patch set or head. */
function placementsTo(
	comparison: Comparison,
	session: SessionInfo | undefined,
): RereviewTo | null {
	const { viewing } = comparison;
	// A pinned head is the PR as of that commit: its own threads only.
	if (!viewing || !session || session.pinnedHead) return null;
	return viewing.kind === "patchset"
		? { patchset: viewing.number }
		: { head: viewing.oid };
}

/** The commit the comparison views: a patch set's head, or the head itself. */
function viewedHeadOf(
	comparison: Comparison,
	session: SessionInfo | undefined,
): string | undefined {
	const { viewing } = comparison;
	if (!viewing || !session) return undefined;
	if (viewing.kind === "head") return viewing.oid;
	return session.patchsets.find((p) => p.number === viewing.number)?.head;
}

export function FilesPage() {
	// The comparison (the graph's markers): which review to show.
	const session = useQuery(sessionQuery).data;
	const comparison = useComparison(session);
	// The reviewer's intended states over the server's (useSetStates).
	const { review, raw: servedRaw, pending } = useReviewView(comparison.target);
	// The engine's answer for the comparison: the since view's chips and
	// hunks, the provisional carries over a viewed head (under the
	// reviewer's pending states, shownView).
	const sinceView = useSince(comparison, session, servedRaw, pending);
	const data = sinceView.shown;
	const latest = session?.patchsets.at(-1)?.number ?? null;
	// An earlier patch set opens as reviewed: its marks are locked.
	const readOnlyOf =
		comparison.viewing?.kind === "patchset" &&
		latest !== null &&
		comparison.viewing.number < latest
			? comparison.viewing.number
			: null;
	const readOnly = readOnlyOf !== null;
	// The tree's "needs eyes" filter: fully carried files hidden (never clusters).
	const [eyesOnly, setEyesOnly] = useState(false);
	// Bumped on each opening of a file (a pick, a link, its header): the
	// tree reveals it.
	const [reveal, setReveal] = useState(0);
	// The file last opened, by snapshot and index: the tree marks it until
	// another one is opened.
	const [opened, setOpened] = useState<string | null>(null);
	// The page's one order, the tree's (fileOrder): the diff list follows
	// it, minus the fully carried files while "needs eyes" is on.
	const byFile = sinceView.byFile;
	const files = useMemo(() => {
		if (!data) return [];
		const ordered = treeOrder(data.files);
		if (!eyesOnly || !byFile) return ordered;
		return ordered.filter((f) => eyesOf(f, byFile.get(f.index)) !== "carried");
	}, [data, eyesOnly, byFile]);
	const { stale } = useSyncState();
	// False while another page shows (kept mounted, hidden): measuring and
	// tracking pause, root styles are given back, the sheet closes.
	const active = usePageActive();
	// `w` and `s` flip the diff's view settings while this page shows.
	useViewShortcuts();
	const diffs = useRef<HTMLDivElement>(null);
	const bar = useRef<HTMLDivElement>(null);
	// The sticky stack, top down: the app header's compact row, the progress
	// bar, then the open file's header.
	const appHeader = useAppHeaderHeight();
	const barHeight = useHeight(() => bar.current, data !== undefined, !active);
	const [current, setCurrent] = useCurrentFile(
		diffs,
		data ? `${data.revision}:${data.files.length}` : "",
		appHeader + barHeight,
		active,
	);

	// Back on this page: read the review again, so writes made elsewhere (another
	// tab or device) show. Unchanged data keeps its identity: nothing moves.
	const wasActive = useRef(active);
	const { refetch } = review;
	useEffect(() => {
		if (active && !wasActive.current) void refetch();
		wasActive.current = active;
	}, [active, refetch]);
	// A new snapshot arrived while hidden (Refresh on the overview): the saved
	// scroll belongs to another layout, so the page shows from the top.
	const forgetScroll = useForgetPageScroll();
	const revision = data?.revision;
	const lastRevision = useRef(revision);
	useEffect(() => {
		if (revision === lastRevision.current) return;
		if (lastRevision.current !== undefined && !active) forgetScroll();
		lastRevision.current = revision;
	}, [revision, active, forgetScroll]);

	const [unit, saveUnit] = useUnit();
	const wide = useMedia(WIDE);
	const [sheetOpen, setSheetOpen] = useState(false);

	// One file open at a time, by snapshot and index: a new snapshot starts
	// with every file closed.
	const [open, setOpen] = useState<string | null>(null);
	const keyOf = (index: number) => `${data?.revision}:${index}`;
	/** A file opened: the tree marks it and unfolds its folders. */
	const openInTree = (index: number) => {
		setOpened(keyOf(index));
		setReveal((n) => n + 1);
	};
	const openedIndex =
		data && opened?.startsWith(`${data.revision}:`)
			? Number(opened.slice(data.revision.length + 1))
			: null;
	const openIndex =
		data && open?.startsWith(`${data.revision}:`)
			? Number(open.slice(data.revision.length + 1))
			: null;
	const openHeader = useHeight(
		() => (openIndex === null ? null : headerOf(openIndex)),
		openIndex,
		!active,
	);
	// Keyboard focus scrolling keeps focused controls clear of the sticky
	// stack (WCAG 2.4.11): the page's scroll-padding-top adds this to the app
	// header's height (index.css).
	const pageSticky = barHeight + openHeader;
	useLayoutEffect(() => {
		if (!active) return;
		const root = document.documentElement;
		root.style.setProperty("--page-sticky", `${pageSticky}px`);
		return () => {
			root.style.removeProperty("--page-sticky");
		};
	}, [pageSticky, active]);
	// Switching the unit keeps the row being read where it is on screen,
	// whatever the counts' new widths do to the sticky bar or headers above it.
	const unitAnchor = useRef<ScrollAnchor | null>(null);
	const setUnit = (next: Unit) => {
		const root = diffs.current;
		unitAnchor.current =
			root && next !== unit
				? captureAnchor(root, appHeader + pageSticky)
				: null;
		saveUnit(next);
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs after each unit switch.
	useLayoutEffect(() => {
		const a = unitAnchor.current;
		unitAnchor.current = null;
		if (a && diffs.current) restoreAnchor(a, diffs.current);
	}, [unit]);
	// So does switching a view setting that lays the rows out again (side
	// by side, ignore whitespace, hidden characters): the anchor is taken as the setting
	// changes, before React re-renders, and the row found again by its
	// numbers once the new rows are in.
	const settingAnchor = useRef<ScrollAnchor | null>(null);
	useEffect(() => {
		const capture = () => {
			const root = diffs.current;
			settingAnchor.current = root
				? captureAnchor(root, appHeader + pageSticky)
				: null;
		};
		const unsubscribe = [
			sideBySide.subscribe(capture),
			ignoreWhitespace.subscribe(capture),
			showInvisibles.subscribe(capture),
		];
		return () => {
			for (const off of unsubscribe) off();
		};
	}, [appHeader, pageSticky]);
	const split = sideBySide.use();
	const ignoreWs = ignoreWhitespace.use();
	const invisibles = showInvisibles.use();
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs after each setting switch.
	useLayoutEffect(() => {
		const a = settingAnchor.current;
		settingAnchor.current = null;
		if (a && diffs.current) restoreAnchor(a, diffs.current);
	}, [split, ignoreWs, invisibles]);
	/** The file just opened by a move-on, ignoring marks until `until`. */
	const [movedOn, setMovedOn] = useState<{
		key: string;
		until: number;
	} | null>(null);
	/** The header to keep where it was on screen as files open and close. */
	const anchor = useRef<{ index: number; top: number } | null>(null);
	const sectionOf = (index: number) => document.getElementById(`file-${index}`);
	const toggleFile = (index: number, expanded: boolean, auto = false) => {
		// A file opened or closed here is no move-on's any more: its lines
		// arriving later are the reviewer's own open, not unseen.
		setMovedOn(null);
		// Where the reader sees the header, stuck or not.
		const header = headerOf(index);
		anchor.current = header
			? { index, top: header.getBoundingClientRect().top }
			: null;
		setOpen(expanded ? keyOf(index) : null);
		// Opening a file from its header opens it in the tree too; a failed
		// save reopening it (auto) isn't the reviewer opening it.
		if (expanded && !auto) openInTree(index);
	};
	// Closing the file above, or the one being read, would move the header
	// that was just used: scroll so it stays under the pointer.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs after each open/close.
	useLayoutEffect(() => {
		const a = anchor.current;
		anchor.current = null;
		if (!a) return;
		// Afterwards, measured where the header lies in the flow (the section's
		// top, inside its border): a header that just stuck reports where it's
		// stuck, not where it is.
		const section = sectionOf(a.index);
		if (!section) return;
		const natural = section.getBoundingClientRect().top + section.clientTop;
		const delta = natural - a.top;
		if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
	}, [open]);

	// Widening to the sidebar layout closes the sheet; narrowing doesn't reopen
	// it. Leaving the page (browser back) closes it too: a hidden modal would
	// leave the shown page inert.
	useLayoutEffect(() => {
		if (wide || !active) setSheetOpen(false);
	}, [wide, active]);

	/**
	 * Puts the file's header right below the app header and the sticky bar
	 * (its border under the bar's).
	 */
	const scrollTo = (index: number) => {
		const section = document.getElementById(`file-${index}`);
		if (!section) return;
		const top = section.getBoundingClientRect().top + window.scrollY;
		window.scrollTo({ top: top - appHeader - barHeight + 1 });
	};
	/**
	 * Opens the file alone and brings its header to the top, once the other
	 * files have closed; `focus`: its toggle takes the focus.
	 */
	const openAlone = (index: number, focus: boolean, shown?: () => void) => {
		setCurrent(index);
		openInTree(index);
		anchor.current = null;
		setOpen(keyOf(index));
		requestAnimationFrame(() => {
			if (focus) {
				headerOf(index)
					?.querySelector<HTMLElement>("button[aria-expanded]")
					?.focus({ preventScroll: true });
			}
			scrollTo(index);
			shown?.();
		});
	};
	/** A file picked in the tree: open it alone and bring its header to the top. */
	const select = (index: number) => {
		setMovedOn(null);
		const fromSheet = sheetOpen;
		if (fromSheet) setSheetOpen(false);
		// After a sheet (once it has handed focus back to its button), the
		// header takes the focus.
		openAlone(index, fromSheet);
	};
	/** The verdict a move-on brought into view ignores clicks until then. */
	const [verdictGuard, setVerdictGuard] = useState<number | undefined>();
	/**
	 * The reviewer's mark finished the open file: it closes and the next file
	 * with something unreviewed (in the page's order, wrapping) opens at the
	 * top, with the focus (the control used is gone), rising into place.
	 * With none left it closes and the verdict at the end rises into view.
	 */
	const finished = (index: number) => {
		const next = nextFile(files, index);
		if (!next) {
			// The verdict rises where the click landed: a double click's
			// second click must not send a verdict (Approve posts at once).
			const from = performance.now();
			setVerdictGuard(from + MOVE_ON_MAX_MS);
			const settle = () => {
				const until = Math.min(
					performance.now() + UNDO_ARM_MS,
					from + MOVE_ON_MAX_MS,
				);
				setVerdictGuard((g) => (g === from + MOVE_ON_MAX_MS ? until : g));
			};
			toggleFile(index, false);
			requestAnimationFrame(async () => {
				const verdict = document.getElementById("files-verdict");
				if (verdict) {
					const top = verdict.getBoundingClientRect().top + window.scrollY;
					window.scrollTo({ top: top - appHeader - barHeight - VERDICT_GAP });
					await arrive(verdict);
				}
				settle();
			});
			return;
		}
		// It opens where the click landed: a double click's second click must
		// not mark it unseen. Its marks wait until a moment after it is in
		// place, risen (a long file can take a while to close).
		const key = keyOf(next.index);
		setMovedOn({ key, until: performance.now() + MOVE_ON_MAX_MS });
		openAlone(next.index, true, async () => {
			const section = sectionOf(next.index);
			if (section) await arrive(section);
			const until = performance.now() + UNDO_ARM_MS;
			setMovedOn((m) => (m?.key === key ? { key, until } : m));
		});
	};

	// A thread's file:line link (landing.ts): open that file alone; its diff
	// scrolls to the line and highlights it, or says the line isn't there.
	// The params are dropped once read, so the same link works again.
	// Rendered among the review's kept pages, not in the files route's
	// outlet: its search as the address has it (strings, search.ts), read
	// as the route reads it.
	const raw = useSearch({ strict: false }) as Record<string, unknown>;
	const search: FilesSearch = parseFilesSearch(raw);
	const navigate = useNavigate();
	const id = useReviewId();
	const [landing, setLanding] = useState<Landing | null>(null);
	const landingSeq = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs per landing.
	useEffect(() => {
		if (!active || !data || !search.path) return;
		const file = landingFile(data.files, search);
		landingSeq.current += 1;
		setLanding({
			...search,
			index: file?.index ?? null,
			seq: landingSeq.current,
		});
		void navigate({
			to: "/r/$id/files",
			params: { id },
			// The comparison stays in the address; the landing goes.
			search: (prev: FilesSearch) => {
				const { ps, head, from } = prev;
				return { ps, head, from };
			},
			replace: true,
			resetScroll: false,
		});
		if (!file) return;
		setCurrent(file.index);
		openInTree(file.index);
		anchor.current = null;
		setOpen(keyOf(file.index));
	}, [active, data, search.path, search.line, search.side, search.moved]);

	// "Not in this diff" is about the link just followed: it goes after a
	// while, or when the page is left.
	useEffect(() => {
		if (landing?.index !== null || landing === null) return;
		if (!active) {
			setLanding(null);
			return;
		}
		const timer = window.setTimeout(() => setLanding(null), MISSING_HINT_MS);
		return () => window.clearTimeout(timer);
	}, [landing, active]);

	// What the threads (GitHub's and the agent's) are placed into.
	const placingTo = useStableTo(placementsTo(comparison, session));
	// On an earlier patch set: threads published before the next one started.
	const threadsCutoff = threadsUntil(comparison, session);
	// Comments are read in the background, the open file's threads first,
	// then the other files' in the page's order (one prefetch for the page).
	const {
		threads,
		all: allThreads,
		failed: threadsFailed,
		loading: threadsLoading,
		outside,
		unplacedOnError,
		placement: placementInfo,
	} = useDiffThreads(
		viewedHeadOf(comparison, session),
		placingTo,
		latest,
		threadsCutoff,
		comparison.base.kind === "branch",
	);
	// The first open's own reads are in (the files, their threads): only
	// then may the verdict card read GitHub's merge facts.
	const firstOpenSettled =
		data !== undefined && (allThreads !== undefined || threadsFailed !== null);
	// A Refresh shows the new head before its diff: drafts move only once
	// the diff shown is that head's.
	// The viewed head, whether or not GitHub's threads are in (Comment and
	// Ask agent wait on it, never on GitHub).
	const headSure = useHeadSure(
		viewedHeadOf(comparison, session) ?? session?.snapshotHead,
		data?.revision,
	);
	const queryClient = useQueryClient();
	const prefetch = useMemo(
		() =>
			data && threads
				? filesPrefetchOrder(
						files,
						threads.threads,
						openIndex === null
							? null
							: files.findIndex((f) => f.index === openIndex),
						(f) =>
							queryClient.getQueryData(
								hunksQuery(data.revision, f.index).queryKey,
							) ?? null,
					)
				: [],
		[data, files, threads, openIndex, queryClient],
	);
	usePrefetchComments(threads?.readId, prefetch);

	// Each file's threads on the head, built once per thread list.
	const threadsByPath = useMemo(() => {
		const byPath = new Map<string, ReviewThread[]>();
		for (const t of threads?.threads ?? []) {
			byPath.set(t.path, [...(byPath.get(t.path) ?? []), t]);
		}
		return byPath;
	}, [threads]);

	// The reviewer's agent threads (their own read, beside GitHub's): the
	// tree's second dot; the diffs read them from this query's cache.
	const agentOn = useAgentOn();
	const agentThreads = useQuery({
		...agentThreadsQuery,
		enabled: agentOn,
	}).data?.threads;
	// Where the tracer puts them in the viewed snapshot, as GitHub's are;
	// until it answers (or if it fails) each shows where it was asked.
	const agentIds = useMemo(
		() => (agentThreads ?? []).map((t) => t.id),
		[agentThreads],
	);
	const agentPlacingState = useAgentPlacementsFor({
		to: placingTo,
		revision: data?.revision,
		ids: agentIds,
		enabled: agentOn,
	});
	const agentPlacements = agentPlacingState.placements;
	const agentPending = agentPlacingState.pending;
	// Until they are in, one asked on another head waits (a spinner after
	// the files), never shown outdated first; a failure shows each where it
	// was asked, and says so.
	const agentPlacing = useMemo(
		() => ({
			placements: agentPlacements,
			until: threadsCutoff,
			pending: agentPending,
			failed: agentPlacingState.error !== null,
		}),
		[agentPlacements, threadsCutoff, agentPending, agentPlacingState.error],
	);
	const agentHead =
		threads?.snapshotHead ??
		viewedHeadOf(comparison, session) ??
		session?.snapshotHead ??
		"";
	const agentShown = useMemo(
		() => shownAgentPlaceables(agentThreads ?? [], agentHead, agentPlacing),
		[agentThreads, agentHead, agentPlacing],
	);
	// The threads that wait for their place: the spinners are for them,
	// and on a failure they are the unknown-fate rows.
	const agentWaitingList = useMemo(
		() =>
			agentPending || agentPlacingState.error
				? agentWaiting(agentThreads ?? [], agentHead, agentPlacing)
				: [],
		[
			agentPending,
			agentPlacingState.error,
			agentThreads,
			agentHead,
			agentPlacing,
		],
	);
	const agentWaitingCount = agentPending ? agentWaitingList.length : 0;
	// The tree's dot: each on the path it shows under now.
	const agentThreadsByPath = useMemo(() => {
		const byPath = new Map<string, AgentThread[]>();
		for (const p of agentShown) {
			byPath.set(p.path, [...(byPath.get(p.path) ?? []), p.thread]);
		}
		return byPath;
	}, [agentShown]);
	// Those no file of the diff shows: listed after the review threads'
	// "Not in this comparison" (never hidden).
	const agentOutsideShown = useMemo(
		() =>
			data
				? agentOutside(
						agentShown,
						new Set(data.files.map((f) => f.path)),
						agentPlacements,
					)
				: [],
		[agentShown, data, agentPlacements],
	);

	// The floating Files button makes way while a comment is being written
	// (a box has focus) or one was refused: it would cover its buttons.
	const writing = useWritingHere();
	const refused = useThreadWrites().refused.some(
		(f) => dropLosesText(f) && !f.retrying,
	);
	const filesButton = !writing && !refused;

	// Folded folders are kept per PR, once it's known.
	const pr = session?.pr;
	const tree = data && (
		<FileTree
			files={files}
			unit={unit}
			current={current}
			onSelect={select}
			threadsOf={(f) => threadsByPath.get(f.path) ?? NO_THREADS}
			agentThreadsOf={(f) => agentThreadsByPath.get(f.path) ?? NO_AGENT_THREADS}
			threadsLoading={threadsLoading}
			agentLoading={agentWaitingCount > 0}
			foldKey={pr ? foldsKey(pr) : null}
			revealSeq={reveal}
			opened={openedIndex}
			eyesOf={byFile ? (f) => eyesOf(f, byFile.get(f.index)) : undefined}
			filter={byFile ? { on: eyesOnly, onChange: setEyesOnly } : undefined}
		/>
	);
	// "5 to read": the comparison's unreviewed reworked and new clusters,
	// in the unit; a spinner while the engine computes; nothing in a plain
	// full diff (no comparison asked).
	const toRead = !sinceView.asked
		? undefined
		: byFile && data && sinceView.answer
			? sinceView.since !== null
				? toReadCount(byFile, data, unit)
				: toReadClusters(sinceView.answer, data, unit)
			: sinceView.error
				? undefined
				: null;
	const since = sinceView.since;
	/** The chips of a file: the engine's, or in a full diff its carried count alone. */
	const sinceInfoOf = (index: number, carried: number) => {
		const info = byFile?.get(index);
		if (info) return info;
		if (sinceView.asked || carried === 0) return undefined;
		return {
			kinds: new Map(),
			conflict: false,
			counts: {
				reworked: 0,
				new: 0,
				gone: 0,
				carried,
				reverted: 0,
				removed: 0,
				unticked: 0,
			},
			left: { units: 0, lines: 0 },
		};
	};
	// The since view counts its own units (pieces), the full diff the
	// snapshot's clusters; a spinner while the engine computes (never 0).
	const sinceAnswer = since !== null ? sinceView.answer : null;
	const units = useMemo(
		() => (sinceAnswer && data ? unitsOf(sinceAnswer, data) : []),
		[sinceAnswer, data],
	);
	const viewProgress = useMemo(
		() => (sinceAnswer ? sinceProgress(units) : (data?.progress ?? null)),
		[sinceAnswer, units, data],
	);
	// The since view never shows the full diff's numbers: its own empty
	// state, or its failure.
	const progressInstead =
		since === null
			? undefined
			: sinceAnswer && units.length === 0
				? ("empty" as const)
				: sinceView.error
					? ("failed" as const)
					: undefined;
	// Each file's header meter in the since view: its own units.
	const unitsByFile = useMemo(() => {
		const out = new Map<number, typeof units>();
		for (const u of units) out.set(u.index, [...(out.get(u.index) ?? []), u]);
		return out;
	}, [units]);
	const progressPending = since !== null && sinceView.pending;
	// The connector of the comparison on screen counts what is left here.
	const live =
		since !== null && byFile && comparison.viewing
			? { from: since, to: comparison.viewing, toRead: liveToRead(byFile) }
			: undefined;
	const gone =
		since !== null && sinceView.answer && data
			? goneFiles(sinceView.answer, data)
			: [];
	const emptySince =
		since !== null &&
		sinceView.answer &&
		byFile &&
		data &&
		nothingSince(sinceView.answer, byFile)
			? `Nothing to read since PS${since} · ${carriedCount(data)} carried`
			: null;

	const notInComparison = (
		<>
			{threads && (
				<NotInComparison
					threads={outside}
					readId={threads.readId}
					pending={placementInfo.pending}
					failed={
						unplacedOnError && {
							threads: unplacedOnError,
							error: placementInfo.error,
							retry: placementInfo.retry,
							retrying: placementInfo.retrying,
						}
					}
				/>
			)}
			<AgentNotInComparison
				threads={agentOutsideShown}
				snapshotHead={agentHead}
				placements={agentPlacements}
				pending={agentPending}
				waiting={agentWaitingCount}
				failed={
					agentPlacingState.error && {
						error: agentPlacingState.error,
						retry: agentPlacingState.retry,
						retrying: agentPlacingState.retrying,
						threads: agentWaitingList,
					}
				}
			/>
		</>
	);

	return (
		<PeopleProvider threads={allThreads}>
			<PlacementProvider value={placementInfo}>
				<AgentPlacingProvider value={agentPlacing}>
					<section
						aria-label="Files changed"
						style={{ "--files-bar": `${barHeight}px` } as CSSProperties}
					>
						<h2 className="sr-only">Files changed</h2>
						{/* The graph needs the session alone: it never waits for the diff. */}
						{session && (
							<PatchsetGraph
								session={session}
								comparison={comparison}
								live={live}
							/>
						)}
						{review.isPending && <FilesSkeleton />}
						{review.isError && <ErrorMessage error={review.error} />}
						{data && (
							<>
								<ProgressBar
									ref={bar}
									progress={viewProgress ?? data.progress}
									pending={progressPending}
									instead={progressInstead}
									unit={unit}
									onUnitChange={setUnit}
									toRead={toRead}
									note={
										readOnlyOf !== null && (
											<p
												data-testid="read-only-note"
												className="mt-1 flex min-h-8 flex-wrap items-center gap-2 text-xs"
											>
												<Tooltip content="An earlier patch set, exactly as you reviewed it: marks are locked, replies still send">
													{(trigger) => (
														<span
															{...trigger}
															// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
															tabIndex={0}
															className="inline-flex h-5 items-center rounded-full border border-faint px-2 text-[11px] whitespace-nowrap text-faint focus-visible:outline-2 focus-visible:outline-accent"
														>
															PS{readOnlyOf} · as reviewed · read-only
														</span>
													)}
												</Tooltip>
												<button
													type="button"
													onClick={() =>
														latest !== null &&
														comparison.setViewing({
															kind: "patchset",
															number: latest,
														})
													}
													className="inline-flex min-h-8 items-center rounded-md px-2 font-medium text-link underline hover:bg-overlay focus-visible:outline-2 focus-visible:outline-accent"
												>
													Back to PS{latest}
												</button>
											</p>
										)
									}
								>
									{/* Every count and bubble waits on them (principle 8). Its
							    place is kept, so the bar moves nothing when it goes. */}
									<span className="flex h-4 w-4 shrink-0 items-center">
										{threadsLoading && <Spinner label="Loading comments" />}
									</span>
								</ProgressBar>
								{stale && (
									<p
										role="status"
										className="mt-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-ink"
									>
										{STALE_MESSAGE}
										{stale.dropped > 0 && " Unsaved changes dropped."}
									</p>
								)}
								{threadsFailed && (
									// Not "no threads": they couldn't be read (flag uncertainty).
									<p
										data-testid="threads-failed"
										className="mt-3 flex min-h-10 items-center gap-2 rounded-md border border-warn/30 bg-warn/10 px-3 text-sm text-ink"
									>
										<LabeledIcon
											icon={AlertIcon}
											label={`Review threads couldn't be read: ${threadsFailed.message}`}
											className="text-warn"
										/>
										Threads not shown
									</p>
								)}
								{landing && landing.index === null && (
									<p
										role="status"
										data-testid="landing-hint"
										className="mt-3 flex items-center gap-2 rounded-md border border-line bg-band px-3 py-2 text-sm text-muted"
									>
										<InfoIcon aria-hidden className="shrink-0 text-accent" />
										<span className="min-w-0 break-all">
											<code className="font-mono text-ink-soft">
												{landing.path}
											</code>{" "}
											isn't in this diff
										</span>
									</p>
								)}
								{sinceView.error && (
									<p
										data-testid="since-failed"
										className="mt-3 flex min-h-10 items-center gap-2 rounded-md border border-bad/30 bg-bad/10 px-3 text-sm text-ink"
									>
										<LabeledIcon
											icon={AlertIcon}
											label={`What changed couldn't be computed: ${sinceView.error.message}`}
											className="text-bad"
										/>
										Changes since PS{sinceView.from} not computed
									</p>
								)}
								{emptySince && (
									<p
										data-testid="since-empty-all"
										className="mt-3 flex min-h-10 items-center gap-2 rounded-md border border-ok/30 bg-ok/10 px-3 text-sm text-ink"
									>
										{emptySince}
									</p>
								)}
								{data.files.length === 0 && gone.length === 0 ? (
									<>
										<p className="mt-4 text-muted">This PR changes no files.</p>
										{notInComparison}
										<FilesVerdict
											threads={allThreads}
											settled={firstOpenSettled}
											ignoreClicksUntil={verdictGuard}
										/>
									</>
								) : (
									<div className="mt-4 flex">
										{/* The handle's 1rem is the gap to the diffs. */}
										{wide && <TreeColumn tree={tree} />}
										<div
											ref={diffs}
											// Room for the floating Files button, and for the save notices
											// (--sync-notices, SyncNotices): the last header can always
											// scroll clear of them; and on touch for the selection bar
											// under a selection in the last line (--selection-room).
											style={{
												paddingBottom: `max(${wide ? "0px" : "5rem"}, var(--sync-notices, 0px), var(--selection-room, 0px))`,
											}}
											className="min-w-0 flex-1 space-y-3"
										>
											{files.map((file) => (
												<FileDiff
													// A new snapshot can reuse an index for another file.
													key={`${data.revision}:${file.index}`}
													file={file}
													revision={data.revision}
													unit={unit}
													expanded={open === keyOf(file.index)}
													onExpandedChange={(expanded, auto) =>
														toggleFile(file.index, expanded, auto)
													}
													onFinished={() => finished(file.index)}
													ignoreMarksUntil={
														movedOn?.key === keyOf(file.index)
															? movedOn.until
															: undefined
													}
													otherOpen={
														openIndex !== null && openIndex !== file.index
													}
													landing={
														landing?.index === file.index ? landing : undefined
													}
													threads={threads}
													threadsLoading={threadsLoading}
													headSure={headSure}
													since={since ?? undefined}
													sinceInfo={sinceInfoOf(
														file.index,
														file.clusters.filter((c) => c.carried).length,
													)}
													sincePending={sinceView.pending}
													sinceMarks={data.sinceMarks}
													counted={
														// The since view counts its units: none here is
														// nothing to read, never the snapshot's numbers.
														sinceAnswer
															? unitsFile(
																	file,
																	unitsByFile.get(file.index) ?? [],
																)
															: undefined
													}
													readOnly={readOnly}
												/>
											))}
											{/* Files only the compared patch set had something reviewed in: their gone clusters. */}
											{gone.map((file) => (
												<GoneFile
													key={`${data.revision}:gone:${file.index}`}
													index={file.index}
													path={file.path}
													revision={data.revision}
													since={since as number}
													info={byFile?.get(file.index)}
													sinceMarks={data.sinceMarks}
													readOnly={readOnly}
												/>
											))}
											{/* Threads whose file isn't in this comparison at all. */}
											{notInComparison}
											{/* After the last file: the verdict (the padding above keeps it clear of the Files button). */}
											<FilesVerdict
												threads={allThreads}
												settled={firstOpenSettled}
												ignoreClicksUntil={verdictGuard}
											/>
										</div>
									</div>
								)}
								<SelectionBar
									files={data.files}
									commit={agentHead}
									headSure={headSure}
									readOnly={readOnly}
								/>
								{!wide && (data.files.length > 0 || gone.length > 0) && (
									<>
										<button
											hidden={!filesButton}
											type="button"
											aria-label="Files"
											aria-haspopup="dialog"
											onClick={() => setSheetOpen(true)}
											className="fixed right-4 bottom-4 z-30 flex h-12 items-center gap-2 cta rounded-full px-5 text-sm font-semibold text-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
										>
											<span aria-hidden>☰</span>
											Files
										</button>
										<FilesSheet
											open={sheetOpen}
											onClose={() => setSheetOpen(false)}
										>
											{tree}
										</FilesSheet>
									</>
								)}
							</>
						)}
					</section>
				</AgentPlacingProvider>
			</PlacementProvider>
		</PeopleProvider>
	);
}
