/**
 * The bit of semver crb's own versions need (`X.Y.Z`, `X.Y.Z-rc.N`):
 * parsing, ordering, and the npm channel a version follows.
 */

export interface Version {
	major: number;
	minor: number;
	patch: number;
	/** Dot-separated prerelease identifiers (`["rc", "2"]`); empty for a release. */
	pre: string[];
}

const VERSION =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** `text` as a version, or null when it isn't one (build metadata isn't accepted). */
export function parseVersion(text: unknown): Version | null {
	if (typeof text !== "string") return null;
	const m = VERSION.exec(text);
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		pre: m[4] ? m[4].split(".") : [],
	};
}

const NUMERIC = /^(0|[1-9]\d*)$/;

function comparePre(a: string[], b: string[]): number {
	// A release sorts after its prereleases.
	if (a.length === 0 || b.length === 0) return b.length - a.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i];
		const y = b[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;
		const xn = NUMERIC.test(x);
		const yn = NUMERIC.test(y);
		if (xn && yn) return Number(x) - Number(y);
		if (xn) return -1;
		if (yn) return 1;
		return x < y ? -1 : 1;
	}
	return 0;
}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: Version, b: Version): number {
	return (
		a.major - b.major ||
		a.minor - b.minor ||
		a.patch - b.patch ||
		comparePre(a.pre, b.pre)
	);
}

/** Whether `candidate` is strictly newer than `current` (false when either isn't a version). */
export function isNewer(candidate: string, current: string): boolean {
	const c = parseVersion(candidate);
	const v = parseVersion(current);
	return c !== null && v !== null && compareVersions(c, v) > 0;
}

/** The dist-tag a version follows: `rc` for a prerelease, else `latest`. */
export const channelOf = (version: string): "rc" | "latest" =>
	(parseVersion(version)?.pre.length ?? 0) > 0 ? "rc" : "latest";
