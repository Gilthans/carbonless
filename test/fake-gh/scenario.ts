import { readFileSync } from "node:fs";
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
	/**
	 * Home's repos, by `owner/repo` (any case): every PR as a GitHub
	 * pullRequest node (homePr builds one). The fake lists them (number and
	 * updatedAt, newest first, `homePageSize` a page) for prFacts.ts's list
	 * query and serves them whole to its details query. Independent of `prs`
	 * (the PR a review opens) and `repoPath`. To make a PR change between
	 * refreshes, rewrite the scenario (bumpHomePr).
	 */
	repos?: Record<string, { prs: HomePrNode[] }>;
	/** PRs per page of Home's list query (default 100, like GitHub's). */
	homePageSize?: number;
	/** Home's list and details queries answer this late. */
	homeDelayMs?: number;
	/** Home's list and details queries fail as GitHub's rate limit does. */
	rateLimited?: boolean;
	/**
	 * PRs (by repo, then number) Home's list query leaves out, as if they
	 * slid to an already read page between two pages' reads.
	 */
	homeListSkip?: Record<string, number[]>;
	/** PRs whose details GitHub answers null, with an error (partial data). */
	homeDetailsNull?: Record<string, number[]>;
	/**
	 * The viewer's teams (`org/slug`); null: reading them fails as with a
	 * token missing `read:org`. Absent: no teams.
	 */
	viewerTeams?: string[] | null;
	/**
	 * `gh search repos` answers: repos whose full name holds the text. `gh
	 * search prs --repo` matches the PRs of `repos` (title words, any order,
	 * case-insensitive), newest activity first.
	 */
	search?: {
		repos?: { fullName: string }[];
		/** Both searches fail with this as gh's message. */
		fail?: string;
		/** Answers this late. */
		delayMs?: number;
	};
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
 */
