/**
 * Whether the agent setup modal is open, and on which tab: one modal per
 * page (AgentSetupHost), opened from the chip, the Overview's row or a
 * waiting thread's button. The modal itself gives focus back to what
 * opened it, or, opened over the review conversation's drawer
 * (openAgentSetupOver), to where that says (the drawer's composer). The tab is remembered in localStorage (`crb.agentSetup.tab`),
 * and in memory when storage throws.
 */
import { useSyncExternalStore } from "react";

/** Invite a running session (MCP), or spawn one (ACP). */
export type SetupTab = "invite" | "spawn";

export const TAB_KEY = "crb.agentSetup.tab";

/** The last tab chosen, for when localStorage can't say. */
let remembered: SetupTab = "invite";

const isTab = (v: unknown): v is SetupTab => v === "invite" || v === "spawn";

/** The stored tab: localStorage's, else the one remembered here, else Invite. */
function storedTab(): SetupTab {
	try {
		const v = localStorage.getItem(TAB_KEY);
		if (isTab(v)) return v;
	} catch {
		// Storage refused (a private window, blocked site data).
	}
	return remembered;
}

function store(tab: SetupTab): void {
	remembered = tab;
	try {
		localStorage.setItem(TAB_KEY, tab);
	} catch {
		// Remembered in memory only.
	}
}

let state: { open: boolean; tab: SetupTab } = { open: false, tab: "invite" };
const listeners = new Set<() => void>();
const set = (open: boolean, tab: SetupTab = state.tab) => {
	if (state.open === open && state.tab === tab) return;
	state = { open, tab };
	for (const l of listeners) l();
};

/** Where focus goes once the setup closes, when not back to what opened it. */
let returnFocus: (() => HTMLElement | null | undefined) | null = null;

/** Opens the setup on the stored tab (an onClick handler: takes no argument). */
export const openAgentSetup = (): void => {
	if (!state.open) returnFocus = null;
	set(true, storedTab());
};

/**
 * Opens the setup over something that opened with it (the review
 * conversation's drawer): once it closes, focus goes to what `back`
 * finds then, else back to what opened it.
 */
export const openAgentSetupOver = (
	back: () => HTMLElement | null | undefined,
): void => {
	returnFocus = back;
	set(true, storedTab());
};
export const closeAgentSetup = (): void => set(false);

/** Where focus goes as the setup closes (AgentSetup): `back`'s element, once. */
export function takeSetupReturnFocus(): HTMLElement | null {
	const back = returnFocus;
	returnFocus = null;
	const el = back?.() ?? null;
	return el?.isConnected ? el : null;
}

/** Whether the setup is open now (outside React). */
export const isAgentSetupOpen = (): boolean => state.open;
export const setAgentSetupTab = (tab: SetupTab): void => {
	store(tab);
	set(state.open, tab);
};

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
