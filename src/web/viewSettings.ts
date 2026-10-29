import { useSyncExternalStore } from "react";

/**
 * A remembered on/off view setting (Settings' switches): one value shared
 * by every view, kept for this viewer in localStorage. Storage is a
 * convenience only: when it's unavailable the default holds.
 */
export interface ViewSetting {
	readonly key: string;
	/** The stored choice, else the default. */
	read(): boolean;
	set(next: boolean): void;
	/** Sets the opposite of the value in hand (a shortcut's flip). */
	toggle(): void;
	/** Forgets the in-memory choice (tests), so the next read is from storage. */
	reset(): void;
	use(): boolean;
	/**
	 * Calls `onChange` synchronously inside `set()` when the value changes,
	 * before React re-renders: a chance to measure the page as it was.
	 */
	subscribe(onChange: () => void): () => void;
}

export function viewSetting(key: string, fallback: boolean): ViewSetting {
	let value: boolean | undefined;
	const listeners = new Set<() => void>();
	const read = () => {
		try {
			const stored = localStorage.getItem(key);
			return stored === "on" ? true : stored === "off" ? false : fallback;
		} catch {
			return fallback;
		}
	};
	const subscribe = (onChange: () => void) => {
		listeners.add(onChange);
		return () => listeners.delete(onChange);
	};
	const current = () => {
		value ??= read();
		return value;
	};
	const set = (next: boolean) => {
		const changed = value !== next;
		value = next;
		try {
			localStorage.setItem(key, next ? "on" : "off");
		} catch {
			// Storage is a convenience only.
		}
		if (changed) for (const listener of listeners) listener();
	};
	return {
		key,
		read,
		set,
		toggle: () => set(!current()),
		reset() {
			value = undefined;
		},
		use: () => useSyncExternalStore(subscribe, current),
		subscribe,
	};
}

/** "Show hidden characters": on unless turned off. */
export const showInvisibles = viewSetting("crb.code.invisibles", true);

/**
 * "Ignore whitespace": pairs whitespace-only changes in the diff
 * (src/web/files/whitespace.ts). Off unless turned on.
 */
export const ignoreWhitespace = viewSetting("crb.diff.ignoreWhitespace", false);

/** "Side by side": old left, new right (src/web/files/sideBySide.ts). Off unless turned on. */
export const sideBySide = viewSetting("crb.diff.sideBySide", false);
