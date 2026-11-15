import {
	AlertIcon,
	type Icon,
	MirrorIcon,
	ScreenFullIcon,
	ScreenNormalIcon,
	StackIcon,
} from "@primer/octicons-react";
import { LabeledIcon } from "../../../overview/parts";
import { SkeletonBar } from "../../../Spinner";
import { Tooltip } from "../../../Tooltip";
import type { CompareMode } from "./ImageCompare";
import { dimsText, TONE_TEXT, type Tone } from "./ImageSingle";
import type { Size } from "./stage";

const MODES: { id: CompareMode; label: string; icon: Icon }[] = [
	{ id: "slider", label: "Slider", icon: MirrorIcon },
	{ id: "fade", label: "Fade", icon: StackIcon },
];

const ICON_BUTTON =
	"flex h-10 w-10 items-center justify-center text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent aria-pressed:bg-pressed aria-pressed:text-ink";

/** One side's dimensions in the toolbar: its size, or pending. */
export interface DimsSide {
	tone: Tone;
	/** undefined: still loading. */
	size: Size | undefined;
}

/**
 * The image view's toolbar: the compare mode (unified view only), the
 * dimensions (before red, after green; a skeleton until they're known)
 * and byte sizes, and Fit / 1:1.
 */
export function ImageToolbar(props: {
	mode?: CompareMode;
	onMode?: (mode: CompareMode) => void;
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
			{props.mode && props.onMode && (
				// biome-ignore lint/a11y/useSemanticElements: a named group of toggle buttons; a fieldset is for form fields.
				<div
					role="group"
					aria-label="Compare"
					className="inline-flex overflow-hidden rounded-lg border border-line-strong"
				>
					{MODES.map(({ id, label, icon: ModeIcon }) => (
						<Tooltip key={id} content={label} describe={false}>
							{(trigger) => (
								<button
									type="button"
									{...trigger}
									aria-label={label}
									aria-pressed={props.mode === id}
									onClick={() => props.onMode?.(id)}
									className={`${ICON_BUTTON} not-first:border-line-strong not-first:border-l`}
								>
									<ModeIcon aria-hidden size={20} />
								</button>
							)}
						</Tooltip>
					))}
				</div>
			)}
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
