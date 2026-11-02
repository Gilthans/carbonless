import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Version math and the steps behind `pnpm release` and the publish-rc and
// promote workflows (docs/releasing.md). Everything that touches git, gh or
// npm goes through a Runner, so tests drive it with no network.

export const PACKAGE = "carbonless-review";
export const DEFAULT_REPO = "Gilthans/carbonless";

export type Kind = "patch" | "minor" | "major";
export const KINDS: readonly Kind[] = ["patch", "minor", "major"];

/** A release `X.Y.Z` (rc undefined) or a release candidate `X.Y.Z-rc.N`. */
export type Version = {
	major: number;
	minor: number;
	patch: number;
	rc?: number;
};

const NUM = "(0|[1-9]\\d*)";
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-rc\\.${NUM})?$`);

/** `X.Y.Z` or `X.Y.Z-rc.N`; anything else (other prereleases too) is null. */
export function parseVersion(text: string): Version | null {
	const m = VERSION.exec(text.trim());
	if (!m) return null;
	const v: Version = {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
	};
	if (m[4] !== undefined) v.rc = Number(m[4]);
	return v;
}

/** `vX.Y.Z` or `vX.Y.Z-rc.N` (a ref's `refs/tags/` prefix is fine). */
export function parseTag(tag: string): Version | null {
	const name = tag.trim().replace(/^refs\/tags\//, "");
	return name.startsWith("v") ? parseVersion(name.slice(1)) : null;
}

export function formatVersion(v: Version): string {
	const base = `${v.major}.${v.minor}.${v.patch}`;
	return v.rc === undefined ? base : `${base}-rc.${v.rc}`;
}

export const tagOf = (v: Version) => `v${formatVersion(v)}`;

/** The release an RC is a candidate for: `X.Y.Z-rc.N` -> `X.Y.Z`. */
export const releaseOf = (v: Version): Version => ({
	major: v.major,
	minor: v.minor,
	patch: v.patch,
});

/** Semver order: an RC comes before its release, rc.2 before rc.10. */
export function compareVersions(a: Version, b: Version): number {
	return (
		a.major - b.major ||
		a.minor - b.minor ||
		a.patch - b.patch ||
		(a.rc ?? Number.POSITIVE_INFINITY) - (b.rc ?? Number.POSITIVE_INFINITY) ||
		0
	);
}

const sameRelease = (a: Version, b: Version) =>
	a.major === b.major && a.minor === b.minor && a.patch === b.patch;

/**
 * The next RC of `next` (a release `X.Y.Z`, master's package.json version):
 * one past the highest `X.Y.Z-rc.N` among the git tags and the versions on
 * npm (a version npm has seen can't be published again, even if its tag is
 * gone), so the interim RCs' numbers are never reused.
 */
export function nextRc(
	next: Version,
	tags: readonly string[],
	npmVersions: readonly string[],
): Version {
	if (next.rc !== undefined) {
		throw new Error(
			`package.json's version must be the next release X.Y.Z, not an RC: ${formatVersion(next)}`,
		);
	}
	let highest = 0;
	const seen = [
		...tags.map(parseTag),
		...npmVersions.map((v) => parseVersion(v)),
	];
	for (const v of seen) {
		if (v?.rc !== undefined && sameRelease(v, next)) {
			highest = Math.max(highest, v.rc);
		}
	}
	return { ...releaseOf(next), rc: highest + 1 };
}

/** `X.Y.Z` bumped: patch `X.Y.Z+1`, minor `X.Y+1.0`, major `X+1.0.0`. */
export function bump(v: Version, kind: Kind): Version {
	switch (kind) {
		case "major":
			return { major: v.major + 1, minor: 0, patch: 0 };
		case "minor":
			return { major: v.major, minor: v.minor + 1, patch: 0 };
		case "patch":
			return { major: v.major, minor: v.minor, patch: v.patch + 1 };
	}
}

/** The newest of the tags that parse, RCs (`rc: true`) or releases only. */
export function newestTag(
	tags: readonly string[],
	rc: boolean,
): { tag: string; version: Version } | null {
	let best: { tag: string; version: Version } | null = null;
	for (const raw of tags) {
		const version = parseTag(raw);
		if (!version || (version.rc !== undefined) !== rc) continue;
		if (!best || compareVersions(version, best.version) > 0) {
			best = { tag: tagOf(version), version };
		}
	}
	return best;
}

/** The newest release tag before `v`, the one a changelog starts after. */
export function previousRelease(
	tags: readonly string[],
	v: Version,
): string | null {
	const before = tags
		.map(parseTag)
		.filter(
			(t): t is Version =>
				t !== null && t.rc === undefined && compareVersions(t, v) < 0,
		)
		.sort(compareVersions);
	const last = before.at(-1);
	return last ? tagOf(last) : null;
}

