import { spawn } from "node:child_process";
import type { PrOverview } from "../shared/types.js";
import { headAsOf } from "./asOf.js";
import { GhError } from "./errors.js";
import { mapOverview } from "./overview.js";
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
			stdio: ["ignore", "pipe", "pipe"],
		});
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

export async function runGh(
	args: string[],
	opts: GhRun & {
		/**
		 * Takes a failed call's output anyway when this says it holds an
		 * answer (GraphQL's partial data, which gh exits 1 on).
		 */
		partial?: (stdout: string) => boolean;
	} = {},
): Promise<string> {
	const result = await spawnGh(args, {
		...opts,
		timeoutMs: opts.timeoutMs ?? GH_TIMEOUT_MS,
	});
	if (result.code === 0) return result.stdout;
	if (opts.partial?.(result.stdout)) return result.stdout;
	if (LOGGED_OUT.test(result.stderr)) throw new GhError(NOT_LOGGED_IN);
	const isAuthStatus = args[0] === "auth" && args[1] === "status";
	if (!isAuthStatus) {
		const host = process.env.GH_HOST || "github.com";
		const auth = await spawnGh(
			["auth", "status", "--active", "--hostname", host],
			{ cwd: opts.cwd, env: opts.env, signal: opts.signal },
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
	if (!owner || !repo || extra !== undefined) {
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

export async function fetchPrMeta(ref: PrRef): Promise<PrMeta> {
	const v = rec(
		await prView(
			ref,
			"number,title,url,state,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner",
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
// A thread's summary: everything the lists need (grouping, sorting,
// counts, the card's header) and the anchor of its code, without the
// opening comment's text and diff hunk (threadContents reads those). Only
// authors and times for the comments (reply detection, and counting as of
// a cutoff), and the latest comment's time (last activity past the first
// 100). The opener's original commit is where the clone takes its code from.
const THREAD_FIELDS = `id isResolved isOutdated path subjectType line originalLine startLine originalStartLine diffSide startDiffSide first: comments(first: 1) { nodes { ${AUTHOR} createdAt originalCommit { oid } } } latest: comments(last: 1) { nodes { createdAt } } comments(first: 100) { totalCount nodes { ${AUTHOR} createdAt } }`;
/** The opening comment's text and GitHub's diff hunk, by thread id. */
const CONTENT_FIELDS =
	"id first: comments(first: 1) { nodes { body bodyText bodyHTML diffHunk } }";
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
): Promise<unknown[]> {
	const query = QUERIES[connection];
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
	"readId" | "fetchedAt" | "servedAt"
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
	return notFoundAsPr(ref, () => fetchConnection(ref, "reviewThreads", read));
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
			return (
				rec(e).type === "NOT_FOUND" &&
				Array.isArray(path) &&
				path[0] === "nodes"
			);
		})
	);
}

/**
 * The opening comments' content (CONTENT_FIELDS) of the threads with these
 * ids, by id, read CONTENT_BATCH at a time, all at once. A thread GitHub
 * no longer has (deleted since its id was read) maps to null.
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
	return found;
}
