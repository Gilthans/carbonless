import type {
	ClusterView,
	Counts,
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

	const clusters = counts();
	const lines = counts();
	const files = { ...counts(), done: 0 };

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
		for (const c of views) {
			clusters.total++;
			lines.total += c.lines;
			if (c.state === "reviewed") {
				clusters.reviewed++;
				lines.reviewed += c.lines;
			} else if (c.state === "crossed-off") {
				clusters.crossedOff++;
				lines.crossedOff += c.lines;
			}
		}
		const any = views.length > 0;
		const done = any && views.every((c) => c.state !== "unreviewed");
		const crossedOff = any && views.every((c) => c.state === "crossed-off");
		// A file counts reviewed only when every cluster is reviewed; a done file
		// with any crossed-off cluster counts as crossed off (out of the work
		// left), so crossing off never raises reviewed.
		const allReviewed = any && views.every((c) => c.state === "reviewed");
		files.total++;
		if (done) files.done++;
		if (allReviewed) files.reviewed++;
		else if (done) files.crossedOff++;
		const { clusters: _, ...summary } = file;
		return { ...summary, clusters: views, done, crossedOff };
	});

	return {
		revision: snapshot.revision,
		patchset: onRevision ? (progress.patchset?.number ?? null) : null,
		files: fileViews,
		progress: { clusters, lines, files },
	};
}

function counts(): Counts {
	return { total: 0, reviewed: 0, crossedOff: 0 };
}
