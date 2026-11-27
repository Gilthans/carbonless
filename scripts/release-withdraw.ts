// `pnpm release withdraw` (CAR-212; docs/releasing.md): the owner stops a
// bad version from spreading. npm deprecates it with WITHDRAWN_PREFIX (crb
// then never offers it, and a crb running it shows the Withdrawn banner),
// and every dist-tag on a withdrawn version moves back to a good one.
// Never `npm unpublish`.
import { WITHDRAWN_PREFIX, withdrawnReason } from "../src/shared/update.js";
import {
	checkNpmVersion,
	compareVersions,
	formatVersion,
	type Io,
	npmState,
	npmView,
	PACKAGE,
	type PublishIo,
	parseVersion,
	type Version,
} from "./release-lib.js";

/** What npm says of the package: every version, the deprecated ones, the dist-tags. */
export interface RegistryState {
	versions: string[];
	/** version → its deprecation message (only the deprecated ones). */
	deprecated: Record<string, string>;
	distTags: Record<string, string>;
}

export interface WithdrawPlan {
	/** The `npm deprecate` calls still to make. */
	deprecate: { version: string; message: string }[];
	/** The dist-tags still on a withdrawn version, and where each goes. */
	tags: { tag: string; from: string; to: string }[];
	/**
	 * RCs withdrawn with a named release without being named: the one it
	 * was promoted from (the same commit, the same code).
	 */
	alongside: { version: string; release: string }[];
	/** Versions to withdraw that are withdrawn already (a rerun). */
	skipped: string[];
	/** Why nothing may be done; null: the plan can run. */
	refused: string | null;
}

// Controls (newlines too: npm shows the message on one line) and bidi
// characters, which would make the owner's terminal and crb's banner
// show something else than was typed.
const CONTROL_OR_BIDI =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
	/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** The longest reason taken: crb shows at most 300 characters of it. */
const MAX_WHY = 300;

/** Parsed versions, newest first; what doesn't parse is left out. */
function newestFirst(versions: readonly string[]): Version[] {
	return versions
		.map((v) => parseVersion(v))
		.filter((v): v is Version => v !== null)
		.sort((a, b) => compareVersions(b, a));
}

/**
 * What is wrong with withdraw's arguments alone (checked before asking git
 * or npm anything); null: nothing.
 */
function withdrawArgsProblem(
	versions: readonly string[],
	why: string,
): string | null {
	if (versions.length === 0) return "name at least one version";
	for (const v of versions) {
		const parsed = parseVersion(v);
		if (!parsed || formatVersion(parsed) !== v) {
			return `${v} is not a version (X.Y.Z or X.Y.Z-rc.N)`;
		}
	}
	const reason = why.trim();
	if (reason === "") return "give a reason (the last argument)";
	if (CONTROL_OR_BIDI.test(reason)) {
		return "the reason must be one line, with no control or bidi characters";
	}
	if (Array.from(reason).length > MAX_WHY) {
		return `the reason must be at most ${MAX_WHY} characters`;
	}
	if (parseVersion(reason.replace(/^v/, ""))) {
		return `the reason (the last argument) is a version, ${reason}: give the reason after the versions`;
	}
	return null;
}

/** `X.Y.Z-rc.N` is a candidate for the release `X.Y.Z`. */
const rcOf = (v: Version, release: Version) =>
	v.rc !== undefined &&
	release.rc === undefined &&
	v.major === release.major &&
	v.minor === release.minor &&
	v.patch === release.patch;

/**
 * What `pnpm release withdraw` does for `versions`: deprecate each not yet
 * withdrawn, with each named release's promoted RC (`opts.promoted`:
 * release → the RC tagged on its commit), and move each dist-tag that
 * points at a withdrawn or deprecated version: `latest` to the newest good
 * release below it, any other tag (`rc`) to the newest good version at or
 * below it (an RC or a release), never an RC of a release being withdrawn
 * (the same code, or older). Refuses a version npm doesn't have, an empty,
 * multi-line or version-like reason, and a tag with no good version left
 * (unless `deprecateOnly`, which moves no tag at all).
 */
