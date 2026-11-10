import { useLayoutEffect } from "react";
import { visualTop } from "./sticky";

/**
 * How far the visual viewport is panned down the page: iOS's soft keyboard
 * leaves it shorter than the layout viewport and a scroll pans it first
 * (Android's resizes the layout viewport: `interactive-widget` in
 * index.html). A pinch zoom isn't followed (0).
 */
export function visualPan(vv: VisualViewport): number {
	return vv.scale > 1.01 ? 0 : Math.max(0, Math.round(vv.offsetTop));
}

/**
 * The page's sticky stack top on the root (`--app-header`): `stack` plus,
 * while the find bar shows (`follow`), the visual viewport's pan
 * (`--vv-top`, `visualTop`), so the bar and the stack under it keep to the
 * top of what's seen. Viewport events are read once a frame, and only a
 * changed pan is written.
 */
export function useStackTop(stack: number, follow: boolean) {
	useLayoutEffect(() => {
		const root = document.documentElement;
		const vv = follow ? window.visualViewport : null;
		let written = -1;
		const write = (top: number) => {
			if (top === written) return;
			written = top;
			root.style.setProperty("--vv-top", `${top}px`);
			root.style.setProperty("--app-header", `${stack + top}px`);
			visualTop.set(top);
		};
		write(vv ? visualPan(vv) : 0);
		let frame = 0;
		const schedule = () => {
			if (frame || !vv) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				write(visualPan(vv));
			});
		};
		vv?.addEventListener("scroll", schedule);
		vv?.addEventListener("resize", schedule);
		return () => {
			cancelAnimationFrame(frame);
			vv?.removeEventListener("scroll", schedule);
			vv?.removeEventListener("resize", schedule);
			root.style.removeProperty("--vv-top");
			root.style.removeProperty("--app-header");
			visualTop.set(0);
		};
	}, [stack, follow]);
}
