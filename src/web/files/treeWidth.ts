import { type RefObject, useLayoutEffect, useState } from "react";
import { numberSetting } from "../viewSettings";

/**
 * The desktop file tree's width, in px: its default (18rem), the sliver
 * either side may be squeezed to (the tree's floor, and what the diffs keep
 * at the tree's widest: enough to grab the handle and come back), and the
 * keyboard step.
 */
export const TREE_WIDTH = {
	default: 288,
	min: 24,
	sliver: 24,
	step: 16,
} as const;

/**
 * The widest the tree may be in `room` px (its row less the handle): all of
 * it but the diffs' sliver, never under the floor.
 */
export const treeWidthMax = (room: number) =>
	Math.max(TREE_WIDTH.min, Math.floor(room) - TREE_WIDTH.sliver);

/** `width` in whole px, between the floor and `max`. */
export const clampTreeWidth = (width: number, max: number) =>
	Math.min(max, Math.max(TREE_WIDTH.min, Math.round(width)));

/**
 * The remembered width (`crb.files.treeWidth`): whole px, never under the
 * floor. The row's maximum is applied when shown (useTreeWidth), so a width
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

/** The tree's width given `room` px for it and the diffs, and how to change it. */
export function useTreeWidth(room: number) {
	const stored = treeWidth.use();
	const max = treeWidthMax(room);
	return {
		width: clampTreeWidth(stored, max),
		min: TREE_WIDTH.min,
		max,
		set: (width: number) => treeWidth.set(clampTreeWidth(width, max)),
	};
}

/**
 * The room the tree column (the tree and its handle) shares with the diffs:
 * its row's width less the handle's, measured before paint and kept current
 * as the row (the window) or the handle changes size.
 */
export function useTreeRoom(column: RefObject<HTMLElement | null>): number {
	const [room, setRoom] = useState(() => window.innerWidth);
	useLayoutEffect(() => {
		const el = column.current;
		const row = el?.parentElement;
		if (!el || !row) return;
		const handle = el.querySelector<HTMLElement>('[role="separator"]');
		const measure = () =>
			setRoom(row.getBoundingClientRect().width - (handle?.offsetWidth ?? 0));
		measure();
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", measure);
			return () => window.removeEventListener("resize", measure);
		}
		const observer = new ResizeObserver(measure);
		observer.observe(row);
		if (handle) observer.observe(handle);
		return () => observer.disconnect();
	}, [column]);
	return room;
}
