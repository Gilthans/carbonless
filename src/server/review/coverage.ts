import type { LineRanges } from "../../shared/lineRanges.js";
import { reviewedLines, viewOfLines } from "../../shared/pieces.js";
import { fileFlags, reviewProgress } from "../../shared/progress.js";
import type {
	Cluster,
	ClusterView,
	FileView,
	ReviewView,
	Snapshot,
} from "../../shared/types.js";
import type { ProgressState, StateEntry } from "./fold.js";

/**
 * The coverage join (CLAUDE.md principle 2): clusters come only from the
 * snapshot's git diff, and each takes its state from the reviewer's folded
 * progress. Anything that doesn't match exactly stays unreviewed, so bad or
 * foreign data can only make coverage look less complete:
 * - a cluster with no stored state is unreviewed;
 * - a stored state with no matching cluster is ignored;
 * - only the states of the patch set on the snapshot's own revision count
 *   (an older patch set folds against its own snapshot the same way);
 * - clusters sharing a key (never expected) stay unreviewed.
 * A crossed-off state counts as crossed off with or without a reason (a blank
 * reason is dropped). Crossed off never counts as reviewed. A state the
 * engine carried keeps its `carried` mark, so the page can say so. A
 * partly reviewed cluster (pieces.ts) is unreviewed with its reviewed
 * lines, only when they all lie within it, and reviewed once they are all.
 */
export function buildReviewView(
	snapshot: Snapshot,
	progress: ProgressState,
): ReviewView {
	const record = progress.patchsets.find(
		(p) => p.revision === snapshot.revision,
	);
	const states = progress.statesByRevision.get(snapshot.revision);
	const keyCount = new Map<string, number>();
	for (const file of snapshot.files) {
		for (const c of file.clusters) {
			keyCount.set(c.key, (keyCount.get(c.key) ?? 0) + 1);
		}
	}

	const fileViews = snapshot.files.map((file): FileView => {
		const views = file.clusters.map((c) =>
			clusterView(
				c,
				record && keyCount.get(c.key) === 1 ? states?.get(c.key) : undefined,
			),
		);
		const { clusters: _, ...summary } = file;
		return { ...summary, clusters: views, ...fileFlags(views) };
	});

	const sinceMarks = record ? progress.sinceMarks.get(snapshot.revision) : [];
	return {
		revision: snapshot.revision,
		patchset: record?.number ?? null,
		files: fileViews,
		progress: reviewProgress(fileViews),
		...(sinceMarks && sinceMarks.length > 0 ? { sinceMarks } : {}),
	};
}

/**
 * One cluster under its stored state (none: unreviewed), as the coverage
 * join reads it: a whole mark as it is (its carry kept), a mark of part
 * of it only when its lines all lie within it (else unreviewed: fail
 * closed).
 */
export function clusterView(c: Cluster, stored?: StateEntry): ClusterView {
	const carried = stored?.carried ? { carried: stored.carried } : {};
	if (stored?.state === "reviewed") {
		return { ...c, state: "reviewed", ...carried };
	}
	if (stored?.state === "crossed-off") {
		const reason = stored.reason?.trim();
		return reason
			? { ...c, state: "crossed-off", reason, ...carried }
			: { ...c, state: "crossed-off", ...carried };
	}
	// Marked one piece at a time: only lines the cluster has count; a
	// range past them voids the marks (forged or stale: fail closed).
	if (stored?.state === "unreviewed" && (stored.lines || stored.crossed)) {
		const shown = viewOfLines(c, stored.lines ?? [], stored.crossed ?? []);
		if (shown) return shown;
	}
	return { ...c, state: "unreviewed" };
}

/**
 * The lines the reviewer marked reviewed on each cluster of a patch set
 * (its snapshot and folded states), by cluster key, under the coverage
 * join's rules (clusters sharing a key: none). A crossed-off line is not
 * one. What a since view may take as unchanged since a reviewed line.
 */
export function reviewedLinesOf(
	snapshot: Snapshot,
	states: ReadonlyMap<string, StateEntry>,
): Map<string, { cluster: Cluster; reviewed: LineRanges }> {
	const out = new Map<string, { cluster: Cluster; reviewed: LineRanges }>();
	const twice = new Set<string>();
	for (const file of snapshot.files) {
		for (const c of file.clusters) {
			if (out.has(c.key)) twice.add(c.key);
			const reviewed = reviewedLines(clusterView(c, states.get(c.key)));
			out.set(c.key, { cluster: c, reviewed });
		}
	}
	for (const key of twice) out.delete(key);
	return out;
}
