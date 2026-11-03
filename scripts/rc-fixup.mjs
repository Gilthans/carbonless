#!/usr/bin/env node
// Moves npm's `rc` dist-tag up when it is behind (main follows `rc`, so it
// must never run behind `latest`). No dependencies, on purpose: it runs in
// the jobs that can get npm's OIDC token (release.yml's rc-publish and
// fixup jobs), where no dependency code runs (docs/releasing.md, "Trusted
// publishing").
//
//   node scripts/rc-fixup.mjs [<version this run published>]
//       prints move_rc_to=<version> (or empty) for $GITHUB_OUTPUT
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NUM = "(0|[1-9]\\d*)";
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-rc\\.${NUM})?$`);

/** `X.Y.Z` or `X.Y.Z-rc.N` as numbers, else null. */
export function parse(text) {
	const m = VERSION.exec(String(text ?? "").trim());
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		rc: m[4] === undefined ? undefined : Number(m[4]),
	};
}

/** Semver order: an RC comes before its release. */
export function compare(a, b) {
	return (
		a.major - b.major ||
		a.minor - b.minor ||
		a.patch - b.patch ||
		(a.rc ?? Number.POSITIVE_INFINITY) - (b.rc ?? Number.POSITIVE_INFINITY) ||
		0
	);
}

const format = (v) =>
	`${v.major}.${v.minor}.${v.patch}${v.rc === undefined ? "" : `-rc.${v.rc}`}`;

/**
 * The version `rc` should move to, or null. The floor is the newer of
 * `published` (what this run published) and `latest` as read: the read can
 * be stale (a 404 right after the first publish, a `latest` not yet
 * updated, a read that misses this run's own RC), so `rc` is never moved
 * below what the run itself published, and only ever up.
 */
export function rcMoveTo(distTags, published) {
	const floor = [parse(published), parse(distTags?.latest)]
		.filter((v) => v !== null)
		.sort(compare)
		.at(-1);
	if (!floor) return null;
	const rc = parse(distTags?.rc);
	return !rc || compare(rc, floor) < 0 ? format(floor) : null;
}

/** npm's dist-tags for the package, fresh; null when it isn't on npm. */
function distTags() {
	try {
		const out = execFileSync(
			"npm",
			["view", "carbonless-review", "dist-tags", "--json", "--prefer-online"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		return JSON.parse(out);
	} catch (error) {
		const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
		if (/E404|404 Not Found/.test(text)) return null;
		throw error;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const published = process.argv[2] ?? "";
	if (published && !parse(published)) {
		console.error(`usage: node scripts/rc-fixup.mjs [<X.Y.Z or X.Y.Z-rc.N>]`);
		process.exit(2);
	}
	console.log(
		`move_rc_to=${rcMoveTo(distTags(), published || undefined) ?? ""}`,
	);
}
