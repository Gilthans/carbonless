import { useViewportWidth } from "../useMedia";
import { numberSetting } from "../viewSettings";

/** The desktop file tree's width, in px: its default (18rem), floor and keyboard step. */
export const TREE_WIDTH = { default: 288, min: 160, step: 16 } as const;

/** The widest the tree may be: half the window, so the diffs keep the rest. */
export const treeWidthMax = (viewport: number) =>
	Math.max(TREE_WIDTH.min, Math.floor(viewport / 2));

/** `width` in whole px, within the tree's range for this window. */
export const clampTreeWidth = (width: number, viewport: number) =>
	Math.min(treeWidthMax(viewport), Math.max(TREE_WIDTH.min, Math.round(width)));

/**
 * The remembered width (`crb.files.treeWidth`): whole px, never under the
 * floor. The window's half is applied when shown (useTreeWidth), so a width
 * chosen on a wide screen comes back once the window is wide again.
 */
export const treeWidth = numberSetting(
	"crb.files.treeWidth",
	TREE_WIDTH.default,
	(width) => Math.max(TREE_WIDTH.min, Math.round(width)),
);

/**
 * The width a key on the handle asks for, or null for a key it doesn't use:
 * arrows step (Shift: four steps), Home/End go to the ends, Enter resets.
 */
export function treeWidthKey(
	key: string,
	shift: boolean,
	at: { width: number; min: number; max: number },
): number | null {
	const step = TREE_WIDTH.step * (shift ? 4 : 1);
	const clamp = (w: number) => Math.min(at.max, Math.max(at.min, w));
	switch (key) {
		case "ArrowLeft":
			return clamp(at.width - step);
		case "ArrowRight":
			return clamp(at.width + step);
		case "Home":
			return at.min;
		case "End":
			return at.max;
		case "Enter":
			return clamp(TREE_WIDTH.default);
		default:
			return null;
	}
}

/** The tree's width for this window, and how to change it. */
export function useTreeWidth() {
	const stored = treeWidth.use();
	const viewport = useViewportWidth();
	return {
		width: clampTreeWidth(stored, viewport),
		min: TREE_WIDTH.min,
		max: treeWidthMax(viewport),
		set: (width: number) => treeWidth.set(clampTreeWidth(width, viewport)),
	};
}
