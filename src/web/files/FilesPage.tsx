import { AlertIcon, InfoIcon } from "@primer/octicons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import type { AgentThread } from "../../shared/agent";
import type { ReviewThread } from "../../shared/types";
import { agentThreadsQuery, useAgentOn } from "../agent/api";
import { hunksQuery, overviewQuery, sessionQuery } from "../api";
import { LabeledIcon } from "../overview/parts";
import { useForgetPageScroll, usePageActive } from "../pageActive";
import { useReviewId } from "../reviewId";
import { SkeletonBar, Spinner } from "../Spinner";
import { useShortcut } from "../shortcuts";
import { FindSlot, useAppHeaderHeight, useHeight, visualTop } from "../sticky";
import { PeopleProvider } from "../threads/people";
import { dropLosesText, useThreadWrites } from "../threads/threadWrites";
import { usePrefetchComments } from "../threads/useThreadComments";
import { useThreads } from "../threads/useThreads";
import { ErrorMessage } from "../ui";
import { useMedia, WIDE } from "../useMedia";
import { FilesVerdict } from "../verdict/FilesVerdict";
import { ignoreWhitespace, showInvisibles, sideBySide } from "../viewSettings";
import type { DiffThreads } from "./DiffBody";
import { FileDiff, UNDO_ARM_MS } from "./FileDiff";
import { FileTree } from "./FileTree";
import { nextFile } from "./fileFinish";
import { treeOrder } from "./fileOrder";
import { filesPrefetchOrder } from "./filesPrefetch";
import { FindBar } from "./find/FindBar";
import { findState, useFindFloatShown } from "./find/findState";
import { hitSeen } from "./find/hitSeen";
import { useFind } from "./find/useFind";
import { foldsKey } from "./folderFold";
import { useHeadSure } from "./headSure";
import {
	type FilesSearch,
	type Landing,
	landingFile,
	parseFilesSearch,
} from "./landing";
import { ProgressBar } from "./ProgressBar";
import { SelectionBar } from "./SelectionBar";
import {
	captureAnchor,
	restoreAnchor,
	type ScrollAnchor,
} from "./scrollAnchor";
import { TreeColumn } from "./TreeResizer";
import { threadsOnHead } from "./threadPlacement";

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
 * below the sticky app header and progress bar (`top` px tall together),
 * lower by the visual viewport's pan (visualTop).
 * Not while the page is hidden (`active` false): nothing is in view then,
 * and the file in view when it shows again is the one it was left on.
 * A new `top` alone (the sticky stack growing or shrinking: the find bar
 * opening or closing, a bar wrapping) holds the file in view until the page
 * next scrolls, which picks it afresh.
 */
export function useCurrentFile(
	container: RefObject<HTMLElement | null>,
	sections: string,
	top: number,
	active: boolean,
) {
	const [current, setCurrent] = useState<number | null>(null);
	// The visual viewport's pan (iOS's keyboard): the stack sits that lower.
	const pan = visualTop.use();
	const band = top + pan;
	// What the observer was last made for: a new one made for a new `top`
	// only takes its first report as the files in the band, not as a move.
	const last = useRef({ sections, top, pan, active });
	// `sections` changes when the rendered file sections do: observe the new ones.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above.
	useEffect(() => {
		const was = last.current;
		last.current = { sections, top, pan, active };
		const root = container.current;
		if (!active || !root || typeof IntersectionObserver === "undefined") {
			return;
		}
		// Only the stack's height changed: a layout change, not a move.
		let settle =
			was.active &&
			was.sections === sections &&
			was.pan === pan &&
			was.top !== top;
		const visible = new Set<number>();
		// The first in the page's order (fileOrder), not the lowest index.
		const firstVisible = () =>
			[...root.querySelectorAll<HTMLElement>("[data-file-index]")]
				.map((el) => Number(el.dataset.fileIndex))
				.find((index) => visible.has(index));
		// Held since the settling report, at this scroll: the next scroll
		// (another scrollY) picks the file afresh, crossing or not.
		let heldAt: number | null = null;
		const onScroll = () => {
			if (heldAt === null || window.scrollY === heldAt) return;
			heldAt = null;
			const first = firstVisible();
			if (first !== undefined) setCurrent(first);
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const index = Number((entry.target as HTMLElement).dataset.fileIndex);
					if (entry.isIntersecting) visible.add(index);
					else visible.delete(index);
				}
				const first = firstVisible();
				// The first report (every file, as observing starts) after a
				// layout change keeps the file in view; later ones follow moves.
				const settling = settle;
				settle = false;
				heldAt = settling ? window.scrollY : null;
				if (first === undefined) return;
				if (settling) setCurrent((now) => now ?? first);
				else setCurrent(first);
			},
			{ rootMargin: `-${Math.round(band) + 1}px 0px -60% 0px` },
		);
		for (const section of root.querySelectorAll("[data-file-index]")) {
			observer.observe(section);
		}
		return () => {
			observer.disconnect();
			window.removeEventListener("scroll", onScroll);
		};
	}, [container, sections, band, active]);
	return [current, setCurrent] as const;
}

