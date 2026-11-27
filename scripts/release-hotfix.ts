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
import {
	compareVersions,
	dispatchPromote,
	formatVersion,
	hotfixStartOf,
	type Io,
	masterVersion,
	must,
	newestTag,
	npmState,
	parseTag,
	parseVersion,
	previousRelease,
	remoteTags,
	tagCommit,
	tagOf,
	type Version,
} from "./release-lib.js";
import { mdText, subjectPr, titleTickets } from "./release-notes.js";

/**
 * The release a hotfix of `fromTag` (a release tag) becomes: its next patch
 * with no release tag yet (`v0.4.0` -> 0.4.1; a second hotfix of the line
 * starts from the first one's tag, `v0.4.1` -> 0.4.2).
 */
export function hotfixVersion(
	fromTag: string,
	tags: readonly string[],
): string {
	const from = parseTag(fromTag);
	if (!from || from.rc !== undefined) {
		throw new Error(`not a release tag (vX.Y.Z): ${fromTag}`);
	}
	const taken = new Set(tags.map((t) => t.replace(/^refs\/tags\//, "")));
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
	const version = hotfixVersion(start.tag, tags);
	if (hotfixStartOf(parseVersion(version) as Version) !== start.tag) {
		throw new Error(
			`${version} doesn't follow ${start.tag}: finish the hotfixes of this line first`,
		);
	}
	if (npm?.versions.includes(version)) {
		throw new Error(
			`${version} is on npm already, with no v${version} tag: finish its release (release-finish) before another hotfix`,
		);
	}
	if (master === version) {
		throw new Error(
			`master's next release is ${version} too: release it (pnpm release promote), or move master on first (pnpm release next minor)`,
		);
	}
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
 * be a hotfix of the newest release: the branch name's version is the next
 * patch of that release tag, which is the newest release, the head is on
 * top of it (at least one PR), and the version isn't released. People ask
 * GitHub (Io.tags "origin"), the workflow its checkout (every branch and
 * tag).
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
	const start = hotfixStartOf(v);
	const newest = newestTag(tags, false);
	if (!start || previousRelease(tags, v) !== start || newest?.tag !== start) {
		throw new Error(
			`${branch} is not a hotfix of the newest release (${newest?.tag ?? "none"}): the next one is ${newest ? hotfixVersion(newest.tag, tags) : "none"}`,
		);
	}
	let sha: string;
	if (io.tags === "local") {
		const r = await io.run("git", [
			"rev-parse",
			"-q",
			"--verify",
			`refs/remotes/origin/${branch}^{commit}`,
		]);
		if (r.code !== 0) throw new Error(`no ${branch} on origin`);
		sha = r.stdout.trim();
		const startSha = (
			await must(io, "git", ["rev-parse", `refs/tags/${start}^{commit}`])
		).trim();
		if (sha === startSha) {
			throw new Error(`${branch} has nothing on top of ${start} yet`);
		}
		if (!(await isAncestor(io, `refs/tags/${start}`, sha))) {
			throw new Error(`${branch} is not on top of ${start}`);
		}
	} else {
		const r = await io.run("gh", [
			"api",
			`repos/${io.repo}/git/ref/heads/${branch}`,
			"--jq",
			".object.sha",
		]);
		if (r.code !== 0) {
			throw new Error(
				`no ${branch} on origin: pnpm release hotfix ${start} creates it`,
			);
		}
		sha = r.stdout.trim();
		const status = (
			await must(io, "gh", [
				"api",
				`repos/${io.repo}/compare/${start}...${sha}`,
				"--jq",
				".status",
			])
		).trim();
		if (status === "identical") {
			throw new Error(`${branch} has nothing on top of ${start} yet`);
		}
		if (status !== "ahead") {
			throw new Error(`${branch} is not on top of ${start} (${status})`);
		}
	}
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${branch}'s head: ${sha}`);
	// `npm stage publish --tag latest` would move latest backwards.
	const latest = parseVersion(npm?.distTags.latest ?? "");
	if (latest && compareVersions(v, latest) <= 0) {
		throw new Error(
			`${version} is not newer than latest (${npm?.distTags.latest})`,
		);
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
	/** The first CAR-N of its title, or null. */
	ticket: string | null;
	sha: string;
	/** Cherry-picks onto master cleanly (after the ones before it). */
	applies: boolean;
};

/**
 * Each PR of hotfix `hotfixTag` (its first-parent commits after the release
 * it starts from) whose change `master` lacks: not when a master commit
 * since the two parted names one of its tickets, nor when git finds the
 * same patch there (`git cherry`, by patch-id, whatever the title). Each
 * is tried, in order, as `git cherry-pick -x` onto master in `worktree`:
 * `applies` says whether it went in cleanly. With `keep`, the worktree
 * stays on a new branch of that name holding the picks that applied (the
 * port PR's); else it's removed.
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
	const start = previousRelease(await remoteTags(io), v);
	if (!start) throw new Error(`no release before ${hotfixTag}`);
	const log = await must(io, "git", [
		"log",
		"--first-parent",
		"--reverse",
		"--format=%H %P%x09%s",
		`refs/tags/${start}..refs/tags/${hotfixTag}`,
		"--",
	]);
	const base = (
		await must(io, "git", ["merge-base", `refs/tags/${hotfixTag}`, master])
	).trim();
	const onMasterTickets = new Set(
		(
			await must(io, "git", [
				"log",
				"--first-parent",
				"--format=%s",
				`${base}..${master}`,
				"--",
			])
		)
			.split("\n")
			.flatMap((s) => titleTickets(s)),
	);
	// "- <sha>": a commit whose patch master has.
	const samePatch = new Set(
		(
			await must(io, "git", [
				"cherry",
				master,
				`refs/tags/${hotfixTag}`,
				`refs/tags/${start}`,
			])
		)
			.split("\n")
			.filter((l) => l.startsWith("- "))
			.map((l) => l.slice(2).trim()),
	);
	const missing: (PortItem & { merge: boolean })[] = [];
	for (const line of log.split("\n")) {
		if (line.trim() === "") continue;
		const tab = line.indexOf("\t");
		const [sha = "", ...parents] = line.slice(0, tab).trim().split(" ");
		const pr = subjectPr(line.slice(tab + 1));
		if (!pr) {
			io.log(`not a PR (no "(#N)"), not ported: ${line.slice(tab + 1)}`);
			continue;
		}
		if (pr.tickets.some((t) => onMasterTickets.has(t))) continue;
		if (samePatch.has(sha)) continue;
		missing.push({
			pr: pr.number,
			title: pr.title,
			ticket: pr.tickets[0] ?? null,
			sha,
			applies: false,
			merge: parents.length > 1,
		});
	}
	if (missing.length === 0 && !opts.keep) return [];
	const tmp = opts.worktree ? null : mkdtempSync(join(tmpdir(), "crb-port-"));
	const dir = opts.worktree ?? join(tmp ?? "", "tree");
	await must(io, "git", [
		"worktree",
		"add",
		...(opts.keep ? ["-b", opts.keep] : ["--detach"]),
		dir,
		master,
	]);
	try {
		// A trial (nothing kept) commits under a placeholder name: it works
		// with no git identity set up. The port branch's picks are the
		// configured identity's (release-finish's bot).
		const who = opts.keep
			? []
			: ["-c", "user.name=crb release", "-c", "user.email=release@invalid"];
		for (const item of missing) {
			const r = await io.run(
				"git",
				[
					...who,
					"cherry-pick",
					"-x",
					...(item.merge ? ["-m", "1"] : []),
					item.sha,
				],
				{ cwd: dir },
			);
			item.applies = r.code === 0;
			if (!item.applies) {
				await io.run("git", ["cherry-pick", "--abort"], { cwd: dir });
				// A conflict is an answer; any other failure is not.
				if (!/could not apply|conflict/i.test(r.stderr + r.stdout)) {
					throw new Error(
						`git cherry-pick ${item.sha} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
					);
				}
			}
		}
	} finally {
		if (!opts.keep) {
			await io.run("git", ["worktree", "remove", "--force", dir]);
		}
		if (tmp && !opts.keep) rmSync(tmp, { recursive: true, force: true });
	}
	return missing.map(({ merge: _, ...item }) => item);
}

/** The port PR's title and body (markdown, every git-sourced text escaped). */
export function portPr(
	version: string,
	items: readonly PortItem[],
): { title: string; body: string } {
	const ported = items.filter((i) => i.applies);
	const conflicts = items.filter((i) => !i.applies);
	const tickets = [
		...new Set(ported.flatMap((i) => (i.ticket ? [i.ticket] : []))),
	];
	const title = `Hotfix ${version} to master${tickets.length ? ` (${tickets.join(", ")})` : ""}`;
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
				`hotfix:  ${tag}: master lacks ${missing.map((m) => `#${m.pr}${m.ticket ? ` (${m.ticket})` : ""}${m.applies ? "" : " (conflicts)"}`).join(", ")}: merge its port PR (hotfix-port/${formatVersion(v)}), or port by hand`,
			);
		}
	} catch (error) {
		io.log(`hotfix:  unknown (${(error as Error).message})`);
	}
}
