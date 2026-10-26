import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import prViewFixture from "../fixtures/gh/pr-view.json" with { type: "json" };
import threadsFixture from "../fixtures/gh/review-threads.json" with {
	type: "json",
};

/** Directory holding the fake `gh`; put it first on PATH. */
export const FAKE_GH_DIR = resolve(import.meta.dirname);

/** What the fake `gh` (test/fake-gh/gh) answers, read from `$CRB_FAKE_GH`. */
export interface Scenario {
	/** Local repository that `gh repo clone` clones from. */
	repoPath: string;
	user: { login: string };
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
	/** Each read of threads' opening comments by id answers this late. */
	threadContentDelayMs?: number;
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
	/** Every GraphQL query containing this text fails (gh exits 1). */
	failGraphql?: string;
	/** Nodes per GraphQL page (default 100, like gh.ts asks for). */
	pageSize?: number;
	/**
	 * Commits by OID, for `object(oid) { statusCheckRollup }` (as-of mode):
	 * `contexts` null means the commit has no rollup; a missing OID, no commit.
	 */
	commits?: Record<string, { contexts: unknown[] | null }>;
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

/** Writes the scenario as JSON into `dir` and returns its path for `$CRB_FAKE_GH`. */
export function writeScenario(dir: string, s: Scenario): string {
	const path = join(dir, "fake-gh-scenario.json");
	writeFileSync(path, JSON.stringify(s, null, "\t"));
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
	author: { login: string; __typename: string };
	/** The markdown (suggested changes are read from it). */
	body?: string;
	bodyText: string;
	bodyHTML: string;
	createdAt: string;
	/** GitHub's diff hunk ending at the commented line; "" for a file comment. */
	diffHunk?: string;
	/** The commit the comment was written on. */
	originalCommit?: { oid: string };
}

/** A reviewThreads node, as gh.ts queries it. */
export interface ThreadNode {
	isResolved: boolean;
	/** "LINE" or "FILE"; missing in older fixtures (taken from the line). */
	subjectType?: string;
	isOutdated: boolean;
	path: string;
	line: number | null;
	originalLine: number | null;
	originalStartLine: number | null;
	diffSide: string;
	startDiffSide: string | null;
	first: { nodes: CommentNode[] };
	latest: { nodes: { createdAt: string }[] };
	comments: {
		totalCount: number;
		nodes: { author: CommentNode["author"]; createdAt: string }[];
	};
}

/**
 * A reviewThreads node shaped like the synthetic fixture's first thread.
 * `comments` (opener first) fills the aliased `first` comment (with the
 * opener's diff hunk, if any), the aliased `latest` one and the authors-only
 * list. A `line` without an `originalLine` is taken as both.
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
					latest: { nodes: [{ createdAt: last.createdAt }] },
					comments: {
						totalCount: comments.length,
						nodes: comments.map((c) => ({
							author: c.author,
							createdAt: c.createdAt,
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
	text: string;
	html?: string;
	createdAt?: string;
	diffHunk?: string;
	/** The commit it was written on (GitHub's originalCommit). */
	commit?: string;
	/** The markdown, when it differs from `text`. */
	body?: string;
}): CommentNode {
	const escaped = c.text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	return {
		author: { login: c.login, __typename: c.bot ? "Bot" : "User" },
		body: c.body ?? c.text,
		bodyText: c.text,
		bodyHTML: c.html ?? `<p dir="auto">${escaped}</p>`,
		createdAt: c.createdAt ?? "2026-01-03T09:00:00Z",
		...(c.diffHunk === undefined ? {} : { diffHunk: c.diffHunk }),
		...(c.commit === undefined ? {} : { originalCommit: { oid: c.commit } }),
	};
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
		at: string;
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
				createdAt: c.at,
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
