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
}

export interface UpdateFailure {
	version: string;
	/** The install's output, its last lines (or why nothing was installed). */
	tail: string;
	command: string;
}

/** `POST /api/update`'s body: the version the toast offered. */
export interface UpdateRequest {
	version: string;
}

/** The release page of `version`: its tag on GitHub. */
export const releaseUrl = (version: string): string =>
	`https://github.com/Gilthans/carbonless/releases/tag/v${encodeURIComponent(version)}`;
