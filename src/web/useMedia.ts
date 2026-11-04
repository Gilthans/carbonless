import { useSyncExternalStore } from "react";

/** Tailwind's `md`: the file tree gets a sidebar from here up. */
export const WIDE = "(min-width: 768px)";
/** Tailwind's `sm`: below it, small panels open as bottom sheets. */
export const NOT_PHONE = "(min-width: 640px)";

/** Whether the media query matches; true where matchMedia is unavailable. */
export function useMedia(query: string): boolean {
	return useSyncExternalStore(
		(onChange) => {
			if (typeof window.matchMedia !== "function") return () => {};
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		() =>
			typeof window.matchMedia === "function"
				? window.matchMedia(query).matches
				: true,
	);
}

const onResize = (onChange: () => void) => {
	window.addEventListener("resize", onChange);
	return () => window.removeEventListener("resize", onChange);
};

/** The window's width in CSS pixels, kept current as it is resized. */
export function useViewportWidth(): number {
	return useSyncExternalStore(onResize, () => window.innerWidth);
}
