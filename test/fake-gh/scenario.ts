import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import prViewFixture from "../fixtures/gh/pr-view.json" with { type: "json" };
import threadsFixture from "../fixtures/gh/review-threads.json" with {
	type: "json",
};
import { writeFileAtomic } from "./atomic.mjs";

/** Directory holding the fake `gh`; put it first on PATH. */
export const FAKE_GH_DIR = resolve(import.meta.dirname);

/** What the fake `gh` (test/fake-gh/gh) answers, read from `$CRB_FAKE_GH`. */
export interface Scenario {
	/** Local repository that `gh repo clone` clones from. */
	repoPath: string;
	/** The `gh` login; `avatarUrl` is GitHub's for it (REST `avatar_url`). */
	user: { login: string; avatarUrl?: string };
	/** Answer to `gh repo view --json nameWithOwner`; absent = not a GitHub repo. */
	nameWithOwner?: string;
	/** Every `gh` call fails as if no account were logged in. */
	loggedOut?: boolean;
	/** `gh repo clone` fails with this as git's last stderr line. */
	cloneError?: string;
	/** `gh pr view` answers only after this many milliseconds. */
	prViewDelayMs?: number;
	/** Each page of review threads (their summaries) answers this late. */
	threadsDelayMs?: number;
	/** Each read of threads' comments by id answers this late. */
	threadContentDelayMs?: number;
	/**
	 * Each read of threads' comments by id (the first page, or the rest)
	 * answers this late, on top of threadContentDelayMs.
	 */
	commentsDelayMs?: number;
	/** Comments per page of a thread's comments (default 100, like GitHub). */
	commentPageSize?: number;
	/**
	 * Thread ids (`T<pr>-<index>`) deleted since their list was read: their
	 * content comes back null with a NOT_FOUND error, and gh exits 1.
	 */
	deletedThreads?: string[];
	/** Each page of the timeline answers this late. */
	timelineDelayMs?: number;
	/**
	 * The timeline's count grows by the page's position on every page read
	 * (as if items were added between the reads).
	 */
	timelineCountDrift?: boolean;
	/** Timeline items GitHub counts (`filteredCount`) but doesn't list. */
	timelineUnlisted?: number;
	/** Every GraphQL query containing this text fails (gh exits 1). */
	failGraphql?: string;
	/**
	 * The next write of this kind fails with this HTTP status (used up once
	 * it has): a REST reply ("reply"), or resolving or unresolving
	 * ("resolve"; 403 fails as GraphQL's FORBIDDEN). `afterWrite` stores the
	 * write first, then fails: the ambiguous case (it landed, the answer
	 * didn't come back). Replies and resolving are written back into the
	 * scenario file, so later calls see them.
	 */
	failNext?: {
		/**
		 * Also a comment's REST edit ("edit") or delete ("delete"), or a new
		 * thread's REST comment ("comment").
		 */
		op: "reply" | "resolve" | "edit" | "delete" | "comment";
		status?: number;
		afterWrite?: boolean;
		/** GitHub's message (default: the status's usual one). */
		message?: string;
		/** Fail as GraphQL errors do instead: this error, its type only if given. */
		graphql?: { type?: string; message: string };
	};
	/** A posted reply's thread is deleted right after (deletedThreads). */
	replyDeletesThread?: boolean;
	/** A REST reply answers only after this many milliseconds (before it lands). */
	replyDelayMs?: number;
	/**
	 * A new thread's REST comment answers only after this many milliseconds
	 * (before it lands). New threads (REST `pulls/<n>/comments`) are checked
	 * against the PR's diff at their `commit_id` (merge base...commit, from
	 * the repository: a line or file outside it is GitHub's 422 "could not
	 * be resolved"), refused under the viewer's pending review (422), and
	 * written back into the scenario as GraphQL threads.
	 */
	commentDelayMs?: number;
	/**
	 * New threads started while this holds aren't listed by GitHub's
	 * GraphQL until it is cleared (listReplies); REST lists them at once.
	 */
	threadUnlisted?: boolean;
	/**
	 * GitHub's merge base of the PR's base branch and a commit (REST
	 * compare, and what a new comment's lines resolve against), by commit;
	 * else git's merge base in the repository.
	 */
	mergeBases?: Record<string, string>;
	/** The REST list of a PR's review comments answers this late. */
	restListDelayMs?: number;
	/** A REST compare (commentLeft's merge base) answers this late. */
	compareDelayMs?: number;
	/** A REST edit of a comment answers only after this many milliseconds (before it lands). */
	editDelayMs?: number;
	/** A REST delete of a comment answers only after this many milliseconds (before it lands). */
	deleteDelayMs?: number;
	/**
	 * Calls of these kinds wait (after their delay) until a test takes the
	 * kind out again (`release`): a gate on the test's cue, not the clock.
	 */
	hold?: HoldOp[];
	/** Held kinds whose new calls go at once; those already held still wait. */
	letThrough?: HoldOp[];
	/**
	 * An edit or a delete GitHub's GraphQL doesn't show for this many
	 * milliseconds after it was made (REST has it at once): the comment's
	 * text before, or the deleted comment, until then.
	 */
	writeUnlistedMs?: number;
	/**
	 * A reply GitHub's GraphQL doesn't list for this many milliseconds after
	 * it was posted (REST has it at once): the lag a write's re-read meets.
	 */
	replyUnlistedMs?: number;
	/**
	 * Replies posted while this holds aren't listed by GitHub's GraphQL
	 * until it is cleared (listReplies): the same lag, on a test's cue
	 * rather than the clock.
	 */
	replyUnlisted?: boolean;
	/**
	 * Fields merged into the REST review comment (`api repos/…/pulls/<n>/comments`)
	 * whose node id is the key; the fake derives the rest from the threads.
	 */
	restEdits?: Record<string, Record<string, unknown>>;
	/** Nodes per GraphQL page (default 100, like gh.ts asks for; REST: 30). */
	pageSize?: number;
	/**
	 * Commits by OID, for `object(oid) { statusCheckRollup }` (as-of mode):
	 * `contexts` null means the commit has no rollup; a missing OID, no commit.
	 */
	commits?: Record<string, { contexts: unknown[] | null }>;
	/**
	 * Review node id → every comment of that review (`{ replyTo }` nodes),
	 * for the pages after its first (`node(id) { ... on PullRequestReview }`).
	 */
	reviewComments?: Record<string, unknown[]>;
	prs: Record<
		string,
		{
			/** `gh pr view --json` object; only the requested fields are printed. */
			view: Record<string, unknown>;
			/** Full node lists of each PR connection; the fake pages them. */
			graphql?: {
				/** The description as GitHub renders it (`pullRequest { bodyHTML }`). */
				bodyHTML?: string;
				reviewThreads?: unknown[];
				comments?: unknown[];
				/**
				 * `reviews` nodes; one by the viewer (`user`) in state "PENDING"
				 * makes the fake refuse replies and new threads as GitHub does (422).
				 */
				reviews?: unknown[];
				/** `commits` nodes: `{ commit: { oid, committedDate, pushedDate } }`. */
				commits?: unknown[];
				/**
				 * `timelineItems` nodes (gh.ts TIMELINE_NODE's shape), GitHub's
				 * order; see timelineCommit etc. below.
				 */
				timelineItems?: unknown[];
				/** `commits { totalCount }` for the timeline (default: its commits). */
				commitCount?: number;
			};
		}
	>;
}

