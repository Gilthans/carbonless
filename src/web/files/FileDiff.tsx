import { useQuery } from "@tanstack/react-query";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ClusterView, FileView, StateChange } from "../../shared/types";
import { hunksQuery } from "../api";
import { Tooltip, TooltipPath, type TooltipTriggerProps } from "../Tooltip";
import { ChangeKindIcon, changeKindLabel } from "./changeKind";
import { DiffBody, type DiffThreads } from "./DiffBody";
import type { Landing } from "./landing";
import { Meter } from "./ProgressBar";
import { isStale } from "./stateSync";
import {
	ChangeCount,
	clusterCount,
	fileProgress as fileStatus,
	lineCount,
	StatusIcon,
} from "./status";
import { ThreadBubble } from "./ThreadBubble";
import { ThreadBlock } from "./ThreadRow";
import { fileThreads, placeThreads } from "./threadPlacement";
import {
	describeFileProgress,
	fileUnitProgress,
	formatFileProgress,
	type Unit,
} from "./unit";
import { useSetStates } from "./useSetStates";

const tones = {
	purple: {
		idle: "border-crossed text-done group-[:enabled:hover]:bg-crossed/20",
		pressed:
			"border-crossed bg-crossed-strong text-ink group-[:enabled:hover]:border-crossed-light group-[:enabled:hover]:bg-crossed",
	},
	green: {
		idle: "border-ok-fill text-ok group-[:enabled:hover]:bg-ok/15",
		pressed: "",
	},
};

/**
 * A file-wide action shown as an outlined icon, named by `label` and
 * explained by `tooltip` (a tooltip, also its accessible description).
 * 40×40 on touch and in a narrow header.
 */
/** How long "Undo cross-off" ignores clicks after replacing "Cross off file". */
export const UNDO_ARM_MS = 500;

/** Whether any of `el` lies within the viewport. */
function onScreen(el: Element | null): boolean {
	if (!el) return false;
	const r = el.getBoundingClientRect();
	return r.bottom >= 0 && r.top <= window.innerHeight;
}

