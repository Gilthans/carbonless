import { useCallback, useEffect, useState } from "react";

/**
 * The tree's sidebar view state, kept per PR like its folded folders
 * (folderFold.ts): which tab shows, which Threads regions are folded, and
 * whether resolved conversations are listed. View state only: nothing here
 * changes what is reviewed.
 */
export interface SidebarState {
	tab: "files" | "threads";
	/** The People region is folded. */
	peopleFolded: boolean;
	/** The AI region is folded. */
	aiFolded: boolean;
	showResolved: boolean;
}

export const SIDEBAR_DEFAULT: SidebarState = {
	tab: "files",
	peopleFolded: false,
	aiFolded: false,
	showResolved: false,
};

/** `crb:sidebar:<owner>/<repo>#<number>`. */
export const sidebarKey = (pr: {
	owner: string;
	repo: string;
	number: number;
}) => `crb:sidebar:${pr.owner}/${pr.repo}#${pr.number}`;

/** The stored state, each field checked; the default for anything missing or odd. */
export function readSidebar(key: string | null): SidebarState {
	if (!key) return SIDEBAR_DEFAULT;
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
		const o =
			raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const flag = (k: keyof SidebarState) =>
			typeof o[k] === "boolean" ? (o[k] as boolean) : SIDEBAR_DEFAULT[k];
		return {
			tab: o.tab === "threads" ? "threads" : "files",
			peopleFolded: flag("peopleFolded") as boolean,
			aiFolded: flag("aiFolded") as boolean,
			showResolved: flag("showResolved") as boolean,
		};
	} catch {
		return SIDEBAR_DEFAULT;
	}
}

/** Remembers the state; silently does nothing without storage. */
export function writeSidebar(key: string | null, state: SidebarState) {
	if (!key) return;
	try {
		localStorage.setItem(key, JSON.stringify(state));
	} catch {
		// Storage is a convenience only.
	}
}

/** The sidebar's state for the PR under `key` (null: in memory only), and its setter. */
export function useSidebarState(
	key: string | null,
): [SidebarState, (change: Partial<SidebarState>) => void] {
	const [held, setHeld] = useState(() => ({ key, state: readSidebar(key) }));
	// Another PR (or the key arriving once the session is in): its own state.
	const state = held.key === key ? held.state : readSidebar(key);
	useEffect(() => {
		if (held.key !== key) setHeld({ key, state: readSidebar(key) });
	}, [key, held.key]);
	const update = useCallback(
		(change: Partial<SidebarState>) =>
			setHeld((h) => {
				const base = h.key === key ? h.state : readSidebar(key);
				const next = { ...base, ...change };
				writeSidebar(key, next);
				return { key, state: next };
			}),
		[key],
	);
	return [state, update];
}