/**
 * Writes the scenario as JSON into `dir` and returns its path for
 * `$CRB_FAKE_GH`. Every write of the file is atomic (writeFileAtomic): gh
 * processes read it whole at any moment, and must never see it half-written.
 * A `hold` (and `letThrough`) already in the file stays unless `s` has its
 * own: a gate opens only on release(), never because the scenario was
 * rewritten (moveHead).
 */
export function writeScenario(dir: string, s: Scenario): string {
	const path = join(dir, "fake-gh-scenario.json");
	const before = existsSync(path)
		? (JSON.parse(readFileSync(path, "utf8")) as Scenario)
		: undefined;
	const next = { ...s };
	if (before?.hold?.length && !("hold" in s)) next.hold = before.hold;
	if (before?.letThrough?.length && !("letThrough" in s)) {
		next.letThrough = before.letThrough;
	}
	writeFileAtomic(path, JSON.stringify(next, null, "\t"));
	return path;
}

/** A `gh pr view` object: the synthetic fixture plus what fetchPrMeta reads. */
export function prView(
	partial: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		...prViewFixture,
		headRefOid: "0".repeat(40),
		headRepository: { name: "widget" },
		headRepositoryOwner: { login: "acme" },
		...partial,
	};
}

/** A review comment with its text, as the aliased `first` query returns it. */
export interface CommentNode {
	author: { login: string; __typename: string; avatarUrl?: string };
	/** The markdown (suggested changes are read from it). */
	body?: string;
	bodyText: string;
	bodyHTML: string;
	/** When it was written (also while its review was pending). */
	createdAt: string;
	/** When its review was submitted; null while pending (or unknown). */
	publishedAt?: string | null;
	/** "PENDING" in the viewer's unsubmitted review, else "SUBMITTED". */
	state?: "PENDING" | "SUBMITTED";
	/** GitHub's diff hunk ending at the commented line; "" for a file comment. */
	diffHunk?: string;
	/** The commit the comment was written on. */
	originalCommit?: { oid: string };
	/** When its text was last edited; none or null, never. */
	lastEditedAt?: string | null;
	/**
	 * Whether the viewer may edit or delete it (the fake's default: their
	 * own comments, as GitHub's for a writer).
	 */
	viewerCanUpdate?: boolean;
	viewerCanDelete?: boolean;
}

