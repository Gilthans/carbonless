import { useSyncExternalStore } from "react";

/**
 * A remembered view choice: one value shared by every view, kept for this
 * viewer in localStorage. Storage is a convenience only: when it's
 * unavailable the default holds (and a choice holds in memory for the page).
 */
export interface Remembered<T> {
	readonly key: string;
	/** The stored choice, else the default. */
	read(): T;
	set(next: T): void;
	/** Forgets the in-memory choice (tests), so the next read is from storage. */
	reset(): void;
	use(): T;
	/**
	 * Calls `onChange` synchronously inside `set()` when the value changes,
	 * before React re-renders: a chance to measure the page as it was.
	 */
	subscribe(onChange: () => void): () => void;
}

/** A remembered on/off view setting (Settings' switches). */
export interface ViewSetting extends Remembered<boolean> {
	/** Sets the opposite of the value in hand (a shortcut's flip). */
	toggle(): void;
}

/** A remembered number (a size the viewer dragged to), in whole units or not. */
export type NumberSetting = Remembered<number>;

interface Codec<T> {
	/** The value a stored string means; undefined when it means nothing. */
	parse(stored: string): T | undefined;
	format(value: T): string;
}

function remembered<T>(
	key: string,
	fallback: T,
	codec: Codec<T>,
	/** Keeps every read and stored value in range. */
	clamp: (value: T) => T = (value) => value,
): Remembered<T> & { current(): T } {
	let value: T | undefined;
	const listeners = new Set<() => void>();
	const read = () => {
		try {
			const stored = localStorage.getItem(key);
			const parsed = stored === null ? undefined : codec.parse(stored);
			return parsed === undefined ? fallback : clamp(parsed);
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
	const set = (raw: T) => {
		const next = clamp(raw);
		const changed = value !== next;
		value = next;
		try {
			localStorage.setItem(key, codec.format(next));
		} catch {
			// Storage is a convenience only.
		}
		if (changed) for (const listener of listeners) listener();
	};
	return {
		key,
		read,
		set,
		reset() {
			value = undefined;
		},
		use: () => useSyncExternalStore(subscribe, current),
		subscribe,
		current,
	};
}

const onOff: Codec<boolean> = {
	parse: (stored) =>
		stored === "on" ? true : stored === "off" ? false : undefined,
	format: (value) => (value ? "on" : "off"),
};

export function viewSetting(key: string, fallback: boolean): ViewSetting {
	const { current, ...setting } = remembered(key, fallback, onOff);
	return { ...setting, toggle: () => setting.set(!current()) };
}

const finite: Codec<number> = {
	parse: (stored) => {
		// Number("") is 0: a blank means nothing.
		const n = stored.trim() === "" ? Number.NaN : Number(stored);
		return Number.isFinite(n) ? n : undefined;
	},
	format: String,
};

/**
 * A remembered number. `clamp` keeps what is read and stored in range (a
 * stored value from another day, or a wild drag, never gets out of it).
 */
export function numberSetting(
	key: string,
	fallback: number,
	clamp?: (value: number) => number,
): NumberSetting {
	const { current: _, ...setting } = remembered(key, fallback, finite, clamp);
	return setting;
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
