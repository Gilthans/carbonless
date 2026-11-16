/**
 * Whether the review conversation's drawer is open: one drawer per page,
 * toggled from the header chip. It survives tab switches inside the review
 * (Overview, Files changed) and is not kept across reloads (in memory only,
 * never in storage).
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
const set = (next: boolean) => {
	if (open === next) return;
	open = next;
	for (const l of listeners) l();
};

/** onClick handlers: take no argument. */
export const openReviewDrawer = (): void => set(true);
export const closeReviewDrawer = (): void => set(false);
export const toggleReviewDrawer = (): void => set(!open);

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
};
const getOpen = () => open;

/** Whether the drawer is open now (outside React). */
export const isReviewDrawerOpen = (): boolean => open;

export function useReviewDrawerOpen(): boolean {
	return useSyncExternalStore(subscribe, getOpen, getOpen);
}