/** Tag names from `git ls-remote --tags` or `git tag -l` output. */
export function tagNames(output: string): string[] {
	return output
		.split("\n")
		.map((line) => line.trim().split(/\s+/).at(-1) ?? "")
		.filter((ref) => ref !== "")
		.map((ref) => ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, ""));
}

export type MergedPr = { number: number; title: string; mergedAt: string };

/**
 * docs/changelog.md with the section for `version` (dated `date`) on top,
 * replacing an older section of that version (a promote run again).
 */
export function renderChangelog(
	existing: string | null,
	version: string,
	date: string,
	prs: readonly MergedPr[],
): string {
	const heading = `## ${version} (${date})`;
	const items = [...prs]
		.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number)
		.map((pr) => `- ${pr.title.trim()} (#${pr.number})`);
	const section = [heading, "", ...(items.length ? items : ["- No PRs."])].join(
		"\n",
	);
	const sections = (existing ?? "")
		.replace(/^# Changelog\s*/, "")
		.split(/^(?=## )/m)
		.map((s) => s.trim())
		.filter((s) => s !== "" && !s.startsWith(`## ${version} (`));
	return `# Changelog\n\n${[section, ...sections].join("\n\n")}\n`;
}

/** package.json's text with `version` replaced, its formatting kept. */
export function withVersion(packageJson: string, version: string): string {
	const re = /^(\t"version": )"[^"]*"/m;
	if (!re.test(packageJson)) {
		throw new Error('package.json has no top-level "version" line');
	}
	return packageJson.replace(re, `$1"${version}"`);
}

// ---------------------------------------------------------------------------
// Commands, over an injected runner.

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (
	cmd: string,
	args: readonly string[],
	opts?: { cwd?: string },
) => Promise<RunResult>;

export type Io = {
	run: Runner;
	/**
	 * Where tags come from: origin (`git ls-remote`, for people) or the
	 * checkout's own (the workflows: a full-history checkout has every tag,
	 * and steps that run dependency code get no token to reach origin).
	 */
	tags?: "origin" | "local";
	log: (line: string) => void;
	repo: string;
	now: () => Date;
	sleep: (ms: number) => Promise<void>;
};

async function must(
	io: Io,
	cmd: string,
	args: readonly string[],
	opts?: { cwd?: string },
): Promise<string> {
	const r = await io.run(cmd, args, opts);
	if (r.code !== 0) {
		throw new Error(
			`${cmd} ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
		);
	}
	return r.stdout;
}

/** The tags on GitHub: origin's, without fetching, or the checkout's (Io.tags). */
export async function remoteTags(io: Io): Promise<string[]> {
	if (io.tags === "local") {
		return tagNames(await must(io, "git", ["tag", "-l", "v*"]));
	}
	return tagNames(
		await must(io, "git", ["ls-remote", "--tags", "--refs", "origin", "v*"]),
	);
}

export type NpmState = {
	distTags: Record<string, string>;
	versions: string[];
} | null;

/** The package's dist-tags and versions on npm; null before its first publish. */
export async function npmState(io: Io): Promise<NpmState> {
	const r = await io.run("npm", [
		"view",
		PACKAGE,
		"dist-tags",
		"versions",
		"--json",
		// Fresh from the registry, not npm's cache: a publish may have just happened.
		"--prefer-online",
	]);
	if (r.code !== 0) {
		if (/E404|404 Not Found/.test(r.stderr + r.stdout)) return null;
		throw new Error(`npm view ${PACKAGE} failed: ${r.stderr.trim()}`);
	}
	const data = JSON.parse(r.stdout) as {
		"dist-tags"?: Record<string, string>;
		versions?: string[] | string;
	};
	const versions = data.versions ?? [];
	return {
		distTags: data["dist-tags"] ?? {},
		versions: Array.isArray(versions) ? versions : [versions],
	};
}

/** master's package.json version on GitHub. */
export async function masterVersion(io: Io): Promise<string> {
	const content = await must(io, "gh", [
		"api",
		`repos/${io.repo}/contents/package.json?ref=master`,
		"--jq",
		".content",
	]);
	const json = JSON.parse(Buffer.from(content, "base64").toString("utf8")) as {
		version: string;
	};
	return json.version;
}

/** `pnpm release status`. */
export async function status(io: Io): Promise<void> {
	const [next, tags, npm] = await Promise.all([
		masterVersion(io),
		remoteTags(io),
		npmState(io),
	]);
	const rcTag = newestTag(tags, true)?.tag ?? "none";
	const releaseTag = newestTag(tags, false)?.tag ?? "none";
	const nextVersion = parseVersion(next);
	io.log(`master:  next release ${next}`);
	io.log(`rc:      npm ${npm?.distTags.rc ?? "none"}, newest tag ${rcTag}`);
	io.log(
		`latest:  npm ${npm?.distTags.latest ?? "none"}, newest tag ${releaseTag}`,
	);
	if (!npm) io.log(`npm:     ${PACKAGE} is not published yet`);
	if (nextVersion && nextVersion.rc === undefined) {
		// What publish-rc will do, by the same logic (master's history from
		// the local origin/master: the interim RCs are old enough for it).
		const plan = await rcToPublish(io, next, "origin/master");
		if (plan.blocked) {
			io.log(`next merge to master publishes nothing: ${plan.blocked}`);
		} else if (plan.firstPublish) {
			io.log(
				`next merge to master tags v${plan.version} only: ${PACKAGE} is not on npm yet, its first version is a release (pnpm release promote v${plan.version})`,
			);
		} else {
			io.log(`next merge to master publishes ${plan.version} on rc`);
		}
	} else {
		io.log(`warning: master's version ${next} is not a release X.Y.Z`);
	}
}

const RUN_URL = /https:\/\/github\.com\/\S+\/actions\/runs\/\d+/;

/** `pnpm release promote [<rc tag>] [--next kind]`. */
export async function promote(
	io: Io,
	rcTag: string | undefined,
	next: Kind,
): Promise<string> {
	const tags = await remoteTags(io);
	const tag = rcTag ?? newestTag(tags, true)?.tag;
	if (!tag) throw new Error("no v*-rc.* tag on origin to promote");
	const version = parseTag(tag);
	if (!version || version.rc === undefined) {
		throw new Error(`not an RC tag (vX.Y.Z-rc.N): ${tag}`);
	}
	if (!tags.includes(tag)) throw new Error(`${tag} is not on origin`);
	const release = tagOf(releaseOf(version));
	if (tags.includes(release)) {
		throw new Error(`${release} is already released`);
	}
	const started = io.now().getTime();
	const out = await must(io, "gh", [
		"workflow",
		"run",
		"promote.yml",
		"--repo",
		io.repo,
		"--ref",
		"master",
		"-f",
		`rc=${tag}`,
		"-f",
		`next=${next}`,
	]);
	io.log(
		`Promoting ${tag}: checks and packs ${release}; then the owner runs pnpm release publish (npm OTP)`,
	);
	let url = RUN_URL.exec(out)?.[0];
	for (let i = 0; !url && i < 20; i++) {
		await io.sleep(1500);
		const runs = JSON.parse(
			await must(io, "gh", [
				"run",
				"list",
				"--repo",
				io.repo,
				"--workflow",
				"promote.yml",
				"--event",
				"workflow_dispatch",
				"--limit",
				"5",
				"--json",
				"url,createdAt",
			]),
		) as { url: string; createdAt: string }[];
		// GitHub's clock and ours may differ a little.
		url = runs.find((r) => Date.parse(r.createdAt) >= started - 30_000)?.url;
	}
	const shown =
		url ?? `https://github.com/${io.repo}/actions/workflows/promote.yml`;
	io.log(shown);
	return shown;
}

/**
 * `pnpm release next <kind | X.Y.Z>`: a branch from origin/master whose only
 * change is package.json's version, pushed, and a PR for it. A kind bumps the
 * newest release (patch after 0.2.0 is 0.2.1).
 */
export async function next(
	io: Io,
	what: string,
	worktree: string,
): Promise<string> {
	const tags = await remoteTags(io);
	let target: Version | null;
	if ((KINDS as readonly string[]).includes(what)) {
		const released = newestTag(tags, false);
		if (!released) {
			throw new Error(
				`nothing is released yet: give the version (pnpm release next X.Y.Z)`,
			);
		}
		target = bump(released.version, what as Kind);
	} else {
		target = parseVersion(what);
		if (!target || target.rc !== undefined) {
			throw new Error(`not patch, minor, major or X.Y.Z: ${what}`);
		}
	}
	const released = newestTag(tags, false);
	if (released && compareVersions(target, released.version) <= 0) {
		throw new Error(
			`${formatVersion(target)} is not after the newest release ${released.tag}`,
		);
	}
	const version = formatVersion(target);
	const current = await masterVersion(io);
	if (current === version) throw new Error(`master is already at ${version}`);
	const branch = `next/${version}`;
	await must(io, "git", ["fetch", "origin", "master"]);
	await must(io, "git", [
		"worktree",
		"add",
		"-b",
		branch,
		worktree,
		"origin/master",
	]);
	try {
		const pkg = join(worktree, "package.json");
		writeFileSync(pkg, withVersion(readFileSync(pkg, "utf8"), version));
		const message = `next: ${version}\n\nThe next release is ${version} (was ${current}): merges to master publish ${version}-rc.N.`;
		await must(
			io,
			"git",
			["commit", "--only", "-m", message, "--", "package.json"],
			{ cwd: worktree },
		);
		await must(io, "git", ["push", "-u", "origin", branch], { cwd: worktree });
		const url = (
			await must(
				io,
				"gh",
				[
					"pr",
					"create",
					"--repo",
					io.repo,
					"--base",
					"master",
					"--head",
					branch,
					"--title",
					`next: ${version}`,
					"--body",
					`The next release becomes ${version} (was ${current}); after this merges, master's RCs are ${version}-rc.N.`,
				],
				{ cwd: worktree },
			)
		).trim();
		io.log(url);
		return url;
	} finally {
		await io.run("git", ["worktree", "remove", "--force", worktree]);
		// Pushed (or failed): a local branch left behind would only block a retry.
		await io.run("git", ["branch", "-D", branch]);
	}
}

// ---------------------------------------------------------------------------
// Steps the workflows run (.github/workflows/publish-rc.yml, promote.yml).

/**
 * What a push to master publishes: the next RC of package.json's `X.Y.Z`.
 * `firstPublish` when the package isn't on npm yet: its first version must
 * be a release, or npm makes the RC `latest` (docs/releasing.md).
 * `blocked` (a reason) when `X.Y.Z` is released already (its tag or its npm
 * version exists): until the "next" PR moves master on, an RC of it would
 * sort before the release and move `rc` backwards.
 */
/**
 * The versions package.json has had in this checkout's history. Before the
 * switch to CI-published RCs, interim RCs were set there by hand (0.1.0-rc.2
 * to rc.4 on master, their tags local only): their numbers count as used, so
 * no CI-published RC repeats one. Nothing when git can't say.
 */
export async function historyVersions(io: Io, ref = "HEAD"): Promise<string[]> {
	// A shallow history would undercount, and reuse a number.
	const shallow = await must(io, "git", [
		"rev-parse",
		"--is-shallow-repository",
	]);
	if (shallow.trim() === "true") {
		throw new Error(
			"the checkout is shallow: package.json's history needs it all (fetch-depth: 0)",
		);
	}
	const log = await must(io, "git", [
		"log",
		"-p",
		"--format=",
		ref,
		"--",
		"package.json",
	]);
	return [...log.matchAll(/^[+-]\s*"version":\s*"([^"]+)"/gm)].flatMap((m) =>
		m[1] ? [m[1]] : [],
	);
}

/**
 * What a push of master with this package.json version publishes: the next
 * RC, whether it only tags (npm has no carbonless-review yet: its first
 * version must be a release), or why nothing (blocked). publish-rc runs it
 * on the pushed commit (history `HEAD`); `pnpm release status` on
 * `origin/master`.
 */
export async function rcToPublish(
	io: Io,
	packageVersion: string,
	historyRef = "HEAD",
): Promise<{ version: string; firstPublish: boolean; blocked: string | null }> {
	const next = parseVersion(packageVersion);
	if (!next || next.rc !== undefined) {
		throw new Error(
			`package.json's version must be the next release X.Y.Z: ${packageVersion}`,
		);
	}
	const [tags, npm, history] = await Promise.all([
		remoteTags(io),
		npmState(io),
		historyVersions(io, historyRef),
	]);
	const release = formatVersion(next);
	const released =
		tags.includes(tagOf(next)) || (npm?.versions.includes(release) ?? false);
	return {
		version: formatVersion(
			nextRc(next, tags, [...(npm?.versions ?? []), ...history]),
		),
		firstPublish: npm === null,
		blocked: released
			? `${release} is released and master's version is still ${release}: merge the "next" PR first; no RC is published until then`
			: null,
	};
}

/**
 * The version npm's `rc` should move to so it is never behind `latest` (main
 * follows `rc`), or null. Both workflows run this after publishing, so a
 * promote and an RC publish racing each other end with `rc` on the newer.
 *
 * `published` is what this run just published (promote: the release;
 * publish-rc: its RC, if any). The read can be stale (a CDN may still serve
 * the packument from before, even a 404 right after the first publish), so
 * the floor is the newer of `published` and the `latest` read, and `rc` is
 * never moved below `published`: a read that misses this run's own RC can't
 * move `rc` back past it.
 */
export function rcBehindLatest(
	npm: NpmState,
	published?: string,
): string | null {
	const candidates = [
		parseVersion(published ?? ""),
		parseVersion(npm?.distTags.latest ?? ""),
	].filter((v): v is Version => v !== null);
	const floor = candidates.sort(compareVersions).at(-1);
	if (!floor) return null;
	const rc = parseVersion(npm?.distTags.rc ?? "");
	return !rc || compareVersions(rc, floor) < 0 ? formatVersion(floor) : null;
}

/**
 * Whether the tag's commit is in master's history: the workflows ask the
 * checkout (master, full history), people ask GitHub (no fetch).
 */
async function onMaster(io: Io, tag: string): Promise<boolean> {
	if (io.tags === "local") {
		const r = await io.run("git", [
			"merge-base",
			"--is-ancestor",
			`refs/tags/${tag}^{commit}`,
			"HEAD",
		]);
		if (r.code === 0 || r.code === 1) return r.code === 0;
		throw new Error(`git merge-base failed: ${r.stderr.trim()}`);
	}
	const status = await must(io, "gh", [
		"api",
		`repos/${io.repo}/compare/${tag}...master`,
		"--jq",
		".status",
	]);
	// master is ahead of the tag, or at it.
	return ["ahead", "identical"].includes(status.trim());
}

/** The version a publish step may publish under `rc`: `X.Y.Z-rc.N`, nothing else. */
export function checkRcPublish(version: string, tag: string): void {
	if (tag !== "rc")
		throw new Error(`publish-rc publishes to rc only, not ${tag}`);
	const v = parseVersion(version);
	if (!v || v.rc === undefined || formatVersion(v) !== version) {
		throw new Error(`refusing to publish ${version} to rc: not X.Y.Z-rc.N`);
	}
}

/** package.json's text with `"gitHead": "<sha>"` after its version. */
export function withGitHead(packageJson: string, sha: string): string {
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit: ${sha}`);
	const without = packageJson.replace(/^\t"gitHead": "[^"]*",?\n/m, "");
	const re = /^(\t"version": "[^"]*")(,?)\n/m;
	if (!re.test(without)) {
		throw new Error('package.json has no top-level "version" line');
	}
	return without.replace(re, `$1,\n\t"gitHead": "${sha}"$2\n`);
}

/**
 * The RC tag a promote checks (`given`, else the newest on origin) and the
 * release it becomes.
 */
export async function resolvePromote(
	io: Io,
	given: string,
): Promise<{ tag: string; release: string }> {
	const tags = await remoteTags(io);
	const tag = given.trim() || newestTag(tags, true)?.tag;
	if (!tag) throw new Error("no v*-rc.* tag on origin to promote");
	const version = parseTag(tag);
	if (!version || version.rc === undefined) {
		throw new Error(`not an RC tag (vX.Y.Z-rc.N): ${tag}`);
	}
	if (!tags.includes(tag)) throw new Error(`${tag} is not on origin`);
	if (!(await onMaster(io, tag))) {
		throw new Error(
			`${tag} is not on master: only an RC of a master commit can be released`,
		);
	}
	const release = releaseOf(version);
	const npm = await npmState(io);
	if (
		tags.includes(tagOf(release)) ||
		npm?.versions.includes(formatVersion(release))
	) {
		throw new Error(`${formatVersion(release)} is already released`);
	}
	// `npm publish --tag latest` would move latest backwards.
	const latest = parseVersion(npm?.distTags.latest ?? "");
	if (latest && compareVersions(release, latest) <= 0) {
		throw new Error(
			`${formatVersion(release)} is not newer than latest (${formatVersion(latest)})`,
		);
	}
	return { tag, release: formatVersion(release) };
}

/**
 * The PRs merged into master that `to` (the promoted RC's commit) has and
 * the previous release's tag doesn't, by ancestry of each PR's merge commit
 * (a merge, squash or rebase merge all leave theirs on master).
 */
export async function releasePrs(
	io: Io,
	version: string,
	to: string,
	cwd: string,
): Promise<MergedPr[]> {
	const v = parseVersion(version);
	if (!v || v.rc !== undefined) throw new Error(`not a release: ${version}`);
	const prev = previousRelease(await remoteTags(io), v);
	const prs = JSON.parse(
		await must(io, "gh", [
			"pr",
			"list",
			"--repo",
			io.repo,
			"--state",
			"merged",
			"--base",
			"master",
			"--limit",
			"1000",
			"--json",
			"number,title,mergedAt,mergeCommit",
		]),
	) as (MergedPr & { mergeCommit: { oid: string } | null })[];
	const isAncestor = async (sha: string, ref: string) =>
		(await io.run("git", ["merge-base", "--is-ancestor", sha, ref], { cwd }))
			.code === 0;
	const picked: MergedPr[] = [];
	for (const pr of prs) {
		const sha = pr.mergeCommit?.oid;
		if (!sha || !(await isAncestor(sha, to))) continue;
		if (prev && (await isAncestor(sha, prev))) continue;
		picked.push({ number: pr.number, title: pr.title, mergedAt: pr.mergedAt });
	}
	return picked;
}

// ---------------------------------------------------------------------------
// Releasing: promote (CI) checks and packs, the owner publishes with npm's
// two-factor OTP (`pnpm release publish`), release-finish (CI) tags, moves
// rc and opens the next PR. Every step can run again.

/** What promote's check job made: the tarball and what it must be. */
export type Manifest = {
	version: string; // X.Y.Z
	tag: string; // the RC tag it was built from
	sha: string; // that tag's commit
	sha256: string; // hex, of the tarball
	integrity: string; // sha512-<base64>, as npm records it
	next: Kind; // the bump of the "next" PR
	tarball: string; // its file name in the artifact
};

/** promote's manifest.json, checked field by field. */
export function parseManifest(text: string): Manifest {
	const m = JSON.parse(text) as Partial<Manifest>;
	const version = parseVersion(m.version ?? "");
	const tag = parseTag(m.tag ?? "");
	if (
		!version ||
		version.rc !== undefined ||
		formatVersion(version) !== m.version ||
		!tag ||
		tag.rc === undefined ||
		formatVersion(releaseOf(tag)) !== m.version ||
		!/^[0-9a-f]{40}$/.test(m.sha ?? "") ||
		!/^[0-9a-f]{64}$/.test(m.sha256 ?? "") ||
		!/^sha512-[A-Za-z0-9+/]+=*$/.test(m.integrity ?? "") ||
		!(KINDS as readonly string[]).includes(m.next ?? "") ||
		m.tarball !== `${PACKAGE}-${m.version}.tgz`
	) {
		throw new Error(`not a promote manifest: ${text.trim()}`);
	}
	return m as Manifest;
}

/** A tarball's sha256 (hex) and npm integrity (sha512, base64). */
export function tarballDigests(data: Buffer): {
	sha256: string;
	integrity: string;
} {
	return {
		sha256: createHash("sha256").update(data).digest("hex"),
		integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
	};
}

/** The integrity npm has for `version`, or null when npm doesn't have it. */
export async function publishedIntegrity(
	io: Io,
	version: string,
): Promise<string | null> {
	const r = await io.run("npm", [
		"view",
		`${PACKAGE}@${version}`,
		"dist.integrity",
		"--prefer-online",
	]);
	if (r.code !== 0) {
		if (/E404|404 Not Found/.test(r.stderr + r.stdout)) return null;
		throw new Error(
			`npm view ${PACKAGE}@${version} failed: ${r.stderr.trim()}`,
		);
	}
	return r.stdout.trim() || null;
}

/**
 * Whether npm needs this tarball published: false when npm already has the
 * version with this very tarball (a publish that ran before), an error when
 * npm has it with another one.
 */
export async function needsPublish(io: Io, m: Manifest): Promise<boolean> {
	const published = await publishedIntegrity(io, m.version);
	if (published === null) return true;
	if (published === m.integrity) return false;
	throw new Error(
		`${PACKAGE}@${m.version} is already on npm with another tarball (${published}, not ${m.integrity}): it can't be published again`,
	);
}

