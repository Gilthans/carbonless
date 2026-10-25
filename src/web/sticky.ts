import { createContext, useContext, useLayoutEffect, useState } from "react";

/**
 * The rendered height in px of the element `find` returns, kept current as it
 * changes (sticky bars wrap differently by width and content). `key` says
 * when to look the element up again.
 */
export function useHeight(find: () => HTMLElement | null, key: unknown) {
	const [height, setHeight] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: looked up again when `key` changes.
	useLayoutEffect(() => {
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
	}, [key]);
	return height;
}

/**
 * The app header's stuck (compact) height in px: the top of the page's own
 * sticky stack. Also on the root element as `--app-header`, for CSS.
 */
export const AppHeaderHeight = createContext(0);

export const useAppHeaderHeight = () => useContext(AppHeaderHeight);
