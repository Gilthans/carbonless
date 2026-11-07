import { useSyncExternalStore } from "react";

export interface FindState {
	open: boolean;
	term: string;
	/** Bumped by each open request: the box takes focus and selects its text. */
	focusSeq: number;
}

const initial: FindState = { open: false, term: "", focusSeq: 0 };

let state = initial;
const listeners = new Set<() => void>();

function set(next: FindState) {
	state = next;
	for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
	listeners.add(onChange);
	return () => {
		listeners.delete(onChange);
	};
}

function open() {
	set({ ...state, open: true, focusSeq: state.focusSeq + 1 });
}

/**
 * The bar's state, one for the page: the header's button and Files changed
 * read it. Closing keeps the term.
 */
export const findState = {
	get: () => state,
	use: () => useSyncExternalStore(subscribe, () => state),
	subscribe,
	/** Opens (or, open already, asks the box to take focus again). */
	open,
	close() {
		if (state.open) set({ ...state, open: false });
	},
	toggle() {
		if (state.open) findState.close();
		else open();
	},
	setTerm(term: string) {
		if (term !== state.term) set({ ...state, term });
	},
	reset() {
		set(initial);
	},
};
