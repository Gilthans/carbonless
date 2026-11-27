#!/usr/bin/env node
// Only merged PRs enter a hotfix (CAR-212): every first-parent commit from
// the release a hotfix branch starts at up to its head is the merge of a PR
// merged into that branch, at exactly that merge commit, and the branch is
// protected by the rulesets (docs/releasing.md, setup step 12). `pnpm
// release promote --hotfix` asks GitHub itself; release.yml's promote-ci
// asks GitHub in its token step (gh only) and this judges the answer with
// no token and no dependencies, like ci-passed.mjs.
//
//   node scripts/hotfix-prs.mjs <hotfix/X.Y.Z> <start tag> <head sha> <pulls.json> <rules.json>
//       exits 0 and lists the PRs, else 1 and why. pulls.json: the
//       branch's closed PRs (`gh api --paginate --slurp
//       repos/R/pulls?state=closed&base=<branch>`); rules.json: `gh api
//       repos/R/rules/branches/<branch>`. git log runs in the cwd.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOTFIX = /^hotfix\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
/**
 * What GitHub must enforce on a hotfix branch (the `Master` ruleset): PRs
 * only, no force push, no deletion, and Restrict updates (only the bypass,
 * the owner, merges into it).
 */
const NEEDED_RULES = ["pull_request", "non_fast_forward", "deletion", "update"];

/** `git log --first-parent --format='%H %P%x09%s'` lines as commits. */
export function parseCommits(text) {
	return String(text)
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((line) => {
			const tab = line.indexOf("\t");
			const [sha = "", ...parents] = line.slice(0, tab).trim().split(" ");
			return { sha, parents, subject: line.slice(tab + 1) };
		});
}

/** The PR a merge commit's subject names: `Title (#N)` or `Merge pull request #N from …`. */
function mergedPr(subject) {
	const m =
		/\s\(#([1-9]\d*)\)\s*$/.exec(subject) ??
		/^Merge pull request #([1-9]\d*) from /.exec(subject);
	return m ? Number(m[1]) : null;
}

/**
 * Each first-parent commit's PR number, failing unless every one is a
 * two-parent merge naming a PR (at least one): the shape alone, from git.
 */
export function prMerges(commits, branch) {
	if (commits.length === 0) throw new Error(`nothing on ${branch} yet`);
	return commits.map((c) => {
		const n = mergedPr(c.subject);
		if (!SHA.test(c.sha) || c.parents.length !== 2 || n === null) {
			throw new Error(
				`${c.sha} is not a PR merge (${c.parents.length} parent(s)): only merged PRs enter ${branch}`,
			);
		}
		return { sha: c.sha, number: n };
	});
}

/**
 * Fails unless the branch is protected (`rules` lists pull_request,
 * non_fast_forward and deletion) and each of `commits` (first-parent,
 * oldest first, at least one) is a two-parent merge of a PR that GitHub
 * (`pulls`, any page shape) says was merged into `branch` at exactly that
 * commit. Returns what passed.
 */
export function checkHotfixPrs({ commits, pulls, rules, branch }) {
	if (!HOTFIX.test(String(branch))) {
		throw new Error(`not a hotfix branch: ${branch}`);
	}
	if (!Array.isArray(rules)) throw new Error("not a list of rules");
	const types = new Set(rules.map((r) => r?.type));
	for (const t of NEEDED_RULES) {
		if (!types.has(t)) {
			throw new Error(
				`${branch} has no ${t} rule: add hotfix/* to the Master ruleset (docs/releasing.md, setup step 12) before a hotfix`,
			);
		}
	}
	const all = (Array.isArray(pulls) ? pulls : []).flat(2);
	const numbers = [];
	for (const { sha, number: n } of prMerges(commits, branch)) {
		const c = { sha };
		const p = all.find((x) => x?.number === n);
		if (!p) throw new Error(`#${n} is not a PR merged into ${branch}`);
		if (!p.merged_at) throw new Error(`#${n} is not merged`);
		if (p.base?.ref !== branch) {
			throw new Error(`#${n} was merged into ${p.base?.ref}, not ${branch}`);
		}
		if (p.merge_commit_sha !== c.sha) {
			throw new Error(
				`#${n}'s merge commit is ${p.merge_commit_sha}, not ${c.sha}`,
			);
		}
		numbers.push(n);
	}
	return `${numbers.length} PR merge(s) into ${branch}: ${numbers.map((n) => `#${n}`).join(", ")}`;
}

function isMain() {
	try {
		return (
			realpathSync(process.argv[1] ?? "") ===
			realpathSync(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
}

if (isMain()) {
	const [branch, start, sha, pullsFile, rulesFile] = process.argv.slice(2);
	if (
		!HOTFIX.test(branch ?? "") ||
		!RELEASE_TAG.test(start ?? "") ||
		!SHA.test(sha ?? "") ||
		!pullsFile ||
		!rulesFile
	) {
		console.error(
			"usage: node scripts/hotfix-prs.mjs <hotfix/X.Y.Z> <vX.Y.Z> <sha> <pulls.json> <rules.json>",
		);
		process.exit(2);
	}
	try {
		const log = execFileSync(
			"git",
			[
				"log",
				"--first-parent",
				"--reverse",
				"--format=%H %P%x09%s",
				`refs/tags/${start}..${sha}`,
				"--",
			],
			{ encoding: "utf8" },
		);
		console.log(
			checkHotfixPrs({
				commits: parseCommits(log),
				pulls: JSON.parse(readFileSync(pullsFile, "utf8")),
				rules: JSON.parse(readFileSync(rulesFile, "utf8")),
				branch,
			}),
		);
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}