function HeaderIconButton(props: {
	label: string;
	tooltip: string;
	icon: string;
	tone: keyof typeof tones;
	pressed?: boolean;
	disabled: boolean;
	onClick: () => void;
	/** Clicks before this `performance.now()` time are ignored. */
	ignoreClicksUntil?: number;
}) {
	const tone = tones[props.tone];
	const onClick = () => {
		if (performance.now() < (props.ignoreClicksUntil ?? 0)) return;
		props.onClick();
	};
	return (
		<Tooltip content={props.tooltip}>
			{({ ref, onMouseEnter, onMouseLeave, ...rest }) => (
				// The wrapper takes the hover so a disabled button still explains
				// itself; focus (and so tap) goes to the button.
				// biome-ignore lint/a11y/noStaticElementInteractions: hover only; the button inside is the control.
				<span
					ref={ref}
					onMouseEnter={onMouseEnter}
					onMouseLeave={onMouseLeave}
					className="flex shrink-0 [&>button:disabled]:pointer-events-none"
				>
					<button
						type="button"
						{...rest}
						aria-label={props.label}
						aria-pressed={props.pressed}
						disabled={props.disabled}
						onClick={onClick}
						className="group flex h-10 w-10 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed @lg:h-8 @lg:w-8 pointer-coarse:@lg:h-10 pointer-coarse:@lg:w-10"
					>
						<span
							aria-hidden
							className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-2 font-sans text-base leading-none transition-colors group-disabled:border-line group-disabled:bg-transparent group-disabled:text-faint motion-reduce:transition-none ${
								props.pressed ? tone.pressed : tone.idle
							}`}
						>
							{props.icon}
						</span>
					</button>
				</span>
			)}
		</Tooltip>
	);
}

/**
 * The path in its own horizontal scroller, kept scrolled fully right so the
 * file name shows; scrolling left reveals the rest. Re-pinned when the path
 * or the available width changes.
 */
function PathScroller({
	text,
	kind,
	className = "",
	fade = "from-raised",
}: {
	text: string;
	/** The fade's start color: the header's background. */
	fade?: string;
	/** The kind of change, first in the tooltip (touch and keyboard get it here). */
	kind: string;
	className?: string;
}) {
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
		<div className={`relative min-w-0 flex-1 ${className}`}>
			<Tooltip
				content={
					<>
						{kind} · <TooltipPath>{text}</TooltipPath>
					</>
				}
				describe={false}
			>
				{(trigger) => (
					// biome-ignore lint/a11y/useSemanticElements: a named group; a fieldset is for form controls, not a path.
					<div
						{...trigger}
						ref={(el) => {
							box.current = el;
							trigger.ref(el);
						}}
						role="group"
						aria-label={`Path: ${text}`}
						// A scroll box must be reachable by keyboard to scroll it (WCAG 2.1.1).
						// biome-ignore lint/a11y/noNoninteractiveTabindex: see above.
						tabIndex={0}
						data-testid="file-path"
						onScroll={(event) => setClipped(event.currentTarget.scrollLeft > 0)}
						className="overflow-x-auto rounded font-mono text-sm whitespace-nowrap text-ink [scrollbar-width:thin] focus-visible:outline-2 focus-visible:outline-accent"
					>
						<span ref={inner} className="inline-block py-1">
							{text}
						</span>
					</div>
				)}
			</Tooltip>
			{clipped && (
				<span
					aria-hidden
					data-testid="path-fade"
					className={`pointer-events-none absolute inset-y-0 left-0 flex w-6 items-center bg-gradient-to-r ${fade} from-40% to-transparent font-mono text-sm text-faint`}
				>
					…
				</span>
			)}
		</div>
	);
}

/**
 * The file's progress in the unit: fixed size, pinned right, so headers line
 * up. It is the header's one focusable summary (status, count and progress in
 * one tooltip sentence), so keyboard and tap users get it in a single stop.
 */
function FileProgress(props: {
	file: FileView;
	unit: Unit;
	summary: string;
	trigger: TooltipTriggerProps;
}) {
	const { file, unit, summary, trigger } = props;
	const p = fileUnitProgress(file, unit);
	const { counts } = p;
	return (
		<div
			{...trigger}
			role="progressbar"
			aria-label="File progress"
			aria-valuenow={p.percent}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuetext={summary}
			// Focusable so keyboard and touch users can read the tooltip.
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
			tabIndex={0}
			className="flex h-9 w-28 shrink-0 flex-col justify-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-accent @lg:order-6 @2xl:w-48"
		>
			<span className="truncate text-right text-xs text-muted tabular-nums">
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
 * One file of the diff: header with review status and bulk actions, and the
 * diff once expanded. Every file starts collapsed; collapsing is only a view
 * setting. The owner may control it (`expanded`, `onExpandedChange`). An open
 * file's header sticks below the app header and the page's progress bar
 * (`--app-header`, `--files-bar`) while
 * its diff scrolls. State actions show at once; useSetStates syncs them.
 */
export function FileDiff(props: {
	file: FileView;
	revision: string;
	unit: Unit;
	expanded?: boolean;
	onExpandedChange?: (expanded: boolean) => void;
	/**
	 * Another file is open (FilesPage keeps one open at a time). Read only to
	 * decide whether a failed file-wide save may reopen this file.
	 */
	otherOpen?: boolean;
	/** A thread link landing in this file (FilesPage). */
	landing?: Landing;
	/** The PR's review threads, placed on this file's diff. */
	threads?: DiffThreads;
}) {
	const { file, revision } = props;
	const [ownExpanded, setOwnExpanded] = useState(false);
	const expanded = props.expanded ?? ownExpanded;
	const setExpanded = (next: boolean) => {
		if (props.expanded === undefined) setOwnExpanded(next);
		props.onExpandedChange?.(next);
	};
	// Read after an await: the reviewer may have reopened this file, or opened
	// another, while a file-wide save ran.
	const expandedNow = useRef(expanded);
	expandedNow.current = expanded;
	const headerEl = useRef<HTMLElement>(null);
	const toggleButton = useRef<HTMLButtonElement>(null);
	const otherOpenNow = useRef(props.otherOpen ?? false);
	otherOpenNow.current = props.otherOpen ?? false;
	const { save: saveStates } = useSetStates();
	const save = (changes: StateChange[]) =>
		saveStates(revision, file.path, changes);
	/**
	 * Marking the rest reviewed or crossing it off finishes the file: it closes
	 * at once, like "Collapse file" does (its header stays where it is, the
	 * next file below). A save that fails for good (the error notice, not a
	 * transient retry) reopens it, unless the reviewer has moved on (opened
	 * another file, or scrolled its header off screen). A stale refusal
	 * doesn't reopen it: the page is reloading a new snapshot.
	 */
	const finishAll = (changes: StateChange[]) => {
		const closing = expanded;
		if (closing) {
			setExpanded(false);
			// The clicked button disables (nothing left to do); keep focus in the header.
			toggleButton.current?.focus({ preventScroll: true });
		}
		save(changes).catch((error: unknown) => {
			if (
				closing &&
				!isStale(error) &&
				!expandedNow.current &&
				!otherOpenNow.current &&
				onScreen(headerEl.current)
			) {
				setExpanded(true);
			}
		});
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
	// "Undo cross-off" swaps in under the pointer once a cross-off is stored:
	// a double click's second click was meant for the cross-off, not undo.
	const undoArmedAt = useRef(0);
	const wasUndo = useRef(crossToggle.undo);
	if (crossToggle.undo && !wasUndo.current) {
		undoArmedAt.current = performance.now() + UNDO_ARM_MS;
	}
	wasUndo.current = crossToggle.undo;
	const path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
	// One sentence for the header's status, counts and progress. The counts
	// are the same in every unit; only the progress follows it.
	const status = fileStatus(file);
	const sentence = describeFileProgress(file, props.unit);
	const summary = [
		sentence.startsWith(status) ? null : status,
		lineCount(file),
		clusterCount(file),
		sentence,
	]
		.filter(Boolean)
		.join(" · ");
	const idle =
		file.clusters.length === 0
			? "No clusters in this file"
			: "Nothing unreviewed";

	// Every thread of the file on the viewed head, hunks or not: a closed
	// file's header counts them all.
	const mine = props.threads
		? fileThreads(props.threads.threads, file.path, props.threads.snapshotHead)
		: [];
	// The header's threads: file comments, and lines the diff can't show,
	// never dropped. A closed file's hunks aren't read (first open stays
	// light): a binary or submodule file's line threads are flagged from the
	// file alone; a line past the end shows once the file is opened.
	const hunks = useQuery({
		...hunksQuery(revision, file.index),
		enabled: expanded,
	});
	const header = props.threads
		? placeThreads({
				threads: props.threads.threads,
				path: file.path,
				snapshotHead: props.threads.snapshotHead,
				hunks: hunks.data ?? null,
				loadedContext: [],
				noLines: file.binary || file.submodule,
			}).header
		: [];
	const [headerOpen, setHeaderOpen] = useState(false);
	const headerThreadsId = useId();
	const unplaced = header.some((h) => h.reason === "unplaced");

	return (
		<section
			id={`file-${file.index}`}
			data-file-index={file.index}
			aria-label={file.path}
			className={`overflow-clip rounded-lg border bg-surface ${
				file.done ? "border-ok-fill/50" : "border-line"
			}`}
		>
			<header
				ref={headerEl}
				data-finished={file.done || undefined}
				// Square corners: the section clips them at the top, and a stuck
				// header must not let lines show through. Finished (every cluster
				// reviewed or crossed off): an opaque green wash and a green left
				// edge, so unreviewed files stand out while scrolling.
				className={`@container border-b border-line px-1.5 ${
					file.done
						? "bg-ok-wash shadow-[inset_3px_0_0_var(--color-ok-fill)]"
						: "bg-raised"
				} ${
					expanded
						? "sticky top-[calc(var(--app-header,0px)+var(--files-bar,0px))] z-10"
						: ""
				}`}
			>
				{/*
				 * DOM (and tab) order is the narrow layout's: the path and counts on
				 * their own row, everything else below it. Wide headers are one row, reordered
				 * to toggle, status, path and counts, actions, progress.
				 */}
				<Tooltip content={summary} describe={false}>
					{(summaryTrigger) => (
						<div className="flex min-h-11 flex-wrap items-center gap-x-1.5 pt-1 @lg:flex-nowrap @lg:pt-0 @2xl:gap-x-3">
							<div className="flex min-w-0 flex-1 basis-full items-center gap-1.5 @lg:order-3 @lg:basis-0">
								<ChangeKindIcon file={file} tooltip />
								<PathScroller
									text={path}
									fade={file.done ? "from-ok-wash" : "from-raised"}
									kind={
										file.status === "renamed"
											? "Renamed"
											: changeKindLabel(file)
									}
								/>
								{/* Beside the path, so a phone's second row keeps its room. */}
								<ChangeCount file={file} hover={summaryTrigger} />
							</div>
							<button
								ref={toggleButton}
								type="button"
								aria-expanded={expanded}
								aria-label={expanded ? "Collapse file" : "Expand file"}
								onClick={() => setExpanded(!expanded)}
								className="flex h-10 w-10 shrink-0 items-center justify-center rounded text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:outline-accent @lg:order-1"
							>
								{expanded ? "▾" : "▸"}
							</button>
							<span className="flex shrink-0 @lg:order-2">
								<StatusIcon file={file} hover={summaryTrigger} />
							</span>
							<div className="ml-auto flex shrink-0 items-center gap-1.5 @lg:order-5">
								{expanded
									? header.length > 0 && (
											<ThreadBubble
												threads={header.map((h) => h.thread)}
												where="on this file"
												flagged={unplaced}
												open={headerOpen}
												controls={headerOpen ? headerThreadsId : undefined}
												onToggle={() => setHeaderOpen(!headerOpen)}
											/>
										)
									: mine.length > 0 && (
											// Closed: every thread in the file; opening it shows
											// them (and the header's, opened).
											<ThreadBubble
												threads={mine}
												where="in this file"
												flagged={unplaced}
												open={false}
												onToggle={() => {
													if (header.length > 0) setHeaderOpen(true);
													setExpanded(true);
												}}
											/>
										)}
								{crossToggle.undo ? (
									<HeaderIconButton
										ignoreClicksUntil={undoArmedAt.current}
										label="Undo cross-off"
										tooltip="Set crossed-off clusters back to unreviewed"
										icon="⊘"
										tone="purple"
										pressed
										disabled={false}
										onClick={() => {
											// Back to unreviewed, never reviewed (R21).
											save(
												crossed.map((c) => ({
													key: c.key,
													state: "unreviewed",
												})),
											).catch(() => {});
										}}
									/>
								) : (
									<HeaderIconButton
										label="Cross off file"
										tooltip={
											crossToggle.none
												? idle
												: "Mark all unreviewed clusters as not needing review"
										}
										icon="⊘"
										tone="purple"
										pressed={false}
										disabled={crossToggle.none}
										onClick={() => {
											// What the reviewer already read stays reviewed (R21).
											finishAll(
												unreviewed.map((c) => ({
													key: c.key,
													state: "crossed-off",
												})),
											);
										}}
									/>
								)}
								<HeaderIconButton
									label="Mark remaining reviewed"
									tooltip={
										unreviewed.length === 0
											? idle
											: "Mark all unreviewed clusters as reviewed"
									}
									icon="✓"
									tone="green"
									disabled={unreviewed.length === 0}
									onClick={() => {
										finishAll(
											unreviewed.map((c) => ({
												key: c.key,
												state: "reviewed",
											})),
										);
									}}
								/>
							</div>
							<FileProgress
								file={file}
								unit={props.unit}
								summary={summary}
								trigger={summaryTrigger}
							/>
						</div>
					)}
				</Tooltip>
			</header>
			{expanded && headerOpen && header.length > 0 && props.threads && (
				<div
					id={headerThreadsId}
					data-testid="header-threads"
					className="space-y-2 border-b border-line bg-canvas p-2"
				>
					{header.map((h, i) => (
						<ThreadBlock
							key={h.thread.id || `#${i}`}
							readId={props.threads?.readId ?? ""}
							thread={h.thread}
							unplaced={h.reason === "unplaced"}
						/>
					))}
				</div>
			)}
			{expanded && (
				<DiffBody
					file={file}
					revision={revision}
					onToggle={toggle}
					onCrossOff={crossOff}
					landing={props.landing}
					threads={props.threads}
				/>
			)}
		</section>
	);
}
