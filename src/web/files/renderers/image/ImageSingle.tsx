import type { CSSProperties, ReactNode } from "react";
import { Spinner } from "../../../Spinner";
import {
	PLACEHOLDER_RATIO,
	type Rect,
	type Size,
	type StageGeometry,
	stageGeometry,
} from "./stage";
import type { ImageSide } from "./useImageSide";

/** Which side an image is, for its color: before red, after green. */
export type Tone = "del" | "add";

export const TONE_TEXT: Record<Tone, string> = {
	del: "text-del-ink",
	add: "text-add-ink",
};

const TONE_EDGE: Record<Tone, string> = {
	del: "outline-2 -outline-offset-2 outline-bad/55",
	add: "outline-2 -outline-offset-2 outline-ok/55",
};

/** `493×312`, or nothing for an image with no intrinsic size. */
export const dimsText = (size: Size | undefined) =>
	size && size.w > 0 && size.h > 0 ? `${size.w}×${size.h}` : "";

/** The stage's box: the geometry's size at Fit (never enlarged) or 1:1. */
function stageStyle(
	geometry: StageGeometry | null,
	actual: boolean,
): CSSProperties {
	if (!geometry?.sized) {
		return { width: "100%", aspectRatio: `1 / ${PLACEHOLDER_RATIO}` };
	}
	const ratio = `${geometry.w} / ${geometry.h}`;
	return actual
		? { width: geometry.w, maxWidth: "none", flex: "none", aspectRatio: ratio }
		: { width: "100%", maxWidth: geometry.w, aspectRatio: ratio };
}

/** An image's place in the stage, in percent of it: pinned top-left. */
function placeStyle(
	geometry: StageGeometry | null,
	rect: Rect | undefined,
): CSSProperties {
	if (!geometry?.sized || !rect)
		return { inset: 0, width: "100%", height: "100%" };
	return {
		left: 0,
		top: 0,
		width: `${(rect.w / geometry.w) * 100}%`,
		height: `${(rect.h / geometry.h) * 100}%`,
	};
}

/** The geometry once every given side is ready, else null (loading). */
export function readyGeometry(
	before: ImageSide | null,
	after: ImageSide | null,
): StageGeometry | null {
	const sides = [before, after].filter((s) => s !== null);
	if (sides.some((s) => s.state !== "ready")) return null;
	return stageGeometry(
		before?.size ?? null,
		after?.size ?? null,
		Number.POSITIVE_INFINITY,
	);
}

/**
 * The checkerboard stage. While loading, a placeholder ratio with the
 * shared spinner over it (principle 8); at 1:1 its frame scrolls, never
 * the page.
 */
export function Stage(props: {
	geometry: StageGeometry | null;
	actual: boolean;
	tone?: Tone;
	children: ReactNode;
}) {
	const busy = props.geometry === null;
	return (
		<div
			data-testid="image-stage-frame"
			className={`w-full min-w-0 ${props.actual ? "overflow-auto" : "flex justify-center"}`}
		>
			<div
				data-testid="image-stage"
				aria-busy={busy || undefined}
				style={stageStyle(props.geometry, props.actual)}
				// The slider's range is invisible: its focus shows on the stage.
				className={`checker relative overflow-hidden rounded has-[>input:focus-visible]:outline-2 has-[>input:focus-visible]:outline-accent ${
					props.tone ? TONE_EDGE[props.tone] : ""
				}`}
			>
				{props.children}
				{busy && (
					<div className="absolute inset-0 grid place-items-center">
						<Spinner label="Loading image" />
					</div>
				)}
			</div>
		</div>
	);
}

/** One side's `<img>` in the stage: hidden until every side is ready. */
export function StageImage(props: {
	side: ImageSide;
	alt: string;
	geometry: StageGeometry | null;
	rect: Rect | undefined;
}) {
	const { side } = props;
	if (!side.src) return null;
	return (
		<img
			src={side.src}
			alt={props.alt}
			draggable={false}
			onLoad={side.onLoad}
			onError={side.onError}
			style={placeStyle(props.geometry, props.rect)}
			className={`absolute block max-w-none object-contain ${
				props.geometry ? "" : "invisible"
			}`}
		/>
	);
}

/**
 * One version of an image: a side of side-by-side, or the only view of an
 * added, deleted or renamed-unchanged image. `label` sits above the stage
 * ("added", "deleted"); `caption` under it (side-by-side).
 */
export function ImageSingle(props: {
	side: ImageSide;
	alt: string;
	tone?: Tone;
	label?: string;
	caption?: { name: string; text: string };
	actual: boolean;
}) {
	const geometry =
		props.side.state === "ready"
			? stageGeometry(props.side.size ?? null, null, Number.POSITIVE_INFINITY)
			: null;
	return (
		<figure className="m-0 grid min-w-0 content-start gap-1.5">
			{props.label && props.tone && (
				<span
					className={`justify-self-start rounded px-2 py-1 font-semibold text-xs uppercase tracking-wide ${
						props.tone === "add" ? "bg-add text-add-ink" : "bg-del text-del-ink"
					}`}
				>
					{props.label}
				</span>
			)}
			<Stage geometry={geometry} actual={props.actual} tone={props.tone}>
				<StageImage
					side={props.side}
					alt={props.alt}
					geometry={geometry}
					rect={geometry?.before}
				/>
			</Stage>
			{props.caption && (
				<figcaption className="flex flex-wrap gap-2 font-mono text-faint text-xs tabular-nums">
					<span
						className={`font-sans font-semibold ${props.tone ? TONE_TEXT[props.tone] : ""}`}
					>
						{props.caption.name}
					</span>
					<span>{props.caption.text}</span>
				</figcaption>
			)}
		</figure>
	);
}
