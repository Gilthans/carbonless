import { createHash } from "node:crypto";
import type { Cluster } from "../../shared/types.js";
import { byteString, type TextEncoding } from "./text.js";

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

export interface KeyOptions {
	/** How `removed`, `added` and `newLines` were decoded (default UTF-8). */
	encoding?: TextEncoding;
	/**
	 * Old and new object IDs, for file-level clusters whose content change is
	 * not visible as lines (binary, submodule, type change without lines).
	 */
	contentOids?: [string, string];
}

/**
 * Identity of each cluster: path, kind, label, the exact bytes of the removed
 * and added lines and of the surrounding context (none for file-level
 * clusters), the missing-newline-at-end flags, and for content changes
 * without lines the old and new object IDs. Repeats of the same identity in
 * file order get `:2`, `:3`… so every key is unique.
 */
export function clusterKeys(
	path: string,
	clusters: Omit<Cluster, "key">[],
	newLines: string[],
	{ encoding = "utf8", contentOids }: KeyOptions = {},
): string[] {
	const bytes = (lines: string[]) =>
		lines.map((line) => byteString(line, encoding));
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
					bytes(c.removed),
					bytes(c.added),
					bytes(before),
					bytes(after),
					c.noNewlineOld === true,
					c.noNewlineNew === true,
					c.kind === "file" ? (contentOids ?? null) : null,
				]),
			)
			.digest("hex");
		const occurrence = (seen.get(hash) ?? 0) + 1;
		seen.set(hash, occurrence);
		return occurrence === 1 ? hash : `${hash}:${occurrence}`;
	});
}
