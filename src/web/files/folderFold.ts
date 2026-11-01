import { useEffect, useState } from "react";
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

interface FoldState {
	key: string | null;
	folded: ReadonlySet<string>;
	/** The current file and reveal request this state has seen. */
	current: number | null;
	reveal: number;
	/** Changed here since read: to be written to storage. */
	dirty: boolean;
}

/**
 * Fold state under `key` (null until the PR is known: in memory only, and
 * merged into the PR's stored folds once it is).
 *
 * Folded ancestors of the current file unfold when the reviewer moves on to
 * it: on a change of `current` from one file to another (scrolling), and on
 * every new `reveal` request (an explicit navigation: a tree pick, a link,
 * even right after load). Not on the page's first settle (null to the file
 * in view) nor on a remount: a stored fold survives a reload, and folding
 * the current file's folder holds until the current file changes.
 */
export function useFolds(
	key: string | null,
	files: readonly FileView[],
	current: number | null,
	reveal = 0,
): Folds {
	const [state, setState] = useState<FoldState>(() => ({
		key,
		folded: readFolds(key),
		current,
		reveal,
		dirty: false,
	}));
	let next = state;
	if (next.key !== key) {
		// The PR became known (or changed): its remembered folds, plus any
		// made before it was known.
		const folded = readFolds(key);
		if (next.key === null) for (const f of next.folded) folded.add(f);
		next = {
			...next,
			key,
			folded,
			dirty: next.key === null && next.folded.size > 0,
		};
	}
	// A navigation before the PR was known (a cold open with a link) still
	// reveals its file among the folds just read.
	const late = state.key === null && key !== null && reveal > 0;
	const asked = next.reveal !== reveal || late;
	const moved = next.current !== null && next.current !== current;
	if (asked || next.current !== current) {
		const path =
			(asked || moved) && current !== null
				? files.find((f) => f.index === current)?.path
				: undefined;
		const open = path ? foldedAncestors(next.folded, path) : [];
		let { folded, dirty } = next;
		if (open.length > 0) {
			const kept = new Set(folded);
			for (const folder of open) kept.delete(folder);
			folded = kept;
			dirty = true;
		}
		next = { ...next, folded, dirty, current, reveal };
	}
	if (next !== state) setState(next);
	// Storage is written after render, only for changes made here.
	useEffect(() => {
		if (state.dirty) writeFolds(state.key, state.folded);
	}, [state]);
	return {
		folded: next.folded,
		toggle: (folder) =>
			setState((s) => {
				const folded = new Set(s.folded);
				if (!folded.delete(folder)) folded.add(folder);
				return { ...s, folded, dirty: true };
			}),
	};
}
