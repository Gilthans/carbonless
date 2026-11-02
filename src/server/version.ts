import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** What a build of carbonless is: package.json's version and the commit built. */
export interface BuildInfo {
	version: string;
	/** Full SHA; "-dirty" appended when the tree had changes at build time. */
	commit: string;
}

/** The request header the CLI sends its BuildInfo in (JSON). */
export const VERSION_HEADER = "x-crb-version";

/**
 * This build: dist/build-info.json (scripts/build-info.mjs, so an installed
 * tarball needs no .git); run from source (tsx, Vitest), package.json's
 * version and the checkout's HEAD.
 */
function readBuild(): BuildInfo {
	try {
		const info = JSON.parse(
			readFileSync(new URL("../build-info.json", import.meta.url), "utf8"),
		) as BuildInfo;
		if (typeof info.version === "string" && typeof info.commit === "string") {
			return { version: info.version, commit: info.commit };
		}
	} catch {
		// Not a build: from source.
	}
	const root = new URL("../../", import.meta.url);
	const { version } = JSON.parse(
		readFileSync(new URL("package.json", root), "utf8"),
	) as { version: string };
	let commit = "unknown";
	try {
		commit = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// No git: "unknown", the same on both sides of a source run.
	}
	return { version, commit };
}

export const BUILD: BuildInfo = readBuild();

/** "0.4.0-rc.1 (93fe843)", "-dirty" kept after the short commit. */
export const formatVersion = (b: BuildInfo): string => {
	const dirty = b.commit.endsWith("-dirty");
	const sha = dirty ? b.commit.slice(0, -"-dirty".length) : b.commit;
	return `${b.version} (${sha.slice(0, 7)}${dirty ? "-dirty" : ""})`;
};

export const sameBuild = (a: BuildInfo, b: BuildInfo): boolean =>
	a.version === b.version && a.commit === b.commit;

/** Why a server refuses a CLI of another build (HTTP 409, and the CLI's error). */
export const mismatchMessage = (server: BuildInfo, client: BuildInfo): string =>
	`server runs ${formatVersion(server)}, this crb is ${formatVersion(client)}. Restart the server (crb serve) or run the matching crb`;

/** A BuildInfo from the header's JSON; null when it isn't one. */
export function parseBuildInfo(text: string | undefined): BuildInfo | null {
	if (!text) return null;
	try {
		const v = JSON.parse(text) as Partial<BuildInfo>;
		return typeof v.version === "string" && typeof v.commit === "string"
			? { version: v.version, commit: v.commit }
			: null;
	} catch {
		return null;
	}
}
