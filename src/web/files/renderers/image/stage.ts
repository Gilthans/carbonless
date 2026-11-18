/**
 * The image stage's geometry (spec "Unified view", the owner's rule for a
 * size change): the stage is the larger width by the larger height of the
 * two images, scaled to fit; each image keeps its own size, pinned top-left.
 */

export interface Size {
	w: number;
	h: number;
}

/** A rectangle in stage pixels; always pinned top-left. */
export interface Rect {
	x: 0;
	y: 0;
	w: number;
	h: number;
}

export interface StageGeometry {
	/** The stage's size in pixels (scaled). */
	w: number;
	h: number;
	/** Image pixels to stage pixels: at most 1 (Fit never enlarges). */
	scale: number;
	/**
	 * Some side has a real size. False when none does (an SVG with no
	 * width or height reads 0×0): the stage is a 4:3 placeholder of the
	 * box's width, and no dimensions are shown.
	 */
	sized: boolean;
	before?: Rect;
	after?: Rect;
}

/** The placeholder's height per unit of width (4:3). */
export const PLACEHOLDER_RATIO = 3 / 4;

const hasSize = (s: Size | null): s is Size => s !== null && s.w > 0 && s.h > 0;

/**
 * The stage for `before` and `after` (null: no such side) in a box `box`
 * pixels wide (Infinity: 1:1). A side with no intrinsic size fills the stage.
 */
export function stageGeometry(
	before: Size | null,
	after: Size | null,
	box: number,
): StageGeometry {
	const sized = [before, after].filter(hasSize);
	if (sized.length === 0) {
		const w = box;
		const h = box * PLACEHOLDER_RATIO;
		const whole: Rect = { x: 0, y: 0, w, h };
		return {
			w,
			h,
			scale: 1,
			sized: false,
			...(before ? { before: whole } : {}),
			...(after ? { after: whole } : {}),
		};
	}
	const maxW = Math.max(...sized.map((s) => s.w));
	const maxH = Math.max(...sized.map((s) => s.h));
	const scale = Math.min(1, box / maxW);
	const w = maxW * scale;
	const h = maxH * scale;
	const rect = (s: Size): Rect =>
		hasSize(s)
			? { x: 0, y: 0, w: s.w * scale, h: s.h * scale }
			: { x: 0, y: 0, w, h };
	return {
		w,
		h,
		scale,
		sized: true,
		...(before ? { before: rect(before) } : {}),
		...(after ? { after: rect(after) } : {}),
	};
}

const KB = 1024;
const MB = 1024 * 1024;

/** [number text, unit] for `n` bytes. */
function bytesParts(n: number): [string, string] {
	if (n < KB) return [String(n), "B"];
	if (n < MB) return [String(Math.round(n / KB)), "KB"];
	const mb = n / MB;
	return [
		mb < 10 ? String(Math.round(mb * 10) / 10) : String(Math.round(mb)),
		"MB",
	];
}

/** `41 KB`, `2.1 MB`. */
export function formatBytes(n: number): string {
	return bytesParts(n).join(" ");
}

/** Before → after sizes, the unit once when both share it: `41 → 44 KB`. */
export function bytesPair(
	before: number | undefined,
	after: number | undefined,
): string {
	if (before === undefined && after === undefined) return "";
	if (before === undefined) return formatBytes(after as number);
	if (after === undefined) return formatBytes(before);
	const [b, bu] = bytesParts(before);
	const [a, au] = bytesParts(after);
	return bu === au ? `${b} → ${a} ${au}` : `${b} ${bu} → ${a} ${au}`;
}
