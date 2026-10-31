import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	test as base,
	expect,
	type Page,
	type TestInfo,
} from "@playwright/test";
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
	url: string;
	output(): string;
	/** SIGTERMs crb; rejects unless it exits promptly with 0. */
	stop(): Promise<CrbExit | null>;
}

/** startCrb's rejection when the CLI exits before printing its URL. */
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

/**
 * Runs a test's setup step (a fixture repo, starting crb) and gives the test
 * back the time it took: on a loaded machine these take seconds, and the
 * test's own timeout is for its own steps. START_TIMEOUT_MS still bounds a
 * start that hangs.
 */
async function untimed<T>(info: TestInfo, step: () => T | Promise<T>) {
	const started = Date.now();
	try {
		return await step();
	} finally {
		if (info.timeout > 0) info.setTimeout(info.timeout + Date.now() - started);
	}
}

export interface CrbExit {
	code: number | null;
	/** Milliseconds from SIGTERM to exit. */
	ms: number;
}

/**
 * Sends SIGTERM and waits for the exit. Rejects (failing the test) when crb
 * needed a SIGKILL or exited with anything but 0: Ctrl-C must stop it even
 * while a browser tab holds connections open.
 */
function stopChild(child: ChildProcess): Promise<CrbExit | null> {
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

	pr: async ({ workdir }, use, info) => {
		const repos: GitFixture[] = [];
		await use(async (opts = {}) => {
			const pr = await untimed(info, () => createPr(workdir, opts));
			repos.push(pr.repo);
			return pr;
		});
		for (const repo of repos) repo.cleanup();
	},

	startCrb: async ({ workdir, context }, use, info) => {
		const children: ChildProcess[] = [];
		await use((arg = `${OWNER_REPO}#${PR_NUMBER}`, extraArgs = []) =>
			untimed(info, async () => {
				const child = spawn(
					process.execPath,
					[CLI, arg, "--no-open", ...extraArgs],
					{
						cwd: workdir,
						stdio: ["ignore", "pipe", "pipe"],
						env: crbEnv(workdir),
					},
				);
				children.push(child);
				let output = "";
				const url = await new Promise<string>((done, fail) => {
					const timer = setTimeout(
						() => fail(new Error(`crb printed no URL in time:\n${output}`)),
						START_TIMEOUT_MS,
					);
					const onData = (chunk: Buffer) => {
						output += chunk.toString();
						const match = output.match(
							/carbonless listening on (http:\/\/\S+)/,
						);
						if (match?.[1]) {
							clearTimeout(timer);
							done(match[1]);
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
						fail(new Error(`could not start crb: ${error.message}`));
					});
				});
				return { url, output: () => output, stop: () => stopChild(child) };
			}),
		);
		// Pages would keep polling the stopped server and log connection errors.
		await Promise.all(
			context.pages().map((p) => p.goto("about:blank").catch(() => {})),
		);
		await Promise.all(children.map(stopChild));
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
