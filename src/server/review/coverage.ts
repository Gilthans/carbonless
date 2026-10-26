import { fileFlags, reviewProgress } from "../../shared/progress.js";
import type {
	ClusterView,
	FileView,
	ReviewView,
	Snapshot,
} from "../../shared/types.js";
import type { ProgressState } from "./fold.js";

/**
 * The coverage join (CLAUDE.md principle 2): clusters come only from the
 * snapshot's git diff, and each takes its state from the reviewer's folded
 * progress. Anything that doesn't match exactly stays unreviewed, so bad or
 * foreign data can only make coverage look less complete:
 * - a cluster with no stored state is unreviewed;
 * - a stored state with no matching cluster is ignored;
 * - states of a patch set on another revision are ignored;
 * - clusters sharing a key (never expected) stay unreviewed.
 * A crossed-off state counts as crossed off with or without a reason (a blank
 * reason is dropped). Crossed off never counts as reviewed.
 */
export function buildReviewView(
	snapshot: Snapshot,
	progress: ProgressState,
): ReviewView {
	const onRevision = progress.patchset?.revision === snapshot.revision;
	const keyCount = new Map<string, number>();
	for (const file of snapshot.files) {
		for (const c of file.clusters) {
			keyCount.set(c.key, (keyCount.get(c.key) ?? 0) + 1);
		}
	}

	const fileViews = snapshot.files.map((file): FileView => {
		const views = file.clusters.map((c): ClusterView => {
			const stored =
				onRevision && keyCount.get(c.key) === 1
					? progress.states.get(c.key)
					: undefined;
			if (stored?.state === "reviewed") return { ...c, state: "reviewed" };
			if (stored?.state === "crossed-off") {
				const reason = stored.reason?.trim();
				return reason
					? { ...c, state: "crossed-off", reason }
					: { ...c, state: "crossed-off" };
			}
			return { ...c, state: "unreviewed" };
		});
		const { clusters: _, ...summary } = file;
		return { ...summary, clusters: views, ...fileFlags(views) };
	});

	return {
		revision: snapshot.revision,
		patchset: onRevision ? (progress.patchset?.number ?? null) : null,
		files: fileViews,
		progress: reviewProgress(fileViews),
	};
}
