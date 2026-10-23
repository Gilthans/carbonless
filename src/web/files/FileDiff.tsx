import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { ClusterView, FileView, StateChange } from "../../shared/types";
import { ErrorMessage } from "../ui";
import { DiffBody } from "./DiffBody";
import { Meter } from "./ProgressBar";
import { AddDel, StatusIcon } from "./status";
import { fileUnitProgress, percent, UNITS, type Unit } from "./unit";
import { isStale, useSetStates } from "./useSetStates";

/** The server's limit on changes per request (MAX_CHANGES in app.ts). */
const MAX_CHANGES = 1000;

const buttonClass =
	"rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium whitespace-nowrap hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-50 pointer-coarse:min-h-10 pointer-coarse:px-3 pointer-coarse:text-sm";

/**
 * The path in its own horizontal scroller, kept scrolled fully right so the
 * file name shows; scrolling left reveals the rest. Re-pinned when the path
 * or the available width changes.
 */
function PathScroller({ text }: { text: string }) {
	const box = useRef<HTMLDivElement>(null);
	const inner = useRef<HTMLSpanElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on a new path.
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		const toEnd = () => {
			el.scrollLeft = el.scrollWidth;
		};
		toEnd();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(toEnd);
		observer.observe(el);
		if (inner.current) observer.observe(inner.current);
		return () => observer.disconnect();
	}, [text]);
	return (
		<div
			ref={box}
			data-testid="file-path"
			title={text}
			className="min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap [scrollbar-width:thin]"
		>
			<span ref={inner} className="inline-block py-1">
				{text}
			</span>
		</div>
	);
}

/** The file's progress in the unit: fixed size, pinned right, so headers line up. */
function FileProgress({ file, unit }: { file: FileView; unit: Unit }) {
	const { unit: shown, counts, text } = fileUnitProgress(file, unit);
	const word = UNITS.find((u) => u.id === shown)?.label.toLowerCase() ?? shown;
	const label = /\d/.test(text) && unit !== "files" ? `${text} ${word}` : text;
	const crossed =
		counts.crossedOff > 0 ? `, ${counts.crossedOff} crossed off` : "";
	return (
		<div
			role="progressbar"
			aria-label="File progress"
			aria-valuenow={percent(counts)}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuetext={`${counts.reviewed} of ${counts.total - counts.crossedOff} ${word} reviewed${crossed}`}
			title={`${counts.reviewed} of ${counts.total - counts.crossedOff} ${word} reviewed${crossed}`}
			className="flex h-9 w-24 shrink-0 flex-col justify-center gap-1 @2xl:w-36"
		>
			<span className="truncate text-right text-xs text-slate-600 tabular-nums">
				{label}
			</span>
			<Meter counts={counts} className="h-1.5" />
		</div>
	);
}

/**
 * The header's bulk actions: inline when the header is wide enough, otherwise
 * behind a compact "File actions" menu.
 */
function FileActions({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const toggle = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		const el = root.current;
		if (!open || !el) return;
		const close = () => {
			setOpen(false);
			toggle.current?.focus();
		};
		const away = (event: PointerEvent) => {
			if (!el.contains(event.target as Node)) setOpen(false);
		};
		const onEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") close();
		};
		// An action picked from the menu closes it.
		const picked = (event: MouseEvent) => {
			const button = (event.target as Element).closest("button");
			if (button && button !== toggle.current) close();
		};
		document.addEventListener("pointerdown", away);
		el.addEventListener("keydown", onEscape);
		el.addEventListener("click", picked);
		return () => {
			document.removeEventListener("pointerdown", away);
			el.removeEventListener("keydown", onEscape);
			el.removeEventListener("click", picked);
		};
	}, [open]);
	return (
		<div ref={root} className="relative shrink-0">
			<button
				ref={toggle}
				type="button"
				aria-label="File actions"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className="flex h-10 w-10 items-center justify-center rounded-md text-lg text-slate-600 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-blue-600 @2xl:hidden"
			>
				⋯
			</button>
			<div
				className={`${open ? "flex" : "hidden"} absolute top-full right-0 z-30 mt-1 w-max flex-col items-stretch gap-1 rounded-md border border-slate-200 bg-white p-1 shadow-lg @2xl:static @2xl:mt-0 @2xl:flex @2xl:flex-row @2xl:items-center @2xl:gap-2 @2xl:border-0 @2xl:bg-transparent @2xl:p-0 @2xl:shadow-none`}
			>
				{children}
			</div>
		</div>
	);
}

