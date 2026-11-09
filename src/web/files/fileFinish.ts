import type { ClusterState, StateChange } from "../../shared/types";

type Cluster = { key: string; state: ClusterState };

/**
 * Whether `changes` finish the file: it has an unreviewed cluster now and
 * none once they apply. Unmarking never finishes a file, and a file with
 * nothing unreviewed already can't finish again.
 */
export function finishes(
	clusters: readonly Cluster[],
	changes: readonly StateChange[],
): boolean {
	if (!clusters.some((c) => c.state === "unreviewed")) return false;
	const next = new Map(changes.map((c) => [c.key, c.state]));
	return clusters.every((c) => (next.get(c.key) ?? c.state) !== "unreviewed");
}

/**
 * A finished file's reset: every cluster marked `kind` back to unreviewed,
 * the other kind left as it is. Empty while anything is unreviewed (the
 * button marks the rest instead) or nothing is marked `kind`.
 */
export function resetChanges(
	clusters: readonly Cluster[],
	kind: "reviewed" | "crossed-off",
): StateChange[] {
	if (clusters.some((c) => c.state === "unreviewed")) return [];
	return clusters
		.filter((c) => c.state === kind)
		.map((c) => ({ key: c.key, state: "unreviewed" }));
}

/**
 * The file to open after `index` finishes: the next one in the page's order
 * (`treeOrder`) that still has something unreviewed, wrapping past the end
 * to the files before it. None when no other file has anything left (or
 * `index` isn't one of `files`).
 */
export function nextFile<
	T extends { index: number; clusters: readonly Cluster[] },
>(files: readonly T[], index: number): T | undefined {
	const at = files.findIndex((f) => f.index === index);
	if (at === -1) return undefined;
	for (let step = 1; step < files.length; step++) {
		const file = files[(at + step) % files.length];
		if (file?.clusters.some((c) => c.state === "unreviewed")) return file;
	}
	return undefined;
}
