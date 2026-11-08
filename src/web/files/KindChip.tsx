import type { ClusterKind } from "../../shared/types";
import { Tooltip } from "../Tooltip";

/** A chip's colors by what happened to the cluster (the design tokens). */
type ChipKind = ClusterKind | "conflict" | "reverted" | "removed";

const TONE: Record<ChipKind, string> = {
	reworked: "border-warn text-warn",
	new: "border-warn text-warn",
	carried: "border-ok text-ok",
	gone: "border-bad text-bad",
	conflict: "border-bad text-bad",
	reverted: "border-bad text-bad",
	removed: "border-bad text-bad",
};

/** What each chip means, in its tooltip. */
export function kindTip(
	kind: ChipKind,
	from?: number,
	rule?: "exact" | "rename",
): string {
	const ps = from === undefined ? "the compared patch set" : `PS${from}`;
	switch (kind) {
		case "reworked":
			return `Reviewed on ${ps}; the author changed it since`;
		case "new":
			return `Not in ${ps}`;
		case "carried":
			return `The same change as on ${ps}: your mark carried over${
				rule === "rename" ? " (the file was renamed)" : ""
			}`;
		case "gone":
			return `Reviewed on ${ps}; no longer in this snapshot`;
		case "conflict":
			return "git could not rebase this file, so all of it is new to read";
		case "reverted":
			return `Back to the base's version since ${ps}`;
		case "removed":
			return `Removed since ${ps}`;
	}
}

/**
 * What happened to a cluster, or a file, since the compared patch set:
 * "reworked", "new", "carried", "gone", "conflict" (a count before the word
 * on a file header: "4 carried"). Icon-first: the color says it, the
 * tooltip explains it.
 */
export function KindChip(props: {
	kind: ChipKind;
	count?: number;
	from?: number;
	rule?: "exact" | "rename";
	className?: string;
}) {
	const text =
		props.count === undefined ? props.kind : `${props.count} ${props.kind}`;
	return (
		<Tooltip content={kindTip(props.kind, props.from, props.rule)}>
			{(trigger) => (
				<span
					{...trigger}
					data-testid="kind-chip"
					data-kind={props.kind}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus.
					tabIndex={0}
					className={`inline-flex h-5 items-center rounded-full border px-2 font-sans text-[11px] leading-none whitespace-nowrap select-none focus-visible:outline-2 focus-visible:outline-accent ${TONE[props.kind]} ${props.className ?? ""}`}
				>
					{text}
				</span>
			)}
		</Tooltip>
	);
}
