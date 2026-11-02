import { spawn } from "node:child_process";
import type { PrOverview } from "../shared/types.js";
import { headAsOf } from "./asOf.js";
import { GhError, WriteRefusedError } from "./errors.js";
import { mapOverview } from "./overview.js";
import { type HeadSpec, needsCommentPages, pickHead } from "./pinnedHead.js";
import { slugify } from "./slug.js";

export { GhError, slugify };

export interface PrRef {
	owner: string;
	repo: string;
	number: number;
}

export interface PrMeta {
	owner: string;
	repo: string;
	number: number;
	url: string;
	title: string;
	baseBranch: string;
	/**
	 * The commit GitHub takes the PR's base at (`baseRefOid`: the branch's
	 * tip while open, frozen once merged or closed); absent if GitHub gave
	 * none.
	 */
	baseOid?: string;
	headBranch: string;
	/** owner/repo of the head branch's repository. */
	headRepo: string;
	headOid: string;
	state: "OPEN" | "CLOSED" | "MERGED";
}

const NOT_INSTALLED =
	"gh is not installed. Install it from https://cli.github.com";
const NOT_LOGGED_IN = "gh is not logged in. Run: gh auth login";

/**
 * GH_* variables (GH_HOST, GH_TOKEN, GH_CONFIG_DIR) pass through on purpose:
 * they are how the reviewer points gh at their account. Only what could make
 * gh prompt, page, colour or redirect `-R`-less commands is overridden.
 */
function ghEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	delete env.GH_REPO;
	delete env.GH_FORCE_TTY;
	delete env.CLICOLOR_FORCE;
	return {
		...env,
		GH_PROMPT_DISABLED: "1",
		GH_NO_UPDATE_NOTIFIER: "1",
		NO_COLOR: "1",
		GH_PAGER: "cat",
		PAGER: "cat",
	};
}

interface GhResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** How long a GitHub read may take before gh is killed (0: no limit). */
export const GH_TIMEOUT_MS = 60_000;

/** How a gh call is run. */
interface GhRun {
	cwd?: string;
	/** Replaces process.env as the base environment for gh. */
	env?: NodeJS.ProcessEnv;
	/** Kills a gh that hangs (default GH_TIMEOUT_MS; 0 for no limit). */
	timeoutMs?: number;
	/** Kills gh when aborted (a session closing); it never starts once aborted. */
	signal?: AbortSignal;
	/** What is being read, for the messages ("the review threads"). */
	what?: string;
	/** Written to gh's stdin (a write's JSON body, `--input -`). */
	input?: string;
}

/** The error an aborted gh call fails with. */
export class GhAbortedError extends GhError {}

function spawnGh(args: string[], run: GhRun = {}): Promise<GhResult> {
	const { signal } = run;
	const timeoutMs = run.timeoutMs ?? 0;
	const what = run.what ?? `gh ${args.slice(0, 2).join(" ")}`;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new GhAbortedError(`Stopped reading ${what}`));
			return;
		}
		const child = spawn("gh", args, {
			cwd: run.cwd,
			env: ghEnv(run.env),
			stdio: ["pipe", "pipe", "pipe"],
		});
		// Nothing to read but a write's body: gh sees its end at once.
		child.stdin.on("error", () => {});
		child.stdin.end(run.input ?? "");
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const stop = (error: GhError) => {
			child.kill("SIGKILL");
			child.stdout.destroy();
			child.stderr.destroy();
			reject(error);
		};
		// A hung read fails rather than hold the page's data forever.
		const timer =
			timeoutMs > 0
				? setTimeout(
						() =>
							stop(
								new GhError(
									`GitHub took longer than ${timeoutMs / 1000} s to answer for ${what}`,
								),
							),
						timeoutMs,
					)
				: undefined;
		const onAbort = () => stop(new GhAbortedError(`Stopped reading ${what}`));
		signal?.addEventListener("abort", onAbort, { once: true });
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		child.stdout.on("data", (c: Buffer) => out.push(c));
		child.stderr.on("data", (c: Buffer) => err.push(c));
		child.on("error", (error: NodeJS.ErrnoException) => {
			done();
			reject(
				new GhError(error.code === "ENOENT" ? NOT_INSTALLED : error.message),
			);
		});
		child.on("close", (code) => {
			done();
			resolve({
				code,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8").trim(),
			});
		});
	});
}

/** What `gh` says when there is no usable login. */
const LOGGED_OUT =
	/not logged in|not logged into|gh auth login|no oauth token|authentication failed|bad credentials|token .*(invalid|expired)/i;

/**
 * The line that names the problem: git (run by gh) prints progress first and
 * its `fatal:`/`error:` line last; otherwise gh's own first line.
 */
function problemLine(text: string): string {
	const lines = text.split("\n").map((line) => line.trim());
	const fatal = lines.filter((line) => /^(fatal|error):/.test(line)).at(-1);
	return fatal ?? lines[0] ?? "";
}

/** gh calls (runGh, runWrite) started and not yet finished: their args. */
const inFlight = new Set<{ args: string[] }>();
let idleWaiters: (() => void)[] = [];

/** Counts a gh call from its start to its end, follow-up gh runs included. */
async function tracked<T>(args: string[], call: () => Promise<T>): Promise<T> {
	const entry = { args };
	inFlight.add(entry);
	try {
		return await call();
	} finally {
		inFlight.delete(entry);
		if (inFlight.size === 0) {
			const waiters = idleWaiters;
			idleWaiters = [];
			for (const w of waiters) w();
		}
	}
}

/**
 * Resolves once no gh call is running, nor starts within a timer tick of
 * the last one ending (a read's next page, a failed read's sibling).
 * Test fixtures await it before they take the fake gh off PATH: a call
 * still going would otherwise end on the real gh. With `timeoutMs`, fails
 * after that long naming the calls still running (a gate left held).
 */
export async function ghIdle(timeoutMs?: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const timedOut =
		timeoutMs === undefined
			? undefined
			: new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						const calls = [...inFlight].map(
							(c) => `gh ${c.args.join(" ").slice(0, 120)}`,
						);
						reject(
							new Error(
								`gh calls still running after ${timeoutMs / 1000} s:\n${calls.join("\n")}`,
							),
						);
					}, timeoutMs);
				});
	const idle = (async () => {
		for (;;) {
			if (inFlight.size > 0) {
				await new Promise<void>((resolve) => idleWaiters.push(resolve));
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (inFlight.size === 0) return;
		}
	})();
	try {
		await (timedOut ? Promise.race([idle, timedOut]) : idle);
	} finally {
		clearTimeout(timer);
	}
}

export function runGh(
	args: string[],
	opts: Parameters<typeof runGhNow>[1] = {},
): Promise<string> {
	return tracked(args, () => runGhNow(args, opts));
}

async function runGhNow(
	args: string[],
	opts: GhRun & {
		/**
		 * Takes a failed call's output anyway when this says it holds an
		 * answer (GraphQL's partial data, which gh exits 1 on).
		 */
		partial?: (stdout: string) => boolean;
	} = {},
): Promise<string> {
	// The environment of the moment the call starts, for every gh it runs:
	// the logged-out check below starts later, when process.env (PATH, the
	// account) may have changed, and must ask the gh the call was made with.
	const env = { ...(opts.env ?? process.env) };
	const result = await spawnGh(args, {
		...opts,
		env,
		timeoutMs: opts.timeoutMs ?? GH_TIMEOUT_MS,
	});
	if (result.code === 0) return result.stdout;
	if (opts.partial?.(result.stdout)) return result.stdout;
	if (LOGGED_OUT.test(result.stderr)) throw new GhError(NOT_LOGGED_IN);
	const isAuthStatus = args[0] === "auth" && args[1] === "status";
	if (!isAuthStatus) {
		const host = env.GH_HOST || "github.com";
		const auth = await spawnGh(
			["auth", "status", "--active", "--hostname", host],
			{ cwd: opts.cwd, env, signal: opts.signal },
		);
		if (auth.code !== 0 && LOGGED_OUT.test(auth.stderr)) {
			throw new GhError(NOT_LOGGED_IN);
		}
	}
	throw new GhError(
		problemLine(result.stderr) || `gh exited with code ${result.code}`,
	);
}

