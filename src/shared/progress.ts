import { size } from "./lineRanges.js";
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
			const crossed = size(c.crossedLines ?? []);
			if (c.state === "reviewed") {
				clusters.reviewed++;
				// Some lines may be crossed off one piece at a time.
				lines.reviewed += c.lines - crossed;
				lines.crossedOff += crossed;
			} else if (c.state === "crossed-off") {
				clusters.crossedOff++;
				lines.crossedOff += c.lines;
			} else {
				// Partly marked: unreviewed, but its marked lines count.
				lines.reviewed += size(c.reviewedLines ?? []);
				lines.crossedOff += crossed;
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

/**
 * With "Ignore whitespace" on, the file as progress counts it: its
 * whitespace-only clusters (Cluster.whitespaceOnly) left out, whatever
 * their marks, and its flags from the rest. The same object when it has
 * none; no clusters at all when every one is whitespace-only. A view of
 * the reviewer's choosing (the switch, CAR-156): the clusters stay in the
 * review, shown and markable, and count again with the switch off.
 */
export function withoutWhitespaceOnly(file: FileView): FileView {
	if (!file.clusters.some((c) => c.whitespaceOnly)) return file;
	const clusters = file.clusters.filter((c) => !c.whitespaceOnly);
	return { ...file, clusters, ...fileFlags(clusters) };
}

/**
 * The review's progress with "Ignore whitespace" on: every file without
 * its whitespace-only clusters (a file of nothing else counts nowhere,
 * not even in files), and how many clusters that left out.
 */
export function countedProgress(files: FileView[]): {
	progress: Progress;
	leftOut: number;
} {
	let leftOut = 0;
	const counted: FileView[] = [];
	for (const file of files) {
		const shown = withoutWhitespaceOnly(file);
		leftOut += file.clusters.length - shown.clusters.length;
		if (shown.clusters.length > 0 || file.clusters.length === 0) {
			counted.push(shown);
		}
	}
	return { progress: reviewProgress(counted), leftOut };
}
