import { readFileSync, writeFileSync } from "node:fs";
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

/** The tags on GitHub (origin), without fetching them. */
export async function remoteTags(io: Io): Promise<string[]> {
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
		const rc = nextRc(nextVersion, tags, npm?.versions ?? []);
		io.log(`next merge to master publishes ${formatVersion(rc)}`);
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
	io.log(`Promoting ${tag} to ${release} (then next: ${next})`);
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
	}
}

// ---------------------------------------------------------------------------
// Steps the workflows run (.github/workflows/publish-rc.yml, promote.yml).

/**
 * What a push to master publishes: the next RC of package.json's `X.Y.Z`.
 * `firstPublish` when the package isn't on npm yet: its first version must
 * be a release, or npm makes the RC `latest` (docs/releasing.md).
 */
export async function rcToPublish(
	io: Io,
	packageVersion: string,
): Promise<{ version: string; firstPublish: boolean }> {
	const next = parseVersion(packageVersion);
	if (!next || next.rc !== undefined) {
		throw new Error(
			`package.json's version must be the next release X.Y.Z: ${packageVersion}`,
		);
	}
	const [tags, npm] = await Promise.all([remoteTags(io), npmState(io)]);
	return {
		version: formatVersion(nextRc(next, tags, npm?.versions ?? [])),
		firstPublish: npm === null,
	};
}

/**
 * The RC tag a promote publishes (`given`, else the newest on origin), the
 * release it becomes, and whether npm's `rc` should move to that release
 * (when `rc` is missing or older, so main never runs behind `latest`).
 */
export async function resolvePromote(
	io: Io,
	given: string,
): Promise<{ tag: string; release: string; moveRc: boolean }> {
	const tags = await remoteTags(io);
	const tag = given.trim() || newestTag(tags, true)?.tag;
	if (!tag) throw new Error("no v*-rc.* tag on origin to promote");
	const version = parseTag(tag);
	if (!version || version.rc === undefined) {
		throw new Error(`not an RC tag (vX.Y.Z-rc.N): ${tag}`);
	}
	if (!tags.includes(tag)) throw new Error(`${tag} is not on origin`);
	const release = releaseOf(version);
	const npm = await npmState(io);
	if (
		tags.includes(tagOf(release)) ||
		npm?.versions.includes(formatVersion(release))
	) {
		throw new Error(`${formatVersion(release)} is already released`);
	}
	const rc = parseVersion(npm?.distTags.rc ?? "");
	return {
		tag,
		release: formatVersion(release),
		moveRc: !rc || compareVersions(rc, release) < 0,
	};
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
