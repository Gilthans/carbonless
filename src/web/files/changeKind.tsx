import {
	DiffAddedIcon,
	DiffIgnoredIcon,
	DiffModifiedIcon,
	DiffRemovedIcon,
	DiffRenamedIcon,
	type Icon,
} from "@primer/octicons-react";
import type { FileStatus, FileSummary } from "../../shared/types";
import { Tooltip } from "../Tooltip";

type ChangedFile = Pick<
	FileSummary,
	"status" | "oldPath" | "oldMode" | "newMode" | "additions" | "deletions"
>;

/**
 * Shape and color per kind of change: a distinct shape for each (never color
 * alone), green added and red deleted as in any diff, yellow for an edit,
 * muted for a move or a change of type.
 */
const KIND: Record<FileStatus, { icon: Icon; className: string }> = {
	added: { icon: DiffAddedIcon, className: "text-ok" },
	deleted: { icon: DiffRemovedIcon, className: "text-bad" },
	modified: { icon: DiffModifiedIcon, className: "text-warn" },
	renamed: { icon: DiffRenamedIcon, className: "text-muted" },
	"type-changed": { icon: DiffIgnoredIcon, className: "text-muted" },
};

/**
 * What happened to the file, in a few words: "Added", "Deleted", "Modified",
 * "Renamed from <old>", "Type changed"; a mode change says so ("Mode
 * 100644 → 100755"), alone when nothing else changed.
 */
export function changeKindLabel(file: ChangedFile): string {
	const mode =
		file.oldMode && file.newMode && file.oldMode !== file.newMode
			? `mode ${file.oldMode} → ${file.newMode}`
			: null;
	switch (file.status) {
		case "added":
			return "Added";
		case "deleted":
			return "Deleted";
		case "renamed":
			return `Renamed from ${file.oldPath ?? "?"}`;
		case "type-changed":
			return mode ? `Type changed, ${mode}` : "Type changed";
		default:
			if (!mode) return "Modified";
			return file.additions + file.deletions === 0
				? `Mode changed: ${mode.slice(5)}`
				: `Modified, ${mode}`;
	}
}

/**
 * The file's kind of change as a small icon named by changeKindLabel. With
 * `tooltip` the label also shows on hover (the file header); without it the
 * icon sits in a control whose own tooltip says it (the tree row).
 */
export function ChangeKindIcon({
	file,
	tooltip = false,
	tone,
}: {
	file: ChangedFile;
	tooltip?: boolean;
	/** A color token class in place of the kind's own (the tree's renames). */
	tone?: string;
}) {
	const kind = KIND[file.status] ?? KIND.modified;
	const label = changeKindLabel(file);
	const icon = <kind.icon size={12} aria-hidden className="block" />;
	const className = `inline-flex shrink-0 items-center ${tone ?? kind.className}`;
	if (!tooltip) {
		return (
			<span
				role="img"
				aria-label={label}
				data-testid="change-kind"
				data-kind={file.status}
				className={className}
			>
				{icon}
			</span>
		);
	}
	return (
		<Tooltip content={label} describe={false}>
			{({ ref, onMouseEnter, onMouseLeave }) => (
				// Hover only: on touch and keyboard the path's tooltip says it.
				<span
					ref={ref}
					onMouseEnter={onMouseEnter}
					onMouseLeave={onMouseLeave}
					role="img"
					aria-label={label}
					data-testid="change-kind"
					data-kind={file.status}
					className={`${className} cursor-help`}
				>
					{icon}
				</span>
			)}
		</Tooltip>
	);
}
