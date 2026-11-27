// Hotfixes (CAR-212; docs/releasing.md, "Withdraw and hotfix"): one fix on
// top of the newest release, without master's other changes.
//
//   pnpm release hotfix [vX.Y.Z]        hotfix/X.Y.Z+1 on origin at that
//                                       release tag's commit (default and
//                                       only choice: the newest release)
//   pnpm release promote --hotfix X.Y.Z the branch's head promoted like an
//                                       RC (master's release.yml packs it)
//
// release-finish then tags vX.Y.Z on the branch, and opens the port PR
// that brings the fix and the changelog to master (`ci:port`).
// Everything goes through the injected Io, as release-lib.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCiPassed } from "./ci-passed.mjs";
import { checkHotfixPrs, parseCommits, prMerges } from "./hotfix-prs.mjs";
import {
	compareVersions,
	dispatchPromote,
	formatVersion,
	hotfixStartFor,
	type Io,
	masterVersion,
	must,
	newestTag,
	npmState,
	parseTag,
	parseVersion,
	remoteTags,
	tagCommit,
	tagOf,
	type Version,
} from "./release-lib.js";
import { mdText, subjectPr, titleTickets } from "./release-notes.js";

/**
 * The release a hotfix of `fromTag` (a release tag) becomes: its next patch
 * with no release tag and not on npm (`v0.4.0` -> 0.4.1; a second hotfix of
 * the line starts from the first one's tag, `v0.4.1` -> 0.4.2). A version
 * npm has without a tag (one we didn't build: the runbook's case) is
 * skipped: npm never takes a version twice.
 */
