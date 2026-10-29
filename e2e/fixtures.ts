import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import type { GitFixture } from "../test/git-fixture";
import {
	CLI,
	crbEnv,
	createPr,
	OWNER_REPO,
	PR_NUMBER,
	type Pr,
	type PrOptions,
} from "./pr-setup";

export type {
	Pr,
	PrOptions,
	ThreadJson,
	ViewJson,
} from "./pr-setup";
export { OWNER_REPO, PR_NUMBER };

export interface Crb {
	/** The review's URL, as `crb <pr>` printed it: `http://<host>:<port>/r/<id>`. */
	url: string;
	/** What crb serve logged since this `crb <pr>`, then the client's own output. */
	output(): string;
	/** SIGTERMs the test's crb serve; rejects unless it exits promptly with 0. */
	stop(): Promise<CrbExit | null>;
}

/** startCrb's rejection when `crb <pr>` exits without printing a URL. */
export class CrbExitError extends Error {
	constructor(
		readonly code: number | null,
		readonly output: string,
	) {
		super(`crb exited with ${code}:\n${output}`);
	}
}

/**
 * A page of the review at `url` (`crb <pr>`'s): "files", or "" for the
 * overview, with `search` ("?path=...") and the URL's own key kept.
 */
export function reviewPage(url: string, page: string, search = ""): string {
	const u = new URL(url);
	u.pathname = `${u.pathname.replace(/\/$/, "")}/${page}`;
	const params = new URLSearchParams(search);
	for (const [k, v] of params) u.searchParams.set(k, v);
	return u.href;
}

const START_TIMEOUT_MS = 20_000;

/** How long crb may take to exit after SIGTERM before the harness kills it. */
const STOP_GRACE_MS = 3_000;

export interface CrbExit {
	code: number | null;
	/** Milliseconds from SIGTERM to exit. */
	ms: number;
}

/** The options `crb serve` takes, with whether each takes a value. */
const SERVE_FLAGS: Record<string, boolean> = {
	"--host": true,
	"--port": true,
	"--new-key": false,
};

/** `args` split into crb serve's and the client's. */
function splitArgs(args: string[]): { serve: string[]; client: string[] } {
	const serve: string[] = [];
	const client: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		const takesValue = SERVE_FLAGS[arg];
		if (takesValue === undefined) client.push(arg);
		else serve.push(arg, ...(takesValue ? [args[++i] as string] : []));
	}
	return { serve, client };
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
		const timer = setTimeout(
			() => fail(new Error(`crb serve printed no URL in time:\n${output}`)),
			START_TIMEOUT_MS,
		);
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

export const test = base.extend<{
	workdir: string;
	pr: (opts?: PrOptions) => Promise<Pr>;
	startCrb: (arg?: string, extraArgs?: string[]) => Promise<Crb>;
	/**
	 * Auto fixture: fails the test on browser console errors and uncaught page
	 * errors, except those matching a pattern declared with
	 * `expectConsoleError(/409/)` (Chromium logs "Failed to load resource"
	 * for every non-2xx fetch).
	 */
	expectConsoleError: (pattern: RegExp) => void;
}>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern.
	workdir: async ({}, use) => {
		const dir = mkdtempSync(join(tmpdir(), "crb-e2e-"));
		await use(dir);
		rmSync(dir, { recursive: true, force: true });
	},

	pr: async ({ workdir }, use) => {
		const repos: GitFixture[] = [];
		await use(async (opts = {}) => {
			const pr = createPr(workdir, opts);
			repos.push(pr.repo);
			return pr;
		});
		for (const repo of repos) repo.cleanup();
	},

	startCrb: async ({ workdir, context }, use) => {
		// One crb serve per test, started by the first crb <pr> (and again
		// after a stop), as the CLI's auto-start would.
		const servers: Served[] = [];
		let current: Served | null = null;
		await use(async (arg = `${OWNER_REPO}#${PR_NUMBER}`, extraArgs = []) => {
			const { serve, client } = splitArgs(extraArgs);
			const live =
				current &&
				current.child.exitCode === null &&
				current.child.signalCode === null;
			if (!current || !live) {
				current = await startServe(workdir, serve);
				servers.push(current);
			}
			const server = current;
			const from = server.output().length;
			const run = await runCli(workdir, [arg, ...client]);
			const output = () => `${server.output().slice(from)}${run.output}`;
			const url = run.stdout.trim().split("\n").at(-1) ?? "";
			if (run.code !== 0 || !/^http:\/\//.test(url)) {
				throw new CrbExitError(run.code, output());
			}
			return { url, output, stop: () => stopChild(server.child) };
		});
		// Pages would keep polling the stopped server and log connection errors.
		await Promise.all(
			context.pages().map((p) => p.goto("about:blank").catch(() => {})),
		);
		await Promise.all(servers.map((s) => stopChild(s.child)));
	},

	expectConsoleError: [
		async ({ page }, use) => {
			const watch = watchConsoleErrors(page);
			await use(watch.expect);
			expect(watch.unexpected(), "unexpected browser console errors").toEqual(
				[],
			);
		},
		{ auto: true },
	],
});

export interface ConsoleErrorWatch {
	/** Declares errors matching `pattern` as expected. */
	expect: (pattern: RegExp) => void;
	/** Console and uncaught page errors seen so far, minus the expected ones. */
	unexpected: () => string[];
}

/** Collects `page`'s console errors and uncaught errors (see expectConsoleError). */
export function watchConsoleErrors(page: Page): ConsoleErrorWatch {
	const errors: string[] = [];
	const expected: RegExp[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	return {
		expect: (pattern) => {
			expected.push(pattern);
		},
		unexpected: () =>
			errors.filter((text) => !expected.some((pattern) => pattern.test(text))),
	};
}

export { expect };
