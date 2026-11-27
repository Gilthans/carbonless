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
	/** Versions named that are withdrawn already (a rerun). */
	skipped: string[];
	/** Why nothing may be done; null: the plan can run. */
	refused: string | null;
}

// Controls (newlines too: npm shows the message on one line) and bidi
// characters, which would make the owner's terminal and crb's banner
// show something else than was typed.
const CONTROL_OR_BIDI =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
	/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;
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
 * What `pnpm release withdraw` does for `versions`: deprecate each not yet
 * withdrawn, and move each dist-tag that points at a withdrawn or
 * deprecated version: `latest` to the newest good release below it, any
 * other tag (`rc`) to the newest good version at or below it (an RC or a
 * release). Refuses a version npm doesn't have, an empty or multi-line
 * reason, and a tag with no good version left (unless `deprecateOnly`,
 * which moves no tag at all).
 */
export function planWithdraw(
	state: RegistryState,
	versions: string[],
	why: string,
	opts: { deprecateOnly: boolean },
): WithdrawPlan {
	const plan: WithdrawPlan = {
		deprecate: [],
		tags: [],
		skipped: [],
		refused: null,
	};
	const refuse = (why: string): WithdrawPlan => ({ ...plan, refused: why });
	if (versions.length === 0) return refuse("name at least one version");
	const reason = why.trim();
	if (reason === "") return refuse("give a reason (the last argument)");
	if (CONTROL_OR_BIDI.test(reason)) {
		return refuse(
			"the reason must be one line, with no control or bidi characters",
		);
	}
	if (Array.from(reason).length > MAX_WHY) {
		return refuse(`the reason must be at most ${MAX_WHY} characters`);
	}
	const published = new Set(state.versions);
	const targets = new Set<string>();
	for (const v of versions) {
		const parsed = parseVersion(v);
		if (!parsed || formatVersion(parsed) !== v) {
			return refuse(`${v} is not a version (X.Y.Z or X.Y.Z-rc.N)`);
		}
		if (!published.has(v)) return refuse(`${v} is not on npm`);
		targets.add(v);
	}
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
 * `npm view <pkg>@<v1 || v2 ...> deprecated version --json`: an array of
 * `{deprecated?, version}` when any matched version is deprecated, of
 * plain versions when none is, or one value for one version. A deprecated
 * field that isn't a string is not a deprecation.
 */
export function parseDeprecated(json: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (json.trim() === "") return out;
	const data = JSON.parse(json) as unknown;
	for (const item of Array.isArray(data) ? data : [data]) {
		if (typeof item !== "object" || item === null) continue;
		const { version, deprecated } = item as Record<string, unknown>;
		if (typeof version === "string" && typeof deprecated === "string") {
			out[version] = deprecated;
		}
	}
	return out;
}

/** `npm view --json`'s answer: an object, or (newer npm) an array of one. */
const unwrap = (data: unknown): Record<string, unknown> =>
	((Array.isArray(data) ? data[0] : data) ?? {}) as Record<string, unknown>;

/**
 * The package as npm has it now (`--prefer-online`: not npm's cache).
 * Deprecations come from one `npm view` over every version by name (an
 * exact version matches a prerelease, which a range like `*` leaves out).
 */
export async function registryState(io: Io): Promise<RegistryState> {
	const view = async (spec: string, fields: string[]) => {
		const r = await io.run("npm", [
			"view",
			spec,
			...fields,
			"--json",
			"--prefer-online",
		]);
		if (r.code !== 0) {
			throw new Error(`npm view ${spec} failed: ${r.stderr.trim()}`);
		}
		return r.stdout;
	};
	const top = unwrap(
		JSON.parse(await view(PACKAGE, ["dist-tags", "versions"])),
	);
	const raw = top.versions;
	const versions = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(
		(v): v is string => typeof v === "string",
	);
	const distTags: Record<string, string> = {};
	const tags = top["dist-tags"];
	if (typeof tags === "object" && tags !== null) {
		for (const [k, v] of Object.entries(tags)) {
			if (typeof v === "string") distTags[k] = v;
		}
	}
	const named = versions.filter((v) => parseVersion(v) !== null);
	const deprecated =
		named.length === 0
			? {}
			: parseDeprecated(
					await view(`${PACKAGE}@${named.join(" || ")}`, [
						"deprecated",
						"version",
					]),
				);
	return { versions, deprecated, distTags };
}

/** The versions withdrawn on npm, with their reasons (printable), oldest first. */
export function withdrawnVersions(
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
	await checkNpmVersion(io, "pnpm release withdraw");
	const state = await registryState(io);
	const plan = planWithdraw(state, args.versions, args.why, {
		deprecateOnly: args.deprecateOnly,
	});
	if (plan.refused) throw new Error(`not withdrawing: ${plan.refused}`);
	const named = new Set(args.versions);
	const first = newestFirst(args.versions).at(-1);
	const later = first
		? laterVersions(state, formatVersion(first)).filter((v) => !named.has(v))
		: [];
	if (later.length > 0) {
		io.log(
			`Published since ${first ? formatVersion(first) : ""} (name any that carry the same bug too):`,
		);
		io.log(`  ${later.join(", ")}`);
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
	const release = newestFirst(args.versions).find((v) => v.rc === undefined);
	io.log(
		release
			? `Now ship a fix: pnpm release hotfix v${formatVersion(release)}`
			: "Now ship a fix: its PR to master publishes the next RC.",
	);
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
