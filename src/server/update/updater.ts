import { spawn } from "node:child_process";
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
	releaseUrl,
	type UpdateFailure,
	type UpdateInfo,
} from "../../shared/update.js";
import { cacheDir, stateDir } from "../paths.js";
import type { BuildInfo } from "../version.js";
import {
	detectInstall,
	type Install,
	installCommand,
	isFromNpm,
	manualCommand,
	restartArgs,
	showCommand,
} from "./install.js";
import { newerOnRegistry, registryUrl } from "./registry.js";
import { channelOf } from "./semver.js";
import { detectService, type Service } from "./service.js";
import {
	HELPER_DIR_PREFIX,
	type HelperConfig,
	runCommand,
	tailOf,
	type UpdateResult,
} from "./updateHelper.js";

export type Channel = "rc" | "latest";

/** How often the registry is asked again after the check at start. */
export const CHECK_EVERY_MS = 6 * 60 * 60_000;

/**
 * How long crb keeps answering "restarting" before it stops: every open
 * page polls /api/update more often than this while an update is on offer
 * (UPDATE_WATCH_MS), so each shows the update and waits to reload.
 */
export const RESTART_GRACE_MS = 6_000;

/** How long the helper waits for crb to exit before giving up. */
const HELPER_WAIT_MS = 60_000;

/** A request the updater refuses (HTTP 409). */
export class UpdateRefusedError extends Error {}

/** The package directory this build runs from (dist/server/update/ → root), real. */
export function packageRoot(): string {
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
	/** How crb was installed (null: unknown, the command instead). */
	install: Install | null;
	/** The registry's newer version, or null (newerOnRegistry). */
	check?: (current: string, channel: Channel) => Promise<string | null>;
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
	/** RESTART_GRACE_MS, shorter in tests. */
	graceMs?: number;
	/** Where the helper's result is left for the next crb. */
	resultFile?: string;
	logFile?: string;
	platform?: NodeJS.Platform;
}

/**
 * crb's self-update (CAR-108): asks npm for a newer version at start and
 * every CHECK_EVERY_MS, and on the reviewer's click installs exactly that
 * version and restarts crb in place. Never automatic; silent on any
 * failure to check.
 */
export class Updater {
	#available: string | null = null;
	#state: UpdateInfo["state"] = "idle";
	#failed: UpdateFailure | null = null;
	#service: Service | null = null;
	#timer: NodeJS.Timeout | null = null;
	#checking: Promise<void> | null = null;
	#channel: Channel = "latest";
	readonly #o: UpdaterOptions;

	constructor(options: UpdaterOptions) {
		this.#o = options;
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

	/** One check of the registry (one at a time). */
	checkNow(): Promise<void> {
		this.#checking ??= (async () => {
			try {
				const check =
					this.#o.check ??
					((current: string, channel: Channel) =>
						newerOnRegistry(current, {
							registry: registryUrl(this.#o.env),
							channel,
						}));
				const newer = await check(this.#o.build.version, this.#channel).catch(
					() => null,
				);
				// A failed check keeps what an earlier one found.
				if (newer !== null) this.#available = newer;
			} finally {
				this.#checking = null;
			}
		})();
		return this.#checking;
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

	#oneClick(): boolean {
		if (!this.#o.install) return false;
		return !this.#service || this.#service.exitCode !== null;
	}

	#command(version: string): string {
		return this.#o.install
			? showCommand(installCommand(this.#o.install.pm, version, "linux"))
			: manualCommand(version);
	}

	info(): UpdateInfo {
		const v = this.#available;
		return {
			current: this.#o.build.version,
			available: v,
			releaseUrl: v ? releaseUrl(v) : null,
			oneClick: v !== null && this.#oneClick(),
			command: v ? this.#command(v) : null,
			state: this.#state,
			failed: this.#failed,
		};
	}

	/**
	 * Installs `version` (the one offered, nothing else) and restarts crb:
	 * under a service manager, installs while serving, then exits for the
	 * manager to start the new one; otherwise a helper installs once crb
	 * has exited and starts it again. Resolves once under way.
	 */
	async update(version: string): Promise<UpdateInfo> {
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
		const cmd = installCommand(install.pm, version, platform);
		const shell = platform === "win32";
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
				const { code, output } = await (this.#o.run ?? runCommand)(
					{ ...cmd, shell },
					log,
				);
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
		const launcher = install.launcher;
		const config: HelperConfig = {
			pid: process.pid,
			waitMs: HELPER_WAIT_MS,
			version,
			install: { ...cmd, shell },
			display,
			relaunch: {
				command: launcher.command,
				args: [
					...launcher.args,
					...restartArgs(this.#o.argv ?? process.argv.slice(2), this.#o.port()),
				],
				shell: shell && /\.cmd$/i.test(launcher.command),
				cwd: this.#o.cwd ?? process.cwd(),
				env: this.#o.env ?? process.env,
			},
			log: this.#logFile,
			result: this.#resultFile,
		};
		this.#failed = null;
		this.#state = "restarting";
		try {
			await mkdir(stateDir(), { recursive: true });
			await mkdir(cacheDir(), { recursive: true });
			await (this.#o.startHelper ?? startHelper)(config);
		} catch (error) {
			this.#state = "idle";
			throw error;
		}
		this.#exitSoon(0);
		return this.info();
	}

	#exitSoon(code: number): void {
		setTimeout(
			() => this.#o.exit(code),
			this.#o.graceMs ?? RESTART_GRACE_MS,
		).unref();
	}

	#log(text: string): void {
		void mkdir(cacheDir(), { recursive: true })
			.then(() => writeFile(this.#logFile, text, { flag: "a" }))
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
 * 0600, removed once read) and starts it with node, detached.
 */
export async function startHelper(config: HelperConfig): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), HELPER_DIR_PREFIX));
	const source = helperSource();
	const script = join(
		dir,
		source.endsWith(".ts") ? "update-helper.mts" : "update-helper.mjs",
	);
	await copyFile(source, script);
	const configFile = join(dir, "config.json");
	await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
	await new Promise<void>((done, fail) => {
		const child = spawn(process.execPath, [script, configFile], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			cwd: dir,
		});
		child.once("spawn", () => {
			child.unref();
			done();
		});
		child.once("error", fail);
	});
}

/**
 * The updater of this crb: on when it is a build npm served
 * (isFromNpm) and neither `$CRB_NO_UPDATE_CHECK` nor config.json's
 * `updates.check: false` turns it off.
 */
export function updaterFor(opts: {
	build: BuildInfo;
	off: boolean;
	channel?: Channel;
	exit: (code: number) => void;
	port: () => number;
	env?: NodeJS.ProcessEnv;
}): Updater {
	const env = opts.env ?? process.env;
	const root = packageRoot();
	const enabled =
		!opts.off && env.CRB_NO_UPDATE_CHECK !== "1" && isFromNpm(root, opts.build);
	return new Updater({
		build: opts.build,
		enabled,
		install: enabled ? detectInstall(root) : null,
		...(opts.channel ? { channel: opts.channel } : {}),
		exit: opts.exit,
		port: opts.port,
		env,
	});
}