const PR_URL =
	/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const PR_SHORT = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_PR_NUMBER = 2 ** 31 - 1;

export function parsePrArg(
	arg: string,
): { owner: string; repo: string; number: number } | { number: number } {
	const fail = () =>
		new GhError(`Not a PR: ${arg}. Use a PR URL, owner/repo#123 or a number`);
	const text = arg.trim();
	const full = PR_URL.exec(text) ?? PR_SHORT.exec(text);
	const raw = full ? full[3] : /^\d+$/.test(text) ? text : undefined;
	const number = Number(raw);
	if (!raw || number < 1 || number > MAX_PR_NUMBER) throw fail();
	if (!full) return { number };
	const [, owner, repo] = full;
	// Task 6 builds cache paths from these, so they must be plain path segments.
	if (!owner || !repo || !validOwnerRepo(owner, repo)) throw fail();
	return { owner, repo, number };
}

export async function resolvePrRef(arg: string, cwd: string): Promise<PrRef> {
	const parsed = parsePrArg(arg);
	if ("owner" in parsed) return parsed;
	const out = await runGh(["repo", "view", "--json", "nameWithOwner"], { cwd });
	const name = (safeJson(out) as { nameWithOwner?: unknown } | null)
		?.nameWithOwner;
	const [owner, repo, extra] = typeof name === "string" ? name.split("/") : [];
	// Plain path segments, as parsePrArg's: cache paths are built from them.
	if (!owner || !repo || extra !== undefined || !validOwnerRepo(owner, repo)) {
		throw new GhError(`Could not find the GitHub repository for ${cwd}`);
	}
	return { owner, repo, number: parsed.number };
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new GhError("gh returned output that is not JSON");
	}
}

export async function viewerSlug(): Promise<string> {
	return slugify(await viewerLogin());
}

async function viewerLogin(): Promise<string> {
	const user = safeJson(await runGh(["api", "user"])) as { login?: unknown };
	const login = typeof user?.login === "string" ? user.login : "";
	if (!slugify(login).replace(/-/g, "")) {
		throw new GhError("Could not determine your GitHub login from gh api user");
	}
	return login;
}

function isNotFound(error: unknown): boolean {
	return (
		error instanceof GhError &&
		/could not resolve to a (pullrequest|repository)|no pull requests found|not found/i.test(
			error.message,
		)
	);
}

/** A read's way to stop its gh calls (Session.close). */
export interface ReadSignal {
	signal?: AbortSignal;
}

async function prView(
	ref: PrRef,
	fields: string,
	read: ReadSignal = {},
): Promise<unknown> {
	try {
		return safeJson(
			await runGh(
				[
					"pr",
					"view",
					String(ref.number),
					"-R",
					`${ref.owner}/${ref.repo}`,
					"--json",
					fields,
				],
				{ ...read, what: "the PR" },
			),
		);
	} catch (error) {
		if (isNotFound(error)) {
			throw new GhError(`PR ${ref.owner}/${ref.repo}#${ref.number} not found`);
		}
		throw error;
	}
}

function rec(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function validOwnerRepo(owner: string, repo: string): boolean {
	return OWNER.test(owner) && REPO.test(repo) && repo !== "." && repo !== "..";
}

const OID_FORM = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export async function fetchPrMeta(
	ref: PrRef,
	read: ReadSignal = {},
): Promise<PrMeta> {
	const v = rec(
		await prView(
			ref,
			"number,title,url,state,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner",
			read,
		),
	);
	const { headRefOid, baseRefName, headRefName } = v;
	if (
		typeof headRefOid !== "string" ||
		typeof baseRefName !== "string" ||
		typeof headRefName !== "string"
	) {
		throw new GhError("gh returned an unexpected response for the PR");
	}
	const headOwner = rec(v.headRepositoryOwner).login;
	const headName = rec(v.headRepository).name;
	// A deleted fork has no head repository; the PR head still lives in the base repo.
	const headRepo =
		typeof headOwner === "string" && typeof headName === "string"
			? `${headOwner}/${headName}`
			: `${ref.owner}/${ref.repo}`;
	// The PR's own URL carries GitHub's canonical owner/repo spelling (and
	// follows renames); use it so every spelling maps to one cache dir and key.
	const url = typeof v.url === "string" ? v.url : "";
	const canonical = PR_URL.exec(url);
	const owner = canonical?.[1] ?? ref.owner;
	const repo = canonical?.[2] ?? ref.repo;
	if (!validOwnerRepo(owner, repo)) {
		throw new GhError("gh returned an unexpected response for the PR");
	}
	return {
		owner,
		repo,
		number: ref.number,
		url,
		title: typeof v.title === "string" ? v.title : "",
		baseBranch: baseRefName,
		...(typeof v.baseRefOid === "string" && OID_FORM.test(v.baseRefOid)
			? { baseOid: v.baseRefOid }
			: {}),
		headBranch: headRefName,
		headRepo,
		headOid: headRefOid,
		state: v.state === "CLOSED" || v.state === "MERGED" ? v.state : "OPEN",
	};
}

/**
 * A page of a PR connection: from the start (after a cursor), or `last`,
 * the final page.
 */
function connectionQuery(
	connection: string,
	nodeFields: string,
	end: "first" | "last" = "first",
): string {
	const [cursor, page] =
		end === "first"
			? [", $endCursor: String", "first: 100, after: $endCursor"]
			: ["", "last: 100"];
	return `query($owner: String!, $name: String!, $number: Int!${cursor}) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${connection}(${page}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { ${nodeFields} }
      }
    }
  }
}`;
}

const AUTHOR = "author { login __typename }";
/** A thread comment's author with their avatar (a 40px image: 20px at 2x). */
const COMMENT_AUTHOR = "author { login __typename avatarUrl(size: 40) }";
// A thread's summary: everything the lists need (grouping, sorting,
// counts, the card's header, the attention set) and the anchor of its
// code, without the comments' text and the opening one's diff hunk
// (threadContents reads those). Only authors and times for the comments
// (reply detection, the attention set and counting as of a cutoff), paged
// on past 100 (fetchThreadCommentPages), and the latest comment's author
// and time (last activity, and who spoke last, without the paging). The
// opener's original commit is where the clone takes its code from.
// Comment ids tie the timeline's review comments to their threads.
// Comments are dated by when they were published (commentTime.ts); `state`
// tells a pending one. Not their review's submission as well: on PR #99 it
// cost about 1 s more a page and never differed from `publishedAt`.
const COMMENT_TIMES = "createdAt publishedAt state";
/** A page of a thread's comments: where to read on from, past 100. */
const COMMENT_PAGE = "pageInfo { hasNextPage endCursor }";
const SUMMARY_COMMENT = `id ${COMMENT_AUTHOR} ${COMMENT_TIMES}`;
// What the viewer may do to it (reply, resolve, unresolve), and the
// opener's REST id, which a reply is posted to.
const THREAD_FIELDS = `id isResolved isOutdated path subjectType line originalLine startLine originalStartLine diffSide startDiffSide viewerCanReply viewerCanResolve viewerCanUnresolve first: comments(first: 1) { nodes { id databaseId ${COMMENT_AUTHOR} ${COMMENT_TIMES} originalCommit { oid } } } latest: comments(last: 1) { nodes { ${COMMENT_AUTHOR} ${COMMENT_TIMES} } } comments(first: 100) { totalCount ${COMMENT_PAGE} nodes { ${SUMMARY_COMMENT} } }`;
/**
 * Each comment's text, and GitHub's diff hunk (the opening one's shows the
 * code); when it was last edited, what the viewer may do to it (only to
 * their own: viewerDidAuthor), and its
 * REST id (which an edit or a delete goes to; server-only).
 */
const CONTENT_COMMENT = `${SUMMARY_COMMENT} body bodyText bodyHTML diffHunk databaseId lastEditedAt viewerCanUpdate viewerCanDelete viewerDidAuthor`;
/** Every comment of a thread with its text, by thread id (paged on past 100). */
const CONTENT_FIELDS = `id comments(first: 100) { totalCount ${COMMENT_PAGE} nodes { ${CONTENT_COMMENT} } }`;
/** Threads whose content one query reads (about 1 s for 50). */
const CONTENT_BATCH = 50;
export const NODE_ID = /^[A-Za-z0-9_=-]{1,100}$/;
/** The last page of threads, asked for alongside the first (fetchConnection). */
const LAST_THREADS_QUERY = connectionQuery(
	"reviewThreads",
	THREAD_FIELDS,
	"last",
);
const QUERIES = {
	reviewThreads: connectionQuery("reviewThreads", THREAD_FIELDS),
	comments: connectionQuery("comments", `${AUTHOR} createdAt`),
	// The commit a review was made on dates the PR's head (as-of mode).
	reviews: connectionQuery(
		"reviews",
		`${AUTHOR} state submittedAt commit { oid }`,
	),
	commits: connectionQuery(
		"commits",
		"commit { oid committedDate pushedDate }",
	),
};
/**
 * Reviews for `--head reviewed`: also whether a review only replied to
 * threads (pinnedHead.ts replyOnly), from its body and its comments' first
 * page; REVIEW_COMMENTS_QUERY reads the rest.
 */
const REVIEWED_QUERY = connectionQuery(
	"reviews",
	`id ${AUTHOR} state submittedAt body commit { oid } comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { replyTo { id } } }`,
);
/** One review's comments after the first page: replies or not. */
const REVIEW_COMMENTS_QUERY = `query($id: ID!, $endCursor: String) {
  node(id: $id) {
    ... on PullRequestReview {
      comments(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { replyTo { id } }
      }
    }
  }
}`;
/** Each connection as the messages name it. */
const CONNECTION_NAMES: Record<keyof typeof QUERIES, string> = {
	reviewThreads: "the review threads",
	comments: "the PR's comments",
	reviews: "the PR's reviews",
	commits: "the PR's commits",
};

/** One commit's check contexts (as-of mode), paged like the PR connections. */
const COMMIT_CHECKS_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: 100, after: $endCursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl startedAt completedAt }
              ... on StatusContext { context state targetUrl createdAt }
            }
          }
        }
      }
    }
  }
}`;

/** The description as GitHub renders it (HTML comments dropped, emoji and images resolved). */
const BODY_HTML_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { bodyHTML }
  }
}`;

