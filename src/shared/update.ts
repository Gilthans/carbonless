/** `GET /api/update`: whether a newer crb is on npm, and an update's progress. */
export interface UpdateInfo {
	/** The running version. */
	current: string;
	/** A strictly newer version on the running version's channel; null: none known. */
	available: string | null;
	/** The release's page on GitHub (its tag), when one is available. */
	releaseUrl: string | null;
	/** Update installs and restarts crb by itself (else: `command`, by hand). */
	oneClick: boolean;
	/** The install command for `available`, to run by hand. */
	command: string | null;
	/**
	 * idle; installing (crb still serves while a service's install runs);
	 * restarting (crb is about to stop: installed, or a helper installs).
	 */
	state: "idle" | "installing" | "restarting";
	/** The last update that failed, until another succeeds. */
	failed: UpdateFailure | null;
	/** The running build's commit (full SHA; "-dirty" or "unknown" from a checkout). */
	commit: string;
	/** The npm dist-tag followed. */
	channel: "rc" | "latest";
	/** The global install crb updates (null: none it knows, or checks off). */
	install: "npm" | "pnpm" | null;
	/** Checks on, but an update is the reviewer's to run (`command`). */
	byHand: boolean;
	/** When the registry last answered or failed (ISO); null: never asked. */
	lastChecked: string | null;
	/** Why the last check failed; null when it succeeded (or none ran). */
	checkError: string | null;
	/** Why crb never checks; null: it does. */
	checksOff: ChecksOff | null;
}

/**
 * Why crb never checks for updates: a build npm didn't serve (a checkout,
 * `pnpm build`, `pnpm release local`), `CRB_NO_UPDATE_CHECK=1`,
 * config.json's `updates.check: false`, or a server with no updater.
 */
export type ChecksOff = "local-build" | "env" | "config" | "unavailable";

export interface UpdateFailure {
	version: string;
	/** The install's output, its last lines (or why nothing was installed). */
	tail: string;
	command: string;
}

/** The commit page of `sha` on GitHub; null when it isn't a full SHA. */
export const commitUrl = (sha: string): string | null => {
	const clean = sha.replace(/-dirty$/, "");
	return /^[0-9a-f]{40}$/.test(clean)
		? `https://github.com/Gilthans/carbonless/commit/${clean}`
		: null;
};

/** `POST /api/update`'s body: the version the toast offered. */
export interface UpdateRequest {
	version: string;
}

/** The release page of `version`: its tag on GitHub. */
export const releaseUrl = (version: string): string =>
	`https://github.com/Gilthans/carbonless/releases/tag/v${encodeURIComponent(version)}`;
