#!/usr/bin/env node
// Did CI pass on the RC's commit? release.yml's promote-ci job asks
// GitHub for ci.yml's runs at that commit (`gh api`, the job's only step
// with the token, before anything of the repository runs) and this judges
// the answer, with no token. No dependencies, on purpose: the job installs
// nothing (docs/releasing.md, "What promote checks").
//
//   node scripts/ci-passed.mjs <sha> <runs.json> [hotfix/X.Y.Z]
//       exits 0 and says which run passed, else 1 and why;
//       the repository is $GITHUB_REPOSITORY. With a hotfix branch
//       (CAR-212): a run of that branch at sha, pushed or dispatched.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const name = (r) =>
	`run ${r.id}${r.run_attempt > 1 ? ` attempt ${r.run_attempt}` : ""}`;

const HOTFIX = /^hotfix\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Fails unless CI (`ci.yml`) passed on `sha` as a push to master of `repo`
 * (or, given `branch` `hotfix/X.Y.Z`, as a push or a dispatch of that
 * branch: a branch cut from an older release tag may run CI on dispatch
 * only):
 * a run of that workflow, event `push`, branch master, at exactly `sha`,
 * completed with conclusion `success` (all its jobs). The API lists each
 * run's latest attempt, so a failed run re-run green counts. `runsJson` is
 * the API's answer (`actions/workflows/ci.yml/runs`); nothing here trusts
 * its query filters. Returns what passed.
 */
export function checkCiPassed(runsJson, sha, repo, branch = "master") {
	if (!/^[0-9a-f]{40}$/.test(String(sha))) {
		throw new Error(`not a commit: ${sha}`);
	}
	const hotfix = branch !== "master";
	if (hotfix && !HOTFIX.test(String(branch))) {
		throw new Error(`not master or a hotfix branch: ${branch}`);
	}
	const events = hotfix ? ["push", "workflow_dispatch"] : ["push"];
	const parsed = JSON.parse(runsJson);
	if (!Array.isArray(parsed?.workflow_runs)) {
		throw new Error("not a list of workflow runs (no workflow_runs)");
	}
	const runs = parsed.workflow_runs.filter(
		(r) =>
			String(r?.path ?? "").replace(/@.*$/, "") ===
				".github/workflows/ci.yml" &&
			events.includes(r.event) &&
			r.head_branch === branch &&
			r.head_sha === sha &&
			r.head_repository?.full_name === repo,
	);
	const passed = runs.find(
		(r) => r.status === "completed" && r.conclusion === "success",
	);
	if (passed) return `CI passed on ${sha} (${name(passed)})`;
	if (runs.length === 0) {
		throw new Error(
			hotfix
				? `CI has no run of ${branch} at ${sha}: start one (gh workflow run ci.yml --ref ${branch}), then promote again once it passes`
				: `CI has no run for a push to master at ${sha}: only a commit CI passed on master can be released`,
		);
	}
	const running = runs.filter((r) => r.status !== "completed");
	if (running.length > 0) {
		throw new Error(
			`CI is still running on ${sha} (${running.map((r) => `${name(r)}: ${r.status}`).join(", ")}): promote again once it passes`,
		);
	}
	throw new Error(
		`CI did not pass on ${sha} (${runs.map((r) => `${name(r)}: ${r.conclusion}`).join(", ")}): re-run it, or promote another RC`,
	);
}

/** Run as a script, also through a symlink (argv[1] keeps the link's path). */
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
	const [sha, file, branch] = process.argv.slice(2);
	const repo = process.env.GITHUB_REPOSITORY;
	if (!sha || !file || !repo) {
		console.error(
			"usage: GITHUB_REPOSITORY=<owner/repo> node scripts/ci-passed.mjs <sha> <runs.json> [hotfix/X.Y.Z]",
		);
		process.exit(2);
	}
	try {
		console.log(checkCiPassed(readFileSync(file, "utf8"), sha, repo, branch));
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}