const MAX_PAGES = 200;

export interface Page {
	nodes: unknown[];
	/** The cursor to read on from; null at the end. */
	next: string | null;
	/** Nodes in the whole connection, when GitHub said. */
	total: number | null;
}

/** One page of a PR connection. */
async function fetchPage(
	ref: PrRef,
	connection: keyof typeof QUERIES,
	query: string,
	after: string | undefined,
	read: ReadSignal,
): Promise<Page> {
	const out = safeJson(
		await runGh(
			[
				"api",
				"graphql",
				"-f",
				`query=${query}`,
				// -f keeps a numeric-looking owner a string; only the number is typed.
				"-f",
				`owner=${ref.owner}`,
				"-f",
				`name=${ref.repo}`,
				"-F",
				`number=${ref.number}`,
				...(after ? ["-f", `endCursor=${after}`] : []),
			],
			{ ...read, what: CONNECTION_NAMES[connection] },
		),
	);
	const conn = rec(rec(rec(rec(out).data).repository).pullRequest)[connection];
	const { nodes, pageInfo, totalCount } = rec(conn);
	if (!Array.isArray(nodes)) {
		throw new GhError(
			`gh returned an unexpected response for the PR ${connection}`,
		);
	}
	const info = rec(pageInfo);
	return {
		nodes,
		next:
			info.hasNextPage !== true
				? null
				: typeof info.endCursor === "string"
					? info.endCursor
					: "",
		total:
			typeof totalCount === "number" && Number.isInteger(totalCount)
				? totalCount
				: null,
	};
}

/**
 * The first and last pages as the whole connection, when together they
 * hold all of it: both count the same total, they overlap by at least one
 * node, and the overlap is the same nodes by id. Null otherwise: more than
 * two pages, or no overlap to show nothing moved between the two reads (a
 * thread deleted and another added keeps the total but shifts the pages,
 * which would drop one).
 */
export function joinEnds(first: Page, last: Page): unknown[] | null {
	const total = first.total;
	if (total === null || last.total !== total) return null;
	const skip = first.nodes.length + last.nodes.length - total;
	if (
		skip < 1 ||
		skip > last.nodes.length ||
		first.nodes.length > total ||
		last.nodes.length > total
	) {
		return null;
	}
	for (let j = 0; j < skip; j++) {
		const a = rec(first.nodes[total - last.nodes.length + j]).id;
		const b = rec(last.nodes[j]).id;
		if (typeof a !== "string" || a !== b) return null;
	}
	return [...first.nodes, ...last.nodes.slice(skip)];
}

/**
 * Every node of one PR connection, following `pageInfo` until the end.
 * Review threads are the slow read (about two seconds a page), so their
 * last page is read alongside the first: up to 199 threads take one round
 * trip. Past that, or if the two don't join, the pages are read in turn.
 */
async function fetchConnection(
	ref: PrRef,
	connection: keyof typeof QUERIES,
	read: ReadSignal = {},
	/** The connection's query with other node fields (same paging). */
	query: string = QUERIES[connection],
): Promise<unknown[]> {
	const [first, last] = await Promise.all([
		fetchPage(ref, connection, query, undefined, read),
		connection === "reviewThreads"
			? fetchPage(ref, connection, LAST_THREADS_QUERY, undefined, read).catch(
					() => null,
				)
			: null,
	]);
	if (first.next === null) return first.nodes;
	const joined = last && joinEnds(first, last);
	if (joined) return joined;
	const nodes = [...first.nodes];
	let after = first.next;
	for (let page = 1; page < MAX_PAGES && after; page++) {
		const next = await fetchPage(ref, connection, query, after, read);
		nodes.push(...next.nodes);
		if (next.next === null) return nodes;
		after = next.next;
	}
	throw new GhError(`Too many ${connection} to read for this PR`);
}

