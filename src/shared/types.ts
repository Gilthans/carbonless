import type { ThreadPlacement } from "./rereview/placement.js";

export type FileStatus =
	| "added"
	| "deleted"
	| "modified"
	| "renamed"
	| "type-changed";

export type ClusterState = "unreviewed" | "reviewed" | "crossed-off";

/**
 * How a patch set's snapshot relates to the one before it (the re-review
 * design's shapes): S1 commits appended, S3 base merged in, S4a a trivial
 * rebase, S4b a rebase with conflicts, S4c rework, S5 a squash, S6 a move
 * backwards, S7 retargeted.
 */
export type ShapeCode =
	| "S1"
	| "S3"
	| "S4a"
	| "S4b"
	| "S4c"
	| "S5"
	| "S6"
	| "S7";

/**
 * What shape detection found between a patch set and a newer snapshot
 * (src/server/rereview/shape.ts): the code, how many commits the new head
 * has over the old one (over the merge base after a force-push), whether
 * the old head virtually rebased onto the new base gives the new head's
 * tree, and the virtual rebase itself: ok, with conflicts (the paths), or
 * none could be built (unrelated histories, a shallow clone, an error).
 */
export interface Shape {
	code: ShapeCode;
	commits: number;
	identical: boolean;
	conflicts: string[];
	virtualRebase: "ok" | "conflict" | "unrelated" | "shallow" | "error";
	/** The virtual rebase's tree OID (`H1'`); null when none could be built. */
	virtualHead: string | null;
}

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
	/**
	 * The state was carried by the engine from that patch set under that
	 * rule (and not re-marked by hand since). Never on an unreviewed cluster.
	 */
	carried?: { from: number; rule: "exact" | "rename" };
}

export interface FileView extends Omit<FileSummary, "clusters"> {
	clusters: ClusterView[];
	/** Every cluster is reviewed or crossed off. */
	done: boolean;
	/**
	 * Done with at least one cluster reviewed (the rest may be crossed
	 * off): the file counts as reviewed in the files unit.
	 */
	reviewed: boolean;
	/** Every cluster is crossed off: the file counts as crossed off. */
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
	 * `reviewed`: done files with at least one reviewed cluster.
	 * `crossedOff`: files whose clusters are all crossed off. `done`: both
	 * together.
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

/** Where a thread sits in a snapshot (a CodeAnchor's range). */
export interface ThreadAnchorRef {
	path: string;
	startSide: DiffSide;
	startLine: number;
	side: DiffSide;
	line: number;
}

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
	/** When the comment was written (the code as its author saw it). */
	at: string;
	/**
	 * A span inside the lines (both absent or null: whole lines). UTF-16
	 * offset into `startLine`'s text where the span starts.
	 */
	startCol?: number | null;
	/** UTF-16 offset into `line`'s text where the span ends (exclusive). */
	endCol?: number | null;
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
	/**
	 * Whether these rows are what the commenter saw (codeWindow.ts,
	 * `snapshotOf`): `same` only when shown to be; absent while pending.
	 * The page flags anything but `same`.
	 */
	snapshot?: CodeSnapshot;
}

/**
 * Why a comment's code may not be what the commenter saw:
 * "no-host-diff": the host kept no diff of the comment's own view to check
 * against; "diff-differs": the host's diff of that view disagrees with the
 * rows shown (another old side, other lines changed, other numbers, or the
 * range not in it).
 */
export type SnapshotReason = "no-host-diff" | "diff-differs";

