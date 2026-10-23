import type { Counts, Progress } from "../../shared/types";

/** Reviewed out of what isn't crossed off, floored; 100 when nothing is left to review. */
export function percent({ total, reviewed, crossedOff }: Counts): number {
	const denominator = total - crossedOff;
	return denominator === 0 ? 100 : Math.floor((reviewed / denominator) * 100);
}

function Bar({ label, counts }: { label: string; counts: Counts }) {
	const value = percent(counts);
	const share = (n: number) =>
		counts.total === 0 ? 0 : (n / counts.total) * 100;
	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuenow={value}
			aria-valuemin={0}
			aria-valuemax={100}
			className="min-w-0 flex-1"
		>
			<div className="flex items-baseline justify-between gap-2 text-sm">
				<span>
					<span className="font-semibold">{label}</span>{" "}
					<span className="text-lg font-semibold tabular-nums">{value}%</span>
				</span>
				<span className="text-slate-600 tabular-nums">
					{counts.reviewed} / {counts.total - counts.crossedOff} reviewed
				</span>
			</div>
			<div className="relative mt-1 h-2.5 overflow-hidden rounded-full bg-slate-200">
				<div
					className="absolute inset-y-0 left-0 bg-green-600"
					style={{ width: `${share(counts.reviewed)}%` }}
				/>
				<div
					className="absolute inset-y-0 right-0 bg-[repeating-linear-gradient(135deg,#a855f7_0_3px,#d8b4fe_3px_6px)]"
					style={{ width: `${share(counts.crossedOff)}%` }}
				/>
			</div>
		</div>
	);
}

/** Sticky review progress: clusters and lines, plus what's left and what was crossed off. */
export function ProgressBar({ progress }: { progress: Progress }) {
	const { clusters, lines, files } = progress;
	const left = (c: Counts) => c.total - c.reviewed - c.crossedOff;
	return (
		<div className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 py-3 backdrop-blur">
			<div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
				<Bar label="Clusters" counts={clusters} />
				<Bar label="Lines" counts={lines} />
			</div>
			<div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
				<span>
					Left: {left(clusters)} clusters · {left(lines)} lines ·{" "}
					{files.total - files.done} files
				</span>
				<span className="inline-flex items-center gap-1.5">
					<span
						aria-hidden
						className="inline-block h-2 w-3 rounded-sm bg-[repeating-linear-gradient(135deg,#a855f7_0_3px,#d8b4fe_3px_6px)]"
					/>
					<span>
						Crossed off, not reviewed: {clusters.crossedOff} clusters ·{" "}
						{lines.crossedOff} lines · {files.crossedOff} files
					</span>
				</span>
			</div>
		</div>
	);
}
