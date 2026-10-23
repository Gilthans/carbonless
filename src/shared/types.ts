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
	/**
	 * `reviewed`: files whose clusters are all reviewed. `crossedOff`: done
	 * files with at least one crossed-off cluster. `done`: both together.
	 */
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

export interface PrOverview {
	title: string;
	number: number;
	url: string;
	author: string;
	body: string;
	isDraft: boolean;
	state: "OPEN" | "CLOSED" | "MERGED";
	createdAt: string;
	updatedAt: string;
	baseBranch: string;
	headBranch: string;
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	requestedReviewers: { name: string; team: boolean }[];
	/**
	 * One entry per reviewer, newest activity first. `state` and `submittedAt`
	 * are the reviewer's latest review; `opinion` is their latest approving,
	 * blocking or dismissed review, so a later plain comment doesn't hide a
	 * change request.
	 */
	reviews: {
		author: string;
		state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
		opinion?: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
		submittedAt: string;
		you: boolean;
		bot: boolean;
	}[];
	commenters: { author: string; lastAt: string; bot: boolean; you: boolean }[];
	/** Any review or comment by a non-bot who is neither the PR author nor the viewer. */
	humanStarted: boolean;
	/** Failing first, then pending, then passing. */
	checks: {
		name: string;
		status: "failing" | "pending" | "passing";
		url?: string;
	}[];
	/** Unresolved threads only. */
	threads: {
		path: string;
		line: number | null;
		excerpt: string;
		author: string;
		bot: boolean;
		hasReply: boolean;
		outdated: boolean;
	}[];
}

export interface SessionInfo {
	pr: {
		owner: string;
		repo: string;
		number: number;
		title: string;
		url: string;
	};
	/** The reviewer's slug. */
	viewer: string;
	/** Head of the snapshot being reviewed (the patch set's, once started). */
	snapshotHead: string;
	/** The PR's head on GitHub, as last fetched or checked. */
	currentHead: string;
	headMoved: boolean;
	patchset: number | null;
}