/** Every check context of commit `oid`; [] when it has none. */
async function fetchCommitChecks(
	ref: PrRef,
	oid: string,
	read: ReadSignal = {},
): Promise<unknown[]> {
	const nodes: unknown[] = [];
	let after: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const out = safeJson(
			await runGh(
				[
					"api",
					"graphql",
					"-f",
					`query=${COMMIT_CHECKS_QUERY}`,
					"-f",
					`owner=${ref.owner}`,
					"-f",
					`name=${ref.repo}`,
					"-f",
					`oid=${oid}`,
					...(after ? ["-f", `endCursor=${after}`] : []),
				],
				{ ...read, what: "the checks" },
			),
		);
		const object = rec(rec(rec(out).data).repository).object;
		if (object === null || typeof object !== "object") {
			throw new GhError(`Commit ${oid} is missing on GitHub`);
		}
		const rollup = rec(object).statusCheckRollup;
		// No checks ever reported for this commit.
		if (rollup === null) return nodes;
		const { nodes: pageNodes, pageInfo } = rec(rec(rollup).contexts);
		if (!Array.isArray(pageNodes)) {
			throw new GhError("gh returned an unexpected response for the checks");
		}
		nodes.push(...pageNodes);
		const info = rec(pageInfo);
		if (info.hasNextPage !== true) return nodes;
		if (typeof info.endCursor !== "string") break;
		after = info.endCursor;
	}
	throw new GhError("Too many checks to read for this commit");
}

/**
 * The PR's head commit at `cutoff` (as-of mode), from its commits and its
 * reviews' commits; see headAsOf.
 */
export async function fetchHeadAsOf(
	ref: PrRef,
	cutoff: string,
): Promise<string> {
	try {
		const [commits, reviews] = await Promise.all([
			fetchConnection(ref, "commits"),
			fetchConnection(ref, "reviews"),
		]);
		return headAsOf(commits, reviews, cutoff);
	} catch (error) {
		if (isNotFound(error)) {
			throw new GhError(`PR ${ref.owner}/${ref.repo}#${ref.number} not found`);
		}
		throw error;
	}
}

/**
 * The commit `spec` pins the view to (`crb --head`), from the PR's commits
 * and its reviews' commits, for `viewer` (a slug); see pickHead.
 */
export async function fetchPinnedHead(
	ref: PrRef,
	spec: HeadSpec,
	viewer: string,
): Promise<string> {
	const pr = `${ref.owner}/${ref.repo}#${ref.number}`;
	try {
		const [commits, reviews] = await Promise.all([
			spec.kind === "sha" ? fetchConnection(ref, "commits") : [],
			spec.kind === "reviewed"
				? fetchConnection(ref, "reviews", {}, REVIEWED_QUERY).then((rs) =>
						Promise.all(rs.map((r) => withAllComments(r, viewer))),
					)
				: fetchConnection(ref, "reviews"),
		]);
		return pickHead(spec, commits, reviews, viewer, pr);
	} catch (error) {
		if (isNotFound(error)) throw new GhError(`PR ${pr} not found`);
		throw error;
	}
}

/**
 * Review node `raw` with every one of its comments, when replyOnly needs
 * them (needsCommentPages); unchanged when it doesn't, or when they can't
 * be read (replyOnly then fails closed on the page still missing).
 */
async function withAllComments(raw: unknown, viewer: string): Promise<unknown> {
	if (!needsCommentPages(raw, viewer)) return raw;
	const review = rec(raw);
	const id = review.id;
	if (typeof id !== "string" || !NODE_ID.test(id)) return raw;
	const first = rec(review.comments);
	const nodes = [...(Array.isArray(first.nodes) ? first.nodes : [])];
	let after = rec(first.pageInfo).endCursor;
	for (let page = 1; page < MAX_PAGES; page++) {
		if (typeof after !== "string" || !after) return raw;
		const out = safeJson(
			await runGh(
				[
					"api",
					"graphql",
					"-f",
					`query=${REVIEW_COMMENTS_QUERY}`,
					"-f",
					`id=${id}`,
					"-f",
					`endCursor=${after}`,
				],
				{ what: "a review's comments" },
			),
		);
		const conn = rec(rec(rec(out).data).node).comments;
		const { nodes: more, pageInfo } = rec(conn);
		if (!Array.isArray(more)) return raw;
		nodes.push(...more);
		const info = rec(pageInfo);
		if (info.hasNextPage === false) {
			return {
				...review,
				comments: { pageInfo: { hasNextPage: false }, nodes },
			};
		}
		after = info.endCursor;
	}
	return raw;
}

async function fetchBodyHtml(
	ref: PrRef,
	read: ReadSignal = {},
): Promise<string> {
	const out = safeJson(
		await runGh(
			[
				"api",
				"graphql",
				"-f",
				`query=${BODY_HTML_QUERY}`,
				"-f",
				`owner=${ref.owner}`,
				"-f",
				`name=${ref.repo}`,
				"-F",
				`number=${ref.number}`,
			],
			{ ...read, what: "the description" },
		),
	);
	const html = rec(rec(rec(rec(out).data).repository).pullRequest).bodyHTML;
	if (typeof html !== "string") {
		throw new GhError("gh returned an unexpected response for the PR body");
	}
	return html;
}

/** The overview's own fields, without the read's stamps. */
export type OverviewFields = Omit<
	PrOverview,
	"readId" | "fetchedAt" | "servedAt" | "writes" | "commentLeft"
>;

/**
 * The PR's overview but its review threads (fetchThreadSummaries,
 * fetchThreadContents): the fast part, a few calls at once.
 */
export async function fetchOverview(
	ref: PrRef,
	viewer: string,
	/** As-of mode: the cutoff, and the snapshot head whose checks to show. */
	asOf?: { at: string; head: string },
	read: ReadSignal = {},
): Promise<OverviewFields> {
	return notFoundAsPr(ref, async () => {
		const [view, bodyHTML, comments, reviews, checks] = await Promise.all([
			prView(
				ref,
				"number,title,url,author,body,state,isDraft,createdAt,updatedAt,baseRefName,headRefName,mergeable,reviewRequests,statusCheckRollup",
				read,
			),
			fetchBodyHtml(ref, read),
			fetchConnection(ref, "comments", read),
			fetchConnection(ref, "reviews", read),
			asOf ? fetchCommitChecks(ref, asOf.head, read) : undefined,
		]);
		return mapOverview(
			view,
			{ bodyHTML, comments, reviews, checks },
			viewer,
			asOf?.at,
		);
	});
}

async function notFoundAsPr<T>(ref: PrRef, read: () => Promise<T>) {
	try {
		return await read();
	} catch (error) {
		if (isNotFound(error)) {
			throw new GhError(`PR ${ref.owner}/${ref.repo}#${ref.number} not found`);
		}
		throw error;
	}
}

/**
 * Every review thread's summary node (THREAD_FIELDS): all a list needs,
 * without the opening comments' text, the slow part of the read.
 */
export function fetchThreadSummaries(
	ref: PrRef,
	read: ReadSignal = {},
): Promise<unknown[]> {
	return notFoundAsPr(ref, async () => {
		const nodes = await fetchConnection(ref, "reviewThreads", read);
		const paged = await withEveryComment(nodes, SUMMARY_COMMENT, read);
		// Deleted while paged: listed as read (its content read says gone).
		return paged.map((node, i) => node ?? nodes[i]);
	});
}

const ACTOR = "login __typename avatarUrl(size: 40)";
/** What the timeline shows of each kind of item (timeline.ts maps it). */
const TIMELINE_NODE = `__typename
... on PullRequestCommit { url commit { oid messageHeadline committedDate pushedDate author { name user { ${ACTOR} } } } }
... on PullRequestReview { author { ${ACTOR} } state submittedAt bodyText url comments(first: 100) { totalCount nodes { id path line originalLine createdAt publishedAt state bodyText url replyTo { id } } } }
... on IssueComment { author { ${ACTOR} } createdAt bodyText url }
... on HeadRefForcePushedEvent { actor { ${ACTOR} } createdAt beforeCommit { oid } afterCommit { oid } }
... on BaseRefChangedEvent { actor { ${ACTOR} } createdAt previousRefName currentRefName }
... on ReadyForReviewEvent { actor { ${ACTOR} } createdAt }
... on ConvertToDraftEvent { actor { ${ACTOR} } createdAt }
... on MergedEvent { actor { ${ACTOR} } createdAt commit { oid } }
... on ClosedEvent { actor { ${ACTOR} } createdAt }
... on ReopenedEvent { actor { ${ACTOR} } createdAt }`;
const TIMELINE_TYPES =
	"PULL_REQUEST_COMMIT, PULL_REQUEST_REVIEW, ISSUE_COMMENT, HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT";
