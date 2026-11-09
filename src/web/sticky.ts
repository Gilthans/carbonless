import {
	createContext,
	useContext,
	useLayoutEffect,
	useState,
	useSyncExternalStore,
} from "react";

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
 * The top of the page's own sticky stack in px: the open find bar's height
 * (App's slot) plus the app header's stuck (compact) row, which a phone's
 * header leaves out while the bar shows. On the root element as
 * `--app-header`, for CSS, plus the visual viewport's pan (`--vv-top`,
 * `visualTop`).
 */
export const AppHeaderHeight = createContext(0);

export const useAppHeaderHeight = () => useContext(AppHeaderHeight);

/**
 * Where the find bar goes: App's slot at the very top of the page, above the
 * app header (null outside App: the bar renders in place).
 */
export const FindSlot = createContext<HTMLElement | null>(null);

let vvTop = 0;
const vvListeners = new Set<() => void>();
const subscribeVv = (onChange: () => void) => {
	vvListeners.add(onChange);
	return () => {
		vvListeners.delete(onChange);
	};
};
/**
 * How far the visual viewport is panned down the page while the find bar
 * shows (App: iOS's soft keyboard; never a pinch zoom), in px; 0 otherwise.
 * Also `--vv-top` on the root: the sticky stack sits that much lower.
 */
export const visualTop = {
	get: () => vvTop,
	use: () => useSyncExternalStore(subscribeVv, () => vvTop),
	set(top: number) {
		if (top === vvTop) return;
		vvTop = top;
		for (const listener of vvListeners) listener();
	},
};
