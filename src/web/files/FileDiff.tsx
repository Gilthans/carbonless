import { useLayoutEffect, useRef, useState } from "react";
import type { ClusterView, FileView, StateChange } from "../../shared/types";
import { Tooltip, TooltipPath, type TooltipTriggerProps } from "../Tooltip";
import { ErrorMessage } from "../ui";
import { DiffBody } from "./DiffBody";
import type { Landing } from "./landing";
import { Meter } from "./ProgressBar";
import {
	ChangeCount,
	clusterCount,
	fileProgress as fileStatus,
	StatusIcon,
} from "./status";
import {
	describeFileProgress,
	fileUnitProgress,
	formatFileProgress,
	type Unit,
} from "./unit";
import { isStale, useSetStates } from "./useSetStates";

/** The server's limit on changes per request (MAX_CHANGES in app.ts). */
const MAX_CHANGES = 1000;

const tones = {
	purple: {
		idle: "border-crossed text-done group-[:enabled:hover]:bg-crossed/20",
		pressed:
			"border-crossed-strong bg-crossed-strong text-ink group-[:enabled:hover]:border-crossed group-[:enabled:hover]:bg-crossed",
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
						onClick={props.onClick}
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
	className = "",
}: {
	text: string;
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
			<Tooltip content={<TooltipPath>{text}</TooltipPath>} describe={false}>
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
					className="pointer-events-none absolute inset-y-0 left-0 flex w-6 items-center bg-gradient-to-r from-raised from-40% to-transparent font-mono text-sm text-faint"
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
 * its diff scrolls. `onStaleChange(true)`: a write was refused because the snapshot
 * moved; `onStaleChange(false)`: a later write was stored.
 */
export function FileDiff(props: {
	file: FileView;
	revision: string;
	unit: Unit;
	expanded?: boolean;
	onExpandedChange?: (expanded: boolean) => void;
	onStaleChange?: (stale: boolean) => void;
	/** A thread link landing in this file (FilesPage). */
	landing?: Landing;
}) {
	const { file, revision } = props;
	const [ownExpanded, setOwnExpanded] = useState(false);
	const expanded = props.expanded ?? ownExpanded;
	const setExpanded = (next: boolean) => {
		if (props.expanded === undefined) setOwnExpanded(next);
		props.onExpandedChange?.(next);
	};
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
	// One sentence for the header's status, count and progress.
	const status = fileStatus(file);
	const sentence = describeFileProgress(file, props.unit);
	const summary = [
		sentence.startsWith(status) ? null : status,
		props.unit === "clusters" ? clusterCount(file) : null,
		sentence,
	]
		.filter(Boolean)
		.join(" · ");
	const idle =
		file.clusters.length === 0
			? "No clusters in this file"
			: "Nothing unreviewed";

	return (
		<section
			id={`file-${file.index}`}
			data-file-index={file.index}
			aria-label={file.path}
			className="overflow-clip rounded-lg border border-line bg-surface"
		>
			<header
				// Square corners: the section clips them at the top, and a stuck
				// header must not let lines show through.
				className={`@container border-b border-line bg-raised px-1.5 ${
					expanded
						? "sticky top-[calc(var(--app-header,0px)+var(--files-bar,0px))] z-10"
						: ""
				}`}
			>
				{/*
				 * DOM (and tab) order is the narrow layout's: the path on its own
				 * row, everything else below it. Wide headers are one row, reordered
				 * to toggle, status, path, count, actions, progress.
				 */}
				<Tooltip content={summary} describe={false}>
					{(summaryTrigger) => (
						<div className="flex min-h-11 flex-wrap items-center gap-x-1.5 pt-1 @lg:flex-nowrap @lg:pt-0 @2xl:gap-x-3">
							<PathScroller
								text={path}
								className="basis-full @lg:order-3 @lg:basis-0"
							/>
							<button
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
							{/* Left out of a phone's second row, where it wouldn't fit. */}
							<span className="ml-auto hidden shrink-0 @sm:flex @lg:order-4 @lg:ml-0">
								<ChangeCount
									file={file}
									unit={props.unit}
									hover={summaryTrigger}
								/>
							</span>
							<div className="ml-auto flex shrink-0 items-center gap-1.5 @sm:ml-0 @lg:order-5">
								{crossToggle.undo ? (
									<HeaderIconButton
										label="Undo cross-off"
										tooltip="Set crossed-off clusters back to unreviewed"
										icon="⊘"
										tone="purple"
										pressed
										disabled={pending}
										onClick={() => {
											// Back to unreviewed, never reviewed (R21).
											saveAll(
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
											? idle
											: "Mark all unreviewed clusters as reviewed"
									}
									icon="✓"
									tone="green"
									disabled={pending || unreviewed.length === 0}
									onClick={() => {
										saveAll(
											unreviewed.map((c) => ({
												key: c.key,
												state: "reviewed",
											})),
										).catch(() => {});
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
					landing={props.landing}
				/>
			)}
		</section>
	);
}
