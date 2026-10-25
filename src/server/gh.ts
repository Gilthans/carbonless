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

function spawnGh(
	args: string[],
	cwd?: string,
	baseEnv?: NodeJS.ProcessEnv,
): Promise<GhResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("gh", args, {
			cwd,
			env: ghEnv(baseEnv),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (c: Buffer) => out.push(c));
		child.stderr.on("data", (c: Buffer) => err.push(c));
		child.on("error", (error: NodeJS.ErrnoException) => {
			reject(
				new GhError(error.code === "ENOENT" ? NOT_INSTALLED : error.message),
			);
		});
		child.on("close", (code) => {
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
	/** `env` replaces process.env as the base environment for gh. */
	opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
	const result = await spawnGh(args, opts.cwd, opts.env);
	if (result.code === 0) return result.stdout;
	if (LOGGED_OUT.test(result.stderr)) throw new GhError(NOT_LOGGED_IN);
	const isAuthStatus = args[0] === "auth" && args[1] === "status";
	if (!isAuthStatus) {
		const host = process.env.GH_HOST || "github.com";
		const auth = await spawnGh(
			["auth", "status", "--active", "--hostname", host],
			opts.cwd,
			opts.env,
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

async function prView(ref: PrRef, fields: string): Promise<unknown> {
	try {
		return safeJson(
			await runGh([
				"pr",
				"view",
				String(ref.number),
				"-R",
				`${ref.owner}/${ref.repo}`,
				"--json",
				fields,
			]),
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

function connectionQuery(connection: string, nodeFields: string): string {
	return `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${connection}(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${nodeFields} }
      }
    }
  }
}`;
}

const AUTHOR = "author { login __typename }";
const QUERIES = {
	reviewThreads: connectionQuery(
		"reviewThreads",
		// The opening comment's text and code; only authors and times for the
		// rest (reply detection, and counting as of a cutoff), and the latest
		// comment's time (last activity past the first 100). The opener's
		// original commit rebuilds its code when GitHub kept no diff hunk.
		`isResolved isOutdated path subjectType line originalLine originalStartLine diffSide startDiffSide first: comments(first: 1) { nodes { ${AUTHOR} bodyText bodyHTML createdAt diffHunk originalCommit { oid } } } latest: comments(last: 1) { nodes { createdAt } } comments(first: 100) { totalCount nodes { ${AUTHOR} createdAt } }`,
	),
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

/** Every node of one PR connection, following `pageInfo` until the end. */
async function fetchConnection(
	ref: PrRef,
	connection: keyof typeof QUERIES,
): Promise<unknown[]> {
	const nodes: unknown[] = [];
	let after: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const out = safeJson(
			await runGh([
				"api",
				"graphql",
				"-f",
				`query=${QUERIES[connection]}`,
				// -f keeps a numeric-looking owner a string; only the number is typed.
				"-f",
				`owner=${ref.owner}`,
				"-f",
				`name=${ref.repo}`,
				"-F",
				`number=${ref.number}`,
				...(after ? ["-f", `endCursor=${after}`] : []),
			]),
		);
		const conn = rec(rec(rec(rec(out).data).repository).pullRequest)[
			connection
		];
		const { nodes: pageNodes, pageInfo } = rec(conn);
		if (!Array.isArray(pageNodes)) {
			throw new GhError(
				`gh returned an unexpected response for the PR ${connection}`,
			);
		}
		nodes.push(...pageNodes);
		const info = rec(pageInfo);
		if (info.hasNextPage !== true) return nodes;
		if (typeof info.endCursor !== "string") break;
		after = info.endCursor;
	}
	throw new GhError(`Too many ${connection} to read for this PR`);
}

/** Every check context of commit `oid`; [] when it has none. */
async function fetchCommitChecks(ref: PrRef, oid: string): Promise<unknown[]> {
	const nodes: unknown[] = [];
	let after: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const out = safeJson(
			await runGh([
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
			]),
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

async function fetchBodyHtml(ref: PrRef): Promise<string> {
	const out = safeJson(
		await runGh([
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
		]),
	);
	const html = rec(rec(rec(rec(out).data).repository).pullRequest).bodyHTML;
	if (typeof html !== "string") {
		throw new GhError("gh returned an unexpected response for the PR body");
	}
	return html;
}

export async function fetchOverview(
	ref: PrRef,
	viewer: string,
	/** As-of mode: the cutoff, and the snapshot head whose checks to show. */
	asOf?: { at: string; head: string },
): Promise<PrOverview> {
	try {
		const [view, bodyHTML, reviewThreads, comments, reviews, checks] =
			await Promise.all([
				prView(
					ref,
					"number,title,url,author,body,state,isDraft,createdAt,updatedAt,baseRefName,headRefName,mergeable,reviewRequests,statusCheckRollup",
				),
				fetchBodyHtml(ref),
				fetchConnection(ref, "reviewThreads"),
				fetchConnection(ref, "comments"),
				fetchConnection(ref, "reviews"),
				asOf ? fetchCommitChecks(ref, asOf.head) : undefined,
			]);
		return mapOverview(
			view,
			{ bodyHTML, reviewThreads, comments, reviews, checks },
			viewer,
			asOf?.at,
		);
	} catch (error) {
		if (isNotFound(error)) {
			throw new GhError(`PR ${ref.owner}/${ref.repo}#${ref.number} not found`);
		}
		throw error;
	}
}
