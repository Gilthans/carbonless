import { type ChildProcess, spawn } from "node:child_process";
import { CLI, crbEnv } from "./pr-setup";

/*
 * crb's processes in e2e: a `crb serve` until it prints its URL, a CLI run
 * to its exit, a SIGTERM stop. The test fixtures (fixtures.ts) and the
 * warm-up before the workers (global-setup.ts) start them the same way.
 */

/** startCrb's rejection when `crb <pr>` exits without printing a URL. */
export class CrbExitError extends Error {
	constructor(
		readonly code: number | null,
		readonly output: string,
	) {
		super(`crb exited with ${code}:\n${output}`);
	}
}

const START_TIMEOUT_MS = 20_000;

/**
 * How long crb may take to exit after SIGTERM before the harness kills it
 * and fails the test. A crb that waited for the browser's sockets would take
 * Node's 60 s headers timeout or longer; a loaded machine can stretch a
 * prompt exit past a few seconds.
 */
const STOP_GRACE_MS = 10_000;

export interface CrbExit {
	code: number | null;
	/** Milliseconds from SIGTERM to exit. */
	ms: number;
}

/** startServe's rejection when crb serve prints no URL in time (it is killed). */
export class CrbStartTimeout extends Error {
	constructor(
		readonly pid: number | undefined,
		message: string,
	) {
		super(message);
	}
}

/** A running `crb serve` of a test. */
export interface Served {
	child: ChildProcess;
	/** Where it listens, as it logged it (`http://<host>:<port>/[?key=...]`). */
	url: string;
	/** Everything it has logged so far. */
	output(): string;
}

/** Starts `crb serve` on a free port in `workdir`'s environment. */
export function startServe(
	workdir: string,
	args: string[] = [],
	env: NodeJS.ProcessEnv = crbEnv(workdir),
	timeoutMs = START_TIMEOUT_MS,
): Promise<Served> {
	const child = spawn(
		process.execPath,
		[CLI, "serve", "--port", "0", ...args],
		{
			cwd: workdir,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		},
	);
	let output = "";
	return new Promise<Served>((done, fail) => {
		// A start that missed its time is killed: no one else holds it to
		// stop it (the caller never got a Served), and it would outlive the run.
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			fail(
				new CrbStartTimeout(
					child.pid,
					`crb serve printed no URL in time:\n${output}`,
				),
			);
		}, timeoutMs);
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			const match = output.match(/carbonless listening on (http:\/\/\S+)/);
			if (match?.[1]) {
				clearTimeout(timer);
				done({ child, url: match[1], output: () => output });
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timer);
			fail(new CrbExitError(code, output));
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			fail(new Error(`could not start crb serve: ${error.message}`));
		});
	});
}

/** Runs the CLI to its exit: its code, stdout and both outputs together. */
export function runCli(
	workdir: string,
	args: string[],
	env: NodeJS.ProcessEnv = crbEnv(workdir),
): Promise<{ code: number | null; stdout: string; output: string }> {
	const child = spawn(process.execPath, [CLI, ...args], {
		cwd: workdir,
		stdio: ["ignore", "pipe", "pipe"],
		env,
	});
	let stdout = "";
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	return new Promise((done, fail) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			fail(new Error(`crb ${args.join(" ")} did not finish:\n${output}`));
		}, START_TIMEOUT_MS);
		child.once("close", (code) => {
			clearTimeout(timer);
			done({ code, stdout, output });
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			fail(new Error(`could not run crb: ${error.message}`));
		});
	});
}

/**
 * Sends SIGTERM and waits for the exit. Rejects (failing the test) when crb
 * needed a SIGKILL or exited with anything but 0: Ctrl-C must stop it even
 * while a browser tab holds connections open.
 */
export function stopChild(child: ChildProcess): Promise<CrbExit | null> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(null);
	}
	return new Promise((done, fail) => {
		const started = Date.now();
		let killed = false;
		const force = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, STOP_GRACE_MS);
		child.once("exit", (code) => {
			clearTimeout(force);
			const ms = Date.now() - started;
			if (killed) {
				fail(new Error(`crb ignored SIGTERM for ${STOP_GRACE_MS} ms`));
			} else if (code !== 0) {
				fail(new Error(`crb exited with ${code} after SIGTERM`));
			} else {
				done({ code, ms });
			}
		});
		child.kill("SIGTERM");
	});
}