/**
 * One file of the diff: header with review status and bulk actions, and the
 * diff once expanded. Every file starts collapsed; collapsing is only a view
 * setting. `onStaleChange(true)`: a write was refused because the snapshot
 * moved; `onStaleChange(false)`: a later write was stored.
 */
export function FileDiff(props: {
	file: FileView;
	revision: string;
	unit: Unit;
	onStaleChange?: (stale: boolean) => void;
}) {
	const { file, revision } = props;
	const [expanded, setExpanded] = useState(false);
	const setStates = useSetStates({ onStaleChange: props.onStaleChange });
	// Also true between a split batch's requests.
	const [batching, setBatching] = useState(false);
	const pending = setStates.isPending || batching;

	const save = (changes: StateChange[]) =>
		setStates.mutateAsync({ revision, changes });
	/**
	 * A file-wide action: requests of at most MAX_CHANGES, one after another
	 * through the same mutation scope, stopping at the first failure.
	 */
	const saveAll = async (changes: StateChange[]) => {
		setBatching(true);
		try {
			for (let i = 0; i < changes.length; i += MAX_CHANGES) {
				await save(changes.slice(i, i + MAX_CHANGES));
			}
		} finally {
			setBatching(false);
		}
	};
	// Only an unreviewed cluster's box marks it reviewed: unchecking a reviewed
	// one or undoing a cross-off makes it unreviewed (R21).
	const toggle = (cluster: ClusterView) => {
		save([
			{
				key: cluster.key,
				state: cluster.state === "unreviewed" ? "reviewed" : "unreviewed",
			},
		]).catch(() => {});
	};
	// Crossing off a cluster, or undoing it to unreviewed (never reviewed).
	const crossOff = (cluster: ClusterView) => {
		save([
			{
				key: cluster.key,
				state: cluster.state === "crossed-off" ? "unreviewed" : "crossed-off",
			},
		]).catch(() => {});
	};
	const unreviewed = file.clusters.filter((c) => c.state === "unreviewed");
	const crossed = file.clusters.filter((c) => c.state === "crossed-off");
	const path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

	return (
		<section
			id={`file-${file.index}`}
			data-file-index={file.index}
			aria-label={file.path}
			className="scroll-mt-28 rounded-md border border-slate-200"
		>
			<header className="@container rounded-t-md border-b border-slate-200 bg-slate-50 px-1.5">
				<div className="flex min-h-11 items-center gap-1.5 @2xl:gap-3">
					<button
						type="button"
						aria-expanded={expanded}
						aria-label={expanded ? "Collapse file" : "Expand file"}
						onClick={() => setExpanded((e) => !e)}
						className="flex h-10 w-8 shrink-0 items-center justify-center rounded text-slate-600 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-blue-600"
					>
						{expanded ? "▾" : "▸"}
					</button>
					<StatusIcon file={file} />
					<PathScroller text={path} />
					<span className="hidden @md:inline">
						<AddDel file={file} />
					</span>
					<FileActions>
						{crossed.length > 0 && (
							<button
								type="button"
								disabled={pending}
								onClick={() => {
									saveAll(
										crossed.map((c) => ({ key: c.key, state: "unreviewed" })),
									).catch(() => {});
								}}
								className={buttonClass}
							>
								Undo cross-off
							</button>
						)}
						<button
							type="button"
							disabled={pending || unreviewed.length === 0}
							onClick={() => {
								// What the reviewer already read stays reviewed (R21).
								saveAll(
									unreviewed.map((c) => ({ key: c.key, state: "crossed-off" })),
								).catch(() => {});
							}}
							className={buttonClass}
						>
							Cross off file
						</button>
						<button
							type="button"
							disabled={pending || unreviewed.length === 0}
							onClick={() => {
								saveAll(
									unreviewed.map((c) => ({ key: c.key, state: "reviewed" })),
								).catch(() => {});
							}}
							className={buttonClass}
						>
							Mark remaining reviewed
						</button>
					</FileActions>
					<FileProgress file={file} unit={props.unit} />
				</div>
			</header>
			{setStates.isError && !isStale(setStates.error) && (
				<div className="px-2 py-1.5">
					<ErrorMessage error={setStates.error} />
				</div>
			)}
			{expanded && (
				<DiffBody
					file={file}
					revision={revision}
					disabled={pending}
					onToggle={toggle}
					onCrossOff={crossOff}
				/>
			)}
		</section>
	);
}
