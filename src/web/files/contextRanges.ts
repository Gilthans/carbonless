import { useSyncExternalStore } from "react";

export type ContextRange = readonly [from: number, to: number];

const NONE: readonly ContextRange[] = [];
const NO_FILES: ReadonlyMap<number, readonly ContextRange[]> = new Map();

const byFile = new Map<string, readonly ContextRange[]>();
/** Per revision, the files' ranges by index; rebuilt only when one changes. */
const byRevision = new Map<
	string,
	ReadonlyMap<number, readonly ContextRange[]>
>();
const listeners = new Set<() => void>();

const keyOf = (revision: string, index: number) => `${revision}:${index}`;
const subscribe = (onChange: () => void) => {
	listeners.add(onChange);
	return () => listeners.delete(onChange);
};

const get = (revision: string, index: number) =>
	byFile.get(keyOf(revision, index)) ?? NONE;

function useRanges(revision: string, index: number): readonly ContextRange[] {
	return useSyncExternalStore(subscribe, () => get(revision, index));
}

function useAllRanges(
	revision: string,
): ReadonlyMap<number, readonly ContextRange[]> {
	return useSyncExternalStore(
		subscribe,
		() => byRevision.get(revision) ?? NO_FILES,
	);
}

/**
 * The context ranges each file has expanded, per snapshot (keyed by
 * revision and file index), kept for the page: a closed file reopens with
 * its context, and the search sees it whether the file is open or not.
 * View state only (owner's decision, 2026-11-05).
 */
export const contextRanges = {
	get,
	/** Adds a range once (the same `from`/`to` twice is one). */
	add(revision: string, index: number, from: number, to: number): void {
		const key = keyOf(revision, index);
		const have = byFile.get(key) ?? NONE;
		if (have.some(([f, t]) => f === from && t === to)) return;
		const next = [...have, [from, to] as const];
		byFile.set(key, next);
		const files = new Map(byRevision.get(revision));
		files.set(index, next);
		byRevision.set(revision, files);
		for (const listener of [...listeners]) listener();
	},
	use: useRanges,
	/** Every file's ranges of `revision`, by index (only files with some). */
	useAll: useAllRanges,
	/** Forgets everything (tests). */
	reset(): void {
		byFile.clear();
		byRevision.clear();
		for (const listener of [...listeners]) listener();
	},
};
