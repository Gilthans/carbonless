import { useEffect, useSyncExternalStore } from "react";

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
 * read it. The term lives only while the bar is open: closing clears it
 * (useFindScope closes the bar when the reviewer leaves the page).
 */
export const findState = {
	get: () => state,
	use: () => useSyncExternalStore(subscribe, () => state),
	subscribe,
	/** Opens (or, open already, asks the box to take focus again). */
	open,
	close() {
		if (state.open || state.term !== "")
			set({ ...state, open: false, term: "" });
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

/**
 * Keeps the find on the Files changed page of one review: leaving the page
 * (another tab, another review, Home: the header unmounts) closes the bar
 * and clears the term. Opening it from elsewhere (the header's button opens,
 * then navigates here) isn't leaving. A new revision of the same review
 * keeps it.
 */
export function useFindScope(onFiles: boolean, reviewId: string): void {
	useEffect(() => {
		if (!onFiles) findState.close();
	}, [onFiles]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: closes on each review change.
	useEffect(() => {
		return () => findState.close();
	}, [reviewId]);
}
