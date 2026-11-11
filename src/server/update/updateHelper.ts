// crb's update helper: copied out of the package to a temp directory and run
// there with node, detached, by the crb that is updating (never from the
// package being replaced). It waits for that crb to exit (freeing its port),
// installs the new version, writes the result where the next crb reads it,
// and starts crb again with the same arguments, directory and environment.
// Node built-ins only: nothing beside it resolves.
import { spawn } from "node:child_process";
import {
	appendFileSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** A command; `shell` only for a Windows `.cmd` (Node runs those no other way). */
export interface HelperCommand {
	command: string;
	args: string[];
	shell?: boolean;
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
	relaunch: (HelperCommand & { cwd: string; env: NodeJS.ProcessEnv }) | null;
	/** Where everything is logged (crb's cache dir). */
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

/** Runs `c`, its output logged and kept; resolves with its exit code. */
export function runCommand(
	c: HelperCommand,
	log: (text: string) => void,
): Promise<{ code: number; output: string }> {
	return new Promise((done) => {
		let output = "";
		const child = spawn(c.command, c.args, {
			stdio: ["ignore", "pipe", "pipe"],
			shell: c.shell ?? false,
			windowsHide: true,
		});
		const take = (chunk: Buffer) => {
			const text = chunk.toString();
			output += text;
			log(text);
		};
		child.stdout?.on("data", take);
		child.stderr?.on("data", take);
		child.once("error", (error) => {
			output += `${error.message}\n`;
			log(`${error.message}\n`);
			done({ code: -1, output });
		});
		child.once("close", (code) => done({ code: code ?? -1, output }));
	});
}

export const tailOf = (text: string, lines = TAIL_LINES): string =>
	text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");

export async function runHelper(config: HelperConfig): Promise<UpdateResult> {
	const log = (text: string) => {
		try {
			appendFileSync(config.log, text);
		} catch {
			// Logging is best effort.
		}
	};
	const stamp = (text: string) =>
		log(`[${new Date().toISOString()}] ${text}\n`);
	stamp(`update to ${config.version}: waiting for crb (pid ${config.pid})`);
	let result: UpdateResult;
	if (!(await waitExit(config.pid, config.waitMs))) {
		stamp("crb did not exit; nothing installed");
		result = {
			version: config.version,
			ok: false,
			tail: `crb (pid ${config.pid}) did not exit; nothing was installed`,
			command: config.display,
			at: new Date().toISOString(),
		};
		writeFileSync(config.result, `${JSON.stringify(result)}\n`);
		// It still runs: nothing to start again.
		return result;
	}
	stamp(`running ${config.display}`);
	const { code, output } = await runCommand(config.install, log);
	stamp(`install exited with ${code}`);
	result = {
		version: config.version,
		ok: code === 0,
		tail: tailOf(output),
		command: config.display,
		at: new Date().toISOString(),
	};
	writeFileSync(config.result, `${JSON.stringify(result)}\n`);
	if (config.relaunch) {
		const r = config.relaunch;
		stamp(`starting ${[r.command, ...r.args].join(" ")}`);
		const out = openSync(config.log, "a");
		const child = spawn(r.command, r.args, {
			cwd: r.cwd,
			env: r.env,
			detached: true,
			stdio: ["ignore", out, out],
			shell: r.shell ?? false,
			windowsHide: true,
		});
		child.once("error", (error) =>
			stamp(`could not start crb: ${error.message}`),
		);
		child.unref();
		// Its pid is known once spawned; an error event comes after.
		await new Promise((r) => setTimeout(r, 200));
	}
	return result;
}

const isMain = (() => {
	try {
		return (
			!!process.argv[1] &&
			realpathSync(process.argv[1]) ===
				realpathSync(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
})();

if (isMain) {
	const file = process.argv[2];
	if (!file) {
		console.error("usage: node update-helper.mjs <config.json>");
		process.exitCode = 2;
	} else {
		const config = JSON.parse(readFileSync(file, "utf8")) as HelperConfig;
		// It holds crb's environment: gone once read.
		rmSync(file, { force: true });
		await runHelper(config);
		// The helper's own temp dir (a running script can be removed), only
		// when it is one crb made.
		const own = dirname(fileURLToPath(import.meta.url));
		if (basename(own).startsWith(HELPER_DIR_PREFIX)) {
			rmSync(own, { recursive: true, force: true });
		}
	}
}
