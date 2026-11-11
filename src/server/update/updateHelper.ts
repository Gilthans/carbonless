// crb's update helper: copied out of the package to a temp directory and run
// there with node (`--run <config>`), detached, by the crb that is updating
// (never from the package being replaced). It waits for that crb to exit
// (freeing its port), installs the new version, writes the result where the
// next crb reads it, and starts crb again with the same arguments, directory
// and environment. Node built-ins only: nothing beside it resolves.
import { spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A command, and what to add to its environment. */
export interface HelperCommand {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

/** How the helper starts crb again: node on the new package's cli.js. */
export interface Relaunch {
	execPath: string;
	execArgv: string[];
	/** crb's own arguments (`serve ...`). */
	args: string[];
	/** The package's cli.js before the install: used when no new one is found. */
	cli: string;
	/** Package dirs that may hold the new version (npm: in place). */
	packages: string[];
	/**
	 * Dirs whose entries may each hold `node_modules/carbonless-review`
	 * (pnpm puts every global install in a new one).
	 */
	scan: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** Where crb's own output goes (serve.log, as when `crb <pr>` starts it). */
	log: string;
}

export interface HelperConfig {
	/** The crb to wait for. */
	pid: number;
	/** How long to wait for it before giving up (nothing installed). */
	waitMs: number;
	version: string;
	install: HelperCommand;
	/** The command as shown to the reviewer, to run by hand on a failure. */
	display: string;
	/** null: a service manager starts crb again; the helper doesn't. */
	relaunch: Relaunch | null;
	/** Where the helper and the install log (crb's cache dir; 0600). */
	log: string;
	/** Where the outcome is written (UpdateResult), for the next crb. */
	result: string;
}

/** What the helper leaves for the next crb. */
export interface UpdateResult {
	version: string;
	ok: boolean;
	/** The install's output, its last lines. */
	tail: string;
	command: string;
	at: string;
}

const TAIL_LINES = 30;
const PACKAGE = "carbonless-review";
/** serve.log moves to serve.log.1 past this (client.ts's trimLog). */
const LOG_LIMIT = 1024 * 1024;
const PRIVATE = 0o600;

/** The temp dirs crb copies the helper into (`crb-update-XXXXXX`). */
export const HELPER_DIR_PREFIX = "crb-update-";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Waits until `pid` is gone; false when it outlived `ms`. */
async function waitExit(pid: number, ms: number): Promise<boolean> {
	const until = Date.now() + ms;
	while (alive(pid)) {
		if (Date.now() > until) return false;
		await new Promise((r) => setTimeout(r, 100));
	}
	return true;
}

const PLAIN = /^[A-Za-z0-9@._=:,+\\/-]+$/;
const CMD_SPECIAL = /["%^&|<>!\r\n]/;

/**
 * An argument for cmd.exe: as is when plain, quoted when it has spaces;
 * anything cmd.exe would read (quotes, %, ^, &, |, <, >, !) is refused.
 */
export function cmdQuote(arg: string): string {
	if (PLAIN.test(arg)) return arg;
	if (CMD_SPECIAL.test(arg) || arg === "") {
		throw new Error(`Can't pass ${JSON.stringify(arg)} to cmd.exe`);
	}
	return `"${arg}"`;
}

/** A Windows batch shim (npm.cmd, pnpm.cmd): runs only through cmd.exe. */
export const isBatch = (command: string, platform = process.platform) =>
	platform === "win32" && /\.(cmd|bat)$/i.test(command);

/**
 * Runs `c`, its output logged and kept; resolves with its exit code (-1
 * when it couldn't start, or was killed after `timeoutMs`). A Windows
 * `.cmd` goes through cmd.exe with every part quoted (cmdQuote).
 */
export function runCommand(
	c: HelperCommand,
	log: (text: string) => void,
	opts: { timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<{ code: number; output: string }> {
	return new Promise((done) => {
		let output = "";
		const fail = (message: string) => {
			output += `${message}\n`;
			log(`${message}\n`);
			done({ code: -1, output });
		};
		const env = { ...process.env, ...c.env };
		let child: ReturnType<typeof spawn>;
		try {
			child = isBatch(c.command, opts.platform)
				? spawn([c.command, ...c.args].map(cmdQuote).join(" "), [], {
						stdio: ["ignore", "pipe", "pipe"],
						shell: true,
						windowsHide: true,
						env,
					})
				: spawn(c.command, c.args, {
						stdio: ["ignore", "pipe", "pipe"],
						windowsHide: true,
						env,
					});
		} catch (error) {
			fail((error as Error).message);
			return;
		}
		const timer = opts.timeoutMs
			? setTimeout(() => {
					output += `Timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)} s\n`;
					child.kill();
				}, opts.timeoutMs)
			: null;
		const take = (chunk: Buffer) => {
			const text = chunk.toString();
			output += text;
			log(text);
		};
		child.stdout?.on("data", take);
		child.stderr?.on("data", take);
		child.once("error", (error) => {
			if (timer) clearTimeout(timer);
			fail(error.message);
		});
		child.once("close", (code) => {
			if (timer) clearTimeout(timer);
			done({ code: code ?? -1, output });
		});
	});
}

export const tailOf = (text: string, lines = TAIL_LINES): string =>
	text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");

/** The version a package dir holds (its dist/build-info.json), or null. */
function versionAt(pkg: string): string | null {
	try {
		const info = JSON.parse(
			readFileSync(join(pkg, "dist", "build-info.json"), "utf8"),
		) as { version?: unknown };
		return typeof info.version === "string" ? info.version : null;
	} catch {
		return null;
	}
}

/** The cli.js of the installed `version`, or null when none is found. */
export function findInstalled(r: Relaunch, version: string): string | null {
	const candidates = [...r.packages];
	for (const dir of r.scan) {
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const e of entries) {
			candidates.push(join(dir, e, "node_modules", PACKAGE));
		}
	}
	for (const pkg of candidates) {
		const cli = join(pkg, "dist", "cli.js");
		if (versionAt(pkg) === version && existsSync(cli)) return cli;
	}
	return null;
}

/** serve.log for appending (0600), moved aside first past LOG_LIMIT. */
function openServeLog(file: string): number {
	try {
		if (statSync(file).size > LOG_LIMIT) renameSync(file, `${file}.1`);
	} catch {
		// No log yet.
	}
	const fd = openSync(file, "a", PRIVATE);
	try {
		chmodSync(file, PRIVATE);
	} catch {
		// Best effort (Windows ignores it).
	}
	return fd;
}

export async function runHelper(config: HelperConfig): Promise<UpdateResult> {
	try {
		appendFileSync(config.log, "", { mode: PRIVATE });
		chmodSync(config.log, PRIVATE);
	} catch {
		// Logging is best effort.
	}
	const log = (text: string) => {
		try {
			appendFileSync(config.log, text, { mode: PRIVATE });
		} catch {
			// Logging is best effort.
		}
	};
	const stamp = (text: string) =>
		log(`[${new Date().toISOString()}] ${text}\n`);
	const finish = (result: UpdateResult) => {
		try {
			writeFileSync(config.result, `${JSON.stringify(result)}\n`, {
				mode: PRIVATE,
			});
		} catch (error) {
			stamp(`could not write the result: ${(error as Error).message}`);
		}
		return result;
	};
	stamp(`update to ${config.version}: waiting for crb (pid ${config.pid})`);
	if (!(await waitExit(config.pid, config.waitMs))) {
		stamp("crb did not exit; nothing installed");
		// It still runs: nothing to start again.
		return finish({
			version: config.version,
			ok: false,
			tail: `crb (pid ${config.pid}) did not exit; nothing was installed`,
			command: config.display,
			at: new Date().toISOString(),
		});
	}
	stamp(`running ${config.display}`);
	const { code, output } = await runCommand(config.install, log);
	stamp(`install exited with ${code}`);
	const result = finish({
		version: config.version,
		ok: code === 0,
		tail: tailOf(output),
		command: config.display,
		at: new Date().toISOString(),
	});
	const r = config.relaunch;
	if (r) {
		const found = code === 0 ? findInstalled(r, config.version) : null;
		if (code === 0 && !found)
			stamp(`${config.version} not found; starting ${r.cli}`);
		const cli = found ?? r.cli;
		const args = [...r.execArgv, cli, ...r.args];
		stamp(`starting ${r.execPath} ${args.join(" ")}`);
		try {
			const out = openServeLog(r.log);
			const child = spawn(r.execPath, args, {
				cwd: r.cwd,
				env: r.env,
				detached: true,
				stdio: ["ignore", out, out],
				windowsHide: true,
			});
			child.once("error", (error) =>
				stamp(`could not start crb: ${error.message}`),
			);
			child.unref();
			// An error event comes after spawn returns.
			await new Promise((done) => setTimeout(done, 200));
		} catch (error) {
			stamp(`could not start crb: ${(error as Error).message}`);
		}
	}
	return result;
}

/** `node update-helper.mjs --run <config.json>`: what crb starts. */
async function main(file: string): Promise<void> {
	let config: HelperConfig;
	try {
		config = JSON.parse(readFileSync(file, "utf8")) as HelperConfig;
	} finally {
		// It holds crb's environment: gone once read, read or not.
		rmSync(file, { force: true });
	}
	try {
		await runHelper(config);
	} finally {
		// The helper's own temp dir, only when it is one crb made; best
		// effort (Windows can refuse while anything holds it).
		const own = dirname(fileURLToPath(import.meta.url));
		if (basename(own).startsWith(HELPER_DIR_PREFIX)) {
			try {
				rmSync(own, { recursive: true, force: true });
			} catch {
				// Left in the temp dir.
			}
		}
	}
}

if (process.argv[2] === "--run" && process.argv[3]) {
	await main(process.argv[3]);
}
