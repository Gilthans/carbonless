import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Where toasts sit: fixed at the bottom of the window, left of the save
 * notices (SyncNotices sits right from md up), above the floating Files
 * button on a phone; several stack upwards instead of covering each other.
 */
export const TOAST_PLACE =
	"pointer-events-none fixed inset-x-3 bottom-20 z-40 flex flex-col-reverse gap-2 sm:inset-x-auto sm:left-4 sm:w-96 md:bottom-4";

const Stack = createContext<HTMLElement | null>(null);

/** The one place every page's toasts go (the new-head toast, the update toast). */
export function ToastStack(props: { children: ReactNode }) {
	const [el, setEl] = useState<HTMLElement | null>(null);
	return (
		<Stack.Provider value={el}>
			{props.children}
			<div ref={setEl} data-testid="toast-stack" className={TOAST_PLACE} />
		</Stack.Provider>
	);
}

/** A toast, in the page's ToastStack; in a place of its own without one (component tests). */
export function ToastSlot(props: { children: ReactNode }) {
	const el = useContext(Stack);
	if (el) return createPortal(props.children, el);
	return <div className={TOAST_PLACE}>{props.children}</div>;
}
