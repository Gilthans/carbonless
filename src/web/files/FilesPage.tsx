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
import type { ReviewThread } from "../../shared/types";
import { hunksQuery, overviewQuery, sessionQuery } from "../api";
import { LabeledIcon } from "../overview/parts";
import { useForgetPageScroll, usePageActive } from "../pageActive";
import { useAppHeaderHeight, useHeight } from "../sticky";
import { PeopleProvider } from "../threads/people";
import { useThreadWrites } from "../threads/threadWrites";
import { usePrefetchComments } from "../threads/useThreadComments";
import { useThreads } from "../threads/useThreads";
import { ErrorMessage } from "../ui";
import { useMedia, WIDE } from "../useMedia";
import { ignoreWhitespace, sideBySide } from "../viewSettings";
import type { DiffThreads } from "./DiffBody";
import { FileDiff } from "./FileDiff";
import { FileTree } from "./FileTree";
import { filesPrefetchOrder } from "./filesPrefetch";
import { useHeadSure } from "./headSure";
import { type FilesSearch, type Landing, landingFile } from "./landing";
import { ProgressBar } from "./ProgressBar";
import { SelectionBar } from "./SelectionBar";
import {
	captureAnchor,
	restoreAnchor,
	type ScrollAnchor,
} from "./scrollAnchor";
import { threadsOnHead } from "./threadPlacement";

const NO_THREADS: ReviewThread[] = [];

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
				<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
					{props.children}
				</div>
			</div>
		</dialog>
	);
}

/**
 * Tracks the file in view: the first file section crossing the band just
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
				if (visible.size > 0) setCurrent(Math.min(...visible));
			},
			{ rootMargin: `-${Math.round(top) + 1}px 0px -60% 0px` },
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
 * with the read they come from and the head being viewed. After a Refresh
 * the previous read's stay until the new one's land (useThreads). Also when
 * Files changed is the first page. `failed`: no threads could be read.
 */
function useDiffThreads(): {
	threads: DiffThreads | undefined;
	/** Every thread of the read, on this head or not (people's tints). */
	all: ReviewThread[] | undefined;
	failed: Error | null;
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
	return { threads, all: view?.threads, failed: view ? null : error };
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

const headerOf = (index: number) =>
	document.querySelector<HTMLElement>(`#file-${index} > header`);

/** How long "<path> isn't in this diff" stays. */
export const MISSING_HINT_MS = 8000;

export function FilesPage() {
	// The reviewer's intended states over the server's (useSetStates).
	const { review, data } = useReviewView();
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
	// by side, ignore whitespace): the anchor is taken as the setting
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
		];
		return () => {
			for (const off of unsubscribe) off();
		};
	}, [appHeader, pageSticky]);
	const split = sideBySide.use();
	const ignoreWs = ignoreWhitespace.use();
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs after each setting switch.
	useLayoutEffect(() => {
		const a = settingAnchor.current;
		settingAnchor.current = null;
		if (a && diffs.current) restoreAnchor(a, diffs.current);
	}, [split, ignoreWs]);
	/** The header to keep where it was on screen as files open and close. */
	const anchor = useRef<{ index: number; top: number } | null>(null);
	const sectionOf = (index: number) => document.getElementById(`file-${index}`);
	const toggleFile = (index: number, expanded: boolean) => {
		// Where the reader sees the header, stuck or not.
		const header = headerOf(index);
		anchor.current = header
			? { index, top: header.getBoundingClientRect().top }
			: null;
		setOpen(expanded ? keyOf(index) : null);
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
	/** A file picked in the tree: open it alone and bring its header to the top. */
	const select = (index: number) => {
		setCurrent(index);
		anchor.current = null;
		setOpen(keyOf(index));
		const fromSheet = sheetOpen;
		if (fromSheet) setSheetOpen(false);
		// Once the other files have closed (and the sheet has handed focus
		// back to its button), scroll there, focusing the header after a sheet.
		requestAnimationFrame(() => {
			if (fromSheet) {
				headerOf(index)
					?.querySelector("button")
					?.focus({ preventScroll: true });
			}
			scrollTo(index);
		});
	};

	// A thread's file:line link (landing.ts): open that file alone; its diff
	// scrolls to the line and highlights it, or says the line isn't there.
	// The params are dropped once read, so the same link works again.
	const search = useSearch({ strict: false }) as FilesSearch;
	const navigate = useNavigate();
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
			to: "/files",
			search: {},
			replace: true,
			resetScroll: false,
		});
		if (!file) return;
		setCurrent(file.index);
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

	// Comments are read in the background, the open file's threads first,
	// then the other files' in file order (one prefetch for the page).
	const { threads, all: allThreads, failed: threadsFailed } = useDiffThreads();
	// A Refresh shows the new head before its diff: drafts move only once
	// the diff shown is that head's.
	const headSure = useHeadSure(threads?.snapshotHead, data?.revision);
	const queryClient = useQueryClient();
	const prefetch = useMemo(
		() =>
			data && threads
				? filesPrefetchOrder(
						data.files,
						threads.threads,
						openIndex === null
							? null
							: data.files.findIndex((f) => f.index === openIndex),
						(f) =>
							queryClient.getQueryData(
								hunksQuery(data.revision, f.index).queryKey,
							) ?? null,
					)
				: [],
		[data, threads, openIndex, queryClient],
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

	// The floating Files button makes way while a comment is being written
	// (a box has focus) or one was refused: it would cover its buttons.
	const writing = useWritingHere();
	const refused = [...useThreadWrites().threads.values()].some(
		(t) =>
			t.failed?.action === "New comment" ||
			t.failed?.action === "Reply" ||
			t.failed?.action === "Edit",
	);
	const filesButton = !writing && !refused;

	const tree = data && (
		<FileTree
			files={data.files}
			unit={unit}
			current={current}
			onSelect={select}
			threadsOf={(f) => threadsByPath.get(f.path) ?? NO_THREADS}
		/>
	);

	return (
		<PeopleProvider threads={allThreads}>
			<section
				aria-label="Files changed"
				style={{ "--files-bar": `${barHeight}px` } as CSSProperties}
			>
				<h2 className="sr-only">Files changed</h2>
				{review.isPending && <p className="text-muted">Loading the diff…</p>}
				{review.isError && <ErrorMessage error={review.error} />}
				{data && (
					<>
						<ProgressBar
							ref={bar}
							progress={data.progress}
							unit={unit}
							onUnitChange={setUnit}
						/>
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
							<p className="mt-4 text-muted">This PR changes no files.</p>
						) : (
							<div className="mt-4 flex gap-4">
								{wide && (
									<aside className="sticky top-[calc(var(--app-header,0px)+var(--files-bar,0px)+1rem)] max-h-[calc(100dvh-var(--app-header,0px)-var(--files-bar,0px)-2rem)] w-72 shrink-0 self-start overflow-y-auto">
										{tree}
									</aside>
								)}
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
									{data.files.map((file) => (
										<FileDiff
											// A new snapshot can reuse an index for another file.
											key={`${data.revision}:${file.index}`}
											file={file}
											revision={data.revision}
											unit={unit}
											expanded={open === keyOf(file.index)}
											onExpandedChange={(expanded) =>
												toggleFile(file.index, expanded)
											}
											otherOpen={openIndex !== null && openIndex !== file.index}
											landing={
												landing?.index === file.index ? landing : undefined
											}
											threads={threads}
											headSure={headSure}
										/>
									))}
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