export type PublishIo = Io & {
	/** Asks the person a yes/no question; true only on yes. */
	ask: (question: string) => Promise<boolean>;
	/** Runs a command on the person's terminal (npm asks for the OTP there). */
	interactive: (cmd: string, args: readonly string[]) => Promise<number>;
};

/**
 * The tarball of a promote run, checked: its sha256 and integrity are the
 * manifest's, its build-info is the release's version at the RC tag's
 * commit, that tag points there on GitHub, and the commit is on master.
 */
export async function checkedRelease(
	io: Io,
	dir: string,
): Promise<{ manifest: Manifest; tarball: string }> {
	const manifest = parseManifest(
		readFileSync(join(dir, "manifest.json"), "utf8"),
	);
	const tarball = join(dir, manifest.tarball);
	const digests = tarballDigests(readFileSync(tarball));
	if (
		digests.sha256 !== manifest.sha256 ||
		digests.integrity !== manifest.integrity
	) {
		throw new Error(
			`${manifest.tarball}'s sha256 is ${digests.sha256}, the manifest says ${manifest.sha256}: not the tarball promote checked`,
		);
	}
	const info = JSON.parse(
		await must(io, "tar", ["-xzOf", tarball, "package/dist/build-info.json"]),
	) as { version?: string; commit?: string };
	if (info.version !== manifest.version || info.commit !== manifest.sha) {
		throw new Error(
			`the tarball's build-info is ${info.version} ${info.commit}, not ${manifest.version} ${manifest.sha}`,
		);
	}
	const tagSha = await tagCommit(io, manifest.tag);
	if (tagSha !== manifest.sha) {
		throw new Error(
			`${manifest.tag} is at ${tagSha} on GitHub, not ${manifest.sha} (the commit promote built)`,
		);
	}
	if (!(await onMaster({ ...io, tags: "origin" }, manifest.tag))) {
		throw new Error(`${manifest.tag} is not on master`);
	}
	return { manifest, tarball };
}

