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
	/**
	 * The answering crb process (`/api/version` says it too): another one
	 * after a restart. Missing from a crb older than CAR-177.
	 */
	boot?: string;
	/** The npm dist-tag followed. */
	channel: "rc" | "latest";
	/** The global install crb updates (null: none it knows, or checks off). */
	install: "npm" | "pnpm" | null;
	/** Checks on, but an update is the reviewer's to run (`command`). */
	byHand: boolean;
	/** Why, when `byHand` (null otherwise). */
	byHandReason: ByHandReason | null;
	/**
	 * For "service": the manager that won't start crb again (e.g.
	 * `systemd (crb.service)`, `PID 1`); null otherwise.
	 */
	byHandManager: string | null;
	/** When the registry last answered or failed (ISO); null: never asked. */
	lastChecked: string | null;
	/** Why the last check failed; null when it succeeded (or none ran). */
	checkError: string | null;
	/** Why crb never checks; null: it does. */
	checksOff: ChecksOff | null;
	/**
	 * The running version is withdrawn (CAR-212: npm deprecated it with
	 * WITHDRAWN_PREFIX): the maintainer's reason, untrusted plain text
	 * (withdrawnReason). Null when it isn't, and until a check said
	 * (`lastChecked` null).
	 */
	withdrawn: { reason: string } | null;
}

/**
 * Why crb can't update itself: not a global npm/pnpm install it knows
 * ("no-install": yarn, bun, a project's dependency...), a global folder it
 * can't write ("not-writable": a root-owned prefix), or a service manager
 * that won't start it again once it exits ("service": systemd without
 * `Restart=on-failure`/`always`, crb not the unit's main process, PID 1).
 */
export type ByHandReason = "no-install" | "not-writable" | "service";

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

/** `POST /api/update`'s body: the version the toast offered. */
export interface UpdateRequest {
	version: string;
}

/** The release page of `version`: its tag on GitHub. */
export const releaseUrl = (version: string): string =>
	`https://github.com/Gilthans/carbonless/releases/tag/v${encodeURIComponent(version)}`;

/**
 * How a withdrawal's npm deprecation message starts (`pnpm release
 * withdraw`, CAR-212): any other deprecation is not a withdrawal.
 */
export const WITHDRAWN_PREFIX = "withdrawn: ";

/** The longest withdrawal reason shown (in code points). */
const MAX_REASON = 300;

// C0 and C1 controls and DEL, and the bidi marks, embeddings, overrides
// and isolates (as releaseNotes.ts's printable).
const CONTROL_OR_BIDI =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
	/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Why a version was withdrawn, from its npm `deprecated` field: the text
 * after WITHDRAWN_PREFIX on one line (whitespace runs as one space), other
 * control and bidi characters as `?`, at most MAX_REASON characters. Null
 * when the field isn't a string or isn't a withdrawal. The text is
 * untrusted (npm's): plain text wherever it goes.
 */
export function withdrawnReason(deprecated: unknown): string | null {
	if (typeof deprecated !== "string") return null;
	if (!deprecated.startsWith(WITHDRAWN_PREFIX)) return null;
	const text = deprecated
		.slice(WITHDRAWN_PREFIX.length)
		.replace(/\s+/g, " ")
		.replace(CONTROL_OR_BIDI, "?")
		.trim();
	return Array.from(text).slice(0, MAX_REASON).join("");
}
