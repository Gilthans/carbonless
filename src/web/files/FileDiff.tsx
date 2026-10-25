import { useLayoutEffect, useRef, useState } from "react";
import type { ClusterView, FileView, StateChange } from "../../shared/types";
import { ErrorMessage } from "../ui";
import { DiffBody } from "./DiffBody";
import { Meter } from "./ProgressBar";
import { ChangeCount, StatusIcon } from "./status";
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
		<button
			type="button"
			aria-label={props.label}
			aria-pressed={props.pressed}
			title={props.tooltip}
			disabled={props.disabled}
			onClick={props.onClick}
			className="group flex h-10 w-10 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed @lg:h-8 @lg:w-8 pointer-coarse:@lg:h-10 pointer-coarse:@lg:w-10"
		>
			<span
				aria-hidden
				className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-2 font-sans text-base leading-none group-disabled:border-slate-300 group-disabled:bg-transparent group-disabled:text-slate-400 ${
					props.pressed ? tone.pressed : tone.idle
				}`}
			>
				{props.icon}
			</span>
		</button>
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
	const sentence = describeFileProgress(file, unit);
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
 * One file of the diff: header with review status and bulk actions, and the
 * diff once expanded. Every file starts collapsed; collapsing is only a view
 * setting. The owner may control it (`expanded`, `onExpandedChange`). An open
 * file's header sticks below the page's progress bar (`--files-bar`) while
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
	const idle =
		file.clusters.length === 0
			? "No clusters in this file"
			: "Nothing unreviewed";

	return (
		<section
			id={`file-${file.index}`}
			data-file-index={file.index}
			aria-label={file.path}
			className="scroll-mt-[calc(var(--files-bar,0px)-1px)] overflow-clip rounded-md border border-slate-200"
		>
			<header
				// Square corners: the section clips them at the top, and a stuck
				// header must not let lines show through.
				className={`@container border-b border-slate-200 bg-slate-50 px-1.5 ${
					expanded ? "sticky top-[var(--files-bar,0px)] z-10" : ""
				}`}
			>
				{/* Narrow: the path on its own row, everything else below it. */}
				<div className="flex min-h-11 flex-wrap items-center gap-x-1.5 pt-1 @lg:flex-nowrap @lg:pt-0 @2xl:gap-x-3">
					<button
						type="button"
						aria-expanded={expanded}
						aria-label={expanded ? "Collapse file" : "Expand file"}
						onClick={() => setExpanded(!expanded)}
						className="flex h-10 w-10 shrink-0 items-center justify-center rounded text-slate-600 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-blue-600"
					>
						{expanded ? "▾" : "▸"}
					</button>
					<StatusIcon file={file} />
					<PathScroller
						text={path}
						className="order-first basis-full @lg:order-none @lg:basis-0"
					/>
					{/* Left out of a phone's second row, where it wouldn't fit. */}
					<span className="ml-auto hidden shrink-0 @sm:flex @lg:ml-0">
						<ChangeCount file={file} unit={props.unit} />
					</span>
					<div className="ml-auto flex shrink-0 items-center gap-1.5 @sm:ml-0">
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
										crossed.map((c) => ({ key: c.key, state: "unreviewed" })),
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
									unreviewed.map((c) => ({ key: c.key, state: "reviewed" })),
								).catch(() => {});
							}}
						/>
					</div>
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
