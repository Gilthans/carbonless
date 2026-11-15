/**
 * Renderers: how a file's body is shown (spec "The renderer seam").
 * Today's `DiffBody` is the text and binary renderers as it is; the image
 * renderer shows the picture and leaves review rows and threads to
 * `DiffBody` with its lines hidden. A renderer changes only the view:
 * never clusters, review states or coverage (principle 2).
 */
import { isImagePath } from "../../../shared/imageTypes";
import type { FileSummary } from "../../../shared/types";
import { mapSetting } from "../../viewSettings";

export type RendererId = "text" | "binary" | "image";

/** What a renderer reads of a file to claim it. */
export type RendererFile = Pick<
	FileSummary,
	"path" | "binary" | "submodule" | "lfs"
>;

export interface Renderer {
	id: RendererId;
	/** It shows `file` by default (the first that claims it does). */
	claims(file: RendererFile): boolean;
	/**
	 * How the reviewer ticks: the clusters one by one (`lines`), or one
	 * control for every unit of the file (`whole-file`, the header's
	 * action). The units themselves are the server's either way. A later
	 * non-text renderer (Markdown) may tick `lines` too.
	 */
	units: "lines" | "whole-file";
	/** The comment anchors it offers (later: `region`). */
	anchors: readonly ("file" | "lines" | "region")[];
}

/** An image path crb can draw: not an LFS pointer or a submodule. */
const drawable = (file: RendererFile) =>
	isImagePath(file.path) && !file.lfs && !file.submodule;

/** In claim order: the first that claims a file shows it. */
export const RENDERERS: readonly Renderer[] = [
	{
		id: "image",
		claims: drawable,
		units: "whole-file",
		anchors: ["file"],
	},
	{
		id: "binary",
		claims: (file) => file.binary,
		units: "whole-file",
		anchors: ["file"],
	},
	{
		id: "text",
		claims: (file) => !file.binary,
		units: "lines",
		anchors: ["file", "lines"],
	},
];

/**
 * The "Show as" menu for `file`, its default first. Text is never offered
 * for a binary file (the server sends no lines for one); an LFS pointer or
 * a submodule shows as it does today, with no other choice.
 */
export function rendererChoices(file: RendererFile): RendererId[] {
	const plain: RendererId = file.binary ? "binary" : "text";
	if (file.lfs || file.submodule) return [plain];
	if (isImagePath(file.path)) return ["image", plain];
	// An unknown binary may be an image (the server checks its bytes).
	return file.binary ? ["binary", "image"] : ["text"];
}

/**
 * How `file` is shown: the reviewer's pick when the menu offers it, else
 * the first renderer that claims the file, else text or binary.
 */
export function resolveRenderer(
	file: RendererFile,
	pick: RendererId | undefined,
): RendererId {
	if (pick !== undefined && rendererChoices(file).includes(pick)) return pick;
	return (
		RENDERERS.find((r) => r.claims(file))?.id ??
		(file.binary ? "binary" : "text")
	);
}

/** The reviewer's picks, path → renderer id (this viewer, local storage). */
export const rendererPicks = mapSetting<RendererId>("crb.files.renderer", [
	"text",
	"binary",
	"image",
]);
