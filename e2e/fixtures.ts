import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	test as base,
	expect,
	type Locator,
	type Page,
	type TestInfo,
} from "@playwright/test";
import type { GitFixture } from "../test/git-fixture";
import {
	collectUnits,
	isolationProblems,
	statesOf,
	type UnitState,
	unitProblems,
} from "../test/markable";
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
		// One crb serve per test, started by the first crb <pr> (and again
		// after a stop), as the CLI's auto-start would.
		const servers: Served[] = [];
		let current: Served | null = null;
		let currentFlags = "";
		await use((arg = `${OWNER_REPO}#${PR_NUMBER}`, extraArgs = []) =>
			untimed(info, async () => {
				const { serve, client } = splitArgs(extraArgs);
				const live =
					current &&
					current.child.exitCode === null &&
					current.child.signalCode === null;
				if (!current || !live) {
					current = await startServe(workdir, serve);
					currentFlags = serve.join(" ");
					servers.push(current);
				} else if (serve.length > 0 && serve.join(" ") !== currentFlags) {
					throw new Error(
						`crb serve already runs with "${currentFlags}", not "${serve.join(" ")}": stop() it first`,
					);
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
			}),
		);
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

/**
 * Loading never looks empty (design principle 8), on a page: while the
 * answer is held (the fake gh's `hold`), `loading` is visible and none of
 * `empty` (nor `result`) is; once `release()` lets it go (`release(path,
 * op)`), `result` shows and `loading` is gone. `release` may assert more
 * while still held before it lets the answer go.
 */
export async function expectLoadingThen(opts: {
	loading: Locator;
	empty?: Locator[];
	release: () => void | Promise<void>;
	result: Locator;
	/** For the result, after the release (a slow machine). */
	timeout?: number;
}): Promise<void> {
	await expect(opts.loading).toBeVisible();
	for (const empty of opts.empty ?? []) await expect(empty).toHaveCount(0);
	await expect(opts.result).toHaveCount(0);
	await opts.release();
	await expect(opts.result.first()).toBeVisible({
		timeout: opts.timeout ?? 15_000,
	});
	await expect(opts.loading).toHaveCount(0);
}

/**
 * The "every visible cluster is individually markable" invariant on a live
 * page (docs/product-rules.md; the units as test/markable.ts reads them):
 * every unit in `scope` (a file's section) has its own enabled reviewed
 * checkbox and cross-off; ticking, unticking, crossing off and undoing each
 * one changes that unit alone; the states left are there again after a
 * reload (`reopen` opens the file again). `cycle: "tick"` only ticks and
 * unticks each unit (fewer writes, for the repeat runs of a file).
 * `readOnly`: an earlier patch set: every control is locked and the
 * read-only chip shows.
 */
export async function expectEveryUnitMarkable(
	scope: Locator,
	opts: {
		readOnly?: boolean;
		cycle?: "full" | "tick";
		reopen?: () => Promise<void>;
	} = {},
): Promise<void> {
	const page = scope.page();
	const units = await scope.evaluate(collectUnits);
	expect(units.length, "the file shows no unit").toBeGreaterThan(0);
	expect(unitProblems(units, opts)).toEqual([]);
	if (opts.readOnly) {
		await expect(page.getByTestId("read-only-note")).toBeVisible();
		return;
	}
	const states = async () => statesOf(await scope.evaluate(collectUnits));
	const use = async (i: number, control: "box" | "cross", want: UnitState) => {
		const before = await states();
		await scope
			.locator(
				`[data-markable-unit="${i}"] ${
					control === "box"
						? 'input[type="checkbox"]'
						: 'button[aria-label="Cross off cluster"]'
				}`,
			)
			.click();
		await expect
			.poll(async () => isolationProblems(i, before, await states(), want))
			.toEqual([]);
	};
	for (const u of units) {
		const now = (await states())[u.index];
		if (now === "reviewed") {
			await use(u.index, "box", "unreviewed");
			await use(u.index, "box", "reviewed");
		} else if (now === "crossed-off") {
			await use(u.index, "box", "unreviewed");
			await use(u.index, "cross", "crossed-off");
		} else {
			await use(u.index, "box", "reviewed");
			await use(u.index, "box", "unreviewed");
			if (opts.cycle !== "tick") {
				await use(u.index, "cross", "crossed-off");
				await use(u.index, "box", "unreviewed");
			}
		}
	}
	if (!opts.reopen) return;
	// Every other unit ticked, then a reload: each keeps its own state.
	for (const u of units) {
		if (u.index % 2 === 0 && (await states())[u.index] === "unreviewed") {
			await use(u.index, "box", "reviewed");
		}
	}
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
	const left = await states();
	await page.reload();
	await opts.reopen();
	await expect.poll(states).toEqual(left);
}

export { expect };
