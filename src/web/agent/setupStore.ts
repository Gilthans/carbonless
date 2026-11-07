/**
 * Whether the agent setup modal is open: one modal per page (AgentSetupHost),
 * opened from the chip, the Overview's row or a waiting thread's button.
 */
import { useSyncExternalStore } from "react";

let open = false;
/** What had focus when it opened: it gets it back on close. */
let opener: HTMLElement | null = null;
const listeners = new Set<() => void>();
const set = (next: boolean) => {
	open = next;
	for (const l of listeners) l();
};

export function openAgentSetup(): void {
	opener =
		typeof document !== "undefined" &&
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	set(true);
}

export function closeAgentSetup(): void {
	set(false);
	const back = opener;
	opener = null;
	if (back?.isConnected) back.focus();
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
};
const get = () => open;

export function useAgentSetupOpen(): boolean {
	return useSyncExternalStore(subscribe, get, get);
}