export function hotfixVersion(
	fromTag: string,
	tags: readonly string[],
	npmVersions: readonly string[] = [],
): string {
	const from = parseTag(fromTag);
	if (!from || from.rc !== undefined) {
		throw new Error(`not a release tag (vX.Y.Z): ${fromTag}`);
	}
	const taken = new Set([
		...tags.map((t) => t.replace(/^refs\/tags\//, "")),
		...npmVersions.map((v) => `v${v}`),
	]);
	let next: Version = { ...from, patch: from.patch + 1 };
	while (taken.has(tagOf(next))) next = { ...next, patch: next.patch + 1 };
	return formatVersion(next);
}

/**
 * Where a hotfix starts: `from` (default: the newest release tag by
 * semver), refused unless it is that newest release. After a withdraw,
 * `latest` has moved back, but the withdrawn release is still the newest
 * tag: its hotfix is what crbs running it are offered. Older lines (and
 * older releases of the newest line) are out of scope.
 */
export function hotfixStartTag(
	tags: readonly string[],
	from?: string,
): { tag: string; version: Version } {
	const newest = newestTag(tags, false);
	if (!newest) throw new Error("nothing is released yet: no v*.*.* tag");
	if (from === undefined) return newest;
	const given = parseTag(from);
	if (!given || given.rc !== undefined || !from.startsWith("v")) {
		throw new Error(
			`not a release tag (vX.Y.Z): ${from}; a hotfix starts from a release tag, never another commit`,
		);
	}
	if (!tags.includes(tagOf(given))) {
		throw new Error(`${tagOf(given)} is not on origin`);
	}
	if (compareVersions(given, newest.version) === 0) return newest;
	if (
		given.major === newest.version.major &&
		given.minor === newest.version.minor
	) {
		throw new Error(
			`${newest.tag} is out: a hotfix of this line starts from it (pnpm release hotfix ${newest.tag})`,
		);
	}
	throw new Error(
		`${tagOf(given)} is an older release line: only the newest release (${newest.tag}) gets hotfixes`,
	);
}

/**
 * Fails when master's next release isn't after the hotfix `version`: its
 * RCs would sort below the hotfix, or be the same version.
 */
function checkMasterAfter(master: string, version: string): void {
	const m = parseVersion(master);
	const v = parseVersion(version);
	if (m && v && compareVersions(m, v) <= 0) {
		throw new Error(
			`master's next release is ${master}, not after the hotfix ${version}: move master on first (pnpm release next minor), or release master instead (pnpm release promote)`,
		);
	}
}

/**
 * `pnpm release hotfix [vX.Y.Z]`: creates `hotfix/X.Y.Z+1` on origin at the
 * release tag's commit (GitHub's API: no clone, no commit; the version is
 * set at pack time). A rerun with the branch already there at that commit
 * does nothing; at another commit it's refused (the hotfix has started).
 * Writes nothing but that branch.
 */
export async function hotfixStart(
	io: Io,
	from?: string,
): Promise<{ branch: string; version: string; sha: string }> {
	const [tags, npm, master] = await Promise.all([
		remoteTags(io),
		npmState(io),
		masterVersion(io),
	]);
	const start = hotfixStartTag(tags, from);
	const version = hotfixVersion(start.tag, tags, npm?.versions ?? []);
	const skipped = (npm?.versions ?? []).filter((n) => {
		const x = parseVersion(n);
		return (
			x !== null &&
			x.rc === undefined &&
			x.major === start.version.major &&
			x.minor === start.version.minor &&
			x.patch > start.version.patch &&
			!tags.includes(tagOf(x))
		);
	});
	if (skipped.length > 0) {
		io.log(
			`skipping ${skipped.join(", ")}: on npm with no tag (withdraw what we didn't build)`,
		);
	}
	checkMasterAfter(master, version);
	const sha = (await tagCommit(io, start.tag)).trim();
	if (!/^[0-9a-f]{40}$/.test(sha)) {
		throw new Error(`${start.tag}'s commit on GitHub: ${sha}`);
	}
	const branch = `hotfix/${version}`;
	const existing = (
		await must(io, "git", [
			"ls-remote",
			"--heads",
			"origin",
			`refs/heads/${branch}`,
		])
	)
		.trim()
		.split(/\s+/)[0];
	if (existing) {
		if (existing !== sha) {
			throw new Error(
				`${branch} is on origin at ${existing}, not ${start.tag} (${sha}): the hotfix has started; its fix goes in as a PR into it`,
			);
		}
		io.log(`${branch} is on origin at ${start.tag} (${sha}) already`);
	} else {
		await must(io, "gh", [
			"api",
			"-X",
			"POST",
			`repos/${io.repo}/git/refs`,
			"-f",
			`ref=refs/heads/${branch}`,
			"-f",
			`sha=${sha}`,
		]);
		io.log(`Created ${branch} at ${start.tag} (${sha})`);
	}
	io.log(
		`Next: the fix as a PR into ${branch} (CI, a release note), then pnpm release promote --hotfix ${version}`,
	);
	return { branch, version, sha };
}

/** Whether `a` is an ancestor of `b` in the checkout (git's answer, 0 or 1). */
async function isAncestor(io: Io, a: string, b: string): Promise<boolean> {
	const r = await io.run("git", ["merge-base", "--is-ancestor", a, b]);
	if (r.code === 0 || r.code === 1) return r.code === 0;
	throw new Error(`git merge-base failed: ${r.stderr.trim()}`);
}

/**
 * What a promote of hotfix `version` builds: its branch's head, checked to
 * be a hotfix of the newest release (the newest release tag below
 * `version`, of its line, which is the newest release; `version` the next
 * patch after it not on npm or tagged), on top of it, not released, with
 * master's next release after it, and every first-parent commit since the
 * start a merge of a PR (hotfix-prs.mjs). People (Io.tags "origin") fetch
 * the branch and ask GitHub whether each PR was merged into the branch at
 * that commit and whether the rulesets protect it; the workflow reads its
 * checkout (every branch and tag) and its promote-ci job asks GitHub.
 */
export async function resolveHotfix(
	io: Io,
	version: string,
): Promise<{ branch: string; tag: string; release: string; sha: string }> {
	const v = parseVersion(version);
	if (!v || v.rc !== undefined || formatVersion(v) !== version) {
		throw new Error(`not a release X.Y.Z: ${version}`);
	}
	const branch = `hotfix/${version}`;
	const [tags, npm] = await Promise.all([remoteTags(io), npmState(io)]);
	if (tags.includes(tagOf(v)) || npm?.versions.includes(version)) {
		throw new Error(`${version} is already released`);
	}
	const start = hotfixStartFor(v, tags);
	const newest = newestTag(tags, false);
	if (
		!start ||
		newest?.tag !== start ||
		hotfixVersion(start, tags, npm?.versions ?? []) !== version
	) {
		throw new Error(
			`${branch} is not a hotfix of the newest release (${newest?.tag ?? "none"}): the next one is ${newest ? hotfixVersion(newest.tag, tags, npm?.versions ?? []) : "none"}`,
		);
	}
	const github = io.tags !== "local";
	if (github) {
		const f = await io.run("git", [
			"fetch",
			"--quiet",
			"origin",
			`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
			"--tags",
		]);
		if (f.code !== 0) {
			throw new Error(
				`no ${branch} on origin: pnpm release hotfix ${start} creates it`,
			);
		}
	}
	const r = await io.run("git", [
		"rev-parse",
		"-q",
		"--verify",
		`refs/remotes/origin/${branch}^{commit}`,
	]);
	if (r.code !== 0) throw new Error(`no ${branch} on origin`);
	const sha = r.stdout.trim();
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${branch}'s head: ${sha}`);
	const startSha = (
		await must(io, "git", ["rev-parse", `refs/tags/${start}^{commit}`])
	).trim();
	if (sha === startSha) {
		throw new Error(`${branch} has nothing on top of ${start} yet`);
	}
	if (!(await isAncestor(io, `refs/tags/${start}`, sha))) {
		throw new Error(`${branch} is not on top of ${start}`);
	}
	const master = github
		? await masterVersion(io)
		: (
				JSON.parse(await must(io, "git", ["show", "HEAD:package.json"])) as {
					version: string;
				}
			).version;
	checkMasterAfter(master, version);
	// `npm stage publish --tag latest` would move latest backwards.
	const latest = parseVersion(npm?.distTags.latest ?? "");
	if (latest && compareVersions(v, latest) <= 0) {
		throw new Error(
			`${version} is not newer than latest (${npm?.distTags.latest})`,
		);
	}
	const commits = parseCommits(
		await must(io, "git", [
			"log",
			"--first-parent",
			"--reverse",
			"--format=%H %P%x09%s",
			`refs/tags/${start}..${sha}`,
			"--",
		]),
	);
	if (github) {
		const [pulls, rules] = await Promise.all([
			must(io, "gh", [
				"api",
				"--paginate",
				"--slurp",
				`repos/${io.repo}/pulls?state=closed&base=${branch}&per_page=100`,
			]),
			must(io, "gh", [
				"api",
				`repos/${io.repo}/rules/branches/${encodeURIComponent(branch)}`,
			]),
		]);
		io.log(
			checkHotfixPrs({
				commits,
				pulls: JSON.parse(pulls),
				rules: JSON.parse(rules),
				branch,
			}),
		);
	} else {
		// No token here: the shape alone (promote-ci asked GitHub).
		prMerges(commits, branch);
	}
	return { branch, tag: start, release: version, sha };
}

/**
 * `pnpm release promote --hotfix X.Y.Z`: the hotfix branch's head promoted
 * as release.yml promotes an RC (no RC on the `rc` channel first: the
 * owner asked for the fastest path). Refused unless CI passed on the head
 * (none yet: it starts CI there, a branch cut from an older tag may run it
 * on dispatch only, and asks to promote again once it passes) and `notes`
 * (hotfixNotes: Linear's notes for exactly the branch's PRs) has them.
 */
export async function promoteHotfix(
	io: Io,
	version: string,
	notes: (branch: string, sha: string, release: string) => Promise<string>,
): Promise<string> {
	const plan = await resolveHotfix({ ...io, tags: "origin" }, version);
	const runs = await must(io, "gh", [
		"api",
		`repos/${io.repo}/actions/workflows/ci.yml/runs?head_sha=${plan.sha}&per_page=100`,
	]);
	try {
		io.log(checkCiPassed(runs, plan.sha, io.repo, plan.branch));
	} catch (error) {
		const message = (error as Error).message;
		if (!message.startsWith("CI has no run")) throw error;
		await must(io, "gh", [
			"workflow",
			"run",
			"ci.yml",
			"--repo",
			io.repo,
			"--ref",
			plan.branch,
		]);
		throw new Error(
			`CI had no run of ${plan.branch} at ${plan.sha}: started one; promote again once it passes`,
		);
	}
	const encoded = await notes(plan.branch, plan.sha, plan.release);
	return dispatchPromote(
		io,
		[
			"-f",
			`hotfix=${plan.branch}`,
			...(encoded ? ["-f", `notes=${encoded}`] : []),
		],
		`Promoting ${plan.branch} (${plan.sha}, on top of ${plan.tag}): packs ${plan.release} with master's scripts, smoke-tests and stages it on npm; then the owner approves it: pnpm release publish (npm OTP)`,
	);
}

// ---------------------------------------------------------------------------
// The fix reaches master.

export type PortItem = {
	pr: number;
	title: string;
	/** Its own ticket (the title's trailing `(CAR-N)`), or null. */
	ticket: string | null;
	sha: string;
	/**
	 * applies: cherry-picks onto master cleanly (after the ones before it);
	 * conflicts: port it by hand; ticket: a master PR names its ticket
	 * (`masterPr`) but master lacks this change: someone checks.
	 */
	status: "applies" | "conflicts" | "ticket";
	masterPr?: number;
};

/**
 * A PR title's own tickets: the repo's trailing `(CAR-N)` or `(CAR-N,
 * CAR-M)`, never a ticket only mentioned ("follow-up to CAR-9"), and none
 * for a revert (its ticket is the reverted change's).
 */
export function ownTickets(title: string): string[] {
	if (/^\s*Revert\b/i.test(title)) return [];
	const m = /\(((?:CAR-[1-9]\d*)(?:,\s*CAR-[1-9]\d*)*)\)\s*$/i.exec(title);
	return m?.[1] ? titleTickets(m[1]) : [];
}

/** A first-parent subject's PR: `Title (#N)`, or `Merge pull request #N from …`. */
function prOf(subject: string): { number: number; title: string } | null {
	const pr = subjectPr(subject);
	if (pr) return { number: pr.number, title: pr.title };
	const m = /^Merge pull request #([1-9]\d*) from /.exec(subject);
	return m ? { number: Number(m[1]), title: subject } : null;
}

/**
 * Each PR of hotfix `hotfixTag` (its first-parent commits after the release
 * it starts from) whose change `master` lacks. A PR is on master when git
 * finds each of its commits' patches there (`git cherry`: no `+` in
 * `sha^1..sha`), or when its pick onto master comes out empty (master has
 * the change, however it got there: the port PR's merge, a fix written
 * differently). The rest are tried in order as `git cherry-pick -x` (`-m
 * 1` for a merge) onto master in a worktree: `applies` or `conflicts`. A
 * master PR naming the same ticket never drops a fix on its own: such a PR
 * is `ticket` (left out of the picks, listed to check). With `keep`, the
 * worktree stays on a new branch of that name holding the picks that
 * applied (the port PR's); else it's removed.
 */
export async function missingOnMaster(
	io: Io,
	hotfixTag: string,
	opts: { master?: string; worktree?: string; keep?: string } = {},
): Promise<PortItem[]> {
	const v = parseTag(hotfixTag);
	if (!v || v.rc !== undefined) {
		throw new Error(`not a release tag: ${hotfixTag}`);
	}
	const master = opts.master ?? "HEAD";
	const start = hotfixStartFor(v, await remoteTags(io));
	if (!start) throw new Error(`no release of its line before ${hotfixTag}`);
	const commits = parseCommits(
		await must(io, "git", [
			"log",
			"--first-parent",
			"--reverse",
			"--format=%H %P%x09%s",
			`refs/tags/${start}..refs/tags/${hotfixTag}`,
			"--",
		]),
	);
	const base = (
		await must(io, "git", ["merge-base", `refs/tags/${hotfixTag}`, master])
	).trim();
	// Each ticket a master PR since the two parted names as its own: that PR.
	const masterPrs = new Map<string, number>();
	for (const subject of (
		await must(io, "git", [
			"log",
			"--first-parent",
			"--format=%s",
			`${base}..${master}`,
			"--",
		])
	).split("\n")) {
		const pr = prOf(subject);
		if (!pr) continue;
		for (const t of ownTickets(pr.title)) {
			if (!masterPrs.has(t)) masterPrs.set(t, pr.number);
		}
	}
	const candidates: (PortItem & { merge: boolean })[] = [];
	for (const c of commits) {
		const pr = prOf(c.subject);
		if (!pr) {
			io.log(`not a PR (no "(#N)"), not ported: ${mdText(c.subject)}`);
			continue;
		}
		// Its commits ("+": a patch master lacks; "-": one it has).
		const cherry = await must(io, "git", [
			"cherry",
			master,
			c.sha,
			`${c.sha}^1`,
		]);
		if (!cherry.split("\n").some((l) => l.startsWith("+ "))) continue;
		const tickets = ownTickets(pr.title);
		const byTicket = tickets.find((t) => masterPrs.has(t));
		candidates.push({
			pr: pr.number,
			title: pr.title,
			ticket: tickets[0] ?? null,
			sha: c.sha,
			status: "conflicts",
			...(byTicket ? { masterPr: masterPrs.get(byTicket) } : {}),
			merge: c.parents.length > 1,
		});
	}
	if (candidates.length === 0 && !opts.keep) return [];
	const tmp = opts.worktree ? null : mkdtempSync(join(tmpdir(), "crb-port-"));
	const dir = opts.worktree ?? join(tmp ?? "", "tree");
	await must(io, "git", [
		"worktree",
		"add",
		...(opts.keep ? ["-b", opts.keep] : ["--detach"]),
		dir,
		master,
	]);
	const missing: PortItem[] = [];
	try {
		// A trial (nothing kept) commits under a placeholder name: it works
		// with no git identity set up. The port branch's picks are the
		// configured identity's (release-finish's bot).
		const who = opts.keep
			? []
			: ["-c", "user.name=crb release", "-c", "user.email=release@invalid"];
		for (const { merge, ...item } of candidates) {
			const r = await io.run(
				"git",
				[...who, "cherry-pick", "-x", ...(merge ? ["-m", "1"] : []), item.sha],
				{ cwd: dir },
			);
			const said = r.stderr + r.stdout;
			if (r.code !== 0 && /is now empty|nothing to commit/i.test(said)) {
				// Master has the change already.
				await io.run("git", ["cherry-pick", "--skip"], { cwd: dir });
				continue;
			}
			if (r.code !== 0) {
				await io.run("git", ["cherry-pick", "--abort"], { cwd: dir });
				// A conflict is an answer; any other failure is not.
				if (!/could not apply|conflict/i.test(said)) {
					throw new Error(
						`git cherry-pick ${item.sha} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
					);
				}
			} else if (item.masterPr !== undefined) {
				// Not on master as this patch: don't port it blind either.
				await must(io, "git", ["reset", "--hard", "-q", "HEAD~1"], {
					cwd: dir,
				});
			}
			missing.push({
				...item,
				status:
					item.masterPr !== undefined
						? "ticket"
						: r.code === 0
							? "applies"
							: "conflicts",
			});
		}
	} finally {
		if (!opts.keep) {
			await io.run("git", ["worktree", "remove", "--force", dir]);
		}
		if (tmp && !opts.keep) rmSync(tmp, { recursive: true, force: true });
	}
	return missing;
}

/** "on master by CAR-N (#M)? check" for a PR matched by its ticket alone. */
const ticketCheck = (i: PortItem) =>
	`on master by ${i.ticket} (#${i.masterPr})? check`;

/** The port PR's title and body (markdown, every git-sourced text escaped). */
export function portPr(
	version: string,
	items: readonly PortItem[],
): { title: string; body: string } {
	const ported = items.filter((i) => i.status === "applies");
	const conflicts = items.filter((i) => i.status === "conflicts");
	const checks = items.filter((i) => i.status === "ticket");
	const tickets = [
		...new Set(ported.flatMap((i) => (i.ticket ? [i.ticket] : []))),
	];
	const title =
		ported.length === 0
			? `Hotfix ${version}: changelog to master`
			: `Hotfix ${version} to master${tickets.length ? ` (${tickets.join(", ")})` : ""}`;
	const line = (i: PortItem) => `- ${mdText(i.title)} (#${i.pr})`;
	const body = [
		`Brings hotfix **${version}** (\`hotfix/${version}\`, tag \`v${version}\`) to master: its changelog section and \`release-notes/${version}.json\`${ported.length ? ", and the fix" : ""}.`,
		...(ported.length
			? ["", "Cherry-picked (`git cherry-pick -x`):", ...ported.map(line)]
			: []),
		...(conflicts.length
			? [
					"",
					"**Not ported: they don't apply cleanly. Port each by hand in its own PR:**",
					...conflicts.map(line),
				]
			: []),
		...(checks.length
			? [
					"",
					"**Not ported: master has a PR of the same ticket, but not this change. Check each; port it by hand if master still needs it:**",
					...checks.map((i) => `${line(i)}: ${ticketCheck(i)}`),
				]
			: []),
		...(items.length === 0
			? ["", "Every fix of the hotfix is on master already."]
			: []),
		"",
		`Release note: none (ported from hotfix ${version}, whose notes shipped there)`,
	].join("\n");
	return { title, body };
}

/**
 * `pnpm release status`'s hotfixes (after release-lib's status): each
 * release tag not on origin/master (a hotfix's) and the PRs master still
 * lacks. Reads only (a fetch, and a throwaway worktree to try the picks).
 */
export async function hotfixStatus(io: Io): Promise<void> {
	try {
		await must(io, "git", ["fetch", "--quiet", "origin", "master", "--tags"]);
		const tags = await remoteTags(io);
		for (const tag of tags) {
			const v = parseTag(tag);
			if (!v || v.rc !== undefined) continue;
			if (await isAncestor(io, `refs/tags/${tag}`, "origin/master")) continue;
			const missing = await missingOnMaster(io, tag, {
				master: "origin/master",
			});
			if (missing.length === 0) {
				io.log(`hotfix:  ${tag}: on master`);
				continue;
			}
			io.log(
				`hotfix:  ${tag}: master lacks ${missing
					.map(
						(m) =>
							`#${m.pr}${m.ticket ? ` (${m.ticket})` : ""}${m.status === "conflicts" ? " (conflicts)" : m.status === "ticket" ? ` (${ticketCheck(m)})` : ""}`,
					)
					.join(
						", ",
					)}: merge its port PR (hotfix-port/${formatVersion(v)}), or port by hand`,
			);
		}
	} catch (error) {
		io.log(`hotfix:  unknown (${(error as Error).message})`);
	}
}
