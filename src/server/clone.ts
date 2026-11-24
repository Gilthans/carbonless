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
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { GhError } from "./errors.js";
import type { PrMeta } from "./gh.js";
import { runGh } from "./gh.js";
import { GitError, inheritedEnv, runGit, runGitFull } from "./git.js";
import { cacheDir } from "./paths.js";

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
	return join(
		cacheDir(),
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

/** Config key marking a repo ensureRepoInit made and no clone has filled yet. */
const INIT_ONLY = "crb.initOnly";

/** Repos (`owner/repo`, lowercased) whose first clone runs now. */
const cloning = new Set<string>();
const repoKey = (owner: string, repo: string) =>
	`${owner}/${repo}`.toLowerCase();

/**
 * Whether crb is cloning `owner/repo` for the first time right now (an open
 * waiting on it shows so: CAR-291). True from ensureClone's `onClone` until
 * the clone is in place; never while an existing clone only fetches.
 */
export const isCloning = (owner: string, repo: string): boolean =>
	cloning.has(repoKey(owner, repo));

/** Runs a first clone of `owner/repo`, marked as cloning meanwhile. */
async function asCloning(
	owner: string,
	repo: string,
	run: () => Promise<void>,
): Promise<void> {
	const key = repoKey(owner, repo);
	cloning.add(key);
	try {
		await run();
	} finally {
		cloning.delete(key);
	}
}

/**
 * The bare clone of `owner/repo`, cloning it through `gh` the first time
 * (calling `onClone` just before; isCloning says so until it is done). A
 * repo ensureRepoInit made is filled the same way, its own refs (crb's)
 * kept.
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
			if (await isInitOnly(path)) {
				await asCloning(owner, repo, async () => {
					onClone();
					await fillInitOnly(owner, repo, path);
				});
			}
			return;
		}
		// Clone next to the target and rename on success, so a crash mid-clone
		// never leaves something at `path` that looks like a complete clone.
		await asCloning(owner, repo, async () => {
			onClone();
			await cloneAside(owner, repo, path, async (partial) => {
				await disableAutoGc(partial);
				await rename(partial, path);
			});
		});
	});
	return path;
}

/**
 * The repo's bare repository, made empty (no fetch, no call to GitHub) when
 * there is none yet: enough to write crb refs, which use only the empty
 * tree (a Home annotation of a PR never opened). The next ensureClone
 * fetches the project into it.
 */
export async function ensureRepoInit(
	owner: string,
	repo: string,
): Promise<string> {
	const path = clonePath(owner, repo);
	// An existing repo needs nothing: never wait behind a clone or fetch
	// holding the lock (crb refs are compare-and-swap anyway).
	if (await exists(path)) return path;
	await withRepoLock(path, async () => {
		if (await exists(path)) return;
		const partial = `${path}.init`;
		await rm(partial, { recursive: true, force: true });
		try {
			await runGit(dirname(path), ["init", "--quiet", "--bare", partial]);
			await disableAutoGc(partial);
			await runGit(partial, ["config", INIT_ONLY, "true"]);
			await rename(partial, path);
		} finally {
			await rm(partial, { recursive: true, force: true });
		}
	});
	return path;
}

const isInitOnly = async (path: string) =>
	(
		await runGit(path, ["config", "--get", INIT_ONLY], { allowFailure: true })
	).trim() === "true";

/**
 * Clones into `<path>.partial` through `gh` and hands it to `use`; the
 * partial clone is removed afterwards whatever happens. Only the lock
 * holder touches `.partial`, so a leftover is safe to wipe.
 */
async function cloneAside(
	owner: string,
	repo: string,
	path: string,
	use: (partial: string) => Promise<void>,
): Promise<void> {
	const partial = `${path}.partial`;
	await rm(partial, { recursive: true, force: true });
	try {
		await runGh(
			["repo", "clone", `${owner}/${repo}`, partial, "--", "--bare", "--quiet"],
			{
				cwd: dirname(path),
				// gh runs git; GIT_DIR and friends must not redirect the clone.
				env: inheritedEnv(),
				// A first clone of a big repo can take long: no limit.
				timeoutMs: 0,
			},
		);
		await use(partial);
	} finally {
		await rm(partial, { recursive: true, force: true });
	}
}

/**
 * Fills an init-only repo from a fresh clone beside it: its branches, tags,
 * HEAD and remote, fetched locally, so crb refs written meanwhile stay
 * where they are. The mark goes last: a crash before it just fills again.
 */
async function fillInitOnly(owner: string, repo: string, path: string) {
	await cloneAside(owner, repo, path, async (partial) => {
		await runGit(path, [
			"fetch",
			"--quiet",
			"--no-tags",
			partial,
			"+refs/heads/*:refs/heads/*",
			"+refs/tags/*:refs/tags/*",
		]);
		const head = (
			await runGit(partial, ["symbolic-ref", "HEAD"], { allowFailure: true })
		).trim();
		if (head) await runGit(path, ["symbolic-ref", "HEAD", head]);
		const url = (
			await runGit(partial, ["config", "--get", "remote.origin.url"], {
				allowFailure: true,
			})
		).trim();
		if (url) await runGit(path, ["config", "remote.origin.url", url]);
		await runGit(path, ["config", "--unset", INIT_ONLY]);
	});
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
 * As of a cutoff (`options.asOf`), `meta.headOid` is the head at the cutoff, which
 * refs/pull/<n>/head may have moved past (or force-pushed away): it is then
 * fetched by OID. The base is the base branch's tip at the cutoff, the last
 * first-parent commit committed by then.
 *
 * A `pinned` head (crb --head) takes the PR head's place against the base
 * branch's current tip; it is fetched by OID too when the clone lacks it (a
 * force-push dropped it from the PR).
 */
export async function fetchPr(
	path: string,
	meta: PrMeta,
	options: {
		/** As of this cutoff (canonical ISO). */
		asOf?: string;
		/** Stops the fetch (a session closing). */
		signal?: AbortSignal;
		/** The head pinned by crb --head, in place of the PR's. */
		pinned?: string;
	} = {},
): Promise<{ baseTip: string; head: string; mergeBase: string }> {
	const { asOf, signal, pinned } = options;
	const base = meta.baseBranch;
	const head = pinned ?? meta.headOid;
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
			{ env: { GIT_TERMINAL_PROMPT: "0" }, signal },
		);
		const present = () =>
			runGit(path, ["cat-file", "-e", `${head}^{commit}`]).then(
				() => true,
				() => false,
			);
		if ((asOf || pinned) && !(await present())) {
			await runGit(
				path,
				[...GH_CREDENTIALS, "fetch", "--quiet", "--no-tags", "origin", head],
				{ env: { GIT_TERMINAL_PROMPT: "0" }, allowFailure: true, signal },
			);
		}
		if (!(await present())) {
			throw new GhError(
				pinned
					? `Commit ${head} could not be fetched from GitHub`
					: asOf
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

/**
 * How long fetching commits by OID may hold the repo lock: one budget for
 * a whole batch, its retries included (a commit GitHub doesn't have costs
 * one more fetch). Commits still unfetched when it runs out answer false
 * (cached until a Refresh), so the lock is never held longer.
 */
const FETCH_COMMIT_TIMEOUT_MS = 60_000;

/**
 * Whether `oid` is a commit in the clone, fetching it by OID from GitHub
 * if not (a commit a force-push dropped from the PR). Never throws.
 * Callers cache the answer (threadCode.ts), so a missing commit is asked
 * for once.
 *
 * Asks are batched per clone (CommitBatcher): those made together are
 * checked with one `git cat-file --batch-check`, and the missing ones are
 * fetched with one `git fetch origin <oid>…` under one repo lock hold,
 * within FETCH_COMMIT_TIMEOUT_MS. Asks made while a batch runs join it
 * when it already has their commit, else the next batch.
 */
export function ensureCommit(
	path: string,
	oid: string,
	/** Stops this ask (a session closing); then false. */
	signal?: AbortSignal,
): Promise<boolean> {
	if (!OID.test(oid) || signal?.aborted) return Promise.resolve(false);
	let batcher = batchers.get(path);
	if (!batcher) {
		const made = new CommitBatcher(path, () => {
			if (batchers.get(path) === made) batchers.delete(path);
		});
		batchers.set(path, made);
		batcher = made;
	}
	return batcher.ask(oid, signal);
}

/** Each clone's batcher, while it has asks. */
const batchers = new Map<string, CommitBatcher>();

/** One ask: answered once, false when its signal stops it first. */
interface CommitAsk {
	answer: (present: boolean) => void;
}

/** Commits asked for together; once running, stopped when every ask is. */
interface CommitBatch {
	/** The asks still waiting, by commit (an answered commit leaves). */
	asks: Map<string, Set<CommitAsk>>;
	/** What it found so far, by commit. */
	answers: Map<string, boolean>;
	stop: AbortController;
}

const newBatch = (): CommitBatch => ({
	asks: new Map(),
	answers: new Map(),
	stop: new AbortController(),
});

/** Answers `ensureCommit` asks for one clone, a batch at a time. */
class CommitBatcher {
	#next: CommitBatch | null = null;
	#running: CommitBatch | null = null;
	#scheduled = false;

	constructor(
		private readonly path: string,
		private readonly idle: () => void,
	) {}

	ask(oid: string, signal?: AbortSignal): Promise<boolean> {
		const running = this.#running;
		const known = running?.answers.get(oid);
		if (known !== undefined) return Promise.resolve(known);
		const batch = running?.asks.has(oid) ? running : this.#nextBatch();
		return new Promise<boolean>((resolve) => {
			let done = false;
			const ask: CommitAsk = {
				answer: (present) => {
					if (done) return;
					done = true;
					signal?.removeEventListener("abort", onAbort);
					resolve(present);
				},
			};
			const onAbort = () => {
				const same = batch.asks.get(oid);
				same?.delete(ask);
				if (same?.size === 0) batch.asks.delete(oid);
				ask.answer(false);
				// Nobody waits on it any more: stop its git. A batch not yet
				// running stays as it is: later asks may still join it.
				if (batch.asks.size === 0 && batch === this.#running) {
					batch.stop.abort();
				}
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const same = batch.asks.get(oid) ?? new Set<CommitAsk>();
			same.add(ask);
			batch.asks.set(oid, same);
			if (batch === this.#next) this.#schedule();
		});
	}

	#nextBatch(): CommitBatch {
		if (!this.#next) this.#next = newBatch();
		return this.#next;
	}

	/** Runs the next batch once this turn's asks are in, after the running one. */
	#schedule(): void {
		if (this.#scheduled || this.#running) return;
		this.#scheduled = true;
		setImmediate(() => {
			this.#scheduled = false;
			const batch = this.#next;
			this.#next = null;
			if (!batch) return this.idle();
			this.#running = batch;
			void answerBatch(this.path, batch).finally(() => {
				this.#running = null;
				if (this.#next) this.#schedule();
				else this.idle();
			});
		});
	}
}

/** Answers every ask of `batch`; never throws. */
async function answerBatch(path: string, batch: CommitBatch): Promise<void> {
	const signal = batch.stop.signal;
	const answer = (oid: string, present: boolean) => {
		if (batch.answers.has(oid)) return;
		batch.answers.set(oid, present);
		for (const ask of batch.asks.get(oid) ?? []) ask.answer(present);
		// No longer waiting: a stop of the rest stops the batch's git.
		batch.asks.delete(oid);
	};
	const asked = () => [...batch.asks.keys()];
	try {
		const have = await presentCommits(path, asked(), signal);
		for (const oid of have) answer(oid, true);
		if (asked().every((oid) => have.has(oid))) return;
		await withRepoLock(path, async () => {
			const missing = asked().filter((oid) => !have.has(oid));
			const now = await presentCommits(path, missing, signal);
			await fetchCommits(
				path,
				missing.filter((oid) => !now.has(oid)),
				signal,
			);
		});
		const after = await presentCommits(path, asked(), signal);
		for (const oid of asked()) answer(oid, after.has(oid));
	} catch {
		// Answered false below.
	} finally {
		for (const oid of asked()) answer(oid, false);
	}
}

/** Which of `oids` are commits in the clone: one `cat-file --batch-check`. */
async function presentCommits(
	path: string,
	oids: string[],
	signal: AbortSignal,
): Promise<Set<string>> {
	if (oids.length === 0) return new Set();
	const out = await runGit(path, ["cat-file", "--batch-check"], {
		input: oids.map((oid) => `${oid}^{commit}\n`).join(""),
		signal,
	});
	// One line per input line, in order: "<oid> commit <size>" or "<input> missing".
	const lines = out.split(/\r?\n/);
	return new Set(oids.filter((_, i) => / commit \d+$/.test(lines[i] ?? "")));
}

/**
 * Fetches `oids` by OID in one `git fetch`, within FETCH_COMMIT_TIMEOUT_MS
 * in all. GitHub fails the whole fetch for one commit it doesn't have,
 * naming it: that one is dropped and the rest fetched again. A failure
 * that names none (the network, a timeout) falls back to one fetch per
 * commit while time is left. What it fetched is checked by the caller.
 */
async function fetchCommits(
	path: string,
	oids: string[],
	signal: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + FETCH_COMMIT_TIMEOUT_MS;
	const fetch = async (wanted: string[]) => {
		const timeoutMs = deadline - Date.now();
		if (timeoutMs <= 0 || signal.aborted) return null;
		return runGitFull(
			path,
			[...GH_CREDENTIALS, "fetch", "--quiet", "--no-tags", "origin", ...wanted],
			{
				env: { GIT_TERMINAL_PROMPT: "0" },
				allowFailure: true,
				timeoutMs,
				signal,
			},
		);
	};
	// Within Windows' command line limit (32K characters).
	for (let i = 0; i < oids.length; i += FETCH_OIDS_MAX) {
		let wanted = oids.slice(i, i + FETCH_OIDS_MAX);
		while (wanted.length > 0) {
			const result = await fetch(wanted);
			if (!result) return;
			if (result.code === 0) break;
			// GitHub (as git's own upload-pack) fails the whole fetch and names
			// the first commit it doesn't have, whatever the locale: "fatal:
			// remote error: upload-pack: not our ref <full oid>" (probed on
			// github.com, 2026-11-24; nothing of the batch is fetched).
			const named = wanted.filter((oid) => result.stderr.includes(oid));
			if (named.length === 0) {
				if (wanted.length > 1) {
					for (const oid of wanted) {
						if (!(await fetch([oid]))) return;
					}
				}
				break;
			}
			wanted = wanted.filter((oid) => !named.includes(oid));
		}
	}
}

/** OIDs one `git fetch` asks for at most. */
const FETCH_OIDS_MAX = 200;

/** The base branch's tip at `cutoff`: its last first-parent commit by then. */
async function baseTipAt(
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
