import {
	createContext,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { usePageActive } from "../pageActive";

/**
 * Whether the cluster run around it stacks its touch controls (DiffBody's
 * STACK_ROWS): its controls stack, and the rows that open under its lines
 * later (a card, a composer, a phone's bubble row) keep clear of the
 * controls column, where the stacked cross-off hangs.
 */
export const StackControls = createContext(false);

/** Marks the slot a cluster's controls sit in (first row of the cluster). */
export const SLOT = "data-sticky-slot";
/** Marks the controls that move; `data-stuck="true"` while they float. */
export const CONTROLS = "data-sticky-controls";
/**
 * An opened review thread's row, or an agent conversation's (ThreadRow):
 * the floating controls stop above it.
 */
const THREAD_ROW =
	'[data-testid="thread-row"], [data-testid="agent-thread-row"]';
/**
 * Room kept between floating controls and the cluster's end, in px. The
 * placement runs on the main thread (once per frame), so on a fast fling the
 * switch into or out of floating can trail the compositor's scroll by a
 * frame; while floating they are position: fixed and don't trail.
 */
const END_GAP = 2;

/** How far right of the diff's visible left edge floating controls sit, in px (their ring shows). */
const SIDE_GAP = 2;

export type Placement =
	| { mode: "static" }
	/** Sideways only: translated right, in their row, to the visible edge. */
	| { mode: "shift"; x: number }
	| { mode: "fixed"; top: number; left: number }
	| { mode: "end"; offset: number; x: number };

/**
 * Where one cluster's controls go, on both axes: below the stack `top`
 * when their slot slips under it (vertically), and at the diff's visible
 * left edge `edge` when the diff is scrolled sideways past the slot.
 */
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
	/** The slot's natural left, and the diff scroller's left (viewport px). */
	slotLeft: number;
	edge: number;
}): Placement {
	const { top, slotTop, clusterBottom, above, below, height } = m;
	// Scrolled sideways past the slot (partly hidden behind the edge): moved
	// just clear of the edge. Not before: a slot still in view stays put.
	const x = m.slotLeft < m.edge ? m.edge + SIDE_GAP - m.slotLeft : 0;
	const sideways: Placement = x > 0 ? { mode: "shift", x } : { mode: "static" };
	// Its targets would slip under the stack: float them just below it.
	if (slotTop - above >= top) return sideways;
	const fixedTop = top + above;
	if (fixedTop + height + below + END_GAP <= clusterBottom) {
		return { mode: "fixed", top: fixedTop, left: m.slotLeft + x };
	}
	// The cluster's end is near: ride up with it.
	const offset = clusterBottom - END_GAP - below - height - slotTop;
	return offset > 0 ? { mode: "end", offset, x } : sideways;
}

/**
 * Where a cluster's floating controls stop (viewport px): its bottom, or the
 * first opened review thread below their slot that the stack (bottom at
 * `top`) hasn't passed yet, whichever comes first. So they ride up to a
 * thread, leave while it passes, and float again below it.
 */
export function runEnd(
	top: number,
	slotTop: number,
	clusterBottom: number,
	threads: { top: number; bottom: number }[],
): number {
	const next = threads
		.filter((t) => t.top > slotTop && t.bottom > top)
		.map((t) => t.top);
	return next.length ? Math.min(clusterBottom, ...next) : clusterBottom;
}

/** Each floating controls' last placement written: unchanged ones aren't written again. */
const written = new WeakMap<HTMLElement, string>();

function reset(slot: HTMLElement, controls: HTMLElement) {
	written.delete(controls);
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
 * take over. Scrolled sideways past their slot, they float at the diff's
 * visible left edge (in their row, or at the top-left corner of the code
 * while they float under the header too); the rest of the row scrolls.
 * CSS sticky can't do it: the diff's horizontal scroller is the nearest
 * scroll container, and a cell is too narrow to stick inside. Only the
 * controls move (fixed, or translated); their slot keeps its size, so the
 * diff text never shifts.
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
			const edge = scroller.current?.getBoundingClientRect().left ?? 0;
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
					top,
					s.top,
					cluster.getBoundingClientRect().bottom,
					[...cluster.querySelectorAll(THREAD_ROW)].map((t) => {
						const r = t.getBoundingClientRect();
						return { top: r.top, bottom: r.bottom };
					}),
				);
				let minTop = c.top;
				let maxBottom = c.bottom;
				for (const target of controls.children) {
					const r = target.getBoundingClientRect();
					minTop = Math.min(minTop, r.top);
					maxBottom = Math.max(maxBottom, r.bottom);
				}
				const placed = placeControls({
					top,
					slotTop: s.top,
					clusterBottom,
					above: c.top - minTop,
					below: maxBottom - c.bottom,
					height: c.height,
					slotLeft: s.left,
					edge,
				});
				// Sideways only, a cluster whose controls' targets are off
				// screen needn't float (nor be written every frame): it does
				// once a scroll brings it in.
				const offScreen =
					s.bottom + (maxBottom - c.bottom) < 0 ||
					s.top - (c.top - minTop) > window.innerHeight;
				const place: Placement =
					placed.mode === "shift" && offScreen ? { mode: "static" } : placed;
				return { slot, controls, place, width: s.width, height: s.height };
			});
			for (const plan of plans) {
				if (!plan) continue;
				const { slot, controls, place } = plan;
				if (place.mode === "static") {
					reset(slot, controls);
					continue;
				}
				const key = JSON.stringify(place);
				if (written.get(controls) === key) continue;
				written.set(controls, key);
				if (!controls.hasAttribute("data-stuck")) {
					slot.style.width = `${plan.width}px`;
					slot.style.height = `${plan.height}px`;
				}
				controls.setAttribute("data-stuck", place.mode);
				if (place.mode === "fixed") {
					controls.style.position = "fixed";
					controls.style.top = `${place.top}px`;
					controls.style.left = `${place.left}px`;
					controls.style.transform = "";
				} else {
					// In their row (or riding up with the cluster's end):
					// translated, so the slot and the text keep their places.
					controls.style.position = "";
					controls.style.top = "";
					controls.style.left = "";
					controls.style.transform =
						place.mode === "shift"
							? `translateX(${place.x}px)`
							: `translate(${place.x}px, ${place.offset}px)`;
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
