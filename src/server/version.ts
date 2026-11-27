import { randomUUID } from "node:crypto";
import { type BuildInfo, readBuild } from "./buildInfo.js";

export type { BuildInfo } from "./buildInfo.js";

/** The request header the CLI sends its BuildInfo in (JSON). */
export const VERSION_HEADER = "x-crb-version";

export const BUILD: BuildInfo = readBuild();

/**
 * This crb process: a restarted crb (of any build) answers another one, so
 * an updating page tells the crb in its restart's grace from one that came
 * back (`/api/version`, UpdateInfo.boot).
 */
export const BOOT_ID = randomUUID();

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