/**
 * The PR's review threads for the diff: the furthest stage in (the summary
 * places them; later stages add the code suggestions are drawn against),
 * with the read they come from and the head being viewed. After a Refresh
 * the previous read's stay until the new one's land (useThreads). Also when
 * Files changed is the first page. `failed`: no threads could be read.
 */
function useDiffThreads(): {
	threads: DiffThreads | undefined;
	/** Every thread of the read, on this head or not (people's tints). */
	all: ReviewThread[] | undefined;
	failed: Error | null;
	/** Still on their way: nothing failed and none are in yet. */
	loading: boolean;
} {
	const overview = useQuery(overviewQuery);
	const session = useQuery(sessionQuery);
	const { view, readId, error } = useThreads(overview.data?.readId);
	const snapshotHead = session.data?.snapshotHead;
	// A thread whose last comment was deleted here: its bubble goes at once.
	const { gone } = useThreadWrites();
	const threads = useMemo(
		() =>
			readId && view && snapshotHead
				? {
						readId,
						snapshotHead,
						threads: threadsOnHead(
							gone.size > 0
								? view.threads.filter((t) => !gone.has(t.id))
								: view.threads,
							snapshotHead,
						),
					}
				: undefined,
		[readId, view, snapshotHead, gone],
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

export function FilesPage() {
	// The reviewer's intended states over the server's (useSetStates).
	const { review, data } = useReviewView();
	// Bumped on each opening of a file (a pick, a link, its header): the
	// tree reveals it.
	const [reveal, setReveal] = useState(0);
	// The file last opened, by snapshot and index: the tree marks it until
	// another one is opened.
	const [opened, setOpened] = useState<string | null>(null);
	// The page's one order, the tree's (fileOrder): the diff list follows it.
	const files = useMemo(() => (data ? treeOrder(data.files) : []), [data]);
	const { stale } = useSyncState();
	// False while another page shows (kept mounted, hidden): measuring and
	// tracking pause, root styles are given back, the sheet closes.
	const active = usePageActive();
	// `w` and `s` flip the diff's view settings while this page shows.
	useViewShortcuts();
	const diffs = useRef<HTMLDivElement>(null);
	const bar = useRef<HTMLDivElement>(null);
	// The sticky stack, top down: the open find bar and the app header's
	// compact row (App: AppHeaderHeight, a phone's header out of the layout
	// while the bar shows), the progress bar, then the open file's header.
	// Plus the visual viewport's pan (iOS's keyboard, the bar open): the
	// stack sits that much lower on the page's top, as `--app-header` does
	// (useCurrentFile adds it itself).
	const stackTop = useAppHeaderHeight();
	const appHeader = stackTop + visualTop.use();
	const barHeight = useHeight(() => bar.current, data !== undefined, !active);
	const [current, setCurrent] = useCurrentFile(
		diffs,
		data ? `${data.revision}:${data.files.length}` : "",
		stackTop + barHeight,
		active,
	);

	// Back on this page: read the review again, so writes made elsewhere (another
	// tab or device) show. Unchanged data keeps its identity: nothing moves.
	const wasActive = useRef(active);
	const { refetch } = review;
	// Find in PR's stale answer: the revision read again (a failed read throws).
	const refetchReview = useCallback(async () => {
		const read = await refetch();
		if (read.isError) throw read.error;
		return read.data?.revision;
	}, [refetch]);
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
	 * Opens the file alone, as a pick does, without scrolling: the tree marks
	 * and reveals it (a find's step scrolls to its hit itself).
	 */
	const openOnly = (index: number) => {
		setCurrent(index);
		openInTree(index);
		anchor.current = null;
		setOpen(keyOf(index));
	};
	/**
	 * Opens the file alone and brings its header to the top, once the other
	 * files have closed; `focus`: its toggle takes the focus.
	 */
	const openAlone = (index: number, focus: boolean, shown?: () => void) => {
		openOnly(index);
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
			search: {},
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

	// Find in PR: the bar, its search, and stepping through the hits. Typing
	// only marks and counts; a step opens a closed file and scrolls.
	const find = useFind({
		revision: data?.revision,
		files,
		openIndex,
		active,
		onStale: refetchReview,
	});
	// The first step after typing passes over a hit the reviewer already
	// sees (painted current where they look, in the open file): on to the
	// next. One in a closed file is gone to: its step opens the file.
	const stepFind = (dir: 1 | -1) => {
		const hit = find.step(
			dir,
			(h) => h.index === openIndex && hitSeen(h, appHeader + barHeight),
		);
		if (!hit) return;
		const isOpen = openIndex === hit.index;
		if (hit.side === "path" || hit.side === "oldPath") {
			if (isOpen) scrollTo(hit.index);
			else select(hit.index);
			return;
		}
		if (!isOpen) {
			// As a pick: no move-on's file any more, the phone's sheet closes.
			setMovedOn(null);
			openOnly(hit.index);
			if (sheetOpen) setSheetOpen(false);
		}
		find.stepInto(hit.index);
	};
	// On a phone the header is hidden while the bar is open: it shows
	// again in this commit, so its button can take focus.
	const closeFind = () => {
		flushSync(() => findState.close());
		document.querySelector<HTMLElement>("[data-find-button]")?.focus();
	};
	useShortcut({
		keys: "Mod+f",
		label: "Find in PR",
		group: "Files changed",
		run: () => findState.open(),
	});
	useShortcut({
		keys: "Mod+g",
		label: "Next match",
		group: "Files changed",
		when: () => findState.get().open,
		run: () => stepFind(1),
	});
	useShortcut({
		keys: "Shift+Mod+g",
		label: "Previous match",
		group: "Files changed",
		when: () => findState.get().open,
		run: () => stepFind(-1),
	});
	// The box takes focus for an open request made while the page shows, or
	// once it shows (the header's button opens the bar before navigating
	// here). Showing the page again with the bar open doesn't take focus.
	const [focusSeq, setFocusSeq] = useState(0);
	if (active && find.state.focusSeq !== focusSeq)
		setFocusSeq(find.state.focusSeq);
	const findMarks = find.state.open && find.state.term !== "";

	// Comments are read in the background, the open file's threads first,
	// then the other files' in the page's order (one prefetch for the page).
	const {
		threads,
		all: allThreads,
		failed: threadsFailed,
		loading: threadsLoading,
	} = useDiffThreads();
	// The first open's own reads are in (the files, their threads): only
	// then may the verdict card read GitHub's merge facts.
	const firstOpenSettled =
		data !== undefined && (allThreads !== undefined || threadsFailed !== null);
	// A Refresh shows the new head before its diff: drafts move only once
	// the diff shown is that head's.
	const headSure = useHeadSure(threads?.snapshotHead, data?.revision);
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
	const agentThreads = useQuery({
		...agentThreadsQuery,
		enabled: useAgentOn(),
	}).data?.threads;
	const agentThreadsByPath = useMemo(() => {
		const byPath = new Map<string, AgentThread[]>();
		// On any head: one asked on an earlier head shows in its file's lead.
		for (const t of agentThreads ?? []) {
			byPath.set(t.anchor.path, [...(byPath.get(t.anchor.path) ?? []), t]);
		}
		return byPath;
	}, [agentThreads]);

	// The floating Files button makes way while a comment is being written
	// (a box has focus) or one was refused: it would cover its buttons.
	const writing = useWritingHere();
	const refused = useThreadWrites().refused.some(
		(f) => dropLosesText(f) && !f.retrying,
	);
	const filesButton = !writing && !refused;

	// Folded folders are kept per PR, once it's known.
	const pr = useQuery(sessionQuery).data?.pr;
	const tree = data && (
		<FileTree
			files={files}
			unit={unit}
			current={current}
			onSelect={select}
			threadsOf={(f) => threadsByPath.get(f.path) ?? NO_THREADS}
			agentThreadsOf={(f) => agentThreadsByPath.get(f.path) ?? NO_AGENT_THREADS}
			threadsLoading={threadsLoading}
			foldKey={pr ? foldsKey(pr) : null}
			revealSeq={reveal}
			opened={openedIndex}
			find={findMarks ? find.tree : undefined}
		/>
	);

	return (
		<PeopleProvider threads={allThreads}>
			<section
				aria-label="Files changed"
				style={
					{
						"--files-bar": `${barHeight}px`,
					} as CSSProperties
				}
			>
				<h2 className="sr-only">Files changed</h2>
				{review.isPending && <FilesSkeleton />}
				{review.isError && <ErrorMessage error={review.error} />}
				{data && (
					<>
						{/* Only while this page shows: kept but hidden, it must not
						    put the bar in App's slot over another page. */}
						{find.state.open && active && (
							// At the very top of the page, above the app header (App's
							// FindSlot), pushing it down by its own height; sticks there
							// (typing and stepping never move it), the stack under it.
							// A phone's takes the header's place.
							<FindFloat>
								<FindBar
									term={find.state.term}
									onTerm={findState.setTerm}
									count={find.count}
									searching={find.searching}
									failed={find.failed}
									onRetry={find.retry}
									onNext={() => stepFind(1)}
									onPrevious={() => stepFind(-1)}
									onClose={closeFind}
									focusSeq={focusSeq}
									matchCase={find.matchCase}
									onMatchCase={find.setMatchCase}
								/>
							</FindFloat>
						)}
						<ProgressBar
							ref={bar}
							progress={data.progress}
							unit={unit}
							onUnitChange={setUnit}
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
						{data.files.length === 0 ? (
							<>
								<p className="mt-4 text-muted">This PR changes no files.</p>
								<FilesVerdict threads={allThreads} settled={firstOpenSettled} />
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
											otherOpen={openIndex !== null && openIndex !== file.index}
											landing={
												landing?.index === file.index ? landing : undefined
											}
											threads={threads}
											threadsLoading={threadsLoading}
											headSure={headSure}
											pathFind={find.pathOf(file.index)}
											find={find.diffOf(file.index)}
										/>
									))}
									{/* After the last file: the verdict (the padding above keeps it clear of the Files button). */}
									<FilesVerdict
										threads={allThreads}
										settled={firstOpenSettled}
										ignoreClicksUntil={verdictGuard}
									/>
								</div>
							</div>
						)}
						<SelectionBar files={data.files} />
						{!wide && data.files.length > 0 && (
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
		</PeopleProvider>
	);
}

/**
 * The find bar's frame (`data-find-float`): a strip across the top of the
 * page, in App's slot (FindSlot; in place without one), the controls at its
 * right on a wide screen. While it is mounted, a phone's app header leaves
 * the layout for it (findFloat).
 */
function FindFloat({ children }: { children: ReactNode }) {
	useFindFloatShown();
	const slot = useContext(FindSlot);
	const strip = (
		<div
			data-find-float
			className="border-b border-line bg-surface shadow-header"
		>
			<div className="mx-auto flex max-w-screen-2xl justify-end sm:px-6">
				<div className="w-full sm:w-[28rem] sm:max-w-full">{children}</div>
			</div>
		</div>
	);
	return slot ? createPortal(strip, slot) : strip;
}
