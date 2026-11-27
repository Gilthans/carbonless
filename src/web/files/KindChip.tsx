import type { ClusterKind } from "../../shared/types";
import { Tooltip } from "../Tooltip";

/** A chip's colors by what happened to the cluster (the design tokens). */
type ChipKind =
	| ClusterKind
	| "conflict"
	| "reverted"
	| "removed"
	| "unreviewed";

const TONE: Record<ChipKind, string> = {
	reworked: "border-warn text-warn",
	new: "border-warn text-warn",
	carried: "border-ok text-ok",
	gone: "border-bad text-bad",
	conflict: "border-bad text-bad",
	reverted: "border-bad text-bad",
	removed: "border-bad text-bad",
	unreviewed: "border-warn text-warn",
};

/** A chip's word: the kind's own, but an orphan run's (CAR-216) names the patch set. */
const wordOf = (kind: ChipKind, from?: number) =>
	kind === "unreviewed"
		? `not reviewed in ${from === undefined ? "the compared patch set" : `PS${from}`}`
		: kind;

/** What each chip means, in its tooltip. */
function kindTip(
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
		case "unreviewed":
			return `Unchanged since ${ps}, not reviewed there`;
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
	/** The tooltip, in place of the kind's own. */
	tip?: string;
	/** Its test id and data-kind, in place of the kind chip's own (a chip of lines). */
	testId?: string;
}) {
	const word = wordOf(props.kind, props.from);
	const text = props.count === undefined ? word : `${props.count} ${word}`;
	return (
		<Tooltip content={props.tip ?? kindTip(props.kind, props.from, props.rule)}>
			{(trigger) => (
				<span
					{...trigger}
					data-testid={props.testId ?? "kind-chip"}
					data-kind={props.testId ?? props.kind}
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
