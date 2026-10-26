import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { usePageActive } from "../pageActive";

/** Marks the slot a cluster's controls sit in (first row of the cluster). */
export const SLOT = "data-sticky-slot";
/** Marks the controls that move; `data-stuck="true"` while they float. */
export const CONTROLS = "data-sticky-controls";
/** An opened review thread's row (ThreadRow): the floating controls stop above it. */
const THREAD_ROW = '[data-testid="thread-row"]';
/**
 * Room kept between floating controls and the cluster's end, in px. The
 * placement runs on the main thread (once per frame), so on a fast fling the
 * switch into or out of floating can trail the compositor's scroll by a
 * frame; while floating they are position: fixed and don't trail.
 */
const END_GAP = 2;

/** Where one cluster's controls go for the stack bottom `top` (viewport px). */
export function placeControls(m: {
	/** The stack's bottom: the open file header's bottom edge. */
	top: number;
	/** The slot's natural top, the cluster's bottom (viewport px). */
	slotTop: number;
	clusterBottom: number;
	/** How far the controls' tap targets reach above / below their box. */
	above: number;
	below: number;
	height: number;
}):
	| { mode: "static" }
	| { mode: "fixed"; top: number }
	| { mode: "end"; offset: number } {
	const { top, slotTop, clusterBottom, above, below, height } = m;
	// Its targets would slip under the stack: float them just below it.
	if (slotTop - above >= top) return { mode: "static" };
	const fixedTop = top + above;
	if (fixedTop + height + below + END_GAP <= clusterBottom) {
		return { mode: "fixed", top: fixedTop };
	}
	// The cluster's end is near: ride up with it.
	const offset = clusterBottom - END_GAP - below - height - slotTop;
	return offset > 0 ? { mode: "end", offset } : { mode: "static" };
}

/**
 * Where a cluster's floating controls stop (viewport px): its bottom, or the
 * first opened review thread below their slot, whichever comes first.
 */
export function runEnd(
	slotTop: number,
	clusterBottom: number,
	threadTops: number[],
): number {
	const next = threadTops.filter((t) => t > slotTop);
	return next.length ? Math.min(clusterBottom, ...next) : clusterBottom;
}

function reset(slot: HTMLElement, controls: HTMLElement) {
	if (!controls.hasAttribute("data-stuck")) return;
	controls.removeAttribute("data-stuck");
	controls.style.position = "";
	controls.style.top = "";
	controls.style.left = "";
	controls.style.transform = "";
	slot.style.width = "";
	slot.style.height = "";
}

/**
 * Keeps each cluster's checkbox and cross-off control on screen while any of
 * the cluster's rows are: they float right below the open file's sticky
 * header, then scroll away with the cluster's end, where the next cluster's
 * take over. CSS sticky can't do it: the diff's horizontal scroller is the
 * nearest scroll container. Only the controls move (fixed, or translated at
 * the end); their slot keeps its size, so the diff text never shifts.
 */
export function useStickyControls(
	root: RefObject<HTMLElement | null>,
	scroller: RefObject<HTMLElement | null>,
) {
	const kick = useRef<(() => void) | null>(null);
	// While the page is hidden nothing is placed: the controls keep their
	// places for when it shows again at the same scroll.
	const active = usePageActive();
	useEffect(() => {
		const box = root.current;
		if (!box || !active) return;
		let frame = 0;
		const update = () => {
			frame = 0;
			const header = box
				.closest("section")
				?.querySelector<HTMLElement>(":scope > header");
			if (!header) return;
			const top = header.getBoundingClientRect().bottom;
			const scrollLeft = scroller.current?.getBoundingClientRect().left ?? 0;
			const slots = box.querySelectorAll<HTMLElement>(`[${SLOT}]`);
			// Measure everything first, then write: one layout per frame.
			const plans = [...slots].map((slot) => {
				const controls = slot.querySelector<HTMLElement>(`[${CONTROLS}]`);
				const cluster = slot.closest("tbody");
				if (!controls || !cluster) return null;
				const s = slot.getBoundingClientRect();
				const c = controls.getBoundingClientRect();
				// An opened review thread inside the cluster ends the run the
				// controls follow: they don't float over the conversation.
				const clusterBottom = runEnd(
					s.top,
					cluster.getBoundingClientRect().bottom,
					[...cluster.querySelectorAll(THREAD_ROW)].map(
						(t) => t.getBoundingClientRect().top,
					),
				);
				let minTop = c.top;
				let maxBottom = c.bottom;
				for (const target of controls.children) {
					const r = target.getBoundingClientRect();
					minTop = Math.min(minTop, r.top);
					maxBottom = Math.max(maxBottom, r.bottom);
				}
				const place = placeControls({
					top,
					slotTop: s.top,
					clusterBottom,
					above: c.top - minTop,
					below: maxBottom - c.bottom,
					height: c.height,
				});
				return {
					slot,
					controls,
					place,
					width: s.width,
					height: s.height,
					left: Math.max(s.left, scrollLeft),
				};
			});
			for (const plan of plans) {
				if (!plan) continue;
				const { slot, controls, place } = plan;
				if (place.mode === "static") {
					reset(slot, controls);
					continue;
				}
				if (!controls.hasAttribute("data-stuck")) {
					slot.style.width = `${plan.width}px`;
					slot.style.height = `${plan.height}px`;
				}
				controls.setAttribute("data-stuck", place.mode);
				if (place.mode === "fixed") {
					controls.style.position = "fixed";
					controls.style.top = `${place.top}px`;
					controls.style.left = `${plan.left}px`;
					controls.style.transform = "";
				} else {
					controls.style.position = "";
					controls.style.top = "";
					controls.style.left = "";
					controls.style.transform = `translateY(${place.offset}px)`;
				}
			}
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		update();
		kick.current = schedule;
		const scrollBox = scroller.current;
		window.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		scrollBox?.addEventListener("scroll", schedule, { passive: true });
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(schedule);
		observer?.observe(box);
		return () => {
			kick.current = null;
			cancelAnimationFrame(frame);
			window.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
			scrollBox?.removeEventListener("scroll", schedule);
			observer?.disconnect();
		};
	}, [root, scroller, active]);
	// Rows change (lines load, a cluster's state flips): place them again.
	useLayoutEffect(() => {
		kick.current?.();
	});
}
