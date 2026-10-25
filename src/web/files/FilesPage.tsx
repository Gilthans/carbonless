import { useQuery } from "@tanstack/react-query";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { reviewQuery } from "../api";
import { useForgetPageScroll, usePageActive } from "../pageActive";
import { useAppHeaderHeight, useHeight } from "../sticky";
import { ErrorMessage } from "../ui";
import { FileDiff } from "./FileDiff";
import { FileTree } from "./FileTree";
import { ProgressBar } from "./ProgressBar";
import { useUnit } from "./unit";
import { STALE_MESSAGE } from "./useSetStates";

/** Tailwind's `md`: the file tree gets a sidebar from here up. */
const WIDE = "(min-width: 768px)";

/** Whether the media query matches; true where matchMedia is unavailable. */
function useMedia(query: string): boolean {
	return useSyncExternalStore(
		(onChange) => {
			if (typeof window.matchMedia !== "function") return () => {};
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		() =>
			typeof window.matchMedia === "function"
				? window.matchMedia(query).matches
				: true,
	);
}

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
			className="m-0 mt-auto h-[85dvh] max-h-none w-full max-w-none overflow-hidden rounded-t-2xl border-t border-edge bg-surface p-0 text-ink shadow-[0_-12px_40px_rgb(0_0_0/0.6)] backdrop:bg-canvas/70 backdrop:backdrop-blur-[2px]"
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

const headerOf = (index: number) =>
	document.querySelector<HTMLElement>(`#file-${index} > header`);

export function FilesPage() {
	const review = useQuery(reviewQuery);
	// False while another page shows (kept mounted, hidden): measuring and
	// tracking pause, root styles are given back, the sheet closes.
	const active = usePageActive();
	const [stale, setStale] = useState(false);
	const diffs = useRef<HTMLDivElement>(null);
	const data = review.data;
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

	const [unit, setUnit] = useUnit();
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

	const tree = data && (
		<FileTree
			files={data.files}
			unit={unit}
			current={current}
			onSelect={select}
		/>
	);

	return (
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
								className={`min-w-0 flex-1 space-y-3 ${wide ? "" : "pb-20"}`}
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
										onStaleChange={setStale}
									/>
								))}
							</div>
						</div>
					)}
					{!wide && data.files.length > 0 && (
						<>
							<button
								type="button"
								aria-label="Files"
								aria-haspopup="dialog"
								onClick={() => setSheetOpen(true)}
								className="fixed right-4 bottom-4 z-30 flex h-12 items-center gap-2 cta rounded-full px-5 text-sm font-semibold text-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
							>
								<span aria-hidden>☰</span>
								Files
							</button>
							<FilesSheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
								{tree}
							</FilesSheet>
						</>
					)}
				</>
			)}
		</section>
	);
}
