/**
 * Whether the agent setup modal is open: one modal per page (AgentSetupHost),
 * opened from the chip, the Overview's row or a waiting thread's button.
 * The modal itself gives focus back to what opened it.
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
const set = (next: boolean) => {
	if (open === next) return;
	open = next;
	for (const l of listeners) l();
};

export const openAgentSetup = (): void => set(true);
export const closeAgentSetup = (): void => set(false);

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
