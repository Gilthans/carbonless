import { useId } from "react";
import type { Counts, Progress } from "../../shared/types";
import {
	clustersLeft,
	pageCounts,
	pagePercent,
	UNITS,
	type Unit,
} from "./unit";

export const HATCH =
	"bg-[repeating-linear-gradient(135deg,#a855f7_0_3px,#d8b4fe_3px_6px)]";

/** Reviewed fills from the left; crossed off is hatched at the right end. */
export function Meter({
	counts,
	className = "",
}: {
	counts: Counts;
	className?: string;
}) {
	const share = (n: number) =>
		counts.total === 0 ? 0 : (n / counts.total) * 100;
	return (
		<div
			aria-hidden
			className={`relative overflow-hidden rounded-full bg-slate-200 ${className}`}
		>
			<div
				className="absolute inset-y-0 left-0 bg-green-600"
				style={{ width: `${share(counts.reviewed)}%` }}
			/>
			<div
				className={`absolute inset-y-0 right-0 ${HATCH}`}
				style={{ width: `${share(counts.crossedOff)}%` }}
			/>
		</div>
	);
}

/** Segmented Lines / Clusters / Files choice. */
function UnitPicker(props: { unit: Unit; onChange: (unit: Unit) => void }) {
	const name = useId();
	return (
		<fieldset className="flex shrink-0 rounded-md border border-slate-300 bg-white p-0.5 text-xs">
			<legend className="sr-only">Count progress in</legend>
			{UNITS.map((u) => (
				<label
					key={u.id}
					className="flex cursor-pointer items-center rounded px-2 py-1 font-medium text-slate-600 has-checked:bg-slate-800 has-checked:text-white has-focus-visible:outline-2 has-focus-visible:outline-blue-600 pointer-coarse:min-h-10 pointer-coarse:px-3"
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
	progress: Progress;
	unit: Unit;
	onUnitChange: (unit: Unit) => void;
}) {
	const { progress, unit } = props;
	const counts = pageCounts(progress, unit);
	const value = pagePercent(progress, unit);
	const word = UNITS.find((u) => u.id === unit)?.label.toLowerCase() ?? unit;
	const summary = `${counts.reviewed} / ${counts.total - counts.crossedOff} ${word} reviewed`;
	const left = clustersLeft(progress);
	// In lines, a rename or mode change weighs nothing: say it's still there.
	const hiddenLeft =
		unit === "lines" &&
		counts.total - counts.reviewed - counts.crossedOff === 0 &&
		left > 0;
	return (
		<div className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 py-2 backdrop-blur">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<UnitPicker unit={unit} onChange={props.onUnitChange} />
				<div
					role="progressbar"
					aria-label="Review progress"
					aria-valuenow={value}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuetext={`${value}%, ${summary}`}
					className="flex min-w-0 flex-1 basis-72 items-center gap-3"
				>
					<span className="w-11 shrink-0 text-right text-base font-semibold tabular-nums">
						{value}%
					</span>
					<Meter counts={counts} className="h-2.5 min-w-8 flex-1" />
					<span className="shrink-0 text-sm whitespace-nowrap text-slate-600 tabular-nums">
						{summary}
					</span>
				</div>
			</div>
			{hiddenLeft && (
				<p className="mt-1 text-xs text-amber-800">
					{left} {left === 1 ? "cluster" : "clusters"} without changed lines
					left
				</p>
			)}
		</div>
	);
}
