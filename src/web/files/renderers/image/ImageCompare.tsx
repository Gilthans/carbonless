import { useState } from "react";
import { readyGeometry, Stage, StageImage } from "./ImageSingle";
import type { ImageSide } from "./useImageSide";

export type CompareMode = "slider" | "fade";

/**
 * Both versions on one stage (the unified view). Slider: after underneath,
 * before on top, each clipped at the handle; a range stretched over the
 * stage drags it (keys too). At 1:1 a swipe scrolls the stage's frame
 * instead, and only a 44px grip on the handle drags it. Fade: a range under the stage sets the before
 * image's opacity. The stage is the larger width by the larger height,
 * each image at its own size, pinned top-left (stage.ts).
 */
export function ImageCompare(props: {
	before: ImageSide;
	after: ImageSide;
	mode: CompareMode;
	actual: boolean;
}) {
	const { before, after, mode } = props;
	const [split, setSplit] = useState(50);
	const [fade, setFade] = useState(50);
	const geometry = readyGeometry(before, after);
	const ready = geometry !== null;
	const slider = mode === "slider";
	return (
		<div className="grid w-full min-w-0 justify-items-center gap-1">
			<Stage geometry={geometry} actual={props.actual}>
				{/* Slider: each side of the handle shows only its own image. */}
				<div
					data-testid="image-after-layer"
					className="absolute inset-0"
					style={slider ? { clipPath: `inset(0 0 0 ${split}%)` } : {}}
				>
					<StageImage
						side={after}
						alt="After"
						geometry={geometry}
						rect={geometry?.after}
					/>
				</div>
				<div
					data-testid="image-before-layer"
					className="absolute inset-0"
					style={
						slider
							? { clipPath: `inset(0 ${100 - split}% 0 0)` }
							: { opacity: 1 - fade / 100 }
					}
				>
					<StageImage
						side={before}
						alt="Before"
						geometry={geometry}
						rect={geometry?.before}
					/>
				</div>
				{ready && slider && (
					<>
						<div
							aria-hidden
							data-testid="image-split-handle"
							className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-ink shadow-control"
							style={{ left: `${split}%` }}
						>
							<span className="absolute top-1/2 left-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink shadow-control" />
						</div>
						<span className="pointer-events-none absolute top-1.5 left-1.5 rounded bg-canvas/85 px-1.5 py-1 font-semibold text-del-ink text-xs leading-none">
							before
						</span>
						<span className="pointer-events-none absolute top-1.5 right-1.5 rounded bg-canvas/85 px-1.5 py-1 font-semibold text-add-ink text-xs leading-none">
							after
						</span>
						<input
							type="range"
							min={0}
							max={100}
							step={1}
							value={split}
							onChange={(e) => setSplit(Number(e.currentTarget.value))}
							aria-label="Before/after split"
							aria-valuetext={`${split}% before`}
							style={{ touchAction: "pan-y" }}
							// At 1:1 a swipe scrolls the image: only the grip drags.
							className={`absolute inset-0 m-0 h-full w-full cursor-ew-resize opacity-0 ${
								props.actual ? "pointer-events-none" : ""
							}`}
						/>
						{props.actual && (
							<div
								aria-hidden
								data-testid="image-split-grip"
								className="absolute inset-y-0 w-11 -translate-x-1/2 cursor-ew-resize touch-none"
								style={{ left: `${split}%` }}
								onPointerDown={(e) => {
									e.currentTarget.setPointerCapture(e.pointerId);
									e.preventDefault();
								}}
								onPointerMove={(e) => {
									const grip = e.currentTarget;
									if (!grip.hasPointerCapture(e.pointerId)) return;
									const stage = grip.parentElement?.getBoundingClientRect();
									if (!stage || stage.width === 0) return;
									const at = ((e.clientX - stage.left) / stage.width) * 100;
									setSplit(Math.round(Math.min(100, Math.max(0, at))));
								}}
							/>
						)}
					</>
				)}
			</Stage>
			{ready && !slider && (
				<div className="flex w-full max-w-lg items-center gap-2.5 text-xs">
					<span className="font-semibold text-del-ink">before</span>
					<input
						type="range"
						min={0}
						max={100}
						step={1}
						value={fade}
						onChange={(e) => setFade(Number(e.currentTarget.value))}
						aria-label="Fade before to after"
						className="h-10 min-w-0 flex-1 accent-accent"
					/>
					<span className="font-semibold text-add-ink">after</span>
				</div>
			)}
		</div>
	);
}
