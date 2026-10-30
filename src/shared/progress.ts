import type { ClusterView, Counts, FileView, Progress } from "./types.js";

/** A file's flags from its clusters' states (see FileView). */
export function fileFlags(
	clusters: ClusterView[],
): Pick<FileView, "done" | "reviewed" | "crossedOff"> {
	const any = clusters.length > 0;
	return {
		done: any && clusters.every((c) => c.state !== "unreviewed"),
		// A done file counts as crossed off only when every cluster is; one
		// with any reviewed cluster counts as reviewed (owner: "Otherwise it
		// should count as reviewed"). A file with any unreviewed cluster is
		// neither.
		reviewed:
			any &&
			clusters.every((c) => c.state !== "unreviewed") &&
			clusters.some((c) => c.state === "reviewed"),
		crossedOff: any && clusters.every((c) => c.state === "crossed-off"),
	};
}

/** The whole review's progress from its files (server and client alike). */
export function reviewProgress(files: FileView[]): Progress {
	const clusters = counts();
	const lines = counts();
	const fileCounts = { ...counts(), done: 0 };
	for (const file of files) {
		for (const c of file.clusters) {
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
		fileCounts.total++;
		if (file.done) fileCounts.done++;
		if (file.reviewed) fileCounts.reviewed++;
		else if (file.crossedOff) fileCounts.crossedOff++;
	}
	return { clusters, lines, files: fileCounts };
}

function counts(): Counts {
	return { total: 0, reviewed: 0, crossedOff: 0 };
}