/** A review comment's times, as gh.ts queries them (COMMENT_TIMES). */
type CommentTimes = Pick<CommentNode, "createdAt" | "publishedAt" | "state">;

const timesOf = (c: CommentNode): CommentTimes => ({
	createdAt: c.createdAt,
	...("publishedAt" in c ? { publishedAt: c.publishedAt } : {}),
	...(c.state ? { state: c.state } : {}),
});

/** A reviewThreads node, as gh.ts queries it. */
export interface ThreadNode {
	isResolved: boolean;
	/**
	 * What the viewer may do (gh.ts THREAD_FIELDS). The fake's defaults are
	 * GitHub's for a writer: reply, and resolve an open thread or unresolve a
	 * resolved one.
	 */
	viewerCanReply?: boolean;
	viewerCanResolve?: boolean;
	viewerCanUnresolve?: boolean;
	/** "LINE" or "FILE"; missing in older fixtures (taken from the line). */
	subjectType?: string;
	isOutdated: boolean;
	path: string;
	line: number | null;
	originalLine: number | null;
	startLine?: number | null;
	originalStartLine: number | null;
	diffSide: string;
	startDiffSide: string | null;
	first: { nodes: CommentNode[] };
	latest: { nodes: ({ author?: CommentNode["author"] } & CommentTimes)[] };
	comments: {
		totalCount: number;
		/**
		 * Every comment, opener first: authors and times (the summary), and
		 * their text (the fake serves it only to a query by id).
		 */
		nodes: ({ author: CommentNode["author"] } & CommentTimes &
			Partial<
				Pick<
					CommentNode,
					| "body"
					| "bodyText"
					| "bodyHTML"
					| "lastEditedAt"
					| "viewerCanUpdate"
					| "viewerCanDelete"
				>
			>)[];
	};
}

