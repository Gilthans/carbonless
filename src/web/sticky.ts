import { createContext, useContext, useLayoutEffect, useState } from "react";

/**
 * The rendered height in px of the element `find` returns, kept current as it
 * changes (sticky bars wrap differently by width and content). `key` says
 * when to look the element up again. While `paused` (its page is hidden, so
 * it measures 0) it keeps the last height, and measures again once resumed.
 */
export function useHeight(
	find: () => HTMLElement | null,
	key: unknown,
	paused = false,
) {
	const [height, setHeight] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: looked up again when `key` changes.
	useLayoutEffect(() => {
		if (paused) return;
		const node = find();
		if (!node) {
			setHeight(0);
			return;
		}
		const measure = () => setHeight(node.offsetHeight);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [key, paused]);
	return height;
}

/**
 * The app header's stuck (compact) height in px: the top of the page's own
 * sticky stack. Also on the root element as `--app-header`, for CSS.
 */
export const AppHeaderHeight = createContext(0);

export const useAppHeaderHeight = () => useContext(AppHeaderHeight);

/**
 * Keeps a sticky sidebar's bottom `gap` px above the viewport's: its
 * max-height is what is left below its top, which is lower than its stuck
 * top until the page scrolls that far. A height fixed at the stuck size
 * would run past the viewport there, and the end of its list could only be
 * reached by scrolling the page as well. Set on the element directly
 * (scrolling re-renders nothing); the CSS max-height stays as the fallback.
 */
export function useFitViewport(ref: { current: HTMLElement | null }, gap = 16) {
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		let frame = 0;
		let last = "";
		const resize = () => {
			frame = 0;
			// Pushed up by the end of its container, it keeps its stuck height.
			const stuck = Number.parseFloat(getComputedStyle(node).top) || 0;
			const top = Math.max(node.getBoundingClientRect().top, stuck);
			const next = `${Math.max(0, window.innerHeight - top - gap)}px`;
			// Stuck, it stays the same frame after frame: no write.
			if (next !== last) node.style.maxHeight = last = next;
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(resize);
		};
		resize();
		window.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		// Content above it (a banner, a wrapping bar) moves it without a scroll.
		const observer =
			typeof ResizeObserver === "undefined"
				? undefined
				: new ResizeObserver(schedule);
		observer?.observe(document.body);
		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
			observer?.disconnect();
			node.style.maxHeight = "";
		};
	}, [ref, gap]);
}