export type CodeSnapshot =
	| { same: true }
	| { same: false; reason: SnapshotReason };

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
	 * change request; none when it was dismissed and they commented after
	 * it (Comment withdrew it: `state` says COMMENTED alone).
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
	/** The viewer opened the PR: their own reviews and comments don't make them a reviewer. */
	youAuthor: boolean;
	/** Failing first, then pending, then passing. */
	checks: {
		name: string;
		status: "failing" | "pending" | "passing";
		url?: string;
	}[];
	/** As-of mode: the cutoff everything here is filtered to. */
	asOf?: string;
	/**
	 * "on", or why this session can't write to GitHub: an as-of view, or
	 * `--viewer` someone other than the gh login.
	 */
	writes: "on" | "as-of" | "viewer";
	/**
	 * Whether a new comment may go on LEFT lines: false when GitHub's merge
	 * base for the snapshot's head (compare of the PR's base commit and it)
	 * differs from the snapshot's left side (a pinned head, a started patch
	 * set). True until GitHub has said (POST /api/threads waits for it).
	 * RIGHT lines and file comments don't depend on it.
	 */
	commentLeft: boolean;
	/**
	 * The viewer has an unsubmitted review on this PR: replies can't be
	 * posted. `url` = `${url}/files`, where it can be submitted or discarded.
	 */
	pendingReview: { url: string } | null;
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
	/**
	 * When the first comment was published (its review submitted), not
	 * written: what others could see, and when.
	 */
	createdAt: string;
	/** When the thread's latest comment was published (as-of mode: by the cutoff). */
	lastActivityAt: string;
	author: string;
	bot: boolean;
	/** The opener's avatar image ("" when the host gave none). */
	avatarUrl: string;
	/**
	 * Who commented, each once, in the order they first spoke (published;
	 * as of a cutoff, by then), pending comments left out: what gives each
	 * person their tint across the PR (src/web/threads/people.ts).
	 */
	participants: ThreadParticipant[];
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
	/**
	 * Where the thread points (the comment host's original range, on the
	 * commit the opening comment was made on), from the summary on: what
	 * places it in Files changed. Null for a file comment.
	 */
	anchor: CodeAnchor | null;
	/**
	 * The commit the opening comment was made on, for line and file
	 * comments alike; "" when the host gave none (it is then on no known
	 * commit, so never on the one viewed).
	 */
	commit: string;
	/** On lines (`anchor`, null when the host gave no line) or on the whole file. */
	subject: "line" | "file";
	/**
	 * Who the thread waits on, as the host spells their logins: everyone
	 * who commented plus the PR author, minus the latest (human) commenter;
	 * bots and pending comments left out; empty once resolved. As of a
	 * cutoff, from the comments published by then.
	 */
	attention: string[];
	/** The viewer is in `attention`. */
	yourTurn: boolean;
	/**
	 * What the viewer may do to the thread on the host (GitHub's
	 * viewerCanReply/Resolve/Unresolve): all false when writing is off
	 * (`PrOverview.writes`) or the host didn't say. `resolve` is false on a
	 * resolved thread and `unresolve` on an open one, as GitHub gives them.
	 */
	viewerCan: { reply: boolean; resolve: boolean; unresolve: boolean };
}

/** Someone who commented on a thread. */
export interface ThreadParticipant {
	login: string;
	/** Their avatar image ("" when the host gave none). */
	avatarUrl: string;
	/** When they first spoke in the thread (published). */
	at: string;
}

/** One comment of a review thread, whoever hosts it. */
export interface ThreadComment {
	/** The host's id for the comment ("" if it gave none). */
	id: string;
	author: string;
	bot: boolean;
	/** The author's avatar image ("" when the host gave none). */
	avatarUrl: string;
	/** When it was published (its review submitted); null for the viewer's own pending comment. */
	publishedAt: string | null;
	/** In the viewer's unsubmitted review: only they see it. */
	pending: boolean;
	/** As the host renders it. Untrusted, like `ReviewThread.html`. */
	html: string;
	/** The markdown (suggested changes are read from it). */
	body: string;
	/** Plain text. */
	text: string;
	/** When its text was last edited on the host; null if never (anyone's comment). */
	editedAt: string | null;
	/** What the viewer may do to it on GitHub; both false when writes are off or for a pending comment. */
	viewerCan: { update: boolean; delete: boolean };
	/**
	 * An opener blanked by carbonless's delete: its body is exactly
	 * "[deleted]" (trimmed). Shown like any other comment and editable;
	 * `viewerCan.delete` is off while published comments follow it.
	 */
	deleted: boolean;
}

/** A review thread's comments (`GET /api/comments`). */
export interface ThreadComments {
	threadId: string;
	/**
	 * Oldest first: those published (as of a cutoff, by then), plus the
	 * viewer's pending ones (never as of a cutoff).
	 */
	comments: ThreadComment[];
	/**
	 * Published comments the thread's list counts (as of a cutoff, by then)
	 * that didn't come (deleted since it was listed): the page flags them.
	 * Absent when none are missing.
	 */
	missing?: number;
	/**
	 * They will never come (`comments` empty): "deleted", the host no longer
	 * has the thread; "unreadable", there is no id to read it by.
	 */
	unavailable?: "deleted" | "unreadable";
}

/** The comments of the threads asked for, in the order asked. */
export interface CommentsView {
	threads: ThreadComments[];
}

/** What a thread write answers with: the thread's new state. */
export interface ThreadUpdate {
	threadId: string;
	resolved: boolean;
	commentCount: number;
	lastActivityAt: string;
	attention: string[];
	yourTurn: boolean;
	viewerCan: ReviewThread["viewerCan"];
	comments: ThreadComments;
	/**
	 * The comment the write was about: a reply's (posted now, or found by
	 * the dedupe), an edit's (the edited comment), or the opener a delete
	 * blanked to "[deleted]".
	 */
	comment?: ThreadComment;
}

