import { type Ref, useId } from "react";
import type { Counts, Progress } from "../../shared/types";
import { InvisiblesToggle } from "../code/Invisibles";
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
 * Reviewed fills from the left; crossed off is hatched at the right end.
 * `incomplete`: something is still unreviewed even if the counts look full
 * (a rename weighs nothing in lines), so the meter is never shown full.
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
	const raw = (n: number) =>
		counts.total === 0 ? 0 : (n / counts.total) * 100;
	let reviewed = raw(counts.reviewed);
	let crossed = raw(counts.crossedOff);
	if (incomplete) {
		const over = reviewed + crossed - (100 - OPEN_GAP);
		if (over > 0) {
			const fromReviewed = Math.min(reviewed, over);
			reviewed -= fromReviewed;
			crossed = Math.max(0, crossed - (over - fromReviewed));
		}
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
}) {
	const { progress, unit } = props;
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
			className="sticky top-[var(--app-header,0px)] z-20 border-b border-line bg-canvas py-2"
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<div className="flex shrink-0 items-center gap-2">
					<UnitPicker unit={unit} onChange={props.onUnitChange} />
					<InvisiblesToggle />
				</div>
				<div
					role="progressbar"
					aria-label="Review progress"
					aria-valuenow={value}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuetext={
						empty
							? `Nothing left to review: ${summary}`
							: `${value}%, ${summary}${hiddenLeft ? `, ${note}` : ""}`
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
					</span>
				</div>
			</div>
			{hiddenLeft && <p className="mt-1 text-xs text-warn">{note}</p>}
		</div>
	);
}
