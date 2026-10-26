import type { ClusterView, Counts, FileView, Progress } from "./types.js";

/** A file's flags from its clusters' states (see FileView). */
export function fileFlags(
	clusters: ClusterView[],
): Pick<FileView, "done" | "reviewed" | "crossedOff"> {
	const any = clusters.length > 0;
	return {
		done: any && clusters.every((c) => c.state !== "unreviewed"),
		// A file counts reviewed only when every cluster is reviewed; a done file
		// with any crossed-off cluster counts as crossed off (out of the work
		// left), so crossing off never raises reviewed.
		reviewed: any && clusters.every((c) => c.state === "reviewed"),
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
		else if (file.done) fileCounts.crossedOff++;
	}
	return { clusters, lines, files: fileCounts };
}

function counts(): Counts {
	return { total: 0, reviewed: 0, crossedOff: 0 };
}
