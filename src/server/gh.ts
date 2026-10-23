import { spawn } from "node:child_process";
import type { PrOverview } from "../shared/types.js";
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
function ghEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
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

function spawnGh(args: string[], cwd?: string): Promise<GhResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("gh", args, {
			cwd,
			env: ghEnv(),
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

const firstLine = (text: string) => text.split("\n")[0]?.trim() ?? "";

export async function runGh(
	args: string[],
	opts: { cwd?: string } = {},
): Promise<string> {
	const result = await spawnGh(args, opts.cwd);
	if (result.code === 0) return result.stdout;
	if (LOGGED_OUT.test(result.stderr)) throw new GhError(NOT_LOGGED_IN);
	const isAuthStatus = args[0] === "auth" && args[1] === "status";
	if (!isAuthStatus) {
		const host = process.env.GH_HOST || "github.com";
		const auth = await spawnGh(
			["auth", "status", "--active", "--hostname", host],
			opts.cwd,
		);
		if (auth.code !== 0 && LOGGED_OUT.test(auth.stderr)) {
			throw new GhError(NOT_LOGGED_IN);
		}
	}
	throw new GhError(
		firstLine(result.stderr) || `gh exited with code ${result.code}`,
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
	if (
		!owner ||
		!repo ||
		!OWNER.test(owner) ||
		!REPO.test(repo) ||
		repo === "." ||
		repo === ".."
	) {
		throw fail();
	}
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

export async function fetchPrMeta(ref: PrRef): Promise<PrMeta> {
	const v = (await prView(
		ref,
		"number,title,url,state,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner",
	)) as Record<string, any> | null;
	if (!v || typeof v !== "object") {
		throw new GhError("gh returned an unexpected response for the PR");
	}
	const headOwner = v.headRepositoryOwner?.login;
	const headName = v.headRepository?.name;
	// A deleted fork has no head repository; the PR head still lives in the base repo.
	const headRepo =
		typeof headOwner === "string" && typeof headName === "string"
			? `${headOwner}/${headName}`
			: `${ref.owner}/${ref.repo}`;
	if (
		typeof v.headRefOid !== "string" ||
		typeof v.baseRefName !== "string" ||
		typeof v.headRefName !== "string"
	) {
		throw new GhError("gh returned an unexpected response for the PR");
	}
	// The PR's own URL carries GitHub's canonical owner/repo spelling (and
	// follows renames); use it so every spelling maps to one cache dir and key.
	const url = String(v.url ?? "");
	const canonical = PR_URL.exec(url);
	return {
		owner: canonical?.[1] ?? ref.owner,
		repo: canonical?.[2] ?? ref.repo,
		number: ref.number,
		url,
		title: String(v.title ?? ""),
		baseBranch: v.baseRefName,
		headBranch: v.headRefName,
		headRepo,
		headOid: v.headRefOid,
		state: ["CLOSED", "MERGED"].includes(v.state) ? v.state : "OPEN",
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
		`isResolved isOutdated path line comments(first: 100) { totalCount nodes { ${AUTHOR} body createdAt } }`,
	),
	comments: connectionQuery("comments", `${AUTHOR} createdAt`),
	reviews: connectionQuery("reviews", `${AUTHOR} state submittedAt`),
};

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
		) as any;
		const conn = out?.data?.repository?.pullRequest?.[connection];
		if (!conn || !Array.isArray(conn.nodes)) {
			throw new GhError(
				`gh returned an unexpected response for the PR ${connection}`,
			);
		}
		nodes.push(...conn.nodes);
		if (conn.pageInfo?.hasNextPage !== true) return nodes;
		if (typeof conn.pageInfo.endCursor !== "string") break;
		after = conn.pageInfo.endCursor;
	}
	throw new GhError(`Too many ${connection} to read for this PR`);
}

export async function fetchOverview(
	ref: PrRef,
	viewer: string,
): Promise<PrOverview> {
	try {
		const [view, reviewThreads, comments, reviews] = await Promise.all([
			prView(
				ref,
				"number,title,url,author,body,state,isDraft,createdAt,updatedAt,baseRefName,headRefName,mergeable,reviewRequests,statusCheckRollup",
			),
			fetchConnection(ref, "reviewThreads"),
			fetchConnection(ref, "comments"),
			fetchConnection(ref, "reviews"),
		]);
		return mapOverview(view, { reviewThreads, comments, reviews }, viewer);
	} catch (error) {
		if (isNotFound(error)) {
			throw new GhError(`PR ${ref.owner}/${ref.repo}#${ref.number} not found`);
		}
		throw error;
	}
}
