import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ByHandReason,
	type ChecksOff,
	releaseUrl,
	type UpdateFailure,
	type UpdateInfo,
} from "../../shared/update.js";
import type { UpdateNotes } from "../../shared/whatsNew.js";
import { cacheDir, stateDir } from "../paths.js";
import { BOOT_ID, type BuildInfo } from "../version.js";
import {
	detectInstall,
	type Install,
	installCommand,
	isFromNpm,
	manualCommand,
	restartArgs,
	showCommand,
} from "./install.js";
import {
	fetchOfferedNotes,
	NotesCache,
	NotesError,
	type ParsedNotes,
	prepareUpdateNotes,
	runningBuildNotes,
} from "./notes.js";
import {
	checkRegistry,
	type RegistryAnswer,
	RegistryError,
	registryUrl,
} from "./registry.js";
import { channelOf, isNewer } from "./semver.js";
import { detectService, type Service } from "./service.js";
import {
	HELPER_DIR_PREFIX,
	type HelperConfig,
	relaunchedPidFile,
	runCommand,
	tailOf,
	type UpdateResult,
} from "./updateHelper.js";

export type Channel = "rc" | "latest";

/**
 * How often the registry is asked again after the check at start: RCs
 * land several times a day. A check from the Global settings page
 * (checkNow) leaves this timer alone.
 */
export const CHECK_EVERY_MS = 60 * 60_000;

/**
 * How long crb keeps answering "restarting" before it stops: every open
 * page polls /api/update more often than this while an update is on offer
 * (UPDATE_WATCH_MS), so each shows the update and waits to reload.
 */
const RESTART_GRACE_MS = 6_000;

/** How long a service's install may run before it counts as failed. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** How long the helper waits for crb to exit before giving up. */
const HELPER_WAIT_MS = 60_000;

/** A request the updater refuses (HTTP 409). */
export class UpdateRefusedError extends Error {}

/** The package directory this build runs from (dist/server/update/ → root), real. */
function packageRoot(): string {
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	try {
		return realpathSync(root);
	} catch {
		return root;
	}
}

export interface UpdaterOptions {
	build: BuildInfo;
	/** Checks at all: a build npm served, not switched off. */
	enabled: boolean;
	/** Why it doesn't, when not `enabled` (default "local-build"). */
	off?: ChecksOff;
	/** How crb was installed (null: unknown, the command instead). */
	install: Install | null;
	/**
	 * What the registry says (checkRegistry): the newer good version, the
	 * running one's withdrawal, which of `offered` (the update on offer) is
	 * deprecated now; rejects when the registry can't be asked.
	 */
	check?: (
		current: string,
		channel: Channel,
		offered: string | null,
	) => Promise<RegistryAnswer>;
	/**
	 * The notes a version carries (fetchOfferedNotes); rejects with a
	 * RegistryError. Default: the registry's, unless `check` is faked (a
	 * test that fakes the check fakes the notes too, or has none).
	 */
	notes?: (version: string) => Promise<ParsedNotes>;
	/** The running build's own notes (default: its package's file). */
	ownNotes?: () => Promise<ParsedNotes | null>;
	/** config.json's `updates.channel`: over the remembered one. */
	channel?: Channel;
	/** Where the channel is remembered (`update-channel` in the state dir). */
	channelFile?: string;
	checkEveryMs?: number;
	service?: () => Promise<Service | null>;
	/** Stops the server and exits with `code` (crb serve's shutdown). */
	exit: (code: number) => void;
	/** The port crb listens on, for the restart. */
	port: () => number;
	/** What crb was started with (process.argv after cli.js), cwd and env. */
	argv?: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Runs a service's install (default: runCommand). */
	run?: typeof runCommand;
	/** Runs the helper (default: node on a copy of it, detached). */
	startHelper?: (config: HelperConfig) => Promise<void>;
	/** INSTALL_TIMEOUT_MS, shorter in tests. */
	installTimeoutMs?: number;
	/** The node, its flags and file checks the commands are built with (tests). */
	execPath?: string;
	execArgv?: readonly string[];
	exists?: (file: string) => boolean;
	/** Where the restarted crb logs (serve.log in the state dir). */
	serveLog?: string;
	/** RESTART_GRACE_MS, shorter in tests. */
	graceMs?: number;
	/** Where the helper's result is left for the next crb. */
	resultFile?: string;
	logFile?: string;
	platform?: NodeJS.Platform;
	/** The clock lastChecked reads (tests). */
	now?: () => Date;
}

