export interface CommitInfo {
	sha: string;
	shortSha: string;
	subject: string;
	author: string;
	date: string;
}

export interface Comparison {
	repoPath: string;
	base: CommitInfo;
	head: CommitInfo;
}

export type FileStatus =
	| "added"
	| "deleted"
	| "modified"
	| "renamed"
	| "type-changed";

export type ClusterState = "unreviewed" | "reviewed" | "crossed-off";

export interface Cluster {
	/** Identity, see Task 2. */
	key: string;
	kind: "lines" | "file";
	/** File-level only, e.g. "Renamed from a/x.cs". */
	label?: string;
	/** All 0 for file-level clusters. */
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	removed: string[];
	added: string[];
	/** removed.length + added.length (0 for file-level). */
	lines: number;
	/** The last removed line had no newline at end of file. */
	noNewlineOld?: boolean;
	/** The last added line has no newline at end of file. */
	noNewlineNew?: boolean;
}

export interface FileSummary {
	index: number;
	path: string;
	oldPath?: string;
	status: FileStatus;
	oldMode?: string;
	newMode?: string;
	binary: boolean;
	submodule: boolean;
	additions: number;
	deletions: number;
	clusters: Cluster[];
}

export interface Snapshot {
	base: string;
	head: string;
	revision: string;
	files: FileSummary[];
}

export interface DiffLine {
	kind: "context" | "add" | "del";
	oldNo?: number;
	newNo?: number;
	text: string;
	clusterKey?: string;
	/** Git's "\\ No newline at end of file" follows this line. */
	noNewline?: boolean;
}

export interface DisplayHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
}

export interface FileHunks {
	hunks: DisplayHunk[];
	newLineCount: number;
}

export interface ClusterView extends Cluster {
	state: ClusterState;
	/** Only for crossed-off clusters. */
	reason?: string;
}

export interface FileView extends Omit<FileSummary, "clusters"> {
	clusters: ClusterView[];
	/** Every cluster is reviewed or crossed off. */
	done: boolean;
	/** Every cluster is crossed off. */
	crossedOff: boolean;
}

export interface Counts {
	total: number;
	reviewed: number;
	crossedOff: number;
}

export interface Progress {
	clusters: Counts;
	lines: Counts;
	/** `reviewed`: done files that aren't entirely crossed off. */
	files: Counts & { done: number };
}

export interface ReviewView {
	revision: string;
	patchset: number | null;
	files: FileView[];
	progress: Progress;
}

export interface StateChange {
	key: string;
	state: ClusterState;
	reason?: string;
}