/**
 * A reviewThreads node shaped like the synthetic fixture's first thread.
 * `comments` (opener first) fills the aliased `first` comment (with the
 * opener's diff hunk, if any), the aliased `latest` one and the list of
 * every comment (its text kept for the fake's read by id). A `line`
 * without an `originalLine` is taken as both.
 */
export function reviewThread(
	partial: Partial<Omit<ThreadNode, "first" | "comments">> = {},
	comments?: CommentNode[],
): ThreadNode {
	const base: ThreadNode | undefined = threadsFixture[0];
	if (!base) throw new Error("review-threads.json is empty");
	const opener = comments?.[0];
	const last = comments?.at(-1);
	return {
		...base,
		...partial,
		...("line" in partial && !("originalLine" in partial)
			? { originalLine: partial.line ?? null }
			: {}),
		...(comments && opener && last
			? {
					first: { nodes: [{ ...opener, diffHunk: opener.diffHunk ?? "" }] },
					latest: { nodes: [{ author: last.author, ...timesOf(last) }] },
					comments: {
						totalCount: comments.length,
						nodes: comments.map((c) => ({
							author: c.author,
							...timesOf(c),
							...(c.body === undefined ? {} : { body: c.body }),
							bodyText: c.bodyText,
							bodyHTML: c.bodyHTML,
							...(c.lastEditedAt === undefined
								? {}
								: { lastEditedAt: c.lastEditedAt }),
							...(c.viewerCanUpdate === undefined
								? {}
								: { viewerCanUpdate: c.viewerCanUpdate }),
							...(c.viewerCanDelete === undefined
								? {}
								: { viewerCanDelete: c.viewerCanDelete }),
						})),
					},
				}
			: {}),
	};
}

/** GitHub's rendering of the synthetic fixture's description. */
export const FIXTURE_BODY_HTML =
	'<p dir="auto">Caches widgets.</p>\n<p dir="auto">Fixes a slow path.</p>';

/**
 * A review comment node: `text` is the plain text, `html` GitHub's rendering
 * (defaults to `text` in one paragraph).
 */
export function threadComment(c: {
	login: string;
	bot?: boolean;
	/** Their avatar (GitHub's avatarUrl); none given, none listed. */
	avatarUrl?: string;
	text: string;
	html?: string;
	/** When it was written. */
	createdAt?: string;
	/**
	 * When its review was submitted (default: when written); null, not
	 * reported. GitHub dates what others saw by it.
	 */
	publishedAt?: string | null;
	/** In the viewer's unsubmitted review: no publishedAt. */
	pending?: boolean;
	diffHunk?: string;
	/** The commit it was written on (GitHub's originalCommit). */
	commit?: string;
	/** The markdown, when it differs from `text`. */
	body?: string;
	/** When its text was last edited (GitHub's lastEditedAt). */
	editedAt?: string;
}): CommentNode {
	const escaped = c.text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	return {
		author: {
			login: c.login,
			__typename: c.bot ? "Bot" : "User",
			...(c.avatarUrl === undefined ? {} : { avatarUrl: c.avatarUrl }),
		},
		body: c.body ?? c.text,
		bodyText: c.text,
		bodyHTML: c.html ?? `<p dir="auto">${escaped}</p>`,
		createdAt: c.createdAt ?? "2026-01-03T09:00:00Z",
		publishedAt: c.pending
			? null
			: c.publishedAt === undefined
				? (c.createdAt ?? "2026-01-03T09:00:00Z")
				: c.publishedAt,
		state: c.pending ? "PENDING" : "SUBMITTED",
		...(c.diffHunk === undefined ? {} : { diffHunk: c.diffHunk }),
		...(c.commit === undefined ? {} : { originalCommit: { oid: c.commit } }),
		...(c.editedAt === undefined ? {} : { lastEditedAt: c.editedAt }),
	};
}