export function planWithdraw(
	state: RegistryState,
	versions: string[],
	why: string,
	opts: { deprecateOnly: boolean; promoted?: Record<string, string> },
): WithdrawPlan {
	const plan: WithdrawPlan = {
		deprecate: [],
		tags: [],
		alongside: [],
		skipped: [],
		refused: null,
	};
	const refuse = (why: string): WithdrawPlan => ({ ...plan, refused: why });
	const problem = withdrawArgsProblem(versions, why);
	if (problem) return refuse(problem);
	const reason = why.trim();
	const published = new Set(state.versions);
	const targets = new Set<string>();
	for (const v of versions) {
		if (!published.has(v)) return refuse(`${v} is not on npm`);
		targets.add(v);
	}
	for (const v of [...targets]) {
		const rc = opts.promoted?.[v];
		if (rc && published.has(rc) && !targets.has(rc)) {
			targets.add(rc);
			plan.alongside.push({ version: rc, release: v });
		}
	}
	// The releases withdrawn: none of their RCs is a tag's fallback.
	const releases = [...targets]
		.map((v) => parseVersion(v))
		.filter((v): v is Version => v !== null && v.rc === undefined);
	const message = `${WITHDRAWN_PREFIX}${reason}`;
	for (const v of targets) {
		if (withdrawnReason(state.deprecated[v]) !== null) plan.skipped.push(v);
		else plan.deprecate.push({ version: v, message });
	}
	if (opts.deprecateOnly) return plan;
	// Bad: withdrawn now, or deprecated before (for any reason).
	const bad = (v: string) => targets.has(v) || Boolean(state.deprecated[v]);
	const all = newestFirst(state.versions);
	for (const [tag, from] of Object.entries(state.distTags)) {
		if (!bad(from)) continue;
		const at = parseVersion(from);
		const to = all.find(
			(v) =>
				!bad(formatVersion(v)) &&
				!releases.some((r) => rcOf(v, r)) &&
				(at === null || compareVersions(v, at) <= 0) &&
				// latest only ever takes a release.
				(tag !== "latest" || v.rc === undefined),
		);
		if (!to) {
			return refuse(
				`no good version is left for ${tag} (on ${from}); --deprecate-only deprecates and moves no tag`,
			);
		}
		plan.tags.push({ tag, from, to: formatVersion(to) });
	}
	return plan;
}

/** Every published version newer than `first`, oldest first: the ones that may carry the same bug. */
export function laterVersions(state: RegistryState, first: string): string[] {
	const from = parseVersion(first);
	if (!from) return [];
	return newestFirst(state.versions)
		.filter((v) => compareVersions(v, from) > 0)
		.reverse()
		.map(formatVersion);
}

/**
 * The versions that may carry the same bug as `named`, oldest first:
 * every one published after the oldest named, and each named release's
 * own RCs; none of `named`.
 */
export function sameBugCandidates(
	state: RegistryState,
	named: readonly string[],
): string[] {
	const first = newestFirst(named).at(-1);
	if (!first) return [];
	const releases = newestFirst(named).filter((v) => v.rc === undefined);
	const skip = new Set(named);
	return newestFirst(state.versions)
		.reverse()
		.filter(
			(v) => compareVersions(v, first) > 0 || releases.some((r) => rcOf(v, r)),
		)
		.map(formatVersion)
		.filter((v) => !skip.has(v));
}

/**
 * Each release's promoted RC from the tags on GitHub (read only): the
 * `vX.Y.Z-rc.N` tag on the same commit as `vX.Y.Z` (an annotated tag by
 * the commit it points at). `missing`: releases with no tag on origin.
 * Throws, saying why, when origin's tags can't be read.
 */
