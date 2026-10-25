import { randomUUID } from "node:crypto";
import {
	type FileHandle,
	link,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
	utimes,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LockOptions {
	/** How long to wait for another holder before giving up. */
	timeoutMs?: number;
	/** A lock whose mtime is older than this belongs to a hung or dead holder. */
	staleMs?: number;
	/** How often the holder refreshes the lock's mtime. */
	heartbeatMs?: number;
}

const LOCK_DEFAULTS = {
	timeoutMs: 120_000,
	staleMs: 10 * 60_000,
	heartbeatMs: 30_000,
};

const readLock = (lock: string) =>
	readFile(lock, "utf8").then(
		(text) => text,
		() => undefined,
	);

/** Lock content is `<host> <pid> <token>`; older or foreign content has no pid. */
function deadHolder(content: string): boolean {
	const [host, pid] = content.trim().split(" ");
	if (host !== hostname() || !pid || !/^\d+$/.test(pid)) return false;
	try {
		process.kill(Number(pid), 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/**
 * Removes `lock` only if it still holds `content`. The lock is first renamed
 * aside, so two waiters that both judged the same lock stale can't remove a
 * fresh lock the other one has just taken; a wrongly moved lock is put back.
 */
async function removeIfUnchanged(lock: string, content: string) {
	const aside = `${lock}.${randomUUID()}`;
	try {
		await rename(lock, aside);
	} catch {
		return;
	}
	if ((await readLock(aside)) !== content) {
		await link(aside, lock).catch(() => {});
	}
	await rm(aside, { force: true });
}

/**
 * Runs `fn` while holding `<path>.lock`, so concurrent crb processes never
 * clone or fetch into the same repository at once. The holder refreshes the
 * lock's mtime while `fn` runs; a lock is stale when that stopped long ago or
 * when its process on this host is gone (Ctrl-C, crash).
 */
export async function withRepoLock<T>(
	path: string,
	fn: () => Promise<T>,
	options: LockOptions = {},
): Promise<T> {
	const { timeoutMs, staleMs, heartbeatMs } = { ...LOCK_DEFAULTS, ...options };
	const lock = `${path}.lock`;
	const mine = `${hostname()} ${process.pid} ${randomUUID()}\n`;
	await mkdir(dirname(lock), { recursive: true });
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await tryCreate(lock, mine)) break;
		const [content, mtime] = await Promise.all([
			readLock(lock),
			stat(lock).then(
				(s) => s.mtimeMs,
				() => Date.now(),
			),
		]);
		if (
			content !== undefined &&
			(Date.now() - mtime > staleMs || deadHolder(content))
		) {
			await removeIfUnchanged(lock, content);
			continue;
		}
		if (Date.now() >= deadline) {
			throw new GitError(
				`Timed out waiting for ${lock}. If no other crb is running, delete it.`,
			);
		}
		await sleep(100);
	}
	const heartbeat = setInterval(() => {
		const now = new Date();
		readLock(lock).then((c) => {
			if (c === mine) utimes(lock, now, now).catch(() => {});
		});
	}, heartbeatMs);
	heartbeat.unref();
	try {
		return await fn();
	} finally {
		clearInterval(heartbeat);
		if ((await readLock(lock)) === mine) await rm(lock, { force: true });
	}
}

/** Creates `lock` with `content`; false if someone else holds it. */
async function tryCreate(lock: string, content: string): Promise<boolean> {
	let handle: FileHandle;
	try {
		handle = await open(lock, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		await handle.writeFile(content);
	} catch (error) {
		await rm(lock, { force: true });
		throw error;
	} finally {
		await handle.close();
	}
	return true;
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

/**
 * The bare clone of `owner/repo`, cloning it through `gh` the first time
 * (calling `onClone` just before).
 */
export async function ensureClone(
	owner: string,
	repo: string,
	onClone: () => void = () => {},
): Promise<string> {
	const path = clonePath(owner, repo);
	await withRepoLock(path, async () => {
		if (await exists(path)) {
			// Clones made before auto gc was turned off.
			await disableAutoGc(path);
			return;
		}
		// Clone next to the target and rename on success, so a crash mid-clone
		// never leaves something at `path` that looks like a complete clone.
		// Only the lock holder touches `.partial`, so a leftover is safe to wipe.
		const partial = `${path}.partial`;
		onClone();
		await rm(partial, { recursive: true, force: true });
		try {
			await runGh(
				[
					"repo",
					"clone",
					`${owner}/${repo}`,
					partial,
					"--",
					"--bare",
					"--quiet",
				],
				{
					cwd: dirname(path),
					// gh runs git; GIT_DIR and friends must not redirect the clone.
					env: inheritedEnv(),
					// A first clone of a big repo can take long: no limit.
					timeoutMs: 0,
				},
			);
			await disableAutoGc(partial);
			await rename(partial, path);
		} finally {
			await rm(partial, { recursive: true, force: true });
		}
	});
	return path;
}

/**
 * PR heads are used by OID without a local ref (docs/review-data-storage.md),
 * so the `gc --auto` that a fetch can trigger must never prune them.
 */
async function disableAutoGc(path: string) {
	const current = await runGit(path, ["config", "--get", "gc.auto"], {
		allowFailure: true,
	});
	if (current.trim() !== "0") await runGit(path, ["config", "gc.auto", "0"]);
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
 *
 * As of a cutoff (`asOf`), `meta.headOid` is the head at the cutoff, which
 * refs/pull/<n>/head may have moved past (or force-pushed away): it is then
 * fetched by OID. The base is the base branch's tip at the cutoff, the last
 * first-parent commit committed by then.
 */
export async function fetchPr(
	path: string,
	meta: PrMeta,
	asOf?: string,
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
				`refs/pull/${meta.number}/head`,
			],
			{ env: { GIT_TERMINAL_PROMPT: "0" } },
		);
		const present = () =>
			runGit(path, ["cat-file", "-e", `${head}^{commit}`]).then(
				() => true,
				() => false,
			);
		if (asOf && !(await present())) {
			await runGit(
				path,
				[...GH_CREDENTIALS, "fetch", "--quiet", "--no-tags", "origin", head],
				{ env: { GIT_TERMINAL_PROMPT: "0" }, allowFailure: true },
			);
		}
		if (!(await present())) {
			throw new GhError(
				asOf
					? `PR head ${head} as of ${asOf} could not be fetched from GitHub`
					: `PR head ${head} is not on GitHub yet (the PR may have just been updated); try again`,
			);
		}
		const baseTip = asOf
			? await baseTipAt(path, baseRef, asOf)
			: (await runGit(path, ["rev-parse", "--verify", baseRef])).trim();
		const mergeBase = (
			await runGit(path, ["merge-base", baseTip, head], { allowFailure: true })
		).trim();
		if (!mergeBase) {
			throw new GhError(`PR head ${head} shares no history with ${base}`);
		}
		return { baseTip, head, mergeBase };
	});
}

/** How long fetching one commit by OID may hold the repo lock. */
export const FETCH_COMMIT_TIMEOUT_MS = 60_000;

/**
 * Whether `oid` is a commit in the clone, fetching it by OID from GitHub
 * if not (a commit a force-push dropped from the PR), within
 * FETCH_COMMIT_TIMEOUT_MS. Never throws. Callers cache the answer
 * (threadCode.ts), so a missing commit is asked for once.
 */
export async function ensureCommit(
	path: string,
	oid: string,
): Promise<boolean> {
	if (!OID.test(oid)) return false;
	const present = () =>
		runGit(path, ["cat-file", "-e", `${oid}^{commit}`]).then(
			() => true,
			() => false,
		);
	if (await present()) return true;
	return withRepoLock(path, async () => {
		if (await present()) return true;
		await runGit(
			path,
			[...GH_CREDENTIALS, "fetch", "--quiet", "--no-tags", "origin", oid],
			{
				env: { GIT_TERMINAL_PROMPT: "0" },
				allowFailure: true,
				timeoutMs: FETCH_COMMIT_TIMEOUT_MS,
			},
		);
		return present();
	}).catch(() => false);
}

/** The base branch's tip at `cutoff`: its last first-parent commit by then. */
export async function baseTipAt(
	path: string,
	baseRef: string,
	cutoff: string,
): Promise<string> {
	const tip = (
		await runGit(path, [
			"rev-list",
			"-1",
			"--first-parent",
			`--before=${cutoff}`,
			baseRef,
			"--",
		])
	).trim();
	if (!tip) {
		throw new GhError(`${baseRef} has no commit at or before ${cutoff}`);
	}
	return tip;
}

async function refFormatOk(path: string, base: string): Promise<boolean> {
	try {
		await runGit(path, ["check-ref-format", `refs/heads/${base}`]);
		return true;
	} catch {
		return false;
	}
}