/** `PATCH /api/threads/:threadId/comments/:commentId` (commentId = ThreadComment.id, the GraphQL node id). */
export interface EditRequest {
	/** The new Markdown, non-empty after trim, at most MAX_REPLY. */
	body: string;
	/** The body the edit started from (the changed-on-GitHub check). */
	from: string;
	/** "Save anyway": skip the check. */
	force: boolean;
}

/** A delete that removed the thread's last comment. */
export interface ThreadGone {
	threadId: string;
	gone: true;
}

/** `DELETE /api/threads/:threadId/comments/:commentId` answers ThreadUpdate | ThreadGone. */
export type DeleteAnswer = ThreadUpdate | ThreadGone;

/** `POST /api/threads/:threadId/replies`. */
export interface ReplyRequest {
	body: string;
	/** ISO time of the first attempt (informative; the dedupe doesn't use it). */
	attemptedAt: string;
	/** A resend after a failed or unknown attempt: dedupe first. */
	retry: boolean;
	/**
	 * The client's own id for this reply, the same on every resend (a
	 * reload's too): the server remembers the replies it posted by it.
	 */
	clientId: string;
	/**
	 * The thread's comment ids the client had when the reply was first
	 * sent: on a retry, only a comment not among them can be this reply.
	 */
	knownCommentIds: string[];
}

/** `POST /api/threads/:threadId/resolved`. */
export interface ResolveRequest {
	resolved: boolean;
}

/** A refused thread write. */
export interface WriteError {
	error: string;
	code:
		| "pending-review"
		| "writes-off"
		| "forbidden"
		| "gone"
		| "invalid"
		| "changed"
		| "stale";
	url?: string;
	/** "changed" (an edit, 409): the comment as GitHub has it now. */
	current?: ThreadComment;
}

/** `POST /api/threads`: start a thread. */
export interface NewThreadRequest {
	/** The client's own id, the same on every resend (a reload's too). */
	clientId: string;
	/** Markdown as typed (no marker), non-empty after trim, ≤ MAX_REPLY minus the marker. */
	body: string;
	attemptedAt: string;
	/** A resend after a failed or unknown attempt: look for it first. */
	retry: boolean;
	path: string;
	/** The snapshot's head the selection was made on; must be the session's head (pinned or not), else 409 code "stale". */
	commit: string;
	subject: "line" | "file";
	/** subject "line" only: GitHub's range (start = first row of the selection, end = last). */
	startSide?: DiffSide;
	startLine?: number;
	side?: DiffSide;
	line?: number;
	/** subject "line" only: the span's columns, both or neither. */
	startCol?: number | null;
	endCol?: number | null;
}

/** 200: the thread as the overview read would show it (anchor with cols, code window may be null until read), and its comments. */
export interface NewThreadAnswer {
	thread: ReviewThread;
	comments: ThreadComments;
}

/** A verdict the reviewer can send: one submitted review (Final Verdict). */
export type VerdictEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

/**
 * `GET /api/verdict`: what GitHub says about merging, read for the Final
 * Verdict tab only (never on first open). Present-only facts are null in
 * as-of views and on merged or closed PRs, never shown as of now.
 */
export interface VerdictFacts {
	/** GitHub's `mergeStateStatus`; null as-of, merged or closed. */
	mergeStateStatus:
		| "BEHIND"
		| "BLOCKED"
		| "CLEAN"
		| "DIRTY"
		| "DRAFT"
		| "HAS_HOOKS"
		| "UNKNOWN"
		| "UNSTABLE"
		| null;
	/** GitHub's `reviewDecision`; null when no review rule applies, as-of, merged or closed. */
	reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
	/**
	 * The head's checks, as `PrOverview.checks` (as of the cutoff in as-of
	 * views), each with GitHub's `isRequired`: null when unknown (as-of).
	 */
	checks: {
		name: string;
		status: "failing" | "pending" | "passing";
		url?: string;
		required: boolean | null;
	}[];
	/**
	 * The base branch's review rule, from branch protection or rulesets;
	 * null when it can't be read (no admin access: an empty rule list on a
	 * protected branch is unknown, not none). Inside, null = that part unknown.
	 */
	rule: {
		approvals: number | null;
		codeOwners: boolean | null;
		strict: boolean | null;
	} | null;
	/**
	 * Requested reviewers GitHub asked as code owners (`asCodeOwner`); [] in
	 * as-of views (who GitHub asks is known only now).
	 */
	codeOwnerRequests: { name: string; team: boolean }[];
	/**
	 * Each reviewer's verdict, newest first: their latest opinionated review
	 * (APPROVED, CHANGES_REQUESTED or DISMISSED, as GitHub's
	 * latestOpinionatedReviews and PrOverview's `opinion`), else their latest
	 * COMMENTED one; PENDING ones left out. A dismissed review followed by a
	 * comment of theirs reads as that comment (Comment withdrew it). `submittedAt`,
	 * `commitId` and `url` are the chosen review's. As of the cutoff in as-of
	 * views, by the same rule.
	 */
	reviews: {
		author: string;
		state: ReviewVerdict;
		submittedAt: string;
		commitId: string;
		/** The review on GitHub (GraphQL `url`); absent when GitHub gave none. */
		url?: string;
		you: boolean;
		bot: boolean;
	}[];
	/** The PR's head on GitHub when this was read; in as-of views, the cutoff's head. */
	head: string;
	/** When the server finished reading this from GitHub (its clock). */
	fetchedAt: string;
}