/**
 * crb's self-update (CAR-108): asks npm for a newer version at start and
 * every CHECK_EVERY_MS (and when the Global settings page asks), and on
 * the reviewer's click installs exactly that version and restarts crb in
 * place. Never automatic. A failed check is only recorded (`checkError`),
 * for the Global settings page; the toast stays silent.
 */
export class Updater {
	#available: string | null = null;
	/** The running version's withdrawal reason (CAR-212); null: not withdrawn, or not known yet. */
	#withdrawn: string | null = null;
	#state: UpdateInfo["state"] = "idle";
	/**
	 * The helper being started (state still idle): "restarting" only once
	 * it runs, never one that turns back to idle in this process, which a
	 * page waiting on this crb's boot would wait on for good (CAR-177).
	 */
	#starting: { version: string; done: Promise<UpdateInfo> } | null = null;
	#failed: UpdateFailure | null = null;
	#service: Service | null = null;
	#timer: NodeJS.Timeout | null = null;
	#checking: Promise<void> | null = null;
	#channel: Channel;
	#lastChecked: Date | null = null;
	#checkError: string | null = null;
	readonly #o: UpdaterOptions;
	readonly #now: () => Date;
	readonly #notes: NotesCache;

	constructor(options: UpdaterOptions) {
		this.#o = options;
		this.#now = options.now ?? (() => new Date());
		const load =
			options.notes ??
			(options.check
				? async () => {
						throw new RegistryError("No notes in this version");
					}
				: (version: string) =>
						fetchOfferedNotes(version, { registry: registryUrl(options.env) }));
		this.#notes = new NotesCache(load);
		// Until start() reads the remembered one: the version's own.
		this.#channel = options.channel ?? channelOf(options.build.version);
	}

