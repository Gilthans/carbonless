import { spawn } from "node:child_process";
import type { PrOverview } from "../shared/types.js";
import { GhError } from "./errors.js";
import { mapOverview } from "./overview.js";

export { GhError };

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

export async function runGh(
	args: string[],
	opts: { cwd?: string } = {},
): Promise<string> {
	const result = await spawnGh(args, opts.cwd);
	if (result.code === 0) return result.stdout;
	const isAuthStatus = args[0] === "auth" && args[1] === "status";
	if (
		isAuthStatus ||
		(await spawnGh(["auth", "status"], opts.cwd)).code !== 0
	) {
		throw new GhError(NOT_LOGGED_IN);
	}
	throw new GhError(result.stderr || `gh exited with code ${result.code}`);
}

const PR_URL =
	/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const PR_SHORT = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

export function parsePrArg(
	arg: string,
): { owner: string; repo: string; number: number } | { number: number } {
	const text = arg.trim();
	const full = PR_URL.exec(text) ?? PR_SHORT.exec(text);
	const bare = /^\d+$/.test(text) ? text : undefined;
	const raw = full ? full[3] : bare;
	const number = Number(raw);
	if (!raw || !Number.isSafeInteger(number) || number < 1) {
		throw new GhError(
			`Not a PR: ${arg}. Use a PR URL, owner/repo#123 or a number`,
		);
	}
	return full && full[1] && full[2]
		? { owner: full[1], repo: full[2], number }
		: { number };
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

export function slugify(login: string): string {
	return login
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.slice(0, 64);
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
	return {
		owner: ref.owner,
		repo: ref.repo,
		number: ref.number,
		url: String(v.url ?? ""),
		title: String(v.title ?? ""),
		baseBranch: v.baseRefName,
		headBranch: v.headRefName,
		headRepo,
		headOid: v.headRefOid,
		state: ["CLOSED", "MERGED"].includes(v.state) ? v.state : "OPEN",
	};
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            totalCount
            nodes { author { login __typename } body createdAt }
          }
        }
      }
    }
  }
}`;

export async function fetchOverview(
	ref: PrRef,
	viewer: string,
): Promise<PrOverview> {
	const [view, threads] = await Promise.all([
		prView(
			ref,
			"number,title,url,author,body,state,isDraft,createdAt,updatedAt,baseRefName,headRefName,mergeable,reviewRequests,reviews,comments,statusCheckRollup",
		),
		runGh([
			"api",
			"graphql",
			"-f",
			`query=${THREADS_QUERY}`,
			"-f",
			`owner=${ref.owner}`,
			"-f",
			`name=${ref.repo}`,
			"-F",
			`number=${ref.number}`,
		]).then(safeJson),
	]);
	return mapOverview(view, threads, viewer);
}