/** `POST /api/verdict`: submit a review with an event. */
export interface VerdictRequest {
	/** The client's own id, the same on every resend (a reload's too). */
	clientId: string;
	event: VerdictEvent;
	/**
	 * Markdown as typed (no marker); required (non-empty after trim) for
	 * COMMENT and REQUEST_CHANGES, optional for APPROVE. ≤ MAX_REPLY minus the marker.
	 */
	body?: string;
	/** The head the reviewer is viewing: must be the session's snapshot head, else 409 code "stale". */
	commit: string;
	attemptedAt: string;
	/** A resend after a failed or unknown attempt: look for it first. */
	retry: boolean;
}

/**
 * 200: the review as GitHub recorded it. Refusals are `WriteError`s:
 * "pending-review" (the viewer has an unsubmitted review; `url` = the PR's
 * files page), "forbidden" (e.g. approving one's own PR), "writes-off",
 * "invalid", "stale".
 */
export interface VerdictAnswer {
	review: {
		id: string;
		state: ReviewVerdict;
		submittedAt: string;
		commitId: string;
		/** Without the marker. */
		body: string;
		/** The review on GitHub (REST `html_url`); absent when GitHub gave none. */
		url?: string;
	};
	/**
	 * COMMENT only, over the viewer's standing approval or change request:
	 * that opinion, withdrawn (dismissed on GitHub) after the comment posted.
	 */
	dismissed?: "APPROVED" | "CHANGES_REQUESTED";
	/**
	 * COMMENT only: the comment posted, but dismissing the standing opinion
	 * failed (no write access, a GitHub error), so it still stands; GitHub's
	 * message. Still a success: the comment is on GitHub, never resent.
	 */
	stillStands?: { state: "APPROVED" | "CHANGES_REQUESTED"; message: string };
}

/** The longest reply GitHub takes (a comment body's limit). */
export const MAX_REPLY = 65536;

/** Threads whose comments one `GET /api/comments` asks for, at most. */
export const COMMENTS_BATCH = 50;

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

/** Who did something on the PR's timeline. */
export interface TimelineActor {
	/** GitHub login; a commit by no GitHub user: its author's name. */
	login: string;
	/** "" when GitHub gave none. */
	avatarUrl: string;
	bot: boolean;
}

/** A submitted review's verdict. */
export type ReviewVerdict =
	| "APPROVED"
	| "CHANGES_REQUESTED"
	| "COMMENTED"
	| "DISMISSED";

/** One commit of a commit run. */
export interface TimelineCommit {
	kind: "commit";
	/** When it was pushed if GitHub knows, else committed. */
	at: string;
	oid: string;
	headline: string;
	/** The commit in the PR on GitHub; "" if unknown. */
	url: string;
}

/** One review comment (a comment on the code) of a review run. */
export interface TimelineReviewComment {
	kind: "comment";
	/**
	 * When it was published, i.e. its review submitted (as the review
	 * threads date comments), not when it was written.
	 */
	at: string;
	path: string;
	/** Its line on the commit it was made on; null for a file comment. */
	line: number | null;
	/** The comment's first line of text. */
	text: string;
	url: string;
	/** The review thread it belongs to (ReviewThread.id); null if unknown. */
	threadId: string | null;
}

/** A submitted review with a verdict or text of its own. */
export interface TimelineReview {
	kind: "review";
	at: string;
	state: ReviewVerdict;
	/** The review's first line of text; "" for none. */
	text: string;
	url: string;
}

/** A comment on the PR's conversation (not on the code). */
export interface TimelineConversationComment {
	kind: "conversation";
	at: string;
	text: string;
	url: string;
}