/** Timeline items per page. */
export const TIMELINE_PAGE = 100;
/**
 * A page of the timeline by position (`skip`), so pages after the first are
 * read at once; `filteredCount` is the number of items of these types.
 */
const TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $skip: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits { totalCount }
      timelineItems(first: ${TIMELINE_PAGE}, skip: $skip, itemTypes: [${TIMELINE_TYPES}]) {
        filteredCount
        nodes { ${TIMELINE_NODE} }
      }
    }
  }
}`;

/** The timeline's items as read (timeline.ts maps them). */
export interface TimelineRead {
	nodes: unknown[];
	/** The PR's commits as GitHub counts them; null if it didn't say. */
	commitCount: number | null;
	/**
	 * The items GitHub counts (`filteredCount`); more than `nodes` when it
	 * listed fewer than it counts (timeline.ts says so).
	 */
	itemCount: number;
}

async function fetchTimelinePage(
	ref: PrRef,
	skip: number,
	read: ReadSignal,
): Promise<{ nodes: unknown[]; count: number; commitCount: number | null }> {
	const out = safeJson(
		await runGh(
			[
				"api",
				"graphql",
				"-f",
				`query=${TIMELINE_QUERY}`,
				"-f",
				`owner=${ref.owner}`,
				"-f",
				`name=${ref.repo}`,
				"-F",
				`number=${ref.number}`,
				"-F",
				`skip=${skip}`,
			],
			{ ...read, what: "the PR's timeline" },
		),
	);
	const pr = rec(rec(rec(out).data).repository).pullRequest;
	const conn = rec(rec(pr).timelineItems);
	const count = conn.filteredCount;
	if (
		!Array.isArray(conn.nodes) ||
		typeof count !== "number" ||
		!Number.isInteger(count)
	) {
		throw new GhError("gh returned an unexpected response for the timeline");
	}
	const commits = rec(rec(pr).commits).totalCount;
	return {
		nodes: conn.nodes,
		count,
		commitCount: typeof commits === "number" ? commits : null,
	};
}

/**
 * Every item of the PR's timeline the Overview shows, in GitHub's order.
 * The first page says how many there are; the rest are read at once. The
 * pages must agree on the count (an item added or deleted between the
 * reads would shift them): if not, they are read again, and a second
 * disagreement is an error, never a timeline with a hole in it. Pages that
 * agree but hold fewer items than counted (items GitHub counts but doesn't
 * list, or the token can't see) are what GitHub gives: they are kept, and
 * `itemCount` lets the page say what's missing.
 */
export async function fetchTimeline(
	ref: PrRef,
	read: ReadSignal = {},
): Promise<TimelineRead> {
	return notFoundAsPr(ref, async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const first = await fetchTimelinePage(ref, 0, read);
			const pages = Math.ceil(first.count / TIMELINE_PAGE);
			if (pages > MAX_PAGES) {
				throw new GhError("Too many timeline items to read for this PR");
			}
			const rest = await Promise.all(
				Array.from({ length: Math.max(0, pages - 1) }, (_, i) =>
					fetchTimelinePage(ref, (i + 1) * TIMELINE_PAGE, read),
				),
			);
			if (rest.every((p) => p.count === first.count)) {
				return {
					nodes: [first, ...rest].flatMap((p) => p.nodes),
					commitCount: first.commitCount,
					itemCount: first.count,
				};
			}
		}
		throw new GhError("The PR's timeline kept changing while it was read");
	});
}

/**
 * Whether a GraphQL answer gh failed on (exit 1) still holds the answer:
 * `data` with every error a NOT_FOUND of a `nodes(ids:)` entry (a thread
 * deleted since its id was read).
 */
export function onlyMissingNodes(stdout: string): boolean {
	let answer: unknown;
	try {
		answer = JSON.parse(stdout);
	} catch {
		return false;
	}
	const { data, errors } = rec(answer);
	if (!Array.isArray(rec(data).nodes) || !Array.isArray(errors)) return false;
	return (
		errors.length > 0 &&
		errors.every((e) => {
			const path = rec(e).path;
			// A missing entry itself (["nodes", i]); one inside a node that
			// came back is a real failure.
			return (
				rec(e).type === "NOT_FOUND" &&
				Array.isArray(path) &&
				path.length === 2 &&
				path[0] === "nodes" &&
				Number.isInteger(path[1])
			);
		})
	);
}

/**
 * Every comment's content (CONTENT_FIELDS) of the threads with these ids,
 * by id, read CONTENT_BATCH at a time, all at once, and paged on past 100
 * comments. A thread GitHub no longer has (deleted since its id was read)
 * maps to null.
 */
export async function fetchThreadContents(
	ids: string[],
	read: ReadSignal = {},
): Promise<Map<string, unknown>> {
	const wanted = ids.filter((id) => NODE_ID.test(id));
	const batches: string[][] = [];
	for (let i = 0; i < wanted.length; i += CONTENT_BATCH) {
		batches.push(wanted.slice(i, i + CONTENT_BATCH));
	}
	const found = new Map<string, unknown>();
	await Promise.all(
		batches.map(async (batch) => {
			// Ids are checked above: plain text in the query is safe.
			const query = `query { nodes(ids: [${batch.map((id) => `"${id}"`).join(", ")}]) { ... on PullRequestReviewThread { ${CONTENT_FIELDS} } } }`;
			const out = safeJson(
				await runGh(["api", "graphql", "-f", `query=${query}`], {
					...read,
					what: "the review threads' comments",
					partial: onlyMissingNodes,
				}),
			);
			const nodes = rec(out).data;
			const list = rec(nodes).nodes;
			if (!Array.isArray(list)) {
				throw new GhError("gh returned an unexpected response for the threads");
			}
			// In the order asked; null for a thread GitHub no longer has.
			list.forEach((node, i) => {
				const id = rec(node).id;
				if (typeof id === "string") found.set(id, node);
				else if (node === null && batch[i] !== undefined) {
					found.set(batch[i], null);
				}
			});
		}),
	);
	const long = [...found.entries()].filter(([, n]) => n !== null);
	const paged = await withEveryComment(
		long.map(([, n]) => n),
		CONTENT_COMMENT,
		read,
	);
	paged.forEach((node, i) => {
		const id = long[i]?.[0];
		if (id !== undefined) found.set(id, node);
	});
	return found;
}

/** A GraphQL cursor, safe as a string literal in a query. */
const CURSOR = /^[A-Za-z0-9+/=_.:-]{1,200}$/;

/**
 * Threads' nodes with the rest of their comments read in, for those with
 * more than they list (`comments.totalCount` past `comments.nodes`): their
 * `comments.nodes` are then every comment, `fields` of each past the
 * first page; null for one GitHub no longer has (deleted while paged).
 * The others come back as they are.
 */
async function withEveryComment(
	nodes: unknown[],
	fields: string,
	read: ReadSignal,
): Promise<unknown[]> {
	const from = new Map<string, string>();
	for (const node of nodes) {
		const t = rec(node);
		const c = rec(t.comments);
		const info = rec(c.pageInfo);
		if (
			typeof t.id === "string" &&
			NODE_ID.test(t.id) &&
			typeof c.totalCount === "number" &&
			Array.isArray(c.nodes) &&
			c.totalCount > c.nodes.length &&
			info.hasNextPage === true &&
			typeof info.endCursor === "string"
		) {
			from.set(t.id, info.endCursor);
		}
	}
	if (from.size === 0) return nodes;
	const rest = await fetchThreadCommentPages(
		[...from.keys()],
		fields,
		read,
		from,
	);
	return nodes.map((node) => {
		const t = rec(node);
		const more = typeof t.id === "string" ? rest.get(t.id) : undefined;
		// Deleted while it was paged: gone, not cut short.
		if (more === null) return null;
		if (!more) return node;
		const c = rec(t.comments);
		return {
			...t,
			comments: { ...c, nodes: [...(c.nodes as unknown[]), ...more] },
		};
	});
}

/**
 * Whether a GraphQL answer gh failed on (exit 1) still holds the answer to
 * an aliased `node(id:)` query: every error a NOT_FOUND of one alias (a
 * thread deleted since its id was read).
 */
function onlyMissingAliases(stdout: string): boolean {
	let answer: unknown;
	try {
		answer = JSON.parse(stdout);
	} catch {
		return false;
	}
	const { data, errors } = rec(answer);
	if (typeof data !== "object" || data === null || !Array.isArray(errors)) {
		return false;
	}
	return (
		errors.length > 0 &&
		errors.every((e) => {
			const path = rec(e).path;
			return (
				rec(e).type === "NOT_FOUND" &&
				Array.isArray(path) &&
				path.length === 1 &&
				typeof path[0] === "string" &&
				/^t\d+$/.test(path[0])
			);
		})
	);
}

/**
 * The comments (`fields` of each) of the threads with these ids, by id,
 * oldest first: from the start, or from `from`'s cursor on for a thread
 * that has one (what its first page didn't list). One query a round for up
 * to CONTENT_BATCH threads at once (aliases), round after round while any
 * has more; never a query per thread. A thread GitHub no longer has maps
 * to null.
 */
export async function fetchThreadCommentPages(
	threadIds: string[],
	fields: string,
	read: ReadSignal = {},
	from: Map<string, string> = new Map(),
): Promise<Map<string, unknown[] | null>> {
	const found = new Map<string, unknown[] | null>();
	let todo = threadIds
		.filter((id) => NODE_ID.test(id))
		.map((id) => ({ id, after: from.get(id) }));
	for (const id of new Set(todo.map((t) => t.id))) found.set(id, []);
	for (let page = 0; todo.length > 0; page++) {
		if (page >= MAX_PAGES) {
			throw new GhError("Too many comments to read for a review thread");
		}
		const batches: (typeof todo)[] = [];
		for (let i = 0; i < todo.length; i += CONTENT_BATCH) {
			batches.push(todo.slice(i, i + CONTENT_BATCH));
		}
		const next = await Promise.all(
			batches.map(async (batch) => {
				const aliases = batch.map(({ id, after }, i) => {
					if (after !== undefined && !CURSOR.test(after)) {
						throw new GhError(
							"gh returned an unexpected cursor for a thread's comments",
						);
					}
					// Ids and cursors are checked: plain text in the query is safe.
					const cursor = after === undefined ? "" : `, after: "${after}"`;
					return `t${i}: node(id: "${id}") { ... on PullRequestReviewThread { comments(first: 100${cursor}) { ${COMMENT_PAGE} nodes { ${fields} } } } }`;
				});
				const out = safeJson(
					await runGh(
						["api", "graphql", "-f", `query=query { ${aliases.join(" ")} }`],
						{
							...read,
							what: "the review threads' comments",
							partial: onlyMissingAliases,
						},
					),
				);
				const data = rec(rec(out).data);
				return batch.flatMap(({ id }, i) => {
					const node = data[`t${i}`];
					// Deleted since: null, never a thread cut short.
					if (node === null || node === undefined) {
						found.set(id, null);
						return [];
					}
					const conn = rec(rec(node).comments);
					if (!Array.isArray(conn.nodes)) {
						throw new GhError(
							"gh returned an unexpected response for a thread's comments",
						);
					}
					found.get(id)?.push(...conn.nodes);
					const info = rec(conn.pageInfo);
					return info.hasNextPage === true && typeof info.endCursor === "string"
						? [{ id, after: info.endCursor }]
						: [];
				});
			}),
		);
		todo = next.flat();
	}
	return found;
}

/** One thread's summary by id, and the PR it is on. */
const THREAD_QUERY = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      ${THREAD_FIELDS}
      pullRequest { number repository { nameWithOwner } }
    }
  }
}`;

