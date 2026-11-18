#!/usr/bin/env node
// The release freeze (CAR-191): once master's version X.Y.Z is released
// (tag vX.Y.Z), only the "next" PR may merge into master until it moves
// master's version on. A merge before it publishes no RC (release.yml skips:
// X.Y.Z is out) and its changelog entry misses the "next" PR's. CI's
// release-gate job asks GitHub (`gh api`, the job's only step with the
// token, before anything of the repository runs) and this judges the
// answer, with no token. No dependencies, on purpose: the job installs
// nothing. `pnpm release status` and `pnpm release merge-ok <pr>` (the
// agents' merge path, which `gh pr merge --admin` would otherwise skip)
// judge with the same function. docs/releasing.md, "The release freeze".
//
//   node scripts/release-gate.mjs <package.json> <tags.json> <pulls.json>
//       the base's package.json, `gh api --paginate --slurp` of
//       git/matching-refs/tags/v and of the open PRs to master;
//       the PR's head from $HEAD_REF and $HEAD_REPO, the repository is
//       $GITHUB_REPOSITORY. Exits 0 and says why, else 1 and what to merge.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The branch release-finish (and `pnpm release next`) opens: next/X.Y.Z. */
const NEXT_BRANCH = /^next\/\d+\.\d+\.\d+$/;

/**
 * `gh api --paginate --slurp` wraps pages in an array: one list either way.
 * Anything but a list (an error body, say) throws: the gate fails closed.
 */
const flat = (value, what) => {
	if (!Array.isArray(value)) {
		throw new Error(
			`${what} is not a list: ${JSON.stringify(value)?.slice(0, 200)}`,
		);
	}
	return value.flatMap((v) => (Array.isArray(v) ? v : [v]));
};

/** A tag's name from `refs/tags/vX`, `{ ref: "refs/tags/vX" }` or `vX`. */
const tagName = (t) =>
	String(typeof t === "string" ? t : (t?.ref ?? "")).replace(
		/^refs\/tags\//,
		"",
	);

/**
 * Whether `version` (X.Y.Z) is released: its tag `vX.Y.Z` is among `tags`,
 * or npm has it (`npmVersions`, when known). An RC tag doesn't count.
 */
export function isReleased(version, tags, npmVersions = []) {
	return (
		flat(tags, "tags").map(tagName).includes(`v${version}`) ||
		flat(npmVersions, "npm versions").includes(version)
	);
}

/** A "next" PR: its head is a next/X.Y.Z branch of this very repository. */
export function isNextPr(pr, repo) {
	return (
		pr?.head?.repo?.full_name === repo &&
		NEXT_BRANCH.test(String(pr?.head?.ref ?? ""))
	);
}

/**
 * Whether master may take `pr` now. `version` is the base's package.json
 * version (read at run time, never the PR's merge commit), `tags` origin's
 * tags (any of the shapes above), `npmVersions` npm's versions of the
 * package when known (released = its tag or its npm version, as
 * release.ts's RC plan counts it), `pulls` the open PRs to master (GitHub's
 * REST shape, pages or flat), `pr` the PR asking (REST shape; none: only
 * the freeze, for status). Frozen while `version` is released; then only a
 * "next" PR of this repository passes (a fork's next/* branch doesn't).
 * `blocker` says which PR to merge first, or that there is none.
 */
export function releaseGate({
	version,
	tags,
	npmVersions = [],
	pulls,
	repo,
	pr,
}) {
	if (!/^\d+\.\d+\.\d+$/.test(String(version))) {
		throw new Error(
			`master's version must be a release X.Y.Z: ${JSON.stringify(version)}`,
		);
	}
	if (!repo) throw new Error("no repository");
	if (pr && pr.base?.ref !== undefined && pr.base.ref !== "master") {
		return {
			ok: true,
			frozen: false,
			blocker: null,
			message: `#${pr.number} is not to master: no freeze applies`,
		};
	}
	const open = flat(pulls, "open PRs");
	if (!isReleased(version, tags, npmVersions)) {
		return {
			ok: true,
			frozen: false,
			blocker: null,
			message: `${version} is not released yet: merges to master are open`,
		};
	}
	const next = open
		.filter((p) => isNextPr(p, repo))
		.sort((a, b) => a.number - b.number);
	const blocker =
		next.length > 0
			? `merge ${next.map((p) => `#${p.number} ${p.title}${p.html_url ? ` (${p.html_url})` : ""}`).join(" or ")} first`
			: `no "next" PR is open: run release-finish again (or \`pnpm release next\`), merge its PR first`;
	const frozen = `${version} is released and master's version is still ${version}`;
	if (pr && isNextPr(pr, repo)) {
		return {
			ok: true,
			frozen: true,
			blocker,
			message: `${frozen}: #${pr.number} is the "next" PR, which ends the freeze`,
		};
	}
	return {
		ok: false,
		frozen: true,
		blocker,
		message: `frozen: ${frozen} (a merge now publishes no RC and misses the changelog): ${blocker}`,
	};
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
	const [pkg, tagsFile, pullsFile] = process.argv.slice(2);
	const repo = process.env.GITHUB_REPOSITORY;
	if (!pkg || !tagsFile || !pullsFile || !repo) {
		console.error(
			"usage: GITHUB_REPOSITORY=<owner/repo> HEAD_REF=<branch> HEAD_REPO=<owner/repo> node scripts/release-gate.mjs <package.json> <tags.json> <pulls.json>",
		);
		process.exit(2);
	}
	try {
		const read = (file) => JSON.parse(readFileSync(file, "utf8"));
		const gate = releaseGate({
			version: read(pkg).version,
			tags: read(tagsFile),
			pulls: read(pullsFile),
			repo,
			pr: {
				number: process.env.PR_NUMBER ?? "?",
				base: { ref: "master" },
				head: {
					ref: process.env.HEAD_REF ?? "",
					repo: { full_name: process.env.HEAD_REPO ?? "" },
				},
			},
		});
		if (gate.ok) {
			console.log(gate.message);
		} else {
			// An annotation on the run, and the reason in the log.
			console.log(
				`::error title=Release freeze::${gate.message}. Once it merges, rerun this check (Re-run failed jobs): it reads master again.`,
			);
			process.exit(1);
		}
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}