export type TimelineReviewItem =
	| TimelineReview
	| TimelineReviewComment
	| TimelineConversationComment;

/** A history fact shown as a single event. */
export type TimelineFact =
	| {
			kind: "force-push";
			actor: TimelineActor;
			at: string;
			/** The head before and after; "" if unknown. */
			before: string;
			after: string;
	  }
	| {
			kind: "base-change";
			actor: TimelineActor;
			at: string;
			/** Branch names. */
			before: string;
			after: string;
	  }
	| {
			kind: "ready" | "draft" | "closed" | "reopened";
			actor: TimelineActor;
			at: string;
	  }
	| {
			kind: "merged";
			actor: TimelineActor;
			at: string;
			/** The merge's commit; "" if unknown. */
			commit: string;
	  };

/**
 * One line of the PR's timeline, oldest first: a run of commits by one
 * author, a run of review activity (reviews, review comments, conversation
 * comments) by one person, or a single history fact.
 */
export type TimelineEvent =
	| {
			kind: "commits";
			actor: TimelineActor;
			from: string;
			to: string;
			items: TimelineCommit[];
	  }
	| {
			kind: "review";
			actor: TimelineActor;
			from: string;
			to: string;
			items: TimelineReviewItem[];
	  }
	| TimelineFact;

/** A read's timeline (OverviewRead): every event, oldest first. */
export interface TimelineView {
	events: TimelineEvent[];
	/**
	 * What GitHub didn't give in full ("GitHub listed 250 of 300 commits"):
	 * shown, so no activity is dropped silently.
	 */
	gaps: string[];
}

/**
 * What became of a cluster of the viewed snapshot since the patch set it
 * is compared with: carried (the same change, its mark carried over),
 * reworked (the reviewer's marked change, edited since), new (not in that
 * patch set), gone (a marked cluster of that patch set with no image in
 * the snapshot; its key is the old cluster's).
 */
export type ClusterKind = "carried" | "reworked" | "new" | "gone";

/**
 * The engine's answer for one comparison, patch set `from` to the snapshot
 * of `toHead` (`GET /rereview?from=&to=`): the shape, whether the
 * interdiff could be built, each file's clusters by kind, how much there is
 * to read, and the thread placements (empty until PR 5). Clusters of a
 * conflicted file are all new. `files` holds every file of the snapshot by
 * its index, then any file only the interdiff has (everything the reviewer
 * saw of it was undone) at an index past the snapshot's files, good for
 * `GET /files/:index/hunks?from=` alone.
 */
export interface RereviewAnswer {
	from: number;
	toHead: string;
	toRevision: string;
	shape: Shape;
	interdiff: "available" | "unavailable";
	reason?: Shape["virtualRebase"];
	files: {
		index: number;
		path: string;
		conflict: boolean;
		clusters: {
			key: string;
			kind: ClusterKind;
			/** carried and gone: the patch set the cluster is from. */
			from?: number;
			/** carried: the state carried, and the rule it carried under. */
			state?: "reviewed" | "crossed-off";
			rule?: "exact" | "rename";
		}[];
	}[];
	/** Files with a reworked or new cluster (or a conflict), and those clusters. */
	toRead: { files: number; clusters: number };
	/**
	 * Every unresolved thread's place in the target snapshot
	 * (src/shared/rereview/placement.ts), as of the read of GitHub the
	 * engine's job saw; the page reads them by read (`GET /placements`).
	 */
	threads: { id: string; placement: ThreadPlacement }[];
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
	/**
	 * The commit `crb --head` pinned the snapshot's head on, for the whole
	 * session (the patch set's once started, which is the same commit); null
	 * without one.
	 */
	pinnedHead: string | null;
	/** The reviewer's patch sets, in start order (the patch set graph's dots). */
	patchsets: {
		number: number;
		head: string;
		mergeBase: string;
		/** Ms since epoch. */
		startedAt: number;
		/** The patch set it follows; null for PS1. */
		since: number | null;
		shape: ShapeCode | null;
	}[];
	/**
	 * The PR's head when this crb last opened the review, before this open
	 * (the toast's "since you last looked"); null on the first open.
	 */
	lastSeen: { head: string; at: number } | null;
	/**
	 * The PR's head on GitHub as last checked (`GET /head`), with its merge
	 * base and the commits it has over the latest patch set's head (over its
	 * merge base after a force-push; 0 when it is the snapshot's head): the
	 * graph's head dot and the toast. Null for a merged or closed PR, an
	 * as-of view and a pinned head, which show neither.
	 */
	head: {
		oid: string;
		mergeBase: string;
		baseBranch: string;
		commits: number;
	} | null;
}