export async function promotedRcs(
	io: Io,
	releases: readonly string[],
): Promise<{ found: Record<string, string>; missing: string[] }> {
	const wanted = releases.filter((v) => parseVersion(v)?.rc === undefined);
	if (wanted.length === 0) return { found: {}, missing: [] };
	// An exact name never brings its peeled line: `vX.Y.Z^{}` asks for it
	// (the glob takes the RCs' own).
	const r = await io.run("git", [
		"ls-remote",
		"--tags",
		"origin",
		...wanted.flatMap((v) => [`v${v}`, `v${v}^{}`, `v${v}-rc.*`]),
	]);
	if (r.code !== 0) {
		throw new Error(
			`can't read release tags from origin to find the RC ${wanted.join(", ")} was promoted from: ${r.stderr.trim() || r.stdout.trim() || `git exited ${r.code}`}`,
		);
	}
	// name → commit: a peeled line (`^{}`) wins over the tag object's.
	const commits = new Map<string, string>();
	for (const line of r.stdout.split("\n")) {
		const [sha, ref] = line.trim().split(/\s+/);
		if (!sha || !ref?.startsWith("refs/tags/")) continue;
		const peeled = ref.endsWith("^{}");
		const name = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
		if (peeled || !commits.has(name)) commits.set(name, sha);
	}
	const found: Record<string, string> = {};
	const missing: string[] = [];
	for (const release of wanted) {
		const at = commits.get(`v${release}`);
		const rel = parseVersion(release);
		if (!at || !rel) {
			missing.push(release);
			continue;
		}
		const rcs = newestFirst(
			[...commits]
				.filter(([name, sha]) => sha === at && name !== `v${release}`)
				.map(([name]) => name.slice(1)),
		).filter((v) => rcOf(v, rel));
		const rc = rcs[0];
		if (rc) found[release] = formatVersion(rc);
	}
	return { found, missing };
}

/**
 * `npm view <pkg>@<v1 || v2 ...> deprecated version --json`: an array of
 * `{deprecated?, version}` when any matched version is deprecated, of
 * plain versions when none is, or one value for one version. A deprecated
 * field that isn't a string is not a deprecation.
 */
export function parseDeprecated(data: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	for (const item of Array.isArray(data) ? data : [data]) {
		if (typeof item !== "object" || item === null) continue;
		const { version, deprecated } = item as Record<string, unknown>;
		if (typeof version === "string" && typeof deprecated === "string") {
			out[version] = deprecated;
		}
	}
	return out;
}

/**
 * The package as npm has it now (release-lib's npmView). Deprecations
 * come from one `npm view` over every version by name (an exact version
 * matches a prerelease, which a range like `*` leaves out).
 */
async function registryState(io: Io): Promise<RegistryState> {
	const npm = await npmState(io);
	if (npm === null) throw new Error(`${PACKAGE} is not on npm`);
	const { versions, distTags } = npm;
	const named = versions.filter((v) => parseVersion(v) !== null);
	const deprecated =
		named.length === 0
			? {}
			: parseDeprecated(
					await npmView(io, `${PACKAGE}@${named.join(" || ")}`, [
						"deprecated",
						"version",
					]),
				);
	return { versions, deprecated, distTags };
}

/**
 * Which of `versions` npm has as withdrawn (deprecated with the
 * `withdrawn: ` prefix): one `npm view` over them by name; none asked,
 * none read.
 */
export async function withdrawnOf(
	io: Io,
	versions: readonly string[],
): Promise<Set<string>> {
	if (versions.length === 0) return new Set();
	const deprecated = parseDeprecated(
		await npmView(io, `${PACKAGE}@${versions.join(" || ")}`, [
			"deprecated",
			"version",
		]),
	);
	return new Set(
		versions.filter((v) => withdrawnReason(deprecated[v]) !== null),
	);
}

/** The versions withdrawn on npm, with their reasons (printable), oldest first. */
function withdrawnVersions(
	state: RegistryState,
): { version: string; reason: string }[] {
	return newestFirst(Object.keys(state.deprecated))
		.reverse()
		.map(formatVersion)
		.flatMap((version) => {
			const reason = withdrawnReason(state.deprecated[version]);
			return reason === null ? [] : [{ version, reason }];
		});
}

/**
 * `pnpm release withdraw <version>... "<why>" [--deprecate-only]`, the
 * owner's (npm asks for their OTP on their terminal; this never reads or
 * passes one). Shows the later versions (to name any that carry the same
 * bug) and the plan, asks y/N, then deprecates and moves the tags. Safe
 * to run again: a rerun finishes only what is left.
 */