/** The commit a tag points at on GitHub, exactly (a branch of that name doesn't count). */
async function tagCommit(io: Io, tag: string): Promise<string> {
	const ref = JSON.parse(
		await must(io, "gh", [
			"api",
			`repos/${io.repo}/git/ref/tags/${tag}`,
			"--jq",
			".object",
		]),
	) as { sha?: string; type?: string };
	if (ref.type === "commit") return ref.sha ?? "";
	if (ref.type === "tag") {
		// An annotated tag: its object.
		return (
			await must(io, "gh", [
				"api",
				`repos/${io.repo}/git/tags/${ref.sha}`,
				"--jq",
				".object.sha",
			])
		).trim();
	}
	throw new Error(`${tag} is not a tag of a commit on GitHub`);
}

/**
 * Fails unless the run is a successful promote of master, dispatched: the
 * only runs whose artifact is what promote checked.
 */
export async function checkPromoteRun(io: Io, run: string): Promise<void> {
	if (!/^\d+$/.test(run)) throw new Error(`not a run id: ${run}`);
	const r = JSON.parse(
		await must(io, "gh", [
			"api",
			`repos/${io.repo}/actions/runs/${run}`,
			"--jq",
			"{path, head_branch, event, conclusion}",
		]),
	) as {
		path?: string;
		head_branch?: string;
		event?: string;
		conclusion?: string;
	};
	const wrong = [
		r.path === ".github/workflows/promote.yml" ? "" : `workflow ${r.path}`,
		r.head_branch === "master" ? "" : `branch ${r.head_branch}`,
		r.event === "workflow_dispatch" ? "" : `event ${r.event}`,
		r.conclusion === "success" ? "" : `conclusion ${r.conclusion}`,
	].filter(Boolean);
	if (wrong.length > 0) {
		throw new Error(
			`run ${run} is not a successful promote of master (${wrong.join(", ")})`,
		);
	}
}

