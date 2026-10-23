import { createHash } from "node:crypto";
import type { Cluster } from "../../shared/types.js";

const CONTEXT = 3;

/**
 * Up to 3 unchanged new-side lines directly above and below a cluster.
 * Line numbers are 1-based as in git hunk headers. For a pure deletion
 * (`newCount === 0`) git's `newStart` is the line the deletion follows.
 */
export function contextAround(
	newLines: string[],
	c: { newStart: number; newCount: number },
): { before: string[]; after: string[] } {
	// 0-based index one past the last line above, and of the first line below.
	const aboveEnd = c.newCount === 0 ? c.newStart : c.newStart - 1;
	const belowStart =
		c.newCount === 0 ? c.newStart : c.newStart + c.newCount - 1;
	return {
		before: newLines.slice(
			Math.max(0, aboveEnd - CONTEXT),
			Math.max(0, aboveEnd),
		),
		after: newLines.slice(
			Math.max(0, belowStart),
			Math.max(0, belowStart + CONTEXT),
		),
	};
}

/**
 * Identity of each cluster: path, kind, label, exact removed and added lines,
 * and the surrounding context (none for file-level clusters). Repeats of the
 * same identity in file order get `:2`, `:3`… so every key is unique.
 */
export function clusterKeys(
	path: string,
	clusters: Omit<Cluster, "key">[],
	newLines: string[],
): string[] {
	const seen = new Map<string, number>();
	return clusters.map((c) => {
		const { before, after } =
			c.kind === "file"
				? { before: [], after: [] }
				: contextAround(newLines, c);
		const hash = createHash("sha256")
			.update(
				JSON.stringify([
					path,
					c.kind,
					c.label ?? null,
					c.removed,
					c.added,
					before,
					after,
				]),
			)
			.digest("hex");
		const occurrence = (seen.get(hash) ?? 0) + 1;
		seen.set(hash, occurrence);
		return occurrence === 1 ? hash : `${hash}:${occurrence}`;
	});
}
