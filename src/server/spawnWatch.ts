/*
 * Every git and gh process crb starts, told to whoever listens (CAR-320).
 * Starting a process costs ~90 ms on Windows against a few ms on Linux, so
 * the number of them behind a request is what makes a page slow there.
 * Tests and `pnpm spawn-counts` listen to count them per request; with no
 * listener a spawn costs one Set size check.
 */

export type SpawnTool = "git" | "gh";

export interface SpawnNote {
	tool: SpawnTool;
	/** The process's arguments (git's without its `-C <repo>`). */
	args: readonly string[];
	/** Its name as spans and activity steps have it: `git cat-file`, `gh api graphql`. */
	name: string;
}

type Listener = (note: SpawnNote) => void;

const listeners = new Set<Listener>();

/** Calls `listener` on every git or gh started from now on; returns the unsubscribe. */
export function onSpawn(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Tells the listeners a process is starting (git.ts, gh.ts). */
export function noteSpawn(
	tool: SpawnTool,
	args: readonly string[],
	name: string,
): void {
	if (listeners.size === 0) return;
	const note = { tool, args, name };
	for (const listener of listeners) listener(note);
}
