import { StackIcon } from "@primer/octicons-react";
import type { ReactNode } from "react";
import type { FileView } from "../../shared/types";

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

/** What a change count reads: a file's, or a folder's sums. */
export type Changes = Pick<FileView, "additions" | "deletions" | "clusters">;

/** "2 clusters". */
export function clusterCount(file: Changes): string {
	const n = file.clusters.length;
	return `${n} ${n === 1 ? "cluster" : "clusters"}`;
}

/** "12 lines added, 3 deleted". */
export function lineCount(file: Changes): string {
	const lines = file.additions === 1 ? "line" : "lines";
	return `${file.additions} ${lines} added, ${file.deletions} deleted`;
}

/**
 * How much the file changes, whatever the unit: "+X −Y" in lines and the
 * cluster count. The unit only switches progress, never these.
 */
export function ChangeCount({
	file,
	hover,
}: {
	file: Changes;
	hover?: HoverProps;
}) {
	return (
		<span
			data-testid="change-count"
			className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums"
		>
			<NamedGlyph label={lineCount(file)} hover={hover} className="shrink-0">
				<span className="text-ok">+{file.additions}</span>{" "}
				<span className="text-bad">−{file.deletions}</span>
			</NamedGlyph>
			<NamedGlyph
				label={clusterCount(file)}
				hover={hover}
				className="inline-flex shrink-0 items-center gap-0.5 text-muted"
			>
				{file.clusters.length}
				<StackIcon size={12} className="text-faint" />
			</NamedGlyph>
		</span>
	);
}
