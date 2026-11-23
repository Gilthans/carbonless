import {
	contains,
	covers,
	type LineRanges,
	union,
} from "../../shared/lineRanges";
import { marksOf as lineMarksOf } from "../../shared/pieces";
import type { ClusterView, FileHunks } from "../../shared/types";
import type { KindEntry } from "./since";

/**
 * The since view: unreviewed clusters the engine lists as reworked or
 * new whose lines these hunks don't show (gap 5: unreviewed on the
 * compared patch set, unchanged since). The line view (DiffBody) and the
 * Rendered view (MarkdownView) both say so (SinceNotes).
 */
export function unshownToRead(
	clusters: readonly ClusterView[],
	kinds: Map<string, KindEntry> | undefined,
	hunks: FileHunks | undefined,
): number {
	if (!kinds || !hunks) return 0;
	// A cluster's lines the pieces here can mark (they own them).
	const owned = new Map<string, LineRanges>();
	const shownKeys = new Set<string>();
	for (const hunk of hunks.hunks) {
		for (const line of hunk.lines) {
			if (line.clusterKey !== undefined) shownKeys.add(line.clusterKey);
		}
	}
	for (const p of hunks.pieces ?? []) {
		if (p.key && p.owns) {
			owned.set(p.key, [...(owned.get(p.key) ?? []), ...p.owns]);
		}
	}
	return clusters.filter((c) => {
		// As the counts do (sinceUnits): a reworked or new cluster, or one
		// whose carried mark the reviewer replaced.
		const kind = kinds.get(c.key)?.kind;
		if (kind !== "reworked" && kind !== "new" && c.carried) return false;
		if (c.state !== "unreviewed") return false;
		if (!shownKeys.has(c.key)) return true;
		// Its pieces all marked, it still has lines no piece owns (not
		// unchanged since a reviewed line): those are the full diff's.
		const pieces = hunks.pieces;
		if (!pieces) return false;
		const own = owned.get(c.key) ?? [];
		const { reviewed, crossed } = lineMarksOf(c);
		return (
			contains(union(reviewed, crossed), own) &&
			!covers(union(own, []), c.lines)
		);
	}).length;
}

/**
 * The since view's notes under a file's body: clusters to read that only
 * the full diff shows ("N to read · only in the full diff"), or, for a
 * file the author left alone with nothing else to show, "Nothing to read
 * since PSn" (never an empty body that reads as "nothing changed" by
 * mistake). `unshown`: when false, that note is left to another view.
 */
export function SinceNotes(props: {
	from: number;
	clusters: readonly ClusterView[];
	kinds: Map<string, KindEntry> | undefined;
	hunks: FileHunks;
	unshown?: boolean;
	empty?: boolean;
}) {
	const { from, clusters, hunks } = props;
	const toRead = unshownToRead(clusters, props.kinds, hunks);
	const carried = clusters.filter((c) => c.carried).length;
	const fileRows = clusters.filter((c) => c.kind === "file").length;
	return (
		<>
			{props.unshown !== false && toRead > 0 && (
				// Clusters the engine says are to read (reworked or new) with no
				// line in these hunks (unreviewed on the compared patch set and
				// unchanged since): never "nothing to read"; the full diff has them.
				<p
					data-testid="since-unshown"
					className="flex min-h-10 items-center gap-2 px-3 text-xs text-warn"
				>
					{toRead} to read · only in the full diff ·{" "}
					<span className="text-muted">{carried} carried</span>
				</p>
			)}
			{props.empty !== false &&
				hunks.hunks.length === 0 &&
				fileRows === 0 &&
				toRead === 0 && (
					<p
						data-testid="since-empty"
						className="flex min-h-10 items-center gap-2 px-3 text-xs text-muted"
					>
						Nothing to read since PS{from} · {carried} carried
					</p>
				)}
		</>
	);
}
