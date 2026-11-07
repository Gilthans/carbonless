import type { Shape, ShapeCode } from "../../shared/types.js";
import { runGit, runGitFull } from "../git.js";

export type { Shape };

/** One snapshot's comparison endpoints and the base branch it was against. */
export interface Endpoints {
	mergeBase: string;
	head: string;
	/** GitHub's base branch name for the PR then. */
	baseBranch: string;
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The OID itself, or throws: nothing but a full object id reaches git. */
export function checkOid(oid: string): string {
	if (!OID.test(oid)) throw new Error(`Not an object id: ${oid}`);
	return oid;
}

/**
 * `git rev-list --count a..b`; `firstParent` counts the commits on `b`'s
 * own line only (a merge of the base in counts as one, not as everything
 * the base gained).
 */
async function countBetween(
	repo: string,
	a: string,
	b: string,
	signal?: AbortSignal,
	firstParent = false,
): Promise<number> {
	const out = await runGit(
		repo,
		[
			"rev-list",
			"--count",
			...(firstParent ? ["--first-parent"] : []),
			`${a}..${b}`,
			"--",
		],
		{ signal },
	);
	return Number(out.trim());
}

/**
 * How many commits `to` has over `from` on its own line (the connector's
 * count): since `from` when `to` descends from it, else since `mergeBase`
 * (a force-push). 0 when they are the same commit.
 */
export async function commitsSince(
	repo: string,
	from: string,
	to: string,
	mergeBase: string,
	signal?: AbortSignal,
): Promise<number> {
	if (from === to) return 0;
	checkOid(from);
	checkOid(to);
	checkOid(mergeBase);
	const behind = await countBetween(repo, to, from, signal);
	return countBetween(repo, behind === 0 ? from : mergeBase, to, signal, true);
}

/**
 * The virtual rebase: `H1` merged onto `B2` without touching any branch.
 * Exit 0 gives the tree; exit 1 the tree with the conflicted paths; anything
 * else says why none could be built.
 */
async function virtualRebase(
	repo: string,
	b2: string,
	h1: string,
	signal?: AbortSignal,
): Promise<Pick<Shape, "conflicts" | "virtualRebase" | "virtualHead">> {
	const result = await runGitFull(
		repo,
		["merge-tree", "-z", "--write-tree", "--name-only", b2, h1],
		{ signal },
	);
	if (result.code === 0 || result.code === 1) {
		// `<tree>\0` then, with conflicts, `<path>\0`... and an empty record
		// before the informational messages.
		const parts = result.stdout.toString("utf8").split("\0");
		const tree = parts[0] ?? "";
		if (!OID.test(tree)) {
			return { conflicts: [], virtualRebase: "error", virtualHead: null };
		}
		if (result.code === 0) {
			return { conflicts: [], virtualRebase: "ok", virtualHead: tree };
		}
		const conflicts: string[] = [];
		for (const part of parts.slice(1)) {
			if (part === "") break;
			if (!conflicts.includes(part)) conflicts.push(part);
		}
		return { conflicts, virtualRebase: "conflict", virtualHead: tree };
	}
	if (/unrelated histories/i.test(result.stderr)) {
		const shallow = (
			await runGit(repo, ["rev-parse", "--is-shallow-repository"], {
				signal,
				allowFailure: true,
			})
		).trim();
		return {
			conflicts: [],
			virtualRebase: shallow === "true" ? "shallow" : "unrelated",
			virtualHead: null,
		};
	}
	return { conflicts: [], virtualRebase: "error", virtualHead: null };
}

/**
 * How the snapshot `r` relates to the patch set `ps` (the re-review
 * design's shapes), from git alone: ancestry of the heads, whether the
 * merge base moved, the virtual rebase of the old head onto the new base
 * and whether its tree equals the new head's. The base branch names come
 * from GitHub (S7). OIDs are checked before any git runs.
 */
export async function detectShape(
	repo: string,
	ps: Endpoints,
	r: Endpoints,
	signal?: AbortSignal,
): Promise<Shape> {
	const h1 = checkOid(ps.head);
	const h2 = checkOid(r.head);
	const b1 = checkOid(ps.mergeBase);
	const b2 = checkOid(r.mergeBase);
	// H1 is an ancestor of H2 when nothing of H1 is missing from H2.
	const [ahead, behind] = await Promise.all([
		countBetween(repo, h1, h2, signal),
		countBetween(repo, h2, h1, signal),
	]);
	const h1InH2 = behind === 0;
	const h2InH1 = ahead === 0;
	const sameBase = b1 === b2;
	// On the same base the old head is already "rebased": its own tree.
	const rebase = sameBase
		? {
				conflicts: [],
				virtualRebase: "ok" as const,
				virtualHead: (
					await runGit(repo, ["rev-parse", `${h1}^{tree}`], { signal })
				).trim(),
			}
		: await virtualRebase(repo, b2, h1, signal);
	const identical =
		rebase.virtualHead !== null &&
		(
			await runGitFull(
				repo,
				["diff-tree", "--quiet", rebase.virtualHead, h2, "--"],
				{ signal },
			)
		).code === 0;
	// What the author added: the new head's own line of commits since the old
	// head, or since the merge base after a force-push.
	const commits = await countBetween(repo, h1InH2 ? h1 : b2, h2, signal, true);

	let code: ShapeCode;
	if (ps.baseBranch !== r.baseBranch) code = "S7";
	else if (h2InH1 && !h1InH2) code = "S6";
	else if (h1InH2) code = sameBase ? "S1" : "S3";
	else if (sameBase && identical) code = "S5";
	else if (rebase.conflicts.length > 0) code = "S4b";
	else if (identical) code = "S4a";
	else code = "S4c";
	return { code, commits, identical, ...rebase };
}