export async function withdraw(
	io: PublishIo,
	args: { versions: string[]; why: string; deprecateOnly: boolean },
): Promise<void> {
	// The arguments first: nothing asked of git or npm with a bad one.
	const problem = withdrawArgsProblem(args.versions, args.why);
	if (problem) throw new Error(`not withdrawing: ${problem}`);
	await checkNpmVersion(io, "pnpm release withdraw");
	const promoted = await promotedRcs(io, args.versions);
	const state = await registryState(io);
	const plan = planWithdraw(state, args.versions, args.why, {
		deprecateOnly: args.deprecateOnly,
		promoted: promoted.found,
	});
	if (plan.refused) throw new Error(`not withdrawing: ${plan.refused}`);
	const candidates = sameBugCandidates(state, [
		...args.versions,
		...plan.alongside.map((a) => a.version),
	]);
	if (candidates.length > 0) {
		io.log("May carry the same bug (name any that do too):");
		io.log(`  ${candidates.join(", ")}`);
	}
	io.log("Plan:");
	for (const v of promoted.missing) {
		io.log(
			`  ${v}: no v${v} tag on origin, so the RC it was promoted from wasn't found`,
		);
	}
	for (const a of plan.alongside) {
		io.log(
			`  ${a.version}: ${a.release} was promoted from it, withdrawn with it`,
		);
	}
	for (const v of plan.skipped) io.log(`  ${v}: withdrawn already, skipped`);
	for (const d of plan.deprecate) {
		io.log(`  npm deprecate ${PACKAGE}@${d.version} "${d.message}"`);
	}
	for (const t of plan.tags) {
		io.log(`  dist-tag ${t.tag}: ${t.from} -> ${t.to}`);
	}
	if (args.deprecateOnly) io.log("  --deprecate-only: no dist-tag moves");
	if (plan.deprecate.length === 0 && plan.tags.length === 0) {
		io.log("Nothing left to do: withdrawn already.");
		return;
	}
	if (!(await io.ask("Withdraw? npm asks for your OTP. [y/N] "))) {
		io.log("Nothing done.");
		return;
	}
	for (const d of plan.deprecate) {
		// The reason is one argv entry: never a shell string.
		const code = await io.interactive("npm", [
			"deprecate",
			`${PACKAGE}@${d.version}`,
			d.message,
		]);
		if (code !== 0) {
			throw new Error(
				`npm deprecate ${PACKAGE}@${d.version} failed (${code}); run the same command again to finish`,
			);
		}
	}
	for (const t of plan.tags) {
		const code = await io.interactive("npm", [
			"dist-tag",
			"add",
			`${PACKAGE}@${t.to}`,
			t.tag,
		]);
		if (code !== 0) {
			throw new Error(
				`npm dist-tag add ${PACKAGE}@${t.to} ${t.tag} failed (${code}); run the same command again to finish`,
			);
		}
	}
	io.log(
		`Withdrawn: ${args.versions.join(", ")}${plan.tags.length ? `; ${plan.tags.map((t) => `${t.tag} on ${t.to}`).join(", ")}` : ""}.`,
	);
	io.log(hotfixAdvice(state.versions, args.versions));
}

/**
 * What withdraw says to do next, in step with `pnpm release hotfix`'s
 * default (the newest release by semver, release-hotfix.ts): a hotfix of
 * the newest release when it is among the withdrawn; else (an older
 * release, or RCs only) the fix ships the usual way.
 */
export function hotfixAdvice(
	published: readonly string[],
	withdrawn: readonly string[],
): string {
	const newest = newestFirst(published).find((v) => v.rc === undefined);
	const releases = newestFirst(withdrawn).filter((v) => v.rc === undefined);
	if (newest && releases.some((v) => compareVersions(v, newest) === 0)) {
		return `Now ship a fix: pnpm release hotfix v${formatVersion(newest)}`;
	}
	if (newest && releases.length > 0) {
		return `Now ship a fix: only the newest release gets a hotfix (v${formatVersion(newest)}: pnpm release hotfix v${formatVersion(newest)}, if it has the bug too); else its PR to master publishes the next RC.`;
	}
	return "Now ship a fix: its PR to master publishes the next RC.";
}

/** `pnpm release status`'s withdrawn versions (after release-lib's status). */
export async function withdrawnStatus(io: Io): Promise<void> {
	let state: RegistryState;
	try {
		state = await registryState(io);
	} catch (error) {
		io.log(`withdrawn: unknown (${(error as Error).message})`);
		return;
	}
	for (const { version, reason } of withdrawnVersions(state)) {
		io.log(`withdrawn: ${version} (${reason})`);
	}
}