	get #resultFile() {
		return this.#o.resultFile ?? join(stateDir(), "update-result.json");
	}

	get #logFile() {
		return this.#o.logFile ?? join(cacheDir(), "update.log");
	}

	/** Reads what an earlier update left, then checks now and every few hours. */
	async start(): Promise<void> {
		if (!this.#o.enabled) return;
		await this.#readResult();
		this.#channel = await this.#stickyChannel();
		this.#service = await (this.#o.service ?? detectService)().catch(
			() => null,
		);
		void this.checkNow();
		const every = this.#o.checkEveryMs ?? CHECK_EVERY_MS;
		this.#timer = setInterval(() => void this.checkNow(), every);
		this.#timer.unref();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
	}

	/**
	 * One check of the registry (concurrent callers share it). Leaves the
	 * timer alone: the hourly checks keep their times. Never rejects.
	 */
	checkNow(): Promise<void> {
		if (!this.#o.enabled) return Promise.resolve();
		this.#checking ??= (async () => {
			try {
				const check =
					this.#o.check ??
					((current: string, channel: Channel, offered: string | null) =>
						checkRegistry(current, {
							registry: registryUrl(this.#o.env),
							channel,
							also: offered ? [offered] : [],
						}));
				const current = this.#o.build.version;
				let answer: RegistryAnswer | null;
				try {
					answer = await check(current, this.#channel, this.#available);
					this.#checkError = null;
				} catch (error) {
					answer = null;
					this.#checkError =
						error instanceof RegistryError
							? error.message
							: "Registry check failed";
				}
				this.#lastChecked = this.#now();
				const newer = answer?.newer ?? null;
				// An offer npm now says is deprecated (withdrawn) is dropped,
				// unless it is being installed already.
				if (
					this.#available !== null &&
					this.#state === "idle" &&
					!this.#starting &&
					answer?.deprecated.includes(this.#available)
				) {
					this.#available = null;
				}
				// Only a strictly newer semver reaches the page or a command line.
				if (newer !== null && newer.length <= 64 && isNewer(newer, current)) {
					this.#available = newer;
				}
				// Unknown this time (undefined): the last answer stands.
				if (answer && answer.withdrawn !== undefined) {
					this.#withdrawn =
						typeof answer.withdrawn === "string" ? answer.withdrawn : null;
				}
				// Fetched when an update is found, so What's new opens with
				// its notes in place (a failure: once more per check).
				if (this.#available) this.#notes.afterCheck(this.#available);
				// A failed check (or none newer) keeps what an earlier one found.
			} finally {
				this.#checking = null;
			}
		})();
		return this.#checking;
	}

	/** Resolves once the check under way (if any) is done; starts none. */
	settled(): Promise<void> {
		return this.#checking ?? Promise.resolve();
	}

	/**
	 * The channel followed: `rc` once this machine's crb has run a
	 * prerelease (remembered in the state dir), so an RC user stays on `rc`
	 * after `rc` moves onto a release; else `latest`. config.json's
	 * `updates.channel` wins over both (an install from `@rc` while `rc`
	 * pointed at a release has never run a prerelease: `"rc"` there).
	 */
	async #stickyChannel(): Promise<Channel> {
		if (this.#o.channel) return this.#o.channel;
		const file = this.#o.channelFile ?? join(stateDir(), "update-channel");
		if (channelOf(this.#o.build.version) === "rc") {
			await mkdir(dirname(file), { recursive: true })
				.then(() => writeFile(file, "rc\n"))
				.catch(() => {});
			return "rc";
		}
		const text = await readFile(file, "utf8").catch(() => "");
		return text.trim() === "rc" ? "rc" : "latest";
	}

	/** An earlier update's outcome: a failure is shown, the file is consumed. */
	async #readResult(): Promise<void> {
		let text: string;
		try {
			text = await readFile(this.#resultFile, "utf8");
		} catch {
			return;
		}
		await rm(this.#resultFile, { force: true });
		await rm(relaunchedPidFile(this.#resultFile), { force: true });
		try {
			const r = JSON.parse(text) as Partial<UpdateResult>;
			if (typeof r.version !== "string" || typeof r.command !== "string") {
				return;
			}
			if (r.version === this.#o.build.version) return;
			this.#failed = {
				version: r.version,
				tail:
					typeof r.tail === "string" && r.tail
						? r.tail
						: r.ok
							? `Installed ${r.version}, but crb ${this.#o.build.version} started again`
							: "The install failed",
				command: r.command,
			};
		} catch {
			// Unreadable: nothing to show.
		}
	}

	/** Why an update is the reviewer's to run; null: one click does it. */
	#byHandReason(): ByHandReason | null {
		if (!this.#o.install) return "no-install";
		if (!this.#o.install.writable) return "not-writable";
		if (this.#service && this.#service.exitCode === null) return "service";
		return null;
	}

	#oneClick(): boolean {
		return this.#byHandReason() === null;
	}

	#command(version: string): string {
		return this.#o.install
			? showCommand(this.#o.install.pm, version)
			: manualCommand(version);
	}

	info(): UpdateInfo {
		const v = this.#available;
		const reason = this.#o.enabled ? this.#byHandReason() : null;
		return {
			current: this.#o.build.version,
			available: v,
			releaseUrl: v ? releaseUrl(v) : null,
			oneClick: v !== null && this.#oneClick(),
			command: v ? this.#command(v) : null,
			state: this.#state,
			failed: this.#failed,
			commit: this.#o.build.commit,
			boot: BOOT_ID,
			channel: this.#channel,
			install: this.#o.enabled ? (this.#o.install?.pm ?? null) : null,
			byHand: reason !== null,
			byHandReason: reason,
			byHandManager:
				reason === "service" ? (this.#service?.manager ?? null) : null,
			lastChecked: this.#lastChecked?.toISOString() ?? null,
			checkError: this.#checkError,
			checksOff: this.#o.enabled ? null : (this.#o.off ?? "local-build"),
			withdrawn:
				this.#o.enabled && this.#withdrawn !== null
					? { reason: this.#withdrawn }
					: null,
		};
	}

	/**
	 * What's new from the running version to the one on offer, from the
	 * notes it carries on the registry (loaded once per offered version;
	 * `retry` loads again after a failure). UpdateRefusedError when nothing
	 * is on offer, NotesError with the reason when the notes didn't load.
	 */
	async notes(retry = false): Promise<UpdateNotes> {
		const version = this.#available;
		if (!this.#o.enabled || !version) {
			throw new UpdateRefusedError("No update on offer");
		}
		const result = await (retry
			? this.#notes.retry(version)
			: this.#notes.get(version));
		if (!result.ok) throw new NotesError(result.reason);
		const own = await (this.#o.ownNotes ?? runningBuildNotes)().catch(
			() => null,
		);
		return prepareUpdateNotes(
			this.#o.build.version,
			version,
			result.notes,
			own,
		);
	}

	/**
	 * Installs `version` (the one offered, nothing else) and restarts crb:
	 * under a service manager, installs while serving, then exits for the
	 * manager to start the new one; otherwise a helper installs once crb
	 * has exited and starts it again. Resolves once under way.
	 */
	async update(version: string): Promise<UpdateInfo> {
		if (this.#starting) {
			if (version === this.#starting.version) return this.#starting.done;
			throw new UpdateRefusedError("An update is already under way");
		}
		if (this.#state !== "idle") {
			if (version === this.#available) return this.info();
			throw new UpdateRefusedError("An update is already under way");
		}
		if (!this.#o.enabled || version !== this.#available) {
			throw new UpdateRefusedError(`${version} is not the update on offer`);
		}
		const install = this.#o.install;
		if (!install || !this.#oneClick()) {
			throw new UpdateRefusedError(`Update by hand: ${this.#command(version)}`);
		}
		const platform = this.#o.platform ?? process.platform;
		const cmd = installCommand(install, version, {
			platform,
			...(this.#o.execPath ? { execPath: this.#o.execPath } : {}),
			...(this.#o.exists ? { exists: this.#o.exists } : {}),
			env: this.#o.env ?? process.env,
		});
		const display = this.#command(version);
		if (this.#service) {
			const exitCode = this.#service.exitCode as number;
			this.#failed = null;
			this.#state = "installing";
			void (async () => {
				const log = (text: string) => this.#log(text);
				log(
					`[${new Date().toISOString()}] update to ${version} under ${this.#service?.manager}: ${display}\n`,
				);
				const { code, output } = await (this.#o.run ?? runCommand)(cmd, log, {
					timeoutMs: this.#o.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
					platform,
				});
				if (code === 0) {
					this.#state = "restarting";
					this.#exitSoon(exitCode);
				} else {
					this.#failed = { version, tail: tailOf(output), command: display };
					this.#state = "idle";
				}
			})();
			return this.info();
		}
		const config: HelperConfig = {
			pid: process.pid,
			waitMs: HELPER_WAIT_MS,
			version,
			install: cmd,
			display,
			relaunch: {
				execPath: this.#o.execPath ?? process.execPath,
				execArgv: [...(this.#o.execArgv ?? process.execArgv)],
				args: restartArgs(
					this.#o.argv ?? process.argv.slice(2),
					this.#o.port(),
				),
				cli: join(install.root, "dist", "cli.js"),
				packages: install.packages,
				scan: install.scan,
				cwd: this.#o.cwd ?? process.cwd(),
				env: this.#o.env ?? process.env,
				log: this.#o.serveLog ?? join(stateDir(), "serve.log"),
			},
			log: this.#logFile,
			result: this.#resultFile,
		};
		this.#failed = null;
		const done = (async () => {
			try {
				await mkdir(stateDir(), { recursive: true });
				await mkdir(cacheDir(), { recursive: true });
				await (this.#o.startHelper ?? startHelper)(config);
			} catch (error) {
				// Nothing installed: the failure, for every page (the toast's).
				const why = error instanceof Error ? error.message : String(error);
				this.#failed = {
					version,
					tail: `The updater could not start: ${why}`,
					command: display,
				};
				throw error;
			} finally {
				this.#starting = null;
			}
			this.#state = "restarting";
			this.#exitSoon(0);
			return this.info();
		})();
		this.#starting = { version, done };
		return done;
	}

	#exitSoon(code: number): void {
		setTimeout(
			() => this.#o.exit(code),
			this.#o.graceMs ?? RESTART_GRACE_MS,
		).unref();
	}

	#log(text: string): void {
		void mkdir(cacheDir(), { recursive: true })
			.then(() => writeFile(this.#logFile, text, { flag: "a", mode: 0o600 }))
			.catch(() => {});
	}
}

/** The helper's source in this build, beside this file. */
const helperSource = (): string => {
	const js = fileURLToPath(new URL("./updateHelper.js", import.meta.url));
	try {
		readFileSync(js);
		return js;
	} catch {
		// From source (tsx, Vitest): Node strips the types.
		return fileURLToPath(new URL("./updateHelper.ts", import.meta.url));
	}
};

/**
 * Copies the helper to a temp dir of its own (never run from the package
 * being replaced), writes its config there (it holds crb's environment:
 * 0600, removed once read) and starts it with node, detached. Resolves
 * with the helper's process (unref'd: crb never waits for it; a test
 * does, before removing the dirs it runs in).
 */
export async function startHelper(
	config: HelperConfig,
	opts: { source?: string; tmp?: string } = {},
): Promise<ChildProcess> {
	const tmp = opts.tmp ?? tmpdir();
	const dir = await mkdtemp(join(tmp, HELPER_DIR_PREFIX));
	try {
		const source = opts.source ?? helperSource();
		const script = join(
			dir,
			source.endsWith(".ts") ? "update-helper.mts" : "update-helper.mjs",
		);
		await copyFile(source, script);
		const configFile = join(dir, "config.json");
		await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
		return await new Promise<ChildProcess>((done, fail) => {
			const child = spawn(process.execPath, [script, "--run", configFile], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
				// Not its own dir, which it removes (Windows can't remove a
				// process's current directory).
				cwd: tmp,
			});
			child.once("spawn", () => {
				child.unref();
				done(child);
			});
			child.once("error", fail);
		});
	} catch (error) {
		// Nothing left behind, the config (crb's environment) least of all.
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Why crb serve never checks, from what it was started with: no way to
 * restart (no exit hook) is "unavailable", config.json's `updates.check:
 * false` is "config"; null: up to updaterFor (the env and the build).
 */
export const serveChecksOff = (opts: {
	canRestart: boolean;
	configCheck: boolean;
}): ChecksOff | null =>
	!opts.canRestart ? "unavailable" : opts.configCheck ? null : "config";

/**
 * The updater of this crb: on when it is a build npm served
 * (isFromNpm) and neither `$CRB_NO_UPDATE_CHECK` nor config.json's
 * `updates.check: false` turns it off (`off`: "config", or "unavailable"
 * for a server that can't restart).
 */
export function updaterFor(opts: {
	build: BuildInfo;
	off: ChecksOff | null;
	channel?: Channel;
	exit: (code: number) => void;
	port: () => number;
	env?: NodeJS.ProcessEnv;
}): Updater {
	const env = opts.env ?? process.env;
	const root = packageRoot();
	const off: ChecksOff | null =
		opts.off ??
		(env.CRB_NO_UPDATE_CHECK === "1"
			? "env"
			: isFromNpm(root, opts.build)
				? null
				: "local-build");
	const enabled = off === null;
	return new Updater({
		build: opts.build,
		enabled,
		...(off ? { off } : {}),
		install: enabled ? detectInstall(root) : null,
		...(opts.channel ? { channel: opts.channel } : {}),
		exit: opts.exit,
		port: opts.port,
		env,
	});
}
