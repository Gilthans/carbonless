import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "../git.js";
import { cacheDir } from "../paths.js";
import { isLowerUlid } from "../review/events.js";
import { pidAlive, readClaim } from "./claim.js";

/** `<cache>/agents`: one dir per review whose agent runs (or ran) here. */
export const agentsDir = (): string => join(cacheDir(), "agents");

/** The agent's own checkout of the PR: `<dir>/tree`; `dir` is the session's cwd. */
export interface Checkout {
	dir: string;
	tree: string;
	remove(): Promise<void>;
	/**
	 * Moves the tree to `head` (detached) when it is elsewhere: null when
	 * it is there, else why not (the agent's own changes in the way).
	 */
	moveTo(head: string): Promise<string | null>;
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * A shared clone of the cache clone (`--shared --no-checkout`: objects
 * through alternates, so the base commit is there too), detached at `head`,
 * with `origin` the cache clone's origin URL (GitHub's; none if it has
 * none, never the cache clone itself) and an identity to commit with. It
 * gets refs/heads and refs/tags only: no refs/crb, so the agent is no
 * update-ref away from review state (why not `git worktree add`).
 */
export async function createCheckout(
	cacheClone: string,
	reviewId: string,
	head: string,
): Promise<Checkout> {
	if (!isLowerUlid(reviewId)) throw new Error(`Invalid review id: ${reviewId}`);
	if (!OID.test(head)) throw new Error(`Invalid head: ${head}`);
	const dir = join(agentsDir(), reviewId);
	const tree = join(dir, "tree");
	await mkdir(dir, { recursive: true });
	// A tree left by a crashed server: start afresh.
	await rm(tree, { recursive: true, force: true });
	await runGit(dir, [
		"clone",
		"--quiet",
		"--shared",
		"--no-checkout",
		"--",
		cacheClone,
		"tree",
	]);
	await runGit(tree, ["checkout", "--quiet", "--detach", head]);
	const url = (
		await runGit(cacheClone, ["remote", "get-url", "origin"], {
			allowFailure: true,
		})
	).trim();
	if (url) await runGit(tree, ["remote", "set-url", "origin", url]);
	else await runGit(tree, ["remote", "remove", "origin"]);
	for (const [key, value] of [
		["commit.gpgsign", "false"],
		["user.name", "carbonless agent"],
		["user.email", "agent@crb"],
	] as const) {
		await runGit(tree, ["config", key, value]);
	}
	return {
		dir,
		tree,
		remove: () => rm(tree, { recursive: true, force: true }),
		moveTo: async (to) => {
			if (!OID.test(to)) return `Invalid head: ${to}`;
			const at = (
				await runGit(tree, ["rev-parse", "HEAD"], { allowFailure: true })
			).trim();
			if (at === to) return null;
			try {
				await runGit(tree, ["checkout", "--quiet", "--detach", to]);
				return null;
			} catch (error) {
				return (error as Error).message;
			}
		},
	};
}

/** What a review's agent dir keeps across servers: see join.ts. */
const KEEP = new Set(["acp-off", "joined.json"]);

/**
 * Removes `<agentsDir>/<review id>` dirs not in `live` whose claim is free
 * or names a dead pid (left by a server that stopped), all but their
 * `acp-off` and `joined.json`. Other names are left alone.
 */
export async function sweepStaleCheckouts(
	live: ReadonlySet<string>,
): Promise<void> {
	let names: string[];
	try {
		names = await readdir(agentsDir());
	} catch {
		return;
	}
	await Promise.all(
		names
			.filter((name) => isLowerUlid(name) && !live.has(name))
			.map(async (name) => {
				const dir = join(agentsDir(), name);
				const claim = await readClaim(dir);
				if (claim && pidAlive(claim.pid)) return;
				// A joined session and the ACP-off flag outlive a server
				// (join.ts): only they stay.
				const entries = await readdir(dir).catch(() => [] as string[]);
				const kept = entries.filter((e) => KEEP.has(e));
				if (kept.length === 0) {
					await rm(dir, { recursive: true, force: true });
					return;
				}
				await Promise.all(
					entries
						.filter((e) => !KEEP.has(e))
						.map((e) => rm(join(dir, e), { recursive: true, force: true })),
				);
			}),
	);
}
