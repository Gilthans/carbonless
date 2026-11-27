import { useSyncExternalStore } from "react";

/**
 * A remembered view choice: one value shared by every view, kept for this
 * viewer in localStorage. Storage is a convenience only: when it's
 * unavailable the default holds (and a choice holds in memory for the page).
 */
interface Remembered<T> {
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

/** A remembered pick among fixed values (a mode). */
export type ChoiceSetting<T extends string> = Remembered<T>;

/**
 * A remembered value per key (a path), kept as data (key → value): e.g.
 * how each file is shown, which a later change can learn preferences from.
 */
export interface MapSetting<V extends string> {
	readonly key: string;
	/** The value kept for `name`, if any. */
	get(name: string): V | undefined;
	set(name: string, value: V): void;
	/** Forgets the in-memory map (tests), so the next read is from storage. */
	reset(): void;
	use(name: string): V | undefined;
}

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

/** The find bar's "Match case" (Aa). Off unless turned on: case-insensitive, like the browser's find. */
export const matchCase = viewSetting("crb.find.matchCase", false);

/**
 * A remembered pick among `values`: a stored value it doesn't know (another
 * build's, a typo) reads as the default.
 */
export function choiceSetting<T extends string>(
	key: string,
	fallback: T,
	values: readonly T[],
): ChoiceSetting<T> {
	const codec: Codec<T> = {
		parse: (stored) =>
			(values as readonly string[]).includes(stored)
				? (stored as T)
				: undefined,
		format: (value) => value,
	};
	const { current: _, ...setting } = remembered(key, fallback, codec);
	return setting;
}

type Entries<V> = Readonly<Record<string, V>>;

/**
 * A remembered map from a name (a path) to one of `values`, stored as one
 * JSON object. Corrupt storage reads as empty; an entry whose value isn't
 * one of `values` is dropped.
 */
export function mapSetting<V extends string>(
	key: string,
	values: readonly V[],
): MapSetting<V> {
	const known = new Set<string>(values);
	const codec: Codec<Entries<V>> = {
		parse: (stored) => {
			let raw: unknown;
			try {
				raw = JSON.parse(stored);
			} catch {
				return undefined;
			}
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
				return undefined;
			}
			// No prototype: a name like "constructor" is only ever a stored one.
			const out: Record<string, V> = Object.create(null);
			for (const [name, value] of Object.entries(raw)) {
				if (typeof value === "string" && known.has(value)) {
					out[name] = value as V;
				}
			}
			return out;
		},
		format: (entries) => JSON.stringify(entries),
	};
	const store = remembered<Entries<V>>(key, Object.create(null), codec);
	const get = (entries: Entries<V>, name: string) =>
		Object.hasOwn(entries, name) ? entries[name] : undefined;
	return {
		key,
		get: (name) => get(store.current(), name),
		set(name, value) {
			// Onto what storage holds now (another tab may have picked
			// since), over this page's own (all of it while storage is blocked).
			const next: Record<string, V> = Object.assign(
				Object.create(null),
				store.current(),
				store.read(),
			);
			next[name] = value;
			store.set(next);
		},
		reset: store.reset,
		use: (name) =>
			useSyncExternalStore(store.subscribe, () => get(store.current(), name)),
	};
}

/** The image view's before/after comparison: a slider unless the fade was picked. */
export const imageMode = choiceSetting("crb.image.mode", "slider", [
	"slider",
	"fade",
] as const);
