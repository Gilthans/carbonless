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
import {
	fileUnitProgress,
	formatFileProgress,
	type Unit,
	unitWord,
} from "./unit";
import { isStale, useSetStates } from "./useSetStates";

/** The server's limit on changes per request (MAX_CHANGES in app.ts). */
const MAX_CHANGES = 1000;

const tones = {
	purple: {
		idle: "border-purple-400 bg-white text-purple-700 group-[:enabled:hover]:bg-purple-50",
		pressed:
			"border-purple-600 bg-purple-600 text-white group-[:enabled:hover]:bg-purple-700",
	},
	green: {
		idle: "border-green-500 bg-white text-green-700 group-[:enabled:hover]:bg-green-50",
		pressed: "",
	},
};

/**
 * A file-wide action shown as an outlined icon, named by `label` and
 * explained by `tooltip` (the native title, also its accessible description).
 * Inline in a wide header it is the icon alone (40×40 on touch); in the
 * compact menu the label is written next to it.
 */
function HeaderIconButton(props: {
	label: string;
	tooltip: string;
	icon: string;
	tone: keyof typeof tones;
	pressed?: boolean;
	disabled: boolean;
	onClick: () => void;
}) {
	const tone = tones[props.tone];
	return (
		<button
			type="button"
			aria-label={props.label}
			aria-pressed={props.pressed}
			title={props.tooltip}
			disabled={props.disabled}
			onClick={props.onClick}
			className="group flex h-10 shrink-0 items-center gap-2 rounded-md pr-3 pl-1 text-sm whitespace-nowrap text-slate-800 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent @lg:h-8 @lg:w-8 @lg:justify-center @lg:p-0 @lg:hover:bg-transparent pointer-coarse:@lg:h-10 pointer-coarse:@lg:w-10"
		>
			<span
				aria-hidden
				className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-2 font-sans text-base leading-none group-disabled:border-slate-300 group-disabled:bg-transparent group-disabled:text-slate-400 ${
					props.pressed ? tone.pressed : tone.idle
				}`}
			>
				{props.icon}
			</span>
			<span aria-hidden className="@lg:hidden">
				{props.label}
			</span>
		</button>
	);
}

/**
 * The path in its own horizontal scroller, kept scrolled fully right so the
 * file name shows; scrolling left reveals the rest. Re-pinned when the path
 * or the available width changes.
 */
function PathScroller({ text }: { text: string }) {
	const box = useRef<HTMLDivElement>(null);
	const inner = useRef<HTMLSpanElement>(null);
	// More of the path sits to the left: fade the left edge to say so.
	const [clipped, setClipped] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on a new path.
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		const toEnd = () => {
			el.scrollLeft = el.scrollWidth;
			setClipped(el.scrollLeft > 0);
		};
		toEnd();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(toEnd);
		observer.observe(el);
		if (inner.current) observer.observe(inner.current);
		return () => observer.disconnect();
	}, [text]);
	return (
		<div className="relative min-w-0 flex-1">
			{/* biome-ignore lint/a11y/useSemanticElements: a named group; a fieldset is for form controls, not a path. */}
			<div
				ref={box}
				role="group"
				aria-label={`Path: ${text}`}
				// A scroll box must be reachable by keyboard to scroll it (WCAG 2.1.1).
				// biome-ignore lint/a11y/noNoninteractiveTabindex: see above.
				tabIndex={0}
				data-testid="file-path"
				title={text}
				onScroll={(event) => setClipped(event.currentTarget.scrollLeft > 0)}
				className="overflow-x-auto rounded font-mono text-sm whitespace-nowrap [scrollbar-width:thin] focus-visible:outline-2 focus-visible:outline-blue-600"
			>
				<span ref={inner} className="inline-block py-1">
					{text}
				</span>
			</div>
			{clipped && (
				<span
					aria-hidden
					data-testid="path-fade"
					className="pointer-events-none absolute inset-y-0 left-0 flex w-6 items-center bg-gradient-to-r from-slate-50 from-40% to-transparent font-mono text-sm text-slate-400"
				>
					…
				</span>
			)}
		</div>
	);
}

/** The file's progress in the unit: fixed size, pinned right, so headers line up. */
function FileProgress({ file, unit }: { file: FileView; unit: Unit }) {
	const p = fileUnitProgress(file, unit);
	const { counts } = p;
	const word = p.status === null ? unitWord(unit) : "clusters";
	const crossed =
		counts.crossedOff > 0 ? `, ${counts.crossedOff} crossed off` : "";
	const left = p.hiddenLeft
		? `, ${p.clustersLeft} ${p.clustersLeft === 1 ? "cluster" : "clusters"} without changed lines left`
		: "";
	const sentence =
		p.status !== null
			? formatFileProgress(p, unit)
			: `${counts.reviewed} of ${counts.total - counts.crossedOff} ${word} reviewed${crossed}${left}`;
	return (
		<div
			role="progressbar"
			aria-label="File progress"
			aria-valuenow={p.percent}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuetext={sentence}
			title={sentence}
			className="flex h-9 w-28 shrink-0 flex-col justify-center gap-1 @2xl:w-48"
		>
			<span className="truncate text-right text-xs text-slate-600 tabular-nums">
				<span className="@2xl:hidden">
					{formatFileProgress(p, unit, { short: true })}
				</span>
				<span className="hidden @2xl:inline">
					{formatFileProgress(p, unit, { withUnit: true })}
				</span>
			</span>
			<Meter
				counts={counts}
				incomplete={p.clustersLeft > 0}
				className="h-1.5"
			/>
		</div>
	);
}

/**
 * The header's bulk actions: inline icons when the header is wide enough,
 * otherwise behind a compact "File actions" menu, so a phone keeps room for
 * the path.
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
				className="flex h-10 w-10 items-center justify-center rounded-md text-lg text-slate-600 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-blue-600 @lg:hidden"
			>
				⋯
			</button>
			<div
				className={`${open ? "flex" : "hidden"} absolute top-full right-0 z-40 mt-1 w-max flex-col items-stretch gap-1 rounded-md border border-slate-200 bg-white p-1 shadow-lg @lg:static @lg:mt-0 @lg:flex @lg:flex-row @lg:items-center @lg:gap-1.5 @lg:border-0 @lg:bg-transparent @lg:p-0 @lg:shadow-none`}
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
	// One toggle: cross off what's unreviewed; once nothing is, undo the
	// cross-offs; with neither (all reviewed) there is nothing to do.
	const crossToggle = {
		undo: unreviewed.length === 0 && crossed.length > 0,
		none: unreviewed.length === 0 && crossed.length === 0,
	};
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
						className="flex h-10 w-10 shrink-0 items-center justify-center rounded text-slate-600 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-blue-600"
					>
						{expanded ? "▾" : "▸"}
					</button>
					<StatusIcon file={file} />
					<PathScroller text={path} />
					<span className="hidden @md:inline">
						<AddDel file={file} />
					</span>
					<FileActions>
						{crossToggle.undo ? (
							<HeaderIconButton
								label="Undo cross-off"
								tooltip="Undo cross-off — set this file's crossed-off clusters back to unreviewed"
								icon="⊘"
								tone="purple"
								pressed
								disabled={pending}
								onClick={() => {
									// Back to unreviewed, never reviewed (R21).
									saveAll(
										crossed.map((c) => ({ key: c.key, state: "unreviewed" })),
									).catch(() => {});
								}}
							/>
						) : (
							<HeaderIconButton
								label="Cross off file"
								tooltip={
									crossToggle.none
										? "Cross off file — every cluster in this file is reviewed"
										: "Cross off file — mark every unreviewed cluster in this file as not needing review"
								}
								icon="⊘"
								tone="purple"
								pressed={false}
								disabled={pending || crossToggle.none}
								onClick={() => {
									// What the reviewer already read stays reviewed (R21).
									saveAll(
										unreviewed.map((c) => ({
											key: c.key,
											state: "crossed-off",
										})),
									).catch(() => {});
								}}
							/>
						)}
						<HeaderIconButton
							label="Mark remaining reviewed"
							tooltip={
								unreviewed.length === 0
									? "Mark remaining reviewed — nothing in this file is unreviewed"
									: "Mark remaining reviewed — mark every unreviewed cluster in this file as reviewed"
							}
							icon="✓"
							tone="green"
							disabled={pending || unreviewed.length === 0}
							onClick={() => {
								saveAll(
									unreviewed.map((c) => ({ key: c.key, state: "reviewed" })),
								).catch(() => {});
							}}
						/>
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
