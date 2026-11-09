import { type ReactNode, type Ref, useId } from "react";
import type { Counts, Progress } from "../../shared/types";
import { SkeletonBar, Spinner } from "../Spinner";
import {
	clustersLeft,
	nothingLeft,
	pageCounts,
	pagePercent,
	UNITS,
	type Unit,
	unitWord,
} from "./unit";

/** Crossed off: violet stripes (the `hatch` utility, index.css). */
export const HATCH = "hatch";

/** The gap a meter keeps open while anything is unreviewed, in percent. */
const OPEN_GAP = 6;

/**
 * The most of a meter crossed off may take, in percent, so the rest has room
 * to show progress toward done.
 */
const CROSSED_CAP = 20;

/**
 * Reviewed fills from the left; crossed off is hatched at the right end, at
 * most `CROSSED_CAP` of the bar. The rest shows reviewed out of what isn't
 * crossed off, so it agrees with the percentage; below the cap that is just
 * reviewed ÷ total. With everything crossed off the bar is all hatch.
 * `incomplete`: something is still unreviewed even if the counts look full
 * (a rename weighs nothing in lines), so the meter is never shown full: both
 * segments shrink by the same factor to leave the gap, so neither vanishes
 * while its count is above zero (7 reviewed next to 395 crossed off is a
 * sliver of green, not none).
 */
export function Meter({
	counts,
	incomplete = false,
	className = "",
}: {
	counts: Counts;
	incomplete?: boolean;
	className?: string;
}) {
	const { total, crossedOff } = counts;
	const left = total - crossedOff;
	let crossed =
		total === 0
			? 0
			: left <= 0
				? 100
				: Math.min((crossedOff / total) * 100, CROSSED_CAP);
	let reviewed = left <= 0 ? 0 : (counts.reviewed / left) * (100 - crossed);
	if (incomplete && reviewed + crossed > 100 - OPEN_GAP) {
		const scale = (100 - OPEN_GAP) / (reviewed + crossed);
		reviewed *= scale;
		crossed *= scale;
	}
	const widths = { reviewed, crossed };
	// Spans, so a meter can sit inside a button (a tree row).
	return (
		<span
			aria-hidden
			className={`relative block overflow-hidden rounded-full bg-overlay ${className}`}
		>
			<span
				className="absolute inset-y-0 left-0 block rounded-r-full bg-ok-fill transition-[width] duration-300 ease-out motion-reduce:transition-none"
				data-part="reviewed"
				style={{ width: `${widths.reviewed}%` }}
			/>
			<span
				className={`absolute inset-y-0 right-0 block ${HATCH} transition-[width] duration-300 ease-out motion-reduce:transition-none`}
				data-part="crossed-off"
				style={{ width: `${widths.crossed}%` }}
			/>
		</span>
	);
}

/** Segmented Lines / Clusters / Files choice. */
function UnitPicker(props: { unit: Unit; onChange: (unit: Unit) => void }) {
	const name = useId();
	return (
		<fieldset className="flex shrink-0 rounded-lg border border-line-strong bg-surface p-0.5 text-xs">
			<legend className="sr-only">Count progress in</legend>
			{UNITS.map((u) => (
				<label
					key={u.id}
					className="flex cursor-pointer items-center rounded px-2 py-1 font-medium text-muted transition-colors hover:text-ink has-checked:bg-accent has-checked:text-canvas motion-reduce:transition-none has-focus-visible:outline-2 has-focus-visible:outline-accent pointer-coarse:min-h-10 pointer-coarse:px-3"
				>
					<input
						type="radio"
						name={name}
						value={u.id}
						checked={props.unit === u.id}
						onChange={() => props.onChange(u.id)}
						className="sr-only"
					/>
					{u.label}
				</label>
			))}
		</fieldset>
	);
}

/**
 * Sticky review progress in the selected unit: one bar, reviewed out of what
 * isn't crossed off.
 */
