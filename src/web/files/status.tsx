import { StackIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { FileView } from "../../shared/types";
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
	"not started": { glyph: "○", className: "text-unreviewed" },
	"partly done": { glyph: "◐", className: "text-warn" },
	done: { glyph: "✓", className: "text-ok" },
	"crossed off": { glyph: "⊘", className: "text-done" },
};

/** Mouse handlers a decorative piece forwards to the header's one tooltip. */
export interface HoverProps {
	onMouseEnter: () => void;
	onMouseLeave: () => void;
}

/**
 * A glyph named by `label`. With `hover` it is decorative (hidden from
 * assistive tech): the header's one focusable summary carries the name, and
 * hovering the glyph shows that same tooltip.
 */
function NamedGlyph(props: {
	label: string;
	hover?: HoverProps;
	className: string;
	children: ReactNode;
}) {
	if (!props.hover) {
		return (
			<span role="img" aria-label={props.label} className={props.className}>
				{props.children}
			</span>
		);
	}
	return (
		<span
			aria-hidden
			onMouseEnter={props.hover.onMouseEnter}
			onMouseLeave={props.hover.onMouseLeave}
			className={`${props.className} cursor-help`}
		>
			{props.children}
		</span>
	);
}

export function StatusIcon({
	file,
	hover,
}: {
	file: FileView;
	hover?: HoverProps;
}) {
	const progress = fileProgress(file);
	const icon = ICON[progress];
	return (
		<NamedGlyph
			label={progress}
			hover={hover}
			className={`inline-block w-4 shrink-0 text-center ${icon.className}`}
		>
			{icon.glyph}
		</NamedGlyph>
	);
}

/** "2 clusters". */
export function clusterCount(file: FileView): string {
	const n = file.clusters.length;
	return `${n} ${n === 1 ? "cluster" : "clusters"}`;
}

export function AddDel({ file }: { file: FileView }) {
	return (
		<span className="shrink-0 font-mono text-xs tabular-nums">
			<span className="text-ok">+{file.additions}</span>{" "}
			<span className="text-bad">−{file.deletions}</span>
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
	hover,
}: {
	file: FileView;
	unit: Unit;
	hover?: HoverProps;
}) {
	if (unit === "lines") return <AddDel file={file} />;
	if (unit === "files") return null;
	const label = clusterCount(file);
	return (
		<NamedGlyph
			label={label}
			hover={hover}
			className="inline-flex shrink-0 items-center gap-0.5 font-mono text-xs text-muted tabular-nums"
		>
			{file.clusters.length}
			<StackIcon size={12} className="text-faint" />
		</NamedGlyph>
	);
}