/**
 * One thread's summary node (THREAD_FIELDS, every comment listed) by id,
 * for a write: null when GitHub no longer has it or it isn't on PR `ref`.
 */
export async function fetchThread(
	ref: PrRef,
	id: string,
	read: ReadSignal = {},
): Promise<unknown | null> {
	if (!NODE_ID.test(id)) return null;
	const out = safeJson(
		await runGh(
			["api", "graphql", "-f", `query=${THREAD_QUERY}`, "-f", `id=${id}`],
			{
				...read,
				what: "the review thread",
				partial: (stdout) => writeAnswer(stdout, "").type === "NOT_FOUND",
			},
		),
	);
	const node = rec(rec(out).data).node;
	if (node === null || node === undefined) return null;
	const pr = rec(rec(node).pullRequest);
	const name = rec(pr.repository).nameWithOwner;
	if (
		pr.number !== ref.number ||
		typeof name !== "string" ||
		name.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase()
	) {
		return null;
	}
	const [paged] = await withEveryComment([node], SUMMARY_COMMENT, read);
	return paged ?? null;
}

/** What GitHub answered a failed write, as gh printed it on stdout. */
interface WriteAnswer {
	/** HTTP status: gh's "(HTTP 422)" on stderr, or the answer's own; null for none. */
	status: number | null;
	/** GitHub's message (REST: the top-level one with its details; GraphQL: the errors'). */
	message: string;
	/** GraphQL: the first error's type, when it has one. */
	type: string | null;
	/** Whether GitHub answered at all (a parseable answer on stdout). */
	answered: boolean;
}

/** Reads a failed write's gh output (WriteAnswer). */
export function writeAnswer(stdout: string, stderr: string): WriteAnswer {
	let answer: Record<string, unknown> | null = null;
	try {
		const parsed = JSON.parse(stdout);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			answer = parsed as Record<string, unknown>;
		}
	} catch {
		answer = null;
	}
	const said = /\(HTTP (\d{3})\)/.exec(stderr)?.[1];
	const own = answer?.status;
	const status = said
		? Number(said)
		: typeof own === "string" && /^\d{3}$/.test(own)
			? Number(own)
			: typeof own === "number"
				? own
				: null;
	const errors = Array.isArray(answer?.errors) ? answer.errors : [];
	const details = errors
		.map((e) => (typeof e === "string" ? e : rec(e).message))
		.filter((m): m is string => typeof m === "string" && m !== "");
	const top = typeof answer?.message === "string" ? answer.message : "";
	const type = rec(errors[0]).type;
	return {
		status,
		message: [top, ...details].filter(Boolean).join(": "),
		type: typeof type === "string" ? type : null,
		answered: answer !== null && (top !== "" || errors.length > 0),
	};
}

const RATE_LIMITED = /rate limit/i;
/** GraphQL errors GitHub gives for its own trouble, not the request's. */
const GITHUB_TROUBLE = /something went wrong|timed? ?out|try again/i;

