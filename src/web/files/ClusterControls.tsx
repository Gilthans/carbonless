import { useContext } from "react";
import { crossedCount, partlyMarked, reviewedCount } from "../../shared/pieces";
import type { ClusterView } from "../../shared/types";
import { Tooltip, type TooltipTriggerProps } from "../Tooltip";
import { CONTROLS, SLOT, StackControls } from "./stickyControls";

/**
 * A cluster's controls. The checkbox is checked when reviewed; a crossed-off
 * cluster shows a mixed box named "Undo cross-off" and described by its note,
 * and clicking it makes the cluster unreviewed again, never reviewed. Next to
 * it, a toggle crosses the cluster off or undoes that (to unreviewed); a
 * reviewed cluster must be unchecked first.
 */
export function ClusterControls(props: {
	cluster: ClusterView;
	noteId?: string;
	onToggle: (cluster: ClusterView) => void;
	onCrossOff: (cluster: ClusterView) => void;
	/** An earlier patch set, as reviewed: the marks are locked. */
	readOnly?: boolean;
}) {
	const crossedOff = props.cluster.state === "crossed-off";
	// Marked one piece at a time, not all of it: a dash; a click reviews
	// the whole cluster.
	const partly = partlyMarked(props.cluster);
	const reviewed = props.cluster.state === "reviewed";
	const readOnly = props.readOnly === true;
	// On touch each control gets its own 40×40 target, out of the row's
	// height (it reaches into the rows around it, above them at z 6), so a
	// mis-tap can't reach the other one: stacked in a 40px column where the
	// cluster's own rows have room for it (StackControls), else side by side.
	// With a mouse they stay compact.
	const stack = useContext(StackControls);
	const target =
		"flex items-center justify-center pointer-coarse:h-10 pointer-coarse:w-10";
	const reach = stack ? "" : "pointer-coarse:-my-2.5";
	const box = (trigger: Partial<TooltipTriggerProps> = {}) => (
		<label
			{...trigger}
			data-testid="cluster-box-target"
			className={`${target} ${stack ? "pointer-coarse:-mt-2.5" : reach} ${readOnly ? "cursor-not-allowed" : "cursor-pointer"}`}
		>
			<input
				type="checkbox"
				aria-label={crossedOff ? "Undo cross-off" : "Mark cluster reviewed"}
				aria-describedby={crossedOff ? props.noteId : undefined}
				aria-checked={partly ? "mixed" : undefined}
				data-partly={partly || undefined}
				ref={(el) => {
					if (el) el.indeterminate = crossedOff || partly;
				}}
				checked={props.cluster.state === "reviewed"}
				disabled={readOnly}
				onChange={() => props.onToggle(props.cluster)}
				className={`h-3.5 w-3.5 cursor-pointer disabled:cursor-not-allowed ${
					crossedOff ? "accent-crossed" : "accent-ok-fill"
				}`}
			/>
		</label>
	);
	return (
		// The slot keeps its size while the controls float (stickyControls.ts).
		<span
			{...{ [SLOT]: "" }}
			data-stacked={stack || undefined}
			className={`block ${stack ? "pointer-coarse:relative pointer-coarse:h-5 pointer-coarse:w-10" : ""}`}
		>
			<span
				{...{ [CONTROLS]: "" }}
				className={`relative z-[5] flex w-fit items-center gap-1 rounded-md data-[stuck=end]:z-[6] data-[stuck=fixed]:z-[6] pointer-coarse:z-[6] pointer-coarse:gap-0 ${stack ? "pointer-coarse:absolute pointer-coarse:top-0 pointer-coarse:left-0 pointer-coarse:flex-col" : ""} data-[stuck]:bg-raised data-[stuck]:shadow-control data-[stuck]:ring-1 data-[stuck]:ring-line-strong`}
			>
				{readOnly ? (
					<Tooltip content={READ_ONLY_TIP} describe={false} lazy>
						{(trigger) => box(trigger)}
					</Tooltip>
				) : partly ? (
					<Tooltip content={partlyTip(props.cluster)} lazy>
						{(trigger) => box(trigger)}
					</Tooltip>
				) : (
					box()
				)}
				<Tooltip
					content={
						readOnly
							? READ_ONLY_TIP
							: crossedOff
								? "Undo cross-off"
								: reviewed
									? UNTICK_TO_CROSS
									: "Cross off cluster"
					}
					// Disabled, its reason is its description (its name says what it does).
					describe={readOnly || reviewed}
				>
					{({ ref, onMouseEnter, onMouseLeave, ...trigger }) => (
						// The wrapper takes the hover, so a disabled button still
						// explains itself; focus (and so tap) goes to the button.
						// biome-ignore lint/a11y/noStaticElementInteractions: hover only; the button inside is the control.
						<span
							ref={ref}
							onMouseEnter={onMouseEnter}
							onMouseLeave={onMouseLeave}
							className="flex [&>button:disabled]:pointer-events-none"
						>
							<button
								type="button"
								{...trigger}
								aria-label="Cross off cluster"
								aria-pressed={crossedOff}
								disabled={readOnly || reviewed}
								onClick={() => props.onCrossOff(props.cluster)}
								// Stacked under the box on touch, its glyph at the top of its
								// target: on the cluster's second row, not two rows down.
								className={`${target} ${stack ? "pointer-coarse:items-start" : reach} group/x rounded focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-30`}
							>
								<span
									aria-hidden
									className={`flex h-4 w-4 items-center justify-center rounded font-sans text-xs leading-none ${
										crossedOff
											? "bg-crossed-strong text-ink"
											: "text-done group-hover/x:bg-crossed/25"
									}`}
								>
									⊘
								</span>
							</button>
						</span>
					)}
				</Tooltip>
			</span>
		</span>
	);
}

/** "Partly reviewed: 3 of 10 lines" (and how many are crossed off). */
function partlyTip(cluster: ClusterView): string {
	const crossed = crossedCount(cluster);
	return `Partly reviewed: ${reviewedCount(cluster)} of ${cluster.lines} lines${
		crossed > 0 ? `, ${crossed} crossed off` : ""
	}`;
}

/** Why a reviewed cluster's cross-off is off (R21: untick it first). */
export const UNTICK_TO_CROSS = "Reviewed: untick to cross off";

/** Why a mark can't change on an earlier patch set. */
export const READ_ONLY_TIP = "Read-only: an earlier patch set, as reviewed";
