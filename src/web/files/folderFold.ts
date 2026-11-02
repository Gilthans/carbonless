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
	/** The last reveal request seen. */
	reveal: number;
	/** The file of a reveal asked for before the PR was known: redone on its folds. */
	pending: number | null;
	/** Changed here since read: to be written to storage. */
	dirty: boolean;
}

/**
 * Fold state under `key` (null until the PR is known: in memory only, and
 * merged into the PR's stored folds once it is).
 *
 * A folded folder opens only when the reviewer opens a file inside it: each
 * new reveal request (`reveal.seq`: a tree pick, a link, expanding a file
 * from its header) unfolds the folded folders holding `reveal.index`.
 * Scrolling, the page's first settle and a remount never do, so a fold
 * holds until then, across reloads too.
 */
export function useFolds(
	key: string | null,
	files: readonly FileView[],
	reveal: { seq: number; index: number | null } = { seq: 0, index: null },
): Folds {
	const [state, setState] = useState<FoldState>(() => ({
		key,
		folded: readFolds(key),
		reveal: reveal.seq,
		pending: null,
		dirty: false,
	}));
	let next = state;
	let target: number | null = next.reveal !== reveal.seq ? reveal.index : null;
	if (next.key !== key) {
		// The PR became known (or changed): its remembered folds, plus any
		// made before it was known.
		const folded = readFolds(key);
		if (next.key === null) for (const f of next.folded) folded.add(f);
		// A reveal asked for while it wasn't known applies to these too: its
		// own file, not whatever is current now.
		if (target === null && next.key === null) target = next.pending;
		next = {
			...next,
			key,
			folded,
			pending: null,
			dirty: next.key === null && next.folded.size > 0,
		};
	}
	if (next.reveal !== reveal.seq || target !== null) {
		const path =
			target === null ? undefined : files.find((f) => f.index === target)?.path;
		const open = path ? foldedAncestors(next.folded, path) : [];
		let { folded, dirty } = next;
		if (open.length > 0) {
			const kept = new Set(folded);
			for (const folder of open) kept.delete(folder);
			folded = kept;
			dirty = true;
		}
		next = {
			...next,
			folded,
			dirty,
			reveal: reveal.seq,
			pending:
				key === null && next.reveal !== reveal.seq
					? reveal.index
					: next.pending,
		};
	}
	if (next !== state) setState(next);
	// Storage is written after render, only for changes made here, and only
	// when the folds changed.
	const { dirty, key: storedKey, folded: storedFolds } = state;
	useEffect(() => {
		if (dirty) writeFolds(storedKey, storedFolds);
	}, [dirty, storedKey, storedFolds]);
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