/**
 * Waits until npm shows `version` (the registry may lag a publish), every
 * 15 s for up to 5 min: "match" when it has this integrity, "missing" when it
 * never showed; an error when npm has another tarball.
 */
export async function waitForIntegrity(
	io: Io,
	version: string,
	integrity: string,
	tries = 21,
): Promise<"match" | "missing"> {
	for (let i = 0; i < tries; i++) {
		if (i > 0) await io.sleep(15_000);
		const published = await publishedIntegrity(io, version);
		if (published === integrity) return "match";
		if (published !== null) {
			throw new Error(
				`${PACKAGE}@${version} on npm is another tarball (${published}, not ${integrity})`,
			);
		}
	}
	return "missing";
}

/**
 * Fails unless the checkout `pnpm release publish` runs from is clean and
 * its release code and package.json are origin/master's: the OTP approves
 * whatever this code publishes.
 */
async function checkPublishingCheckout(io: Io): Promise<void> {
	const dirty = await must(io, "git", ["status", "--porcelain"]);
	if (dirty.trim() !== "") {
		throw new Error(
			"run pnpm release publish from a clean checkout of origin/master (this one has changes)",
		);
	}
	const diff = await io.run("git", [
		"diff",
		"--quiet",
		"origin/master",
		"--",
		"scripts/release*.ts",
		"package.json",
	]);
	if (diff.code !== 0) {
		throw new Error(
			"run pnpm release publish from origin/master's code: scripts/release*.ts or package.json differ from origin/master here (git fetch, then check out origin/master)",
		);
	}
}

