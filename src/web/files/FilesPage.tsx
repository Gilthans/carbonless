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
			className="m-0 mt-auto h-[85dvh] max-h-none w-full max-w-none overflow-hidden rounded-t-xl bg-white p-0 shadow-xl backdrop:bg-slate-900/40"
		>
			<div className="flex h-full flex-col">
				<div className="flex items-center justify-between border-b border-slate-200 px-4 py-1">
					<h2 id="files-sheet-title" className="font-semibold">
						Files
					</h2>
					<button
						type="button"
						onClick={props.onClose}
						className="h-10 rounded-md px-3 text-sm font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600"
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
 * below the sticky progress bar (`top` px tall).
 */
function useCurrentFile(
	container: RefObject<HTMLElement | null>,
	sections: string,
	top: number,
) {
	const [current, setCurrent] = useState<number | null>(null);
	// `sections` changes when the rendered file sections do: observe the new ones.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above.
	useEffect(() => {
		const root = container.current;
		if (!root || typeof IntersectionObserver === "undefined") return;
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
	}, [container, sections, top]);
	return [current, setCurrent] as const;
}

/**
 * The rendered height in px of the element `find` returns, kept current as it
 * changes (the sticky bar wraps differently by width and unit). `key` says
 * when to look the element up again.
 */
function useHeight(find: () => HTMLElement | null, key: unknown) {
	const [height, setHeight] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: looked up again when `key` changes.
	useLayoutEffect(() => {
		const node = find();
		if (!node) {
			setHeight(0);
			return;
		}
		const measure = () => setHeight(node.offsetHeight);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [key]);
	return height;
}

const headerOf = (index: number) =>
	document.querySelector<HTMLElement>(`#file-${index} > header`);

export function FilesPage() {
	const review = useQuery(reviewQuery);
	const [stale, setStale] = useState(false);
	const diffs = useRef<HTMLDivElement>(null);
	const data = review.data;
	const bar = useRef<HTMLDivElement>(null);
	// Open file headers stick right below the progress bar.
	const barHeight = useHeight(() => bar.current, data !== undefined);
	const [current, setCurrent] = useCurrentFile(
		diffs,
		data ? `${data.revision}:${data.files.length}` : "",
		barHeight,
	);

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
	);
	// Keyboard focus scrolling keeps focused controls clear of the sticky bar
	// and the open file's sticky header (WCAG 2.4.11).
	const stickyTop = barHeight + openHeader;
	useEffect(() => {
		const root = document.documentElement;
		root.style.scrollPaddingTop = `${stickyTop}px`;
		return () => {
			root.style.scrollPaddingTop = "";
		};
	}, [stickyTop]);
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

	// Widening to the sidebar layout closes the sheet; narrowing doesn't reopen it.
	useEffect(() => {
		if (wide) setSheetOpen(false);
	}, [wide]);

	/** Puts the file's header right below the sticky bar (its border under it). */
	const scrollTo = (index: number) => {
		const section = document.getElementById(`file-${index}`);
		if (!section) return;
		const top = section.getBoundingClientRect().top + window.scrollY;
		window.scrollTo({ top: top - barHeight + 1 });
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
			{review.isPending && <p className="text-slate-500">Loading the diff…</p>}
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
							className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
						>
							{STALE_MESSAGE}
						</p>
					)}
					{data.files.length === 0 ? (
						<p className="mt-4 text-slate-600">This PR changes no files.</p>
					) : (
						<div className="mt-4 flex gap-4">
							{wide && (
								<aside className="sticky top-[calc(var(--files-bar,0px)+1rem)] max-h-[calc(100dvh-var(--files-bar,0px)-2rem)] w-72 shrink-0 self-start overflow-y-auto">
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
								className="fixed right-4 bottom-4 z-30 flex h-12 items-center gap-2 rounded-full bg-slate-900 px-5 text-sm font-semibold text-white shadow-lg hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
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
