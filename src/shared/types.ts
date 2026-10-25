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
	/**
	 * Columns per tab stop, from the head's .editorconfig (`tab_width`, else
	 * a numeric `indent_size`) when it sets one for this path.
	 */
	tabWidth?: number;
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

/** A side of a diff: "LEFT" numbers the old file, "RIGHT" the new one. */
export type DiffSide = "LEFT" | "RIGHT";

/**
 * Where a comment points in the PR's code, whoever hosts the comment: a
 * line range of `path` in the PR's diff at `commit`. The diff's old side is
 * the base as it stood at `at`. Each comment source maps its own fields to
 * this (GitHub's is src/server/overview.ts).
 */
export interface CodeAnchor {
	path: string;
	/** The commit the comment was made on; "" if unknown. */
	commit: string;
	/** The range's last line. */
	side: DiffSide;
	line: number;
	/** The range's first line (the last one for a single line). */
	startSide: DiffSide;
	startLine: number;
	/** When the comment was made. */
	at: string;
}

/** One row of a diff: its numbers on each side, and whether it's commented on. */
export interface CodeRow {
	kind: "context" | "add" | "del";
	oldNo: number | null;
	newNo: number | null;
	text: string;
	/** Git's "\ No newline at end of file" follows this line. */
	noNewline?: boolean;
	/** In the commented range. */
	marked: boolean;
}

/**
 * The code a comment points at: the diff rows of its range and up to three
 * rows before and after it (fewer at the file's edges).
 */
export interface CodeWindow {
	anchor: CodeAnchor;
	rows: CodeRow[];
	/**
	 * "clone": rebuilt from carbonless's clone (the normal case).
	 * "github": GitHub's own diff hunk, when the clone can't give the code
	 * for certain; it ends at the commented line (no rows after it).
	 * "pending": not built yet (no rows); the pane shows its frame.
	 */
	source: "clone" | "github" | "pending";
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
	/** As-of mode: the cutoff everything here is filtered to. */
	asOf?: string;
	/**
	 * This read of the PR from GitHub; its review threads come apart
	 * (`GET /api/threads?read=<readId>`), as they take longer.
	 */
	readId: string;
	/** When the server finished reading this from GitHub (its clock). */
	fetchedAt: string;
	/** When the server sent it (its clock): `servedAt - fetchedAt` is its age. */
	servedAt: string;
}

/** Threads listed at first in each list, and added by each "Load more". */
export const THREAD_PAGE = 5;
/**
 * Threads of each list whose text and code are read first: those listed at
 * first and one "Load more" page; the rest follow.
 */
export const THREADS_FIRST = 2 * THREAD_PAGE;

/** One review thread of the PR. */
export interface ReviewThread {
	/** The comment host's id for the thread ("" if it gave none). */
	id: string;
	path: string;
	/**
	 * The commented line on the commit the comment was made on when there
	 * is code, else the commented line now, else where it was written;
	 * null for a file comment.
	 */
	line: number | null;
	/** GitHub's current line for the comment; null when outdated or a file comment. */
	currentLine: number | null;
	/**
	 * Whether the opening comment's text (`excerpt`, `html`, `body`) has been
	 * read; until then they are "" (the card shows its frame).
	 */
	loaded: boolean;
	/**
	 * Its text will never come (it stays "", `loaded` true): "deleted",
	 * GitHub no longer has the thread (deleted since the list was read);
	 * "unreadable", GitHub gave no id to read it by.
	 */
	unavailable?: "deleted" | "unreadable";
	/** The first comment as plain text, whitespace collapsed, ≤200 chars. */
	excerpt: string;
	/** The first comment as GitHub renders it. Untrusted, like `bodyHtml`. */
	html: string;
	/** The first comment's markdown (suggested changes are read from it). */
	body: string;
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
	 * The code the first comment was written on, from the clone (GitHub's
	 * diff hunk when the clone can't give it for certain). The anchor is
	 * GitHub's original range, on the commit the comment was made on.
	 * Null for a file comment, or when neither source has the code;
	 * `source: "pending"` (no rows) while it is still being built.
	 */
	code: CodeWindow | null;
}

/** How far a read's review threads have come. */
export type ThreadsStage = "summary" | "first" | "firstCode" | "full";

/**
 * A read's review threads. Every thread is listed from the start (its
 * summary: lists, counts and card headers are exact); the text and code of
 * some may still be on their way (`loaded`, code `source: "pending"`).
 */
export interface ThreadsView {
	/**
	 * Every review thread, most recent activity first (as-of mode: those
	 * opened by the cutoff, all unresolved).
	 */
	threads: ReviewThread[];
	/** Every thread's text and code are in. */
	complete: boolean;
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
