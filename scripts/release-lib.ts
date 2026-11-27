import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseReleaseNotesFile,
	printable,
} from "../src/shared/releaseNotes.js";
import { rcMoveTo } from "./rc-fixup.mjs";
import { isReleased, releaseGate } from "./release-gate.mjs";
import type { PullForNotes } from "./release-notes.js";

// Version math and the steps behind `pnpm release` and the release and
// release-finish workflows (docs/releasing.md). Everything that touches git, gh or
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
const releaseOf = (v: Version): Version => ({
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

export async function must(
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
export async function remoteTags(io: Io, cwd?: string): Promise<string[]> {
	if (io.tags === "local") {
		return tagNames(
			await must(io, "git", ["tag", "-l", "v*"], cwd ? { cwd } : undefined),
		);
	}
	return tagNames(
		await must(io, "git", ["ls-remote", "--tags", "--refs", "origin", "v*"]),
	);
}

export type NpmState = {
	distTags: Record<string, string>;
	versions: string[];
} | null;

/**
 * `npm view <spec> <fields...> --json`, fresh from the registry
 * (`--prefer-online`, not npm's cache: a publish may have just happened),
 * parsed; null on a 404 (nothing published). The one reader of `npm view`
 * for status, publish and withdraw.
 */
export async function npmView(
	io: Io,
	spec: string,
	fields: readonly string[],
): Promise<unknown> {
	const r = await io.run("npm", [
		"view",
		spec,
		...fields,
		"--json",
		"--prefer-online",
	]);
	if (r.code !== 0) {
		if (/E404|404 Not Found/.test(r.stderr + r.stdout)) return null;
		throw new Error(`npm view ${spec} failed: ${r.stderr.trim()}`);
	}
	return r.stdout.trim() === "" ? undefined : (JSON.parse(r.stdout) as unknown);
}

/** The package's dist-tags and versions on npm; null before its first publish. */
export async function npmState(io: Io): Promise<NpmState> {
	const parsed = await npmView(io, PACKAGE, ["dist-tags", "versions"]);
	if (parsed === null) return null;
	// An object, or (npm 12, a package with a non-semver-ordered version
	// such as 0.0.0-stage) an array of one.
	const data = ((Array.isArray(parsed) ? parsed[0] : parsed) ?? {}) as Record<
		string,
		unknown
	>;
	const distTags: Record<string, string> = {};
	const tags = data["dist-tags"];
	if (typeof tags === "object" && tags !== null) {
		for (const [k, v] of Object.entries(tags)) {
			if (typeof v === "string") distTags[k] = v;
		}
	}
	const raw = data.versions ?? [];
	const versions = (Array.isArray(raw) ? raw : [raw]).filter(
		(v): v is string => typeof v === "string",
	);
	return { distTags, versions };
}

/** master's package.json version on GitHub. */
async function masterVersion(io: Io): Promise<string> {
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
		// What an RC run will do, by the same logic (master's history from
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
	const freeze = await freezeOf(io, next, tags, npm);
	if (freeze) io.log(`frozen:  ${freeze}`);
}

// ---------------------------------------------------------------------------
// The release freeze (CAR-191; docs/releasing.md, "The release freeze"):
// once master's X.Y.Z is released, only the "next" PR may merge. CI's
// release-gate job judges a PR with scripts/release-gate.mjs; these ask the
// same function for `pnpm release status` and `pnpm release merge-ok`.

/** The open PRs to master, every page. */
async function openPullsToMaster(io: Io): Promise<unknown> {
	return JSON.parse(
		await must(io, "gh", [
			"api",
			"--paginate",
			"--slurp",
			`repos/${io.repo}/pulls?state=open&base=master&per_page=100`,
		]),
	);
}

/** What to merge first while master is frozen ("merge #N next: X.Y.Z first"), else null. */
async function freezeOf(
	io: Io,
	version: string,
	tags: string[],
	npm: NpmState,
): Promise<string | null> {
	const v = parseVersion(version);
	if (!v || v.rc !== undefined) return null;
	if (!isReleased(version, tags, npm?.versions ?? [])) return null;
	const gate = releaseGate({
		version,
		tags,
		npmVersions: npm?.versions ?? [],
		pulls: await openPullsToMaster(io),
		repo: io.repo,
	});
	return gate.blocker;
}

/**
 * `pnpm release merge-ok <pr>`: fails, naming the "next" PR to merge first,
 * when master is frozen and `pr` isn't that PR. The agents' merge path
 * (`gh pr merge --admin` skips required checks) runs it before every merge.
 * Released counts npm's versions too, as the RC plan does. Then `notes`
 * (CAR-192: scripts/release-notes.ts, prNotesOk) checks the PR's release
 * notes, throwing when one is missing.
 */
export async function mergeOk(
	io: Io,
	pr: string,
	notes: (pull: PullForNotes) => Promise<string>,
): Promise<void> {
	const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(
		pr,
	);
	if (url && url[1]?.toLowerCase() !== io.repo.toLowerCase()) {
		throw new Error(`not a PR of ${io.repo}: ${pr}`);
	}
	const number = /^#?(\d+)$/.exec(pr)?.[1] ?? url?.[2];
	if (!number) throw new Error(`not a PR number or URL: ${pr}`);
	const [version, tags, npm, pull, pulls] = await Promise.all([
		masterVersion(io),
		remoteTags(io),
		npmState(io),
		must(io, "gh", ["api", `repos/${io.repo}/pulls/${number}`]),
		openPullsToMaster(io),
	]);
	const gate = releaseGate({
		version,
		tags,
		npmVersions: npm?.versions ?? [],
		pulls,
		repo: io.repo,
		pr: JSON.parse(pull),
	});
	if (!gate.ok) {
		throw new Error(
			`${gate.message}. Run pnpm release merge-ok ${number} again once it merges.`,
		);
	}
	const notesOk = await notes(JSON.parse(pull) as PullForNotes);
	io.log(`notes: ${notesOk}`);
	io.log(`ok: ${gate.message}`);
}

const RUN_URL = /https:\/\/github\.com\/\S+\/actions\/runs\/\d+/;

/**
 * `pnpm release promote [<rc tag>] [--next kind]`. `check` runs before the
 * dispatch (the release notes, CAR-192/CAR-242: promoteNotes) and throws to
 * stop it; what it returns, when not empty, is the run's `notes` input.
 */
export async function promote(
	io: Io,
	rcTag: string | undefined,
	next: Kind,
	check: (tag: string, release: string) => Promise<string | undefined>,
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
	const notes = await check(tag, formatVersion(releaseOf(version)));
	const started = io.now().getTime();
	const out = await must(io, "gh", [
		"workflow",
		"run",
		"release.yml",
		"--repo",
		io.repo,
		"--ref",
		"master",
		"-f",
		"mode=promote",
		"-f",
		`rc=${tag}`,
		"-f",
		`next=${next}`,
		...(notes ? ["-f", `notes=${notes}`] : []),
	]);
	io.log(
		`Promoting ${tag}: checks ${release}, packs and stages it on npm; then the owner approves it: pnpm release publish (npm OTP)`,
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
				"release.yml",
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
		url ?? `https://github.com/${io.repo}/actions/workflows/release.yml`;
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
// Steps the workflows run (.github/workflows/release.yml, release-finish.yml).

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
async function historyVersions(io: Io, ref = "HEAD"): Promise<string[]> {
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
 * version must be a release), or why nothing (blocked). The RC run does it
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
	// The same test as the release freeze's (scripts/release-gate.mjs).
	const released = isReleased(release, tags, npm?.versions ?? []);
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
 * an RC run: its RC, if any). The read can be stale (a CDN may still serve
 * the packument from before, even a 404 right after the first publish), so
 * the floor is the newer of `published` and the `latest` read, and `rc` is
 * never moved below `published`: a read that misses this run's own RC can't
 * move `rc` back past it.
 */
export function rcBehindLatest(
	npm: NpmState,
	published?: string,
): string | null {
	// The workflows run scripts/rc-fixup.mjs itself (no dependencies there).
	return rcMoveTo(npm?.distTags, published);
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
		throw new Error(`an RC run publishes to rc only, not ${tag}`);
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
	// npm's id of the staged version (promote's stage job), absent before
	// the package's first publish (nothing to stage on yet).
	stageId?: string;
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
		m.tarball !== `${PACKAGE}-${m.version}.tgz` ||
		(m.stageId !== undefined &&
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				m.stageId,
			))
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
async function needsPublish(io: Io, m: Manifest): Promise<boolean> {
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
async function checkedRelease(
	io: Io,
	dir: string,
): Promise<{ manifest: Manifest; tarball: string; notes: unknown }> {
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
	// What npm publishes is the tarball's own package.json: exactly
	// carbonless-review at this version, with no publishConfig (which could
	// send it to another registry or under another tag).
	const pkg = JSON.parse(
		await must(io, "tar", ["-xzOf", tarball, "package/package.json"]),
	) as {
		name?: string;
		version?: string;
		publishConfig?: unknown;
		crbReleaseNotesFile?: unknown;
	};
	const wrong = [
		pkg.name === PACKAGE ? "" : `name ${pkg.name}`,
		pkg.version === manifest.version ? "" : `version ${pkg.version}`,
		pkg.publishConfig === undefined ? "" : "a publishConfig",
	].filter(Boolean);
	if (wrong.length > 0) {
		throw new Error(`the tarball's package.json says ${wrong.join(", ")}`);
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
	return { manifest, tarball, notes: pkg.crbReleaseNotesFile };
}

/**
 * The release notes a release's package carries (its crbReleaseNotesFile,
 * CAR-242), as lines for the owner's terminal before approving: each
 * note's kind and text, and how many tickets or PRs need none. Text from
 * the package is printed with control and bidi characters replaced.
 */
export function notesLines(field: unknown, version: string): string[] {
	if (field === undefined) {
		return ["  notes: none in the package (promoted before CAR-242)"];
	}
	const parsed = parseReleaseNotesFile(field);
	if (!parsed.ok || parsed.file.version !== version) {
		return [
			`  notes: unreadable (${printable(parsed.ok ? `for ${parsed.file.version}` : parsed.errors.join("; ")).slice(0, 200)})`,
		];
	}
	const { notes, none } = parsed.file;
	return [
		`  notes: ${notes.length} note(s), ${none.length} without one (none)`,
		...notes.map(
			(n) => `    ${n.kind}: ${printable(n.text)} (${printable(n.id)})`,
		),
	];
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
			"{path, head_branch, event, conclusion, display_title}",
		]),
	) as {
		path?: string;
		head_branch?: string;
		event?: string;
		conclusion?: string;
		display_title?: string;
	};
	const wrong = [
		r.path === ".github/workflows/release.yml" ? "" : `workflow ${r.path}`,
		r.display_title?.startsWith("Promote ") ? "" : `run "${r.display_title}"`,
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
async function waitForIntegrity(
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
 * The oldest npm `pnpm release publish` works with: npm stage (list,
 * download, approve) came in 12.2. In step with the npm release.yml
 * installs (`npm install -g npm@12.2.1`; a test checks).
 */
export const MIN_NPM = "12.2.0";

/**
 * Fails unless this machine's npm is MIN_NPM or newer: an older one answers
 * `npm stage` with "Unknown command" halfway through. Says the fix.
 */
export async function checkNpmVersion(
	io: Io,
	command = "pnpm release publish",
): Promise<void> {
	const r = await io.run("npm", ["--version"]);
	const found = r.code === 0 ? r.stdout.trim() : "";
	const have = /^\d+\.\d+\.\d+$/.test(found) ? parseVersion(found) : null;
	const min = parseVersion(MIN_NPM);
	if (have && min && compareVersions(have, min) >= 0) return;
	const what =
		r.code !== 0
			? `npm --version failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`
			: `this npm is ${found || "(no version)"}`;
	throw new Error(
		`${command} needs npm >= ${MIN_NPM} (npm stage); ${what}. Fix: npm install -g npm@12 (npm 12 needs Node ^22.22.2 or ^24.15.0, or newer)`,
	);
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

/**
 * The ids of the staged entries for `version` in `npm stage list --json`'s
 * answer, whatever its shape (entries with a `version` and an `id` or
 * `stageId`; "?" when an entry has no id).
 */
export function stagedIds(listJson: string, version: string): string[] {
	const ids: string[] = [];
	const walk = (v: unknown) => {
		if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === "object") {
			const o = v as Record<string, unknown>;
			if (o.version === version) {
				const id = o.id ?? o.stageId;
				ids.push(typeof id === "string" ? id : "?");
			}
			Object.values(o).forEach(walk);
		}
	};
	walk(JSON.parse(listJson || "null"));
	return [...new Set(ids)];
}

/**
 * Fails when npm has another staged entry for this version than the one this
 * promote run staged (a second promote of the same version stages a second
 * one): reject the others first, so the one approved on npmjs.com can only
 * be this one. A read with the owner's login (npm stage list doesn't take
 * an OIDC token, so CI can't check this).
 */
async function checkOnlyStaged(
	io: Io,
	stageId: string,
	version: string,
): Promise<void> {
	const others = stagedIds(
		await must(io, "npm", ["stage", "list", PACKAGE, "--json"]),
		version,
	).filter((id) => id !== stageId);
	if (others.length > 0) {
		throw new Error(
			`${PACKAGE}@${version} is staged more than once: ${stageId} (this promote run) and ${others.join(", ")}. Reject the others first (npm stage reject <id>, with your OTP; or on npmjs.com), then run this again`,
		);
	}
}

/**
 * Fails unless the version npm staged under `stageId` is the tarball promote
 * checked: `npm stage download` (a read) into `dir`, then its sha256 and
 * integrity against the manifest.
 */
async function checkStaged(
	io: Io,
	stageId: string,
	m: Manifest,
	dir: string,
): Promise<void> {
	const into = join(dir, "staged");
	mkdirSync(into);
	await must(io, "npm", ["stage", "download", stageId], { cwd: into });
	const files = readdirSync(into).filter((f) => f.endsWith(".tgz"));
	if (files.length !== 1 || !files[0]) {
		throw new Error(
			`npm stage download ${stageId} gave ${files.length} tarballs`,
		);
	}
	const staged = tarballDigests(readFileSync(join(into, files[0])));
	if (staged.sha256 !== m.sha256 || staged.integrity !== m.integrity) {
		throw new Error(
			`the staged ${stageId} is not the tarball promote checked (sha256 ${staged.sha256}, not ${m.sha256})`,
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
			"release.yml",
			"--branch",
			"master",
			"--event",
			"workflow_dispatch",
			"--status",
			"success",
			"--limit",
			"20",
			"--json",
			"databaseId,displayTitle",
		]),
	) as { databaseId: number; displayTitle: string }[];
	// The dispatches are promotes and rc fix-ups; the run name tells them apart.
	const id = runs.find((r) =>
		r.displayTitle.startsWith("Promote "),
	)?.databaseId;
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
	// First: an npm without npm stage would fail only after the downloads.
	await checkNpmVersion(io);
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
		const { manifest, tarball, notes } = await checkedRelease(io, dir);
		const publish = await needsPublish(io, manifest);
		const npm = await npmState(io);
		const latest = npm?.distTags.latest;
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
		// Staged by promote (approve it), or the package's first publish (the
		// owner publishes it; there was nothing to stage on).
		const stageId = manifest.stageId;
		if (publish && !stageId && npm !== null) {
			throw new Error(
				`promote run ${run} staged nothing, and ${PACKAGE} is on npm now: run pnpm release promote again`,
			);
		}
		if (publish && stageId) {
			await checkOnlyStaged(io, stageId, manifest.version);
			await checkStaged(io, stageId, manifest, dir);
		}
		io.log(
			`Release ${manifest.version} from ${manifest.tag} (${manifest.sha})`,
		);
		io.log(
			`  promote run ${run}, ${manifest.tarball}, sha256 ${manifest.sha256}`,
		);
		io.log(
			!publish
				? `  npm: already has ${manifest.version} with this tarball, not published again`
				: stageId
					? `  npm: approve staged ${stageId} (the same tarball) to latest (now ${latest ?? "nothing"}); npm asks for your OTP`
					: `  npm: first publish, to latest; npm asks for your OTP`,
		);
		for (const line of notesLines(notes, manifest.version)) io.log(line);
		io.log(
			`  then release-finish: tag v${manifest.version}, rc, changelog, "next: ${manifest.next}" PR`,
		);
		if (!(await io.ask(`Go on? [y/N] `))) {
			io.log("Nothing done.");
			return;
		}
		if (publish) {
			let code: number;
			if (stageId) {
				code = await io.interactive("npm", ["stage", "approve", stageId]);
			} else {
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
				code = await io.interactive("npm", [
					"publish",
					tarball,
					"--tag",
					"latest",
					"--access",
					"public",
				]);
			}
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
					`npm ${stageId ? "stage approve" : "publish"} failed (${code}); nothing else was done: run pnpm release publish ${run} again`,
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
