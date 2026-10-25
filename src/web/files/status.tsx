import { StackIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { FileView } from "../../shared/types";
import { Tooltip } from "../Tooltip";
import type { Unit } from "./unit";

export type FileProgress =
	| "not started"
	| "partly done"
	| "done"
	| "crossed off";

export function fileProgress(file: FileView): FileProgress {
	if (file.crossedOff) return "crossed off";
	if (file.done) return "done";
	return file.clusters.some((c) => c.state !== "unreviewed")
		? "partly done"
		: "not started";
}

/** The distinct reasons the file's clusters were crossed off with. */
export function crossOffReasons(file: FileView): string[] {
	const reasons = file.clusters.flatMap((c) =>
		c.state === "crossed-off" && c.reason ? [c.reason] : [],
	);
	return [...new Set(reasons)];
}

const ICON: Record<FileProgress, { glyph: string; className: string }> = {
	"not started": { glyph: "○", className: "text-slate-400" },
	"partly done": { glyph: "◐", className: "text-amber-600" },
	done: { glyph: "✓", className: "text-green-700" },
	"crossed off": { glyph: "⊘", className: "text-purple-600" },
};

/**
 * A glyph named by `label`. With `tooltip` it is focusable and shows the label
 * as a tooltip (alone, not inside another control).
 */
function NamedGlyph(props: {
	label: string;
	tooltip?: boolean;
	className: string;
	children: ReactNode;
}) {
	if (!props.tooltip) {
		return (
			<span role="img" aria-label={props.label} className={props.className}>
				{props.children}
			</span>
		);
	}
	return (
		<Tooltip content={props.label} describe={false}>
			{(trigger) => (
				<span
					{...trigger}
					role="img"
					aria-label={props.label}
					// Focusable so keyboard and touch users can read the tooltip.
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className={`${props.className} cursor-help rounded-sm focus-visible:outline-2 focus-visible:outline-blue-600`}
				>
					{props.children}
				</span>
			)}
		</Tooltip>
	);
}

export function StatusIcon({
	file,
	tooltip,
}: {
	file: FileView;
	tooltip?: boolean;
}) {
	const progress = fileProgress(file);
	const icon = ICON[progress];
	return (
		<NamedGlyph
			label={progress}
			tooltip={tooltip}
			className={`inline-block w-4 shrink-0 text-center ${icon.className}`}
		>
			{icon.glyph}
		</NamedGlyph>
	);
}

export function AddDel({ file }: { file: FileView }) {
	return (
		<span className="shrink-0 font-mono text-xs tabular-nums">
			<span className="text-green-700">+{file.additions}</span>{" "}
			<span className="text-red-700">−{file.deletions}</span>
		</span>
	);
}

/**
 * How much the file changes, in the unit: "+X −Y" in lines, the cluster count
 * in clusters, nothing in files.
 */
export function ChangeCount({
	file,
	unit,
	tooltip,
}: {
	file: FileView;
	unit: Unit;
	tooltip?: boolean;
}) {
	if (unit === "lines") return <AddDel file={file} />;
	if (unit === "files") return null;
	const n = file.clusters.length;
	const label = `${n} ${n === 1 ? "cluster" : "clusters"}`;
	return (
		<NamedGlyph
			label={label}
			tooltip={tooltip}
			className="inline-flex shrink-0 items-center gap-0.5 font-mono text-xs text-slate-600 tabular-nums"
		>
			{n}
			<StackIcon size={12} className="text-slate-400" />
		</NamedGlyph>
	);
}