/**
 * Whether a failed write may succeed if sent again unchanged (HTTP 408,
 * 429 or 5xx, a rate limit, GitHub's own trouble, or no answer at all: a
 * timeout or a network failure); otherwise GitHub refused it for good.
 */
export function transientWrite(a: WriteAnswer): boolean {
	if (!a.answered) return true;
	if (a.status === 408 || a.status === 429) return true;
	if (a.status !== null && a.status >= 500) return true;
	if (RATE_LIMITED.test(a.message) || a.type === "RATE_LIMITED") return true;
	return a.status === null && a.type === null && GITHUB_TROUBLE.test(a.message);
}

/**
 * The refusal a failed write is, by GitHub's answer: 401/403 or FORBIDDEN
 * → "forbidden", 404 or NOT_FOUND → "gone", anything else → "invalid",
 * with GitHub's message; null when it is transient (transientWrite).
 */
export function writeRefusal(
	a: WriteAnswer,
	fallback: string,
): WriteRefusedError | null {
	if (transientWrite(a)) return null;
	const message = a.message || fallback;
	if (a.status === 401 || a.status === 403 || a.type === "FORBIDDEN") {
		return new WriteRefusedError(message, "forbidden");
	}
	if (a.status === 404 || a.type === "NOT_FOUND") {
		return new WriteRefusedError(message, "gone");
	}
	return new WriteRefusedError(message, "invalid");
}

/**
 * A write's gh call: its answer, the refusal it is (WriteRefusedError,
 * `special` first), or a GhError when it may land if sent again.
 */
function runWrite(
	args: string[],
	what: string,
	special: (a: WriteAnswer) => WriteRefusedError | null,
	input?: string,
): Promise<string> {
	return tracked(args, () => runWriteNow(args, what, special, input));
}

async function runWriteNow(
	args: string[],
	what: string,
	special: (a: WriteAnswer) => WriteRefusedError | null,
	input?: string,
): Promise<string> {
	const result = await spawnGh(args, { timeoutMs: GH_TIMEOUT_MS, what, input });
	if (result.code === 0) return result.stdout;
	const answer = writeAnswer(result.stdout, result.stderr);
	const refused =
		special(answer) ?? writeRefusal(answer, `GitHub refused ${what}`);
	if (refused) throw refused;
	if (LOGGED_OUT.test(result.stderr)) throw new GhError(NOT_LOGGED_IN);
	throw new GhError(
		problemLine(result.stderr) || `gh exited with code ${result.code}`,
	);
}

/** GitHub's REST answer to a reply: the new comment. */
export interface PostedReply {
	/** Its GraphQL node id. */
	nodeId: string;
	/** Its REST id (an edit or a delete goes to it before GraphQL lists it). */
	restId: number;
	body: string;
	bodyText: string;
	bodyHtml: string;
	author: string;
	/** The author's avatar, at 40px ("" when GitHub gave none). */
	avatarUrl: string;
	createdAt: string;
}

/** A REST avatar URL asked for at 40px, like GraphQL's avatarUrl(size: 40). */
export function avatar40(url: string): string {
	if (!url) return "";
	try {
		const u = new URL(url);
		u.searchParams.set("s", "40");
		return u.toString();
	} catch {
		return "";
	}
}

/**
 * Posts `body` as a reply to the thread whose first comment has REST id
 * `commentId`, at once (REST, never GraphQL's addPullRequestReviewThreadReply,
 * which would put it into a pending review). A pending review of the
 * viewer's (GitHub's 422) → "pending-review" with the PR's files page;
 * other refusals by writeRefusal. A GhError when it may land if sent again
 * (it may also have landed already).
 */
export async function postReply(
	ref: PrRef,
	commentId: number,
	body: string,
	prUrl: string,
): Promise<PostedReply> {
	const out = await runWrite(
		[
			"api",
			"-X",
			"POST",
			`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments/${commentId}/replies`,
			"-H",
			"Accept: application/vnd.github.full+json",
			// The body on stdin: as an argument a long one could pass the
			// system's limit for one.
			"--input",
			"-",
		],
		"the reply",
		(a) =>
			a.status === 422 && /pending review/i.test(a.message)
				? new WriteRefusedError(
						"A pending review on GitHub blocks replies: submit or discard it",
						"pending-review",
						`${prUrl.replace(/\/+$/, "")}/files`,
					)
				: null,
		JSON.stringify({ body }),
	);
	const c = rec(safeJson(out));
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	if (!str(c.node_id)) {
		throw new GhError("gh returned an unexpected response for the reply");
	}
	return {
		nodeId: str(c.node_id),
		restId: typeof c.id === "number" ? c.id : 0,
		body: str(c.body),
		bodyText: str(c.body_text),
		bodyHtml: str(c.body_html),
		author: str(rec(c.user).login),
		avatarUrl: avatar40(str(rec(c.user).avatar_url)),
		createdAt: str(c.created_at),
	};
}

/**
 * Resolves or unresolves thread `id` (GraphQL; idempotent). Refusals by
 * writeRefusal (no such thread: "gone").
 */
export async function postResolved(
	id: string,
	resolved: boolean,
): Promise<void> {
	const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
	const query = `mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { id isResolved } } }`;
	await runWrite(
		["api", "graphql", "-f", `query=${query}`, "-f", `id=${id}`],
		resolved ? "resolving the thread" : "unresolving the thread",
		() => null,
	);
}

/** GitHub's REST answer to an edit: the comment's new text. */
export interface EditedComment {
	body: string;
	bodyText: string;
	bodyHtml: string;
	/** When GitHub says it changed (REST `updated_at`). */
	updatedAt: string;
}

/**
 * Review comment `commentId` (its REST id) of PR `ref` as GitHub's REST
 * API has it now (no GraphQL lag after a write); null when it has none
 * (404). Other failures as a write's (runWrite): it is read for one.
 */
export async function fetchComment(
	ref: PrRef,
	commentId: number,
): Promise<EditedComment | null> {
	let out: string;
	try {
		out = await runWrite(
			[
				"api",
				`repos/${ref.owner}/${ref.repo}/pulls/comments/${commentId}`,
				"-H",
				"Accept: application/vnd.github.full+json",
			],
			"reading the comment",
			() => null,
		);
	} catch (error) {
		if (error instanceof WriteRefusedError && error.code === "gone") {
			return null;
		}
		throw error;
	}
	return editedFrom(out, "the comment");
}

/** A REST review comment's text (an edit's answer, or a read). */
function editedFrom(out: string, what: string): EditedComment {
	const c = rec(safeJson(out));
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	if (typeof c.body !== "string") {
		throw new GhError(`gh returned an unexpected response for ${what}`);
	}
	return {
		body: c.body,
		bodyText: str(c.body_text),
		bodyHtml: str(c.body_html),
		updatedAt: str(c.updated_at),
	};
}

/**
 * Edits review comment `commentId` (its REST id) of PR `ref` to `body`
 * (REST PATCH; a pending review doesn't block it). Refusals by
 * writeRefusal (404: "gone"); a GhError when it may land if sent again.
 */
export async function patchComment(
	ref: PrRef,
	commentId: number,
	body: string,
): Promise<EditedComment> {
	const out = await runWrite(
		[
			"api",
			"-X",
			"PATCH",
			`repos/${ref.owner}/${ref.repo}/pulls/comments/${commentId}`,
			"-H",
			"Accept: application/vnd.github.full+json",
			"--input",
			"-",
		],
		"the edit",
		() => null,
		JSON.stringify({ body }),
	);
	return editedFrom(out, "the edit");
}