/** The newest successful promote run's id. */
async function newestPromoteRun(io: Io): Promise<string> {
	const runs = JSON.parse(
		await must(io, "gh", [
			"run",
			"list",
			"--repo",
			io.repo,
			"--workflow",
			"promote.yml",
			"--branch",
			"master",
			"--event",
			"workflow_dispatch",
			"--status",
			"success",
			"--limit",
			"1",
			"--json",
			"databaseId",
		]),
	) as { databaseId: number }[];
	const id = runs[0]?.databaseId;
	if (!id)
		throw new Error("no successful promote run: pnpm release promote first");
	return String(id);
}

/**
 * `pnpm release publish [<run-id>]`: the owner publishes a promote run's
 * tarball to npm's latest with their own login (npm asks for the OTP), then
 * starts release-finish. Safe to run again: a version npm already has with
 * this tarball isn't published twice.
 */
export async function publishRelease(
	io: PublishIo,
	runId?: string,
): Promise<void> {
	if (runId !== undefined && !/^\d+$/.test(runId)) {
		throw new Error(`not a run id: ${runId}`);
	}
	await checkPublishingCheckout(io);
	const run = runId ?? (await newestPromoteRun(io));
	await checkPromoteRun(io, run);
	const dir = mkdtempSync(join(tmpdir(), "crb-publish-"));
	try {
		await must(io, "gh", [
			"run",
			"download",
			run,
			"--repo",
			io.repo,
			"--name",
			"release",
			"--dir",
			dir,
		]);
		const { manifest, tarball } = await checkedRelease(io, dir);
		const publish = await needsPublish(io, manifest);
		const latest = (await npmState(io))?.distTags.latest;
		const latestV = parseVersion(latest ?? "");
		const releaseV = parseVersion(manifest.version);
		if (
			publish &&
			latestV &&
			releaseV &&
			compareVersions(releaseV, latestV) <= 0
		) {
			throw new Error(
				`${manifest.version} is not newer than latest (${latest})`,
			);
		}
		io.log(
			`Release ${manifest.version} from ${manifest.tag} (${manifest.sha})`,
		);
		io.log(
			`  promote run ${run}, ${manifest.tarball}, sha256 ${manifest.sha256}`,
		);
		io.log(
			publish
				? `  npm: publish to latest (now ${latest ?? "nothing"}); npm asks for your OTP`
				: `  npm: already has ${manifest.version} with this tarball, not published again`,
		);
		io.log(
			`  then release-finish: tag v${manifest.version}, rc, changelog, "next: ${manifest.next}" PR`,
		);
		if (!(await io.ask(`Go on? [y/N] `))) {
			io.log("Nothing done.");
			return;
		}
		if (publish) {
			// The tarball again, right before publishing: not swapped meanwhile.
			const now = tarballDigests(readFileSync(tarball));
			if (
				now.sha256 !== manifest.sha256 ||
				now.integrity !== manifest.integrity
			) {
				throw new Error(
					`${manifest.tarball} changed after it was checked (sha256 ${now.sha256}): not publishing`,
				);
			}
			const code = await io.interactive("npm", [
				"publish",
				tarball,
				"--tag",
				"latest",
				"--access",
				"public",
			]);
			if (
				code !== 0 &&
				(await waitForIntegrity(
					io,
					manifest.version,
					manifest.integrity,
					1,
				)) !== "match"
			) {
				throw new Error(
					`npm publish failed (${code}); nothing else was done: run pnpm release publish ${run} again`,
				);
			}
		}
		// release-finish checks npm has it: wait until npm shows it.
		if (
			(await waitForIntegrity(io, manifest.version, manifest.integrity)) !==
			"match"
		) {
			throw new Error(
				`npm doesn't show ${manifest.version} yet; once it does, start release-finish: gh workflow run release-finish.yml --repo ${io.repo} --ref master -f version=${manifest.version} -f run=${run}`,
			);
		}
		await must(io, "gh", [
			"workflow",
			"run",
			"release-finish.yml",
			"--repo",
			io.repo,
			"--ref",
			"master",
			"-f",
			`version=${manifest.version}`,
			"-f",
			`run=${run}`,
		]);
		io.log(
			`Published ${manifest.version}; release-finish started: https://github.com/${io.repo}/actions/workflows/release-finish.yml`,
		);
		io.log(
			`If it fails, start it again (each step skips what is done): gh workflow run release-finish.yml --repo ${io.repo} --ref master -f version=${manifest.version} -f run=${run}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * What release-finish still has to do for a published release: whether to
 * push the tag (no when origin's tag already points at the RC's commit; an
 * error when it points elsewhere) and to open the next PR (no once master
 * has moved past the release). Fails unless npm has the version with the
 * manifest's tarball.
 */
export async function finishPlan(
	io: Io,
	version: string,
	m: Manifest,
	masterVersion: string,
): Promise<{ pushTag: boolean; nextPr: boolean }> {
	if (m.version !== version) {
		throw new Error(`the promote run released ${m.version}, not ${version}`);
	}
	// The manifest's tag and commit, checked here too: the tag is at that
	// commit, and the commit is on master (this checkout, full history).
	const rcTag = await io.run("git", [
		"rev-parse",
		"-q",
		"--verify",
		`refs/tags/${m.tag}^{commit}`,
	]);
	if (rcTag.code !== 0 || rcTag.stdout.trim() !== m.sha) {
		throw new Error(
			`${m.tag} is not at ${m.sha} here (${rcTag.stdout.trim() || "no such tag"})`,
		);
	}
	const ancestor = await io.run("git", [
		"merge-base",
		"--is-ancestor",
		m.sha,
		"HEAD",
	]);
	if (ancestor.code !== 0) throw new Error(`${m.sha} is not on master`);
	// The registry may lag the owner's publish.
	if ((await waitForIntegrity(io, version, m.integrity)) !== "match") {
		throw new Error(
			`npm doesn't show ${PACKAGE}@${version} yet: start release-finish again in a few minutes (or, if it was never published, pnpm release publish first)`,
		);
	}
	const tag = await io.run("git", [
		"rev-parse",
		"-q",
		"--verify",
		`refs/tags/v${version}^{commit}`,
	]);
	let pushTag = true;
	if (tag.code === 0) {
		if (tag.stdout.trim() !== m.sha) {
			throw new Error(`v${version} is at ${tag.stdout.trim()}, not ${m.sha}`);
		}
		pushTag = false;
	}
	return { pushTag, nextPr: masterVersion === version };
}
