#!/usr/bin/env node
// Did CI pass on the RC's commit? release.yml's promote-ci job asks
// GitHub for ci.yml's runs at that commit (`gh api`, the job's only step
// with the token, before anything of the repository runs) and this judges
// the answer, with no token. No dependencies, on purpose: the job installs
// nothing (docs/releasing.md, "What promote checks").
//
//   node scripts/ci-passed.mjs <sha> <runs.json>
//       exits 0 and says which run passed, else 1 and why;
//       the repository is $GITHUB_REPOSITORY
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const name = (r) =>
	`run ${r.id}${r.run_attempt > 1 ? ` attempt ${r.run_attempt}` : ""}`;

/**
 * Fails unless CI (`ci.yml`) passed on `sha` as a push to master of `repo`:
 * a run of that workflow, event `push`, branch master, at exactly `sha`,
 * completed with conclusion `success` (all its jobs). The API lists each
 * run's latest attempt, so a failed run re-run green counts. `runsJson` is
 * the API's answer (`actions/workflows/ci.yml/runs`); nothing here trusts
 * its query filters. Returns what passed.
 */
export function checkCiPassed(runsJson, sha, repo) {
	if (!/^[0-9a-f]{40}$/.test(String(sha))) {
		throw new Error(`not a commit: ${sha}`);
	}
	const parsed = JSON.parse(runsJson);
	if (!Array.isArray(parsed?.workflow_runs)) {
		throw new Error("not a list of workflow runs (no workflow_runs)");
	}
	const runs = parsed.workflow_runs.filter(
		(r) =>
			String(r?.path ?? "").replace(/@.*$/, "") ===
				".github/workflows/ci.yml" &&
			r.event === "push" &&
			r.head_branch === "master" &&
			r.head_sha === sha &&
			r.head_repository?.full_name === repo,
	);
	const passed = runs.find(
		(r) => r.status === "completed" && r.conclusion === "success",
	);
	if (passed) return `CI passed on ${sha} (${name(passed)})`;
	if (runs.length === 0) {
		throw new Error(
			`CI has no run for a push to master at ${sha}: only a commit CI passed on master can be released`,
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
	const [sha, file] = process.argv.slice(2);
	const repo = process.env.GITHUB_REPOSITORY;
	if (!sha || !file || !repo) {
		console.error(
			"usage: GITHUB_REPOSITORY=<owner/repo> node scripts/ci-passed.mjs <sha> <runs.json>",
		);
		process.exit(2);
	}
	try {
		console.log(checkCiPassed(readFileSync(file, "utf8"), sha, repo));
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}