/**
 * Deletes review comment `commentId` (its REST id) of PR `ref` (REST
 * DELETE). Refusals by writeRefusal (404: "gone", which a caller may count
 * as done); a GhError when it may land if sent again.
 */
export async function deleteComment(
	ref: PrRef,
	commentId: number,
): Promise<void> {
	await runWrite(
		[
			"api",
			"-X",
			"DELETE",
			`repos/${ref.owner}/${ref.repo}/pulls/comments/${commentId}`,
		],
		"the delete",
		() => null,
	);
}

/** Where a new thread goes: GitHub's REST fields for it (postThread). */
export type ThreadPlace =
	| { subject: "file"; path: string }
	| {
			subject: "line";
			path: string;
			side: "LEFT" | "RIGHT";
			line: number;
			/** The range's first line; absent for a single line. */
			start?: { side: "LEFT" | "RIGHT"; line: number };
	  };

/** GitHub's REST answer to a new thread's comment. */
export type PostedComment = PostedReply;

/** A REST review comment's fields a new thread's answer needs. */
function postedFrom(out: string, what: string): PostedComment {
	const c = rec(safeJson(out));
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	if (!str(c.node_id)) {
		throw new GhError(`gh returned an unexpected response for ${what}`);
	}
	return {
		nodeId: str(c.node_id),
		restId: typeof c.id === "number" ? c.id : 0,
		body: str(c.body),
		bodyText: str(c.body_text),
		bodyHtml: str(c.body_html),
		author: str(rec(c.user).login),
		avatarUrl: avatar40(str(rec(c.user).avatar_url)),
		createdAt: str(c.created_at),
	};
}

/**
 * Starts a review thread on PR `ref` at `place` on commit `commit`, with
 * `body`, at once (REST `pulls/{n}/comments`, never GraphQL's
 * addPullRequestReviewThread, which would put it into a pending review).
 * A single line is `line` + `side` only; a range adds `start_line` +
 * `start_side`; a file is `subject_type: "file"`. A pending review of the
 * viewer's (GitHub's 422) → "pending-review" with the PR's files page;
 * a line or file not in GitHub's diff (422 "could not be resolved") →
 * "gone"; other refusals by writeRefusal. A GhError when it may land if
 * sent again (it may also have landed already).
 */
export async function postThread(
	ref: PrRef,
	commit: string,
	place: ThreadPlace,
	body: string,
	prUrl: string,
): Promise<PostedComment> {
	const where =
		place.subject === "file"
			? { path: place.path, subject_type: "file" }
			: {
					path: place.path,
					...(place.start
						? { start_line: place.start.line, start_side: place.start.side }
						: {}),
					line: place.line,
					side: place.side,
				};
	const out = await runWrite(
		[
			"api",
			"-X",
			"POST",
			`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
			"-H",
			"Accept: application/vnd.github.full+json",
			"--input",
			"-",
		],
		"the comment",
		(a) => {
			if (a.status !== 422) return null;
			if (/pending review/i.test(a.message)) {
				return new WriteRefusedError(
					"A pending review on GitHub blocks new comments: submit or discard it",
					"pending-review",
					`${prUrl.replace(/\/+$/, "")}/files`,
				);
			}
			if (/could not be resolved/i.test(a.message)) {
				return new WriteRefusedError(
					place.subject === "file"
						? "GitHub's diff doesn't have this file"
						: "GitHub's diff doesn't have these lines",
					"gone",
				);
			}
			return null;
		},
		JSON.stringify({ body, commit_id: commit, ...where }),
	);
	return postedFrom(out, "the comment");
}

/** A PR review comment as REST lists it: what a retry looks for. */
export interface ListedComment {
	restId: number;
	nodeId: string;
	body: string;
	login: string;
	path: string;
	/** A reply's opener (REST id); null for a thread's first comment. */
	inReplyTo: number | null;
	posted: PostedComment;
}

/**
 * Every review comment of PR `ref` by REST (no GraphQL lag after a
 * write), oldest first, pages and all.
 */
export async function fetchReviewComments(
	ref: PrRef,
): Promise<ListedComment[]> {
	const out = safeJson(
		await runGh(
			[
				"api",
				`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
				"--paginate",
				"--slurp",
			],
			{ what: "the PR's review comments" },
		),
	);
	if (!Array.isArray(out)) {
		throw new GhError("gh returned an unexpected response for the comments");
	}
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	return out.flat().flatMap((raw): ListedComment[] => {
		const c = rec(raw);
		if (typeof c.id !== "number" || !str(c.node_id)) return [];
		return [
			{
				restId: c.id,
				nodeId: str(c.node_id),
				body: str(c.body),
				login: str(rec(c.user).login),
				path: str(c.path),
				inReplyTo:
					typeof c.in_reply_to_id === "number" ? c.in_reply_to_id : null,
				posted: postedFrom(JSON.stringify(c), "the comment"),
			},
		];
	});
}

/** The PR's newest threads, by the id of each one's first comment. */
const NEWEST_THREADS = 20;
const NEWEST_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(last: ${NEWEST_THREADS}) { nodes { id first: comments(first: 1) { nodes { id } } } }
    }
  }
}`;

/**
 * The id of the thread whose first comment is `commentId` (a GraphQL node
 * id; GitHub's comments don't name their thread): among the PR's newest
 * threads, where a thread just started is, or, with `everywhere`, among
 * all of them. Null when GitHub's GraphQL doesn't list it (yet).
 */
export async function findThreadOf(
	ref: PrRef,
	commentId: string,
	everywhere = false,
): Promise<string | null> {
	let nodes: unknown[];
	if (everywhere) {
		nodes = await fetchThreadSummaries(ref);
	} else {
		const out = safeJson(
			await runGh(
				[
					"api",
					"graphql",
					"-f",
					`query=${NEWEST_THREADS_QUERY}`,
					"-f",
					`owner=${ref.owner}`,
					"-f",
					`name=${ref.repo}`,
					"-F",
					`number=${ref.number}`,
				],
				{ what: "the review threads" },
			),
		);
		const conn = rec(
			rec(rec(rec(out).data).repository).pullRequest,
		).reviewThreads;
		const list = rec(conn).nodes;
		if (!Array.isArray(list)) {
			throw new GhError("gh returned an unexpected response for the threads");
		}
		nodes = list;
	}
	for (const node of nodes) {
		const t = rec(node);
		const first = rec((rec(t.first).nodes as unknown[] | undefined)?.[0]);
		if (first.id === commentId && typeof t.id === "string" && t.id) {
			return t.id;
		}
	}
	return null;
}

/**
 * GitHub's merge base of `base` (the PR's base commit, or its branch) and
 * commit `head` (its REST compare), which a LEFT line of a comment on
 * `head` resolves against.
 */
export async function fetchMergeBase(
	ref: PrRef,
	base: string,
	head: string,
	read: ReadSignal = {},
): Promise<string> {
	const out = await runGh(
		[
			"api",
			// A branch name's own slashes stay; anything else is escaped.
			// The second page of one commit: GitHub leaves the files out of
			// any page past the first, and keeps merge_base_commit on every
			// one (gallery #7, 60 files: 261 kB → 10 kB; a 1-commit PR too).
			`repos/${ref.owner}/${ref.repo}/compare/${base.split("/").map(encodeURIComponent).join("/")}...${head}?per_page=1&page=2`,
			"--jq",
			".merge_base_commit.sha",
		],
		{ ...read, what: "the merge base" },
	);
	const sha = out.trim();
	if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
		throw new GhError("gh returned an unexpected response for the merge base");
	}
	return sha;
}
