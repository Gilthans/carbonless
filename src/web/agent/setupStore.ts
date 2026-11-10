/**
 * Whether the agent setup modal is open, and on which tab: one modal per
 * page (AgentSetupHost), opened from the chip, the Overview's row or a
 * waiting thread's button. The modal itself gives focus back to what
 * opened it.
 */
import { useSyncExternalStore } from "react";

/** Launch an agent (ACP), or join from a session (MCP). */
export type SetupTab = "launch" | "join";

let state: { open: boolean; tab: SetupTab } = { open: false, tab: "launch" };
const listeners = new Set<() => void>();
const set = (open: boolean, tab: SetupTab = state.tab) => {
	if (state.open === open && state.tab === tab) return;
	state = { open, tab };
	for (const l of listeners) l();
};

/** Opens the setup on its Launch tab (an onClick handler: takes no argument). */
export const openAgentSetup = (): void => set(true, "launch");
/** Opens the setup on its "Join from a session" tab. */
export const openJoinSetup = (): void => set(true, "join");
export const closeAgentSetup = (): void => set(false);
export const setAgentSetupTab = (tab: SetupTab): void => set(state.open, tab);

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
};
const getOpen = () => state.open;
const getTab = () => state.tab;

export function useAgentSetupOpen(): boolean {
	return useSyncExternalStore(subscribe, getOpen, getOpen);
}

export function useAgentSetupTab(): SetupTab {
	return useSyncExternalStore(subscribe, getTab, getTab);
}