export function ProgressBar(props: {
	ref?: Ref<HTMLDivElement>;
	progress: Progress;
	unit: Unit;
	onUnitChange: (unit: Unit) => void;
	/** At the row's end: what is still loading for the page (a Spinner). */
	children?: ReactNode;
	/**
	 * In a comparison the engine answers: how much of the unit still needs
	 * eyes ("5 to read"); null while it computes (a spinner in the slot).
	 */
	toRead?: number | null;
	/** A second row under the counts (an earlier patch set's read-only note). */
	note?: ReactNode;
	/**
	 * The counts wait on the engine (the since view counts its pieces): a
	 * spinner where the numbers go, never 0 (principle 8).
	 */
	pending?: boolean;
	/**
	 * Instead of counts, a state of its own (the since view): nothing to
	 * count there, or its count failed. Never another view's numbers.
	 * `pending` comes first: a refetch over an earlier empty answer spins.
	 */
	instead?: "empty" | "failed";
}) {
	const { progress, unit } = props;
	const toRead =
		props.toRead === undefined
			? null
			: props.toRead === null
				? "pending"
				: `${props.toRead} to read`;
	const counts = pageCounts(progress, unit);
	const value = pagePercent(progress, unit);
	const shown = counts.total - counts.crossedOff;
	const word = unitWord(unit, shown);
	// Everything the unit counts was crossed off: no bare 100%.
	const empty = nothingLeft(progress, unit);
	const summary = empty
		? `${counts.crossedOff} ${unitWord(unit, counts.crossedOff)} crossed off, ${counts.reviewed} reviewed`
		: `${counts.reviewed} / ${shown} ${word} reviewed`;
	const left = clustersLeft(progress);
	// In lines, a rename or mode change weighs nothing: say it's still there.
	const hiddenLeft =
		unit === "lines" &&
		counts.total - counts.reviewed - counts.crossedOff === 0 &&
		left > 0;
	const note = `${left} ${left === 1 ? "cluster" : "clusters"} without changed lines left`;
	return (
		<div
			ref={props.ref}
			// Its controls never scroll the page when focused (index.css).
			data-page-bar
			className="sticky top-[var(--app-header,0px)] z-20 border-b border-line bg-canvas py-2"
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<div className="flex shrink-0 items-center gap-2">
					<UnitPicker unit={unit} onChange={props.onUnitChange} />
				</div>
				{props.pending ? (
					<div
						role="progressbar"
						aria-label="Review progress"
						aria-busy="true"
						aria-valuetext="Counting the comparison"
						className="flex min-w-0 flex-1 basis-0 items-center gap-x-3"
					>
						<span className="flex w-11 shrink-0 justify-end">
							<Spinner label="Counting the comparison" size={14} />
						</span>
						<SkeletonBar className="h-2.5 min-w-8 flex-1" />
						{toRead !== null && (
							<span
								data-testid="to-read"
								className="inline-flex items-center gap-1 text-sm text-warn"
							>
								{toRead === "pending" ? (
									<Spinner label="Counting what is to read" size={12} />
								) : (
									toRead
								)}
							</span>
						)}
					</div>
				) : props.instead ? (
					<div
						role="progressbar"
						aria-label="Review progress"
						aria-valuetext={
							props.instead === "empty" ? "Nothing to read" : "Not counted"
						}
						data-state={props.instead}
						className="flex min-w-0 flex-1 basis-0 items-center gap-x-3"
					>
						<span
							className={`font-display text-base font-semibold ${props.instead === "failed" ? "text-bad" : ""}`}
						>
							{props.instead === "empty" ? "Nothing to read" : "Not counted"}
						</span>
					</div>
				) : (
					<div
						role="progressbar"
						aria-label="Review progress"
						aria-valuenow={value}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuetext={
							empty
								? `Nothing left to review: ${summary}`
								: `${value}%, ${summary}${hiddenLeft ? `, ${note}` : ""}${
										typeof toRead === "string" && toRead !== "pending"
											? `, ${toRead}`
											: ""
									}`
						}
						// Beside the unit picker even on a phone: the bar stays compact.
						className="flex min-w-0 flex-1 basis-0 flex-wrap items-center gap-x-3 gap-y-1 sm:flex-nowrap"
					>
						{empty ? (
							<span className="shrink-0 font-display text-base font-semibold">
								Nothing left to review
							</span>
						) : (
							<span className="w-11 shrink-0 text-right font-display text-base font-semibold tabular-nums">
								{value}%
							</span>
						)}
						<Meter
							counts={counts}
							incomplete={left > 0}
							className="order-last h-2.5 w-full sm:order-none sm:w-auto sm:min-w-8 sm:flex-1"
						/>
						<span className="min-w-0 text-sm text-muted tabular-nums">
							{empty ? (
								summary
							) : (
								<>
									{counts.reviewed} / {shown}
									{/* The picker beside it names the unit on a phone. */}
									<span className="hidden sm:inline"> {word} reviewed</span>
								</>
							)}
							{toRead !== null && (
								<span
									data-testid="to-read"
									className="ml-1 inline-flex items-center gap-1 text-warn"
								>
									{" · "}
									{toRead === "pending" ? (
										<Spinner label="Counting what is to read" size={12} />
									) : (
										toRead
									)}
								</span>
							)}
						</span>
					</div>
				)}
				{props.children}
			</div>
			{hiddenLeft && <p className="mt-1 text-xs text-warn">{note}</p>}
			{props.note}
		</div>
	);
}
