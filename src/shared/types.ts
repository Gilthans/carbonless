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
	/**
	 * Every cluster is reviewed: the file counts as reviewed in the files
	 * unit. A done file that isn't reviewed counts as crossed off.
	 */
	reviewed: boolean;
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
	/** The description's markdown source. */
	body: string;
	/**
	 * The description as GitHub renders it. Untrusted: sanitize before
	 * rendering (src/web/githubHtml.ts). "" when GitHub returned none.
	 */
	bodyHtml: string;
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
	/**
	 * Every review thread, most recent activity first (as-of mode: those
	 * opened by the cutoff, all unresolved).
	 */
	threads: {
		path: string;
		/** The commented line now, else where it was written; null for a file comment. */
		line: number | null;
		/** The first comment as plain text, whitespace collapsed, ≤200 chars. */
		excerpt: string;
		/** The first comment as GitHub renders it. Untrusted, like `bodyHtml`. */
		html: string;
		/** When the first comment was written. */
		createdAt: string;
		/** The thread's latest comment (as-of mode: by the cutoff). */
		lastActivityAt: string;
		author: string;
		bot: boolean;
		/** Comments in the thread, the opening one included. */
		commentCount: number;
		/** Someone other than the opener commented. */
		hasReply: boolean;
		outdated: boolean;
		/** Resolved on GitHub (as-of mode: always false, the history is unknown). */
		resolved: boolean;
		/**
		 * The code the first comment was written on: GitHub's diff hunk, which
		 * ends at the commented line, and the commented range in the hunk's own
		 * numbering (the old side's for a "LEFT" side; a range may start on the
		 * other side). Null for a file comment.
		 */
		code: {
			diffHunk: string;
			side: "LEFT" | "RIGHT";
			startSide: "LEFT" | "RIGHT";
			startLine: number;
			endLine: number;
		} | null;
	}[];
	/** As-of mode: the cutoff everything here is filtered to. */
	asOf?: string;
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
	/**
	 * As-of mode (dev flag): the cutoff the PR is shown at. The snapshot never
	 * moves, so headMoved stays false.
	 */
	asOf: string | null;
}
