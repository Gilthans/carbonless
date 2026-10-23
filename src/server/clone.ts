import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { GhError } from "./errors.js";
import type { PrMeta } from "./gh.js";
import { runGh } from "./gh.js";
import { GitError, inheritedEnv, runGit } from "./git.js";

/**
 * carbonless's own bare clone of a GitHub repository. The reviewer's working
 * copies are never touched; everything happens here.
 */
export function clonePath(owner: string, repo: string): string {
	for (const segment of [owner, repo]) {
		if (
			!segment ||
			segment === "." ||
			segment === ".." ||
			/[/\\\0]/.test(segment)
		) {
			throw new GhError(`Not a GitHub owner/repo: ${owner}/${repo}`);
		}
	}
	const xdg = process.env.XDG_CACHE_HOME;
	// The XDG spec says relative values are invalid and must be ignored.
	const cache = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
	return join(
		cache,
		"carbonless",
		"repos",
		owner.toLowerCase(),
		`${repo.toLowerCase()}.git`,
	);
}

const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` while holding `<path>.lock`, so concurrent crb processes never
 * clone or fetch into the same repository at once.
 */
export async function withRepoLock<T>(
	path: string,
	fn: () => Promise<T>,
): Promise<T> {
	const lock = `${path}.lock`;
	await mkdir(dirname(lock), { recursive: true });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			const handle = await open(lock, "wx");
			await handle.writeFile(`${process.pid}\n`);
			await handle.close();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const age = await stat(lock).then(
			(s) => Date.now() - s.mtimeMs,
			() => 0,
		);
		if (age > LOCK_STALE_MS) {
			// A crashed holder; nobody legitimately holds a lock this long.
			await rm(lock, { force: true });
			continue;
		}
		if (Date.now() >= deadline) {
			throw new GitError(
				`Timed out waiting for ${lock}. If no other crb is running, delete it.`,
			);
		}
		await sleep(LOCK_RETRY_MS);
	}
	try {
		return await fn();
	} finally {
		await rm(lock, { force: true });
	}
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

/** The bare clone of `owner/repo`, cloning it through `gh` the first time. */
export async function ensureClone(
	owner: string,
	repo: string,
): Promise<string> {
	const path = clonePath(owner, repo);
	await withRepoLock(path, async () => {
		if (await exists(path)) return;
		// Clone next to the target and rename on success, so a crash mid-clone
		// never leaves something at `path` that looks like a complete clone.
		// Only the lock holder touches `.partial`, so a leftover is safe to wipe.
		const partial = `${path}.partial`;
		await rm(partial, { recursive: true, force: true });
		try {
			await runGh(
				["repo", "clone", `${owner}/${repo}`, partial, "--", "--bare"],
				{
					cwd: dirname(path),
					// gh runs git; GIT_DIR and friends must not redirect the clone.
					env: inheritedEnv(),
				},
			);
			await rename(partial, path);
		} finally {
			await rm(partial, { recursive: true, force: true });
		}
	});
	return path;
}

/** Makes `git fetch` authenticate with the reviewer's `gh` login. */
const GH_CREDENTIALS = [
	"-c",
	"credential.helper=",
	"-c",
	"credential.helper=!gh auth git-credential",
];

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Fetches the PR's base branch and head into the bare clone and returns the
 * comparison endpoints: merge-base(origin/<base>, head) → head.
 */
export async function fetchPr(
	path: string,
	meta: PrMeta,
): Promise<{ baseTip: string; head: string; mergeBase: string }> {
	const base = meta.baseBranch;
	const head = meta.headOid;
	if (!OID.test(head)) {
		throw new GhError(`gh returned an unexpected PR head: ${head}`);
	}
	if (base.includes(":") || !(await refFormatOk(path, base))) {
		throw new GhError(`gh returned an invalid base branch name: ${base}`);
	}
	const baseRef = `refs/remotes/origin/${base}`;
	return withRepoLock(path, async () => {
		// The head comes from refs/pull/<n>/head, never the head branch: it
		// exists even when the branch or its fork has been deleted.
		await runGit(
			path,
			[
				...GH_CREDENTIALS,
				"fetch",
				"--quiet",
				"--no-tags",
				"origin",
				`+refs/heads/${base}:${baseRef}`,
				// Kept under GitHub's own name so later reads and gc keep the head.
				`+refs/pull/${meta.number}/head:refs/pull/${meta.number}/head`,
			],
			{ env: { GIT_TERMINAL_PROMPT: "0" } },
		);
		try {
			await runGit(path, ["cat-file", "-e", `${head}^{commit}`]);
		} catch {
			throw new GhError(
				`PR head ${head} is not on GitHub yet (the PR may have just been updated); try again`,
			);
		}
		const baseTip = (
			await runGit(path, ["rev-parse", "--verify", baseRef])
		).trim();
		const mergeBase = (
			await runGit(path, ["merge-base", baseRef, head], { allowFailure: true })
		).trim();
		if (!mergeBase) {
			throw new GhError(`PR head ${head} shares no history with ${base}`);
		}
		return { baseTip, head, mergeBase };
	});
}

async function refFormatOk(path: string, base: string): Promise<boolean> {
	try {
		await runGit(path, ["check-ref-format", `refs/heads/${base}`]);
		return true;
	} catch {
		return false;
	}
}
