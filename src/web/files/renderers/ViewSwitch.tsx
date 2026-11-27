import {
	AlertFillIcon,
	FileBinaryIcon,
	FileCodeIcon,
	FileIcon,
	FileMediaIcon,
	type Icon,
	MirrorIcon,
	StackIcon,
} from "@primer/octicons-react";
import { useId } from "react";
import type { FileSummary } from "../../../shared/types";
import { Tooltip } from "../../Tooltip";
import type { CompareMode } from "./image/ImageCompare";
import { type RendererFile, type RendererId, rendererChoices } from "./index";

/** One way to see a file: a renderer, and for Image its compare mode. */
export type ViewId = CompareMode | RendererId;

export interface ViewOption {
	id: ViewId;
	renderer: RendererId;
	mode?: CompareMode;
	label: string;
	icon: Icon;
}

const IMAGE_MODES: ViewOption[] = [
	{
		id: "slider",
		renderer: "image",
		mode: "slider",
		label: "Slider",
		icon: MirrorIcon,
	},
	{
		id: "fade",
		renderer: "image",
		mode: "fade",
		label: "Fade",
		icon: StackIcon,
	},
];
const IMAGE: ViewOption = {
	id: "image",
	renderer: "image",
	label: "Image",
	icon: FileMediaIcon,
};
const RENDERED: ViewOption = {
	id: "markdown",
	renderer: "markdown",
	label: "Rendered",
	icon: FileIcon,
};
const OTHERS: Record<"text" | "binary", ViewOption> = {
	text: { id: "text", renderer: "text", label: "Text", icon: FileCodeIcon },
	binary: {
		id: "binary",
		renderer: "binary",
		label: "Binary",
		icon: FileBinaryIcon,
	},
};

/**
 * The view switch's buttons for `file`: Image first (as Slider and Fade
 * when `modes`: two versions in the unified view; else one Image button),
 * or Rendered (a Markdown file), then Text, then Binary, each only where
 * `rendererChoices` offers it.
 * None for a file with one renderer: it gets no switch at all.
 */
export function viewOptions(file: RendererFile, modes: boolean): ViewOption[] {
	const choices = rendererChoices(file);
	if (choices.length < 2) return [];
	const out: ViewOption[] = [];
	if (choices.includes("image")) out.push(...(modes ? IMAGE_MODES : [IMAGE]));
	if (choices.includes("markdown")) out.push(RENDERED);
	for (const id of ["text", "binary"] as const)
		if (choices.includes(id)) out.push(OTHERS[id]);
	return out;
}

/**
 * Whether Image compares two versions on one stage, so Slider and Fade
 * apply: decided once from the file's facts (not from what has loaded), so
 * the switch keeps its shape in every view and state.
 */
export function imageModesOf(
	file: Pick<FileSummary, "status" | "sameBlob">,
	sideBySide: boolean,
): boolean {
	return (
		file.status !== "added" &&
		file.status !== "deleted" &&
		!file.sameBlob &&
		!sideBySide
	);
}

/** The pressed button: the renderer shown, and Image's mode when split. */
export function pressedView(
	renderer: RendererId,
	mode: CompareMode,
	modes: boolean,
): ViewId {
	return renderer === "image" ? (modes ? mode : "image") : renderer;
}

/**
 * The row the view switch sits in (over Text and Binary, over a Markdown
 * file's Rendered view, the image toolbar), marked `data-view-bar`: pinned
 * under the file's sticky header (`--file-head`, FileDiff) while any of
 * what it sits over is on screen, so the view can be swapped mid-file
 * (CAR-317). In the flow, so it pushes what follows and never covers the
 * header; the stack's other readers (stickyBottom, the cluster controls)
 * count it.
 */
export const VIEW_BAR =
	"sticky top-[calc(var(--app-header,0px)+var(--files-bar,0px)+var(--file-head,0px))] z-[9] flex min-h-12 flex-wrap items-center gap-2 border-line border-b bg-band px-2 py-1";

export const ICON_BUTTON =
	"flex h-10 w-10 items-center justify-center text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent aria-pressed:bg-pressed aria-pressed:text-ink";

/**
 * How the file is shown, as one segmented control of icon buttons (in the
 * image toolbar, or a row of its own over Text and Binary). Choosing only
 * changes the view (`onPick`): never a review state. The pressed one does
 * nothing.
 */
export function ViewSwitch(props: {
	options: readonly ViewOption[];
	pressed: ViewId;
	onPick: (option: ViewOption) => void;
	/**
	 * Why a view isn't shown though it was the file's (Rendered fell back
	 * to Text by itself): a warning mark on its button, said in its tooltip.
	 */
	warn?: Partial<Record<ViewId, string>>;
}) {
	const warnId = useId();
	if (props.options.length === 0) return null;
	return (
		// biome-ignore lint/a11y/useSemanticElements: a named group of toggle buttons; a fieldset is for form fields.
		<div
			role="group"
			aria-label="View"
			data-testid="view-switch"
			className="inline-flex overflow-hidden rounded-lg border border-line-strong"
		>
			{props.options.map((option) => {
				const ViewIcon = option.icon;
				const warning = props.warn?.[option.id];
				return (
					<Tooltip
						key={option.id}
						content={warning ? `${option.label}: ${warning}` : option.label}
						describe={false}
					>
						{(trigger) => (
							<button
								type="button"
								{...trigger}
								aria-label={option.label}
								aria-describedby={
									warning ? `${warnId}-${option.id}` : undefined
								}
								aria-pressed={props.pressed === option.id}
								// The shown one again does nothing (no pick is kept).
								onClick={() => {
									if (props.pressed !== option.id) props.onPick(option);
								}}
								className={`${ICON_BUTTON} not-first:border-line-strong not-first:border-l`}
							>
								<span className="relative flex">
									<ViewIcon aria-hidden size={20} />
									{warning && (
										<span
											id={`${warnId}-${option.id}`}
											data-testid="view-warn"
											className="absolute -top-1.5 -right-2 flex rounded-full bg-band text-warn"
										>
											<AlertFillIcon aria-hidden size={12} />
											<span className="sr-only">{warning}</span>
										</span>
									)}
								</span>
							</button>
						)}
					</Tooltip>
				);
			})}
		</div>
	);
}