export function writeScenario(dir: string, s: Scenario): string {
	const path = join(dir, "fake-gh-scenario.json");
	writeFileAtomic(path, JSON.stringify(s, null, "\t"));
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

/** A PR as Home's GraphQL queries read it (prFacts.ts PR_FIELDS). */
export interface HomePrNode {
	number: number;
	title: string;
	url: string;
	isDraft: boolean;
	state: "OPEN" | "MERGED" | "CLOSED";
	updatedAt: string;
	closedAt: string | null;
	mergedAt: string | null;
	headRefOid: string;
	author: { login: string; avatarUrl: string } | null;
	reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
	reviewRequests: { nodes: { requestedReviewer: Record<string, unknown> }[] };
	latestReviews: {
		nodes: {
			author: { login: string; avatarUrl: string };
			state: string;
			submittedAt: string;
		}[];
	};
	reviewThreads: { totalCount: number; nodes: { isResolved: boolean }[] };
	commits: {
		nodes: {
			commit: {
				committedDate: string;
				statusCheckRollup: { state: string } | null;
			};
		}[];
	};
	timelineItems: { nodes: Record<string, unknown>[] };
}

const avatar = (login: string) => `https://avatars.example/${login}`;

/**
 * A Home PR node from the facts a test cares about. Activity (`reviews`,
 * `comments`, `commits`) goes into the timeline, reviews also into
 * latestReviews (the latest per login); `updatedAt` defaults to the
 * latest of them, else `created`.
 */
export function homePr(p: {
	repo: string;
	number: number;
	title?: string;
	author: string;
	draft?: boolean;
	state?: "OPEN" | "MERGED" | "CLOSED";
	/** When it was merged or closed. */
	closedAt?: string;
	updatedAt?: string;
	created?: string;
	/** Logins, or `org/slug` for a team. */
	requested?: string[];
	reviews?: { login: string; state?: string; at: string }[];
	comments?: { login: string; at: string }[];
	commits?: { login?: string; at: string }[];
	checks?: "SUCCESS" | "FAILURE" | "PENDING" | null;
	decision?: "APPROVED" | "CHANGES_REQUESTED" | null;
	threads?: { resolved?: number; unresolved?: number };
	/** The head commit (default: one per number). */
	head?: string;
}): HomePrNode {
	const state = p.state ?? "OPEN";
	const times = [
		...(p.reviews ?? []).map((r) => r.at),
		...(p.comments ?? []).map((c) => c.at),
		...(p.commits ?? []).map((c) => c.at),
		...(p.closedAt ? [p.closedAt] : []),
	].sort();
	const updatedAt =
		p.updatedAt ?? times.at(-1) ?? p.created ?? "2026-10-01T00:00:00Z";
	const person = (login: string) => ({ login, avatarUrl: avatar(login) });
	const latest = new Map<
		string,
		{ login: string; state: string; at: string }
	>();
	for (const r of [...(p.reviews ?? [])].sort((a, b) =>
		a.at.localeCompare(b.at),
	)) {
		latest.set(r.login.toLowerCase(), { ...r, state: r.state ?? "COMMENTED" });
	}
	const timeline = [
		...(p.commits ?? []).map((c) => ({
			at: c.at,
			node: {
				__typename: "PullRequestCommit",
				commit: {
					committedDate: c.at,
					author: { user: c.login ? person(c.login) : null },
				},
			},
		})),
		...(p.comments ?? []).map((c) => ({
			at: c.at,
			node: {
				__typename: "IssueComment",
				createdAt: c.at,
				author: person(c.login),
			},
		})),
		...(p.reviews ?? []).map((r) => ({
			at: r.at,
			node: {
				__typename: "PullRequestReview",
				submittedAt: r.at,
				state: r.state ?? "COMMENTED",
				author: person(r.login),
			},
		})),
	].sort((a, b) => a.at.localeCompare(b.at));
	const lastCommit = [...(p.commits ?? [])]
		.sort((a, b) => a.at.localeCompare(b.at))
		.at(-1);
	const [owner = "", name = ""] = p.repo.split("/");
	return {
		number: p.number,
		title: p.title ?? `PR ${p.number}`,
		url: `https://github.com/${owner}/${name}/pull/${p.number}`,
		isDraft: p.draft ?? false,
		state,
		updatedAt,
		closedAt: state === "OPEN" ? null : (p.closedAt ?? updatedAt),
		mergedAt: state === "MERGED" ? (p.closedAt ?? updatedAt) : null,
		headRefOid: p.head ?? p.number.toString(16).padStart(40, "0"),
		author: person(p.author),
		reviewDecision: p.decision ?? null,
		reviewRequests: {
			nodes: (p.requested ?? []).map((r) => {
				const [org, slug] = r.split("/");
				return {
					requestedReviewer: slug
						? {
								__typename: "Team",
								slug,
								organization: { login: org },
								avatarUrl: avatar(r),
							}
						: { __typename: "User", ...person(r) },
				};
			}),
		},
		latestReviews: {
			nodes: [...latest.values()].map((r) => ({
				author: person(r.login),
				state: r.state,
				submittedAt: r.at,
			})),
		},
		reviewThreads: {
			totalCount: (p.threads?.resolved ?? 0) + (p.threads?.unresolved ?? 0),
			nodes: [
				...Array.from({ length: p.threads?.resolved ?? 0 }, () => ({
					isResolved: true,
				})),
				...Array.from({ length: p.threads?.unresolved ?? 0 }, () => ({
					isResolved: false,
				})),
			],
		},
		commits: {
			nodes: lastCommit
				? [
						{
							commit: {
								committedDate: lastCommit.at,
								statusCheckRollup: p.checks ? { state: p.checks } : null,
							},
						},
					]
				: [],
		},
		timelineItems: { nodes: timeline.slice(-30).map((t) => t.node) },
	};
}

/**
 * Activity on a Home PR between refreshes: its updatedAt moves to `at`,
 * and with `by`, that login's comment at `at` joins its timeline. Writes
 * the scenario at `path` (as $CRB_FAKE_GH) back.
 */
export function bumpHomePr(
	path: string,
	repo: string,
	number: number,
	at: string,
	by?: string,
): void {
	const s = JSON.parse(readFileSync(path, "utf8")) as Scenario;
	const key = Object.keys(s.repos ?? {}).find(
		(k) => k.toLowerCase() === repo.toLowerCase(),
	);
	const pr = key
		? s.repos?.[key]?.prs.find((p) => p.number === number)
		: undefined;
	if (!pr) throw new Error(`No Home PR ${repo}#${number} in the scenario`);
	pr.updatedAt = at;
	if (by) {
		pr.timelineItems.nodes.push({
			__typename: "IssueComment",
			createdAt: at,
			author: { login: by, avatarUrl: avatar(by) },
		});
	}
	writeFileAtomic(path, JSON.stringify(s, null, "\t"));
}