/**
 * Hazards of the gate, for test authors:
 * - release() and letThrough() rewrite the scenario file. A gh write that
 *   isn't held (a reply, a resolve) saves the whole scenario it read at its
 *   start; landing after the test's edit, it puts the old `hold` back. Don't
 *   release while an unheld write is still out; wait for it first.
 * - A held write saves, once released, the scenario it read at its start
 *   (only `hold` is refreshed): test edits made while it was held, other
 *   than release(), are lost. Edit the scenario before the write starts or
 *   after it answers.
 *
 * The calls `hold` can stop, each where its `…DelayMs` waits: `comments`
 * and `threadContent` are reads of threads' comments, `threads` their
 * summaries, `restList` the REST review comments, `comment` a new thread's
 * REST comment.
 */
export type HoldOp =
	| "prView"
	| "threads"
	| "threadContent"
	| "comments"
	| "timeline"
	| "restList"
	| "compare"
	| "reply"
	| "comment"
	| "edit"
	| "delete";

/** Lets the held calls of kind `op` go (the scenario file at `path`, its writes kept). */
export function release(path: string, op: HoldOp): void {
	const s = JSON.parse(readFileSync(path, "utf8")) as Scenario;
	s.hold = s.hold?.filter((o) => o !== op);
	s.letThrough = s.letThrough?.filter((o) => o !== op);
	writeFileAtomic(path, JSON.stringify(s, null, "\t"));
}

/**
 * New calls of kind `op` go at once, while those already held keep waiting
 * for release(): a later call overtakes an earlier one, on the test's cue.
 */
export function letThrough(path: string, op: HoldOp): void {
	const s = JSON.parse(readFileSync(path, "utf8")) as Scenario;
	s.letThrough = [...(s.letThrough ?? []), op];
	writeFileAtomic(path, JSON.stringify(s, null, "\t"));
}

/**
 * GitHub's GraphQL catches up: replies posted under `replyUnlisted`, and
 * threads started under `threadUnlisted`, are listed from now on (the
 * scenario file at `path`, its writes kept).
 */
export function listReplies(path: string): void {
	const s = JSON.parse(readFileSync(path, "utf8")) as Scenario;
	s.replyUnlisted = false;
	s.threadUnlisted = false;
	writeFileAtomic(path, JSON.stringify(s, null, "\t"));
}

/**
 * Edits a comment in the scenario file at `path` as if someone did on
 * GitHub (its UI, another tab): the next read sees `body`, edited now.
 * `thread` is its index in PR `pr`'s reviewThreads, `comment` its
 * position there (0: the opener).
 */
export function editElsewhere(
	path: string,
	at: { pr: number | string; thread: number; comment: number },
	body: string,
): void {
	const s = JSON.parse(readFileSync(path, "utf8")) as Scenario;
	const t = s.prs[String(at.pr)]?.graphql?.reviewThreads?.[at.thread] as
		| Partial<ThreadNode>
		| undefined;
	const listed = t?.comments?.nodes?.[at.comment];
	if (!t || (!listed && at.comment !== 0)) {
		throw new Error(`No comment ${at.comment} in thread ${at.thread}`);
	}
	const text = {
		body,
		bodyText: body,
		bodyHTML: `<p dir="auto">${body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`,
		lastEditedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
	};
	if (listed) Object.assign(listed, text);
	const opener = t.first?.nodes?.[0];
	if (at.comment === 0 && opener) Object.assign(opener, text);
	writeFileAtomic(path, JSON.stringify(s, null, "\t"));
}

/**
 * A "suggested change" block as GitHub's bodyHTML draws one (its structure
 * and classes, synthetic text): `removed` lines as deletions, `added` as
 * additions, each cell's text escaped.
 */
