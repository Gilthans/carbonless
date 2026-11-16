import {
	AlertIcon,
	ScreenFullIcon,
	ScreenNormalIcon,
} from "@primer/octicons-react";
import type { ReactNode } from "react";
import { LabeledIcon } from "../../../overview/parts";
import { SkeletonBar } from "../../../Spinner";
import { Tooltip } from "../../../Tooltip";
import { ICON_BUTTON } from "../ViewSwitch";
import { dimsText, TONE_TEXT, type Tone } from "./ImageSingle";
import type { Size } from "./stage";

/** One side's dimensions in the toolbar: its size, or pending. */
export interface DimsSide {
	tone: Tone;
	/** undefined: still loading. */
	size: Size | undefined;
}

/**
 * The image view's toolbar: the view switch (Slider, Fade, the other
 * renderers: renderers/ViewSwitch), the dimensions (before red, after green; a skeleton until they're known)
 * and byte sizes, and Fit / 1:1.
 */
export function ImageToolbar(props: {
	/** The view switch (ViewSwitch), at its start. */
	view?: ReactNode;
	/** The sides whose dimensions show; none when no image is shown. */
	dims: DimsSide[];
	bytes: string;
	/** The image couldn't be shown: say so beside the sizes. */
	failed?: string;
	actual?: boolean;
	onActual?: (actual: boolean) => void;
}) {
	const pending = props.dims.some((d) => d.size === undefined);
	const known = props.dims.filter((d) => dimsText(d.size) !== "");
	return (
		<div className="flex min-h-12 flex-wrap items-center gap-2 border-line border-b bg-band px-2 py-1">
			{props.view}
			<span className="flex-1" />
			{props.failed && (
				<span className="flex h-10 w-10 items-center justify-center">
					<LabeledIcon
						icon={AlertIcon}
						label={props.failed}
						className="text-warn"
					/>
				</span>
			)}
			<span
				data-testid="image-dims"
				className="flex min-w-0 flex-wrap items-center gap-x-1 font-mono text-faint text-xs tabular-nums"
			>
				{pending ? (
					<SkeletonBar className="w-24" />
				) : (
					known.map((d, i) => (
						<span key={d.tone} className="contents">
							{i > 0 && <span aria-hidden>→</span>}
							{i > 0 && <span className="sr-only">to</span>}
							<span className={TONE_TEXT[d.tone]}>{dimsText(d.size)}</span>
						</span>
					))
				)}
				{props.bytes && (
					<span>
						{(pending || known.length > 0) && "· "}
						{props.bytes}
					</span>
				)}
			</span>
			{props.onActual && (
				<Tooltip
					content={props.actual ? "Fit to width" : "Actual size (1:1)"}
					describe={false}
					dismissKey={props.actual}
				>
					{(trigger) => (
						<button
							type="button"
							{...trigger}
							aria-label="Actual size"
							aria-pressed={props.actual ?? false}
							onClick={() => props.onActual?.(!props.actual)}
							className={`${ICON_BUTTON} rounded-md`}
						>
							{props.actual ? (
								<ScreenNormalIcon aria-hidden size={20} />
							) : (
								<ScreenFullIcon aria-hidden size={20} />
							)}
						</button>
					)}
				</Tooltip>
			)}
		</div>
	);
}
