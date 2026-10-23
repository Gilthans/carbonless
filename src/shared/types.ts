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