export function suggestionHtml(removed: string[], added: string[]): string {
	const esc = (t: string) =>
		t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	const row = (kind: "deletion" | "addition", text: string, n: number) =>
		`<tr class="border-0"><td class="blob-num blob-num-${kind} text-right border-0 px-2 py-1 lh-default" data-line-number="${n}"></td><td class="border-0 px-2 py-1 blob-code-inner blob-code-${kind} js-blob-code-${kind} blob-code-marker-${kind}">${esc(text)}</td></tr>`;
	return `<div class="my-2 border rounded-2 js-suggested-changes-blob diff-view js-check-hidden-unicode" id="">
    <div class="f6 p-2 lh-condensed border-bottom d-flex"><div class="flex-auto flex-items-center color-fg-muted">
        Suggested change
      </div></div>
    <div itemprop="text" class="blob-wrapper data file rounded-0"><table class="d-table tab-size mb-0 width-full" data-paste-markdown-skip=""><tbody>${removed.map((t, i) => row("deletion", t, i + 1)).join("")}${added.map((t, i) => row("addition", t, i + 1)).join("")}</tbody></table></div>
    <div class="js-apply-changes"></div>
  </div>`;
}

const actorNode = (login: string, bot = false) => ({
	login,
	__typename: bot ? "Bot" : "User",
	avatarUrl: "",
});

/** A timeline commit (PullRequestCommit) by `login`. */
export function timelineCommit(c: {
	login: string;
	at: string;
	oid: string;
	headline?: string;
}): unknown {
	return {
		__typename: "PullRequestCommit",
		url: `https://github.com/acme/widget/pull/1/commits/${c.oid}`,
		commit: {
			oid: c.oid,
			messageHeadline: c.headline ?? `Commit ${c.oid.slice(0, 7)}`,
			committedDate: c.at,
			pushedDate: null,
			author: { name: c.login, user: actorNode(c.login) },
		},
	};
}

/** A timeline review (PullRequestReview) with its review comments. */
export function timelineReview(r: {
	login: string;
	bot?: boolean;
	at: string;
	state?: string;
	text?: string;
	comments?: {
		id: string;
		path: string;
		line: number | null;
		/** When it was written (default: when the review was submitted). */
		at?: string;
		/** When it was published (default: the review's time); null, not reported. */
		publishedAt?: string | null;
		text: string;
		replyTo?: string;
	}[];
	/** `comments.totalCount`, when more than listed. */
	totalComments?: number;
}): unknown {
	const comments = r.comments ?? [];
	return {
		__typename: "PullRequestReview",
		author: actorNode(r.login, r.bot),
		state: r.state ?? "COMMENTED",
		submittedAt: r.at,
		bodyText: r.text ?? "",
		url: "https://github.com/acme/widget/pull/1#pullrequestreview-1",
		comments: {
			totalCount: r.totalComments ?? comments.length,
			nodes: comments.map((c) => ({
				id: c.id,
				path: c.path,
				line: c.line,
				originalLine: c.line,
				createdAt: c.at ?? r.at,
				publishedAt: c.publishedAt === undefined ? r.at : c.publishedAt,
				state: "SUBMITTED",
				bodyText: c.text,
				url: `https://github.com/acme/widget/pull/1#discussion_${c.id}`,
				replyTo: c.replyTo ? { id: c.replyTo } : null,
			})),
		},
	};
}

/** A conversation comment (IssueComment). */
export function timelineComment(c: {
	login: string;
	bot?: boolean;
	at: string;
	text: string;
}): unknown {
	return {
		__typename: "IssueComment",
		author: actorNode(c.login, c.bot),
		createdAt: c.at,
		bodyText: c.text,
		url: "https://github.com/acme/widget/pull/1#issuecomment-1",
	};
}

/** A history event: force-push, base change, ready, draft, merged, closed, reopened. */
export function timelineFact(
	kind:
		| "HeadRefForcePushedEvent"
		| "BaseRefChangedEvent"
		| "ReadyForReviewEvent"
		| "ConvertToDraftEvent"
		| "MergedEvent"
		| "ClosedEvent"
		| "ReopenedEvent",
	e: { login: string; at: string } & Record<string, unknown>,
): unknown {
	const { login, at, ...rest } = e;
	return {
		__typename: kind,
		actor: actorNode(login),
		createdAt: at,
		...rest,
	};
}
