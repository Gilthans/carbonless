import { useQuery } from "@tanstack/react-query";
import {
	type ReactNode,
	type RefObject,
	useEffect,
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
 * below the sticky progress bar.
 */
function useCurrentFile(
	container: RefObject<HTMLElement | null>,
	sections: string,
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
			{ rootMargin: "-120px 0px -60% 0px" },
		);
		for (const section of root.querySelectorAll("[data-file-index]")) {
			observer.observe(section);
		}
		return () => observer.disconnect();
	}, [container, sections]);
	return [current, setCurrent] as const;
}

export function FilesPage() {
	const review = useQuery(reviewQuery);
	const [stale, setStale] = useState(false);
	const diffs = useRef<HTMLDivElement>(null);
	const data = review.data;
	const [current, setCurrent] = useCurrentFile(
		diffs,
		data ? `${data.revision}:${data.files.length}` : "",
	);

	const [unit, setUnit] = useUnit();
	const wide = useMedia(WIDE);
	const [sheetOpen, setSheetOpen] = useState(false);

	// Widening to the sidebar layout closes the sheet; narrowing doesn't reopen it.
	useEffect(() => {
		if (wide) setSheetOpen(false);
	}, [wide]);

	const scrollTo = (index: number) =>
		document
			.getElementById(`file-${index}`)
			?.scrollIntoView?.({ block: "start" });
	const select = (index: number) => {
		setCurrent(index);
		if (sheetOpen) {
			setSheetOpen(false);
			// Once the sheet has closed (and handed focus back to its button),
			// move focus to the picked file's header and scroll there.
			requestAnimationFrame(() => {
				document
					.querySelector<HTMLElement>(`#file-${index} header button`)
					?.focus({ preventScroll: true });
				scrollTo(index);
			});
		} else {
			scrollTo(index);
		}
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
		<section aria-label="Files changed">
			<h2 className="sr-only">Files changed</h2>
			{review.isPending && <p className="text-slate-500">Loading the diff…</p>}
			{review.isError && <ErrorMessage error={review.error} />}
			{data && (
				<>
					<ProgressBar
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
								<aside className="sticky top-20 max-h-[calc(100vh-6rem)] w-72 shrink-0 self-start overflow-y-auto">
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
