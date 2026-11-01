import { useState } from "react";
import type { FileView } from "../../shared/types";

/**
 * The tree's folded folders, per PR, for this viewer: view state only. It
 * never marks anything reviewed, never changes progress or which file Next
 * goes to; a folded folder still shows its accumulated progress.
 */

/** `crb:folds:<owner>/<repo>#<number>`. */
export const foldsKey = (pr: { owner: string; repo: string; number: number }) =>
	`crb:folds:${pr.owner}/${pr.repo}#${pr.number}`;

/** The folded folders' full paths; none when storage is empty, bad or unavailable. */
export function readFolds(key: string | null): Set<string> {
	if (!key) return new Set();
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
		return new Set(
			Array.isArray(parsed)
				? parsed.filter((p): p is string => typeof p === "string")
				: [],
		);
	} catch {
		return new Set();
	}
}

/** Remembers the folded folders; silently does nothing without storage. */
export function writeFolds(key: string | null, folded: ReadonlySet<string>) {
	if (!key) return;
	try {
		if (folded.size === 0) localStorage.removeItem(key);
		else localStorage.setItem(key, JSON.stringify([...folded]));
	} catch {
		// Storage is a convenience only.
	}
}

/** The folded folders among `folded` that hold `path` (a file's). */
export const foldedAncestors = (folded: ReadonlySet<string>, path: string) =>
	[...folded].filter((folder) => path.startsWith(`${folder}/`));

export interface Folds {
	folded: ReadonlySet<string>;
	toggle: (folder: string) => void;
}

/**
 * Fold state under `key` (null until the PR is known: in memory only). When
 * the current file changes to one inside folded folders, they unfold so it
 * shows; folding the current file's folder holds until it changes.
 */
export function useFolds(
	key: string | null,
	files: readonly FileView[],
	current: number | null,
): Folds {
	const [state, setState] = useState(() => ({
		key,
		folded: readFolds(key) as ReadonlySet<string>,
		current: null as number | null,
	}));
	let next = state;
	if (next.key !== key) {
		// The PR became known (or changed): its remembered folds.
		next = { key, folded: readFolds(key), current: next.current };
	}
	if (next.current !== current) {
		const path =
			current === null
				? undefined
				: files.find((f) => f.index === current)?.path;
		const reveal = path ? foldedAncestors(next.folded, path) : [];
		let folded = next.folded;
		if (reveal.length > 0) {
			const open = new Set(folded);
			for (const folder of reveal) open.delete(folder);
			folded = open;
			writeFolds(key, open);
		}
		next = { ...next, folded, current };
	}
	if (next !== state) setState(next);
	return {
		folded: next.folded,
		toggle: (folder) =>
			setState((s) => {
				const folded = new Set(s.folded);
				if (!folded.delete(folder)) folded.add(folder);
				writeFolds(s.key, folded);
				return { ...s, folded };
			}),
	};
}
