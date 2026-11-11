import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	test as base,
	expect,
	type Locator,
	type Page,
	type TestInfo,
} from "@playwright/test";
import { traceparent, tracer } from "../src/server/trace";
import type { GitFixture } from "../test/git-fixture";
import { testSpanContext } from "../test/trace-run";
import { type CrbClient, openOverHttp } from "./crb-open";
import {
	type CrbExit,
	CrbExitError,
	runCli,
	type Served,
	startServe,
	stopChild,
} from "./crb-process";
import {
	createPr,
	OWNER_REPO,
	PR_NUMBER,
	type Pr,
	type PrOptions,
} from "./pr-setup";
import {
	FINISH_BOUND_MS,
	SharedServer,
	type SharedTest,
} from "./shared-server";

export { type CrbClient, clientRequest, NeedsCliError } from "./crb-open";
export {
	type CrbExit,
	CrbExitError,
	CrbStartTimeout,
	runCli,
	type Served,
	startServe,
	stopChild,
} from "./crb-process";
export type {
	Pr,
	PrOptions,
	ThreadJson,
	ViewJson,
} from "./pr-setup";
export { OWNER_REPO, PR_NUMBER, SharedServer };

/**
 * Which `crb serve` a test's startCrb opens on: "shared", its worker's
 * (e2e/shared-server.ts: a repo and PR number of the test's own, a reset
 * and leak checks after it), or "own", one for the test alone, as a test
 * that stops or restarts crb, passes serve flags, writes config or reads
 * the server's files needs.
 */
export type CrbServer = "shared" | "own";

export interface Crb {
	/** The review's URL, as `crb <pr>` printed it: `http://<host>:<port>/r/<id>`. */
	url: string;
	/** What crb serve logged since this `crb <pr>`, then the client's own output. */
	output(): string;
	/**
	 * SIGTERMs the test's crb serve; rejects unless it exits promptly with
	 * 0. On a shared server it rejects at once: the test needs its own.
	 */
	stop(): Promise<CrbExit | null>;
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

/**
 * Runs a test's setup step (a fixture repo, starting crb) and gives the test
 * back the time it took: on a loaded machine these take seconds, and the
 * test's own timeout is for its own steps. START_TIMEOUT_MS
 * (crb-process.ts) still bounds a start or an open that hangs: a CLI run
 * is killed, an open over HTTP aborted (crb-open.ts), and either fails as
 * CrbExitError with the server's log.
 */
export async function untimed<T>(info: TestInfo, step: () => T | Promise<T>) {
	const started = Date.now();
	try {
		return await step();
	} finally {
		if (info.timeout > 0) info.setTimeout(info.timeout + Date.now() - started);
	}
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

export const test = base.extend<
	{
		/**
		 * How startCrb opens a review: "http" POSTs /api/reviews itself, as the
		 * client would (e2e/crb-open.ts), sparing the client process; "cli" runs
		 * the built `crb <pr>`, for tests of the client: its output and exit
		 * codes, PR resolution, flag checks, --open, finding or starting a server.
		 */
		crbClient: CrbClient;
		/** Which crb serve startCrb uses (CrbServer); serve flags always get the test's own. */
		crbServer: CrbServer;
		/** The test's PR on the fake GitHub: its own on a shared server, else acme/widget#7. */
		ownerRepo: string;
		prNumber: number;
		/**
		 * Declares a leak the shared server's checks must find after this test
		 * (fixtures.spec.ts's canaries): one not found fails the test.
		 */
		expectCrbLeak: (pattern: RegExp) => void;
		_prAt: { ownerRepo: string; number: number };
		_leaks: RegExp[];
		_trace: undefined;
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
	},
	{
		/** The worker's shared crb serve, started by its first shared test. */
		sharedCrb: SharedServer;
	}
>({
	crbClient: ["http", { option: true }],
	crbServer: ["shared", { option: true }],

	sharedCrb: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern.
		async ({}, use, info) => {
			const shared = new SharedServer(info.workerIndex);
			await use(shared);
			await shared.close();
		},
		{ scope: "worker" },
	],

	_prAt: async ({ crbServer, sharedCrb }, use) => {
		await use(
			crbServer === "shared"
				? sharedCrb.nextPr()
				: { ownerRepo: OWNER_REPO, number: PR_NUMBER },
		);
	},
	ownerRepo: async ({ _prAt }, use) => use(_prAt.ownerRepo),
	prNumber: async ({ _prAt }, use) => use(_prAt.number),

	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern.
	_leaks: async ({}, use) => use([]),
	expectCrbLeak: async ({ _leaks }, use, info) =>
		use((pattern) => {
			// The harness's own canaries only: no test declares a leak away.
			if (basename(info.file) !== "fixtures.spec.ts") {
				throw new Error("expectCrbLeak is for e2e/fixtures.spec.ts's canaries");
			}
			_leaks.push(pattern);
		}),

	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern.
	workdir: async ({}, use) => {
		const dir = mkdtempSync(join(tmpdir(), "crb-e2e-"));
		await use(dir);
		rmSync(dir, { recursive: true, force: true });
	},

	_trace: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern.
		async ({}, use, info) => {
			// The test's span (e2e/trace-reporter.ts writes it, with these ids)
			// parents what it runs: fixture gits here, crb and the fake gh below.
			const traced = tracer("playwright-worker");
			const run = process.env.CRB_TRACE_RUN;
			if (!traced.enabled || !run) return use(undefined);
			const context = testSpanContext(
				run,
				info.testId,
				info.retry,
				info.repeatEachIndex,
			);
			traced.setDefaultParent(context);
			process.env.TRACEPARENT = traceparent(context);
			await use(undefined);
			delete process.env.TRACEPARENT;
			traced.setDefaultParent(null);
			traced.flush();
		},
		{ auto: true, box: true },
	],

	pr: async ({ workdir, _prAt }, use, info) => {
		const repos: GitFixture[] = [];
		await use(async (opts = {}) => {
			const pr = await untimed(info, () =>
				base.step("setup: fixture repo", () => createPr(workdir, opts, _prAt), {
					box: true,
				}),
			);
			repos.push(pr.repo);
			return pr;
		});
		for (const repo of repos) repo.cleanup();
	},

	startCrb: async (
		{
			workdir,
			context,
			crbClient,
			crbServer,
			sharedCrb,
			ownerRepo,
			prNumber,
			_leaks,
		},
		use,
		info,
	) => {
		// Page requests nest under the test in its trace, also on a server
		// another test started.
		const parent = process.env.TRACEPARENT;
		if (parent) await context.setExtraHTTPHeaders({ traceparent: parent });
		// The test's own crb serve, started by the first crb <pr> that needs
		// one (and again after a stop), as the CLI's auto-start would; or the
		// worker's shared one.
		const servers: Served[] = [];
		let current: Served | null = null;
		let currentFlags = "";
		const shared: SharedTest = {
			title: info.titlePath.join(" › "),
			scenario: join(workdir, "fake-gh-scenario.json"),
			log: join(workdir, "fake-gh.log"),
			repos: [ownerRepo],
		};
		let usedShared = false;
		// Before the server's first gh call: its calls for this test's repo
		// go to this test's scenario.
		if (crbServer === "shared") sharedCrb.begin(shared);
		const own = async (serve: string[]) => {
			const live =
				current &&
				current.child.exitCode === null &&
				current.child.signalCode === null;
			if (!current || !live) {
				current = await base.step(
					"setup: crb serve",
					() => startServe(workdir, serve),
					{ box: true },
				);
				currentFlags = serve.join(" ");
				servers.push(current);
			} else if (serve.length > 0 && serve.join(" ") !== currentFlags) {
				throw new Error(
					`crb serve already runs with "${currentFlags}", not "${serve.join(" ")}": stop() it first`,
				);
			}
			return current;
		};
		await use((arg = `${ownerRepo}#${prNumber}`, extraArgs = []) =>
			untimed(info, async () => {
				const { serve, client } = splitArgs(extraArgs);
				const onShared = crbServer === "shared" && serve.length === 0;
				let server: Served;
				if (onShared) {
					usedShared = true;
					server = sharedCrb.idle
						? await base.step("setup: crb serve", () => sharedCrb.start(), {
								box: true,
							})
						: await sharedCrb.start();
				} else {
					server = await own(serve);
				}
				const from = server.output().length;
				let run: { code: number | null; stdout: string; output: string };
				try {
					run = await base.step(
						"setup: crb open",
						() =>
							crbClient === "cli"
								? runCli(
										workdir,
										[arg, ...client],
										onShared
											? { ...server.env, TRACEPARENT: process.env.TRACEPARENT }
											: undefined,
									)
								: openOverHttp(server, arg, client),
						{ box: true },
					);
				} catch (error) {
					// A client killed at its timeout may have started one too.
					if (onShared && crbClient === "cli") {
						strangerServer(server, (error as Error).message);
					}
					throw error;
				}
				if (onShared && crbClient === "cli") strangerServer(server, run.output);
				const output = () => `${server.output().slice(from)}${run.output}`;
				const url = run.stdout.trim().split("\n").at(-1) ?? "";
				if (run.code !== 0 || !/^http:\/\//.test(url)) {
					throw new CrbExitError(run.code, output());
				}
				const stop = onShared
					? () =>
							Promise.reject(
								new Error(
									"this test shares its worker's crb serve, which it can't stop: test.use({ crbServer: \"own\" })",
								),
							)
					: () => stopChild(server.child);
				return { url, output, stop };
			}),
		);
		// Pages would keep polling the stopped server and log connection errors
		// (on a shared one, reopen the review after the reset): every page of
		// every context goes blank, or closes (a beforeunload prompt keeps it).
		const pages = (context.browser()?.contexts() ?? [context]).flatMap((c) =>
			c.pages(),
		);
		await Promise.all(
			pages.map(async (p) => {
				// Bounded: a beforeunload prompt, dismissed, cancels the navigation.
				await p.goto("about:blank", { timeout: 5_000 }).catch(() => {});
				if (p.url() !== "about:blank") await p.close().catch(() => {});
			}),
		);
		let problems: string[] = [];
		try {
			if (usedShared) {
				// Teardown runs on a slot of the test's timeout of its own; it
				// grows by the reset's bound first, so a hung reset still
				// reports the leak, not "Tearing down … exceeded the timeout".
				if (info.timeout > 0) info.setTimeout(info.timeout + FINISH_BOUND_MS);
				problems = await base.step(
					"teardown: crb reset",
					() => sharedCrb.finish(shared, _leaks),
					{ box: true },
				);
			} else if (crbServer === "shared") {
				sharedCrb.end(shared);
			}
		} finally {
			await base.step(
				"teardown: crb stop",
				() => Promise.all(servers.map((s) => stopChild(s.child))),
				{ box: true },
			);
		}
		if (_leaks.length > 0 && !usedShared) {
			problems.push(
				"expectCrbLeak in a test that never opened on the shared crb serve",
			);
		}
		if (problems.length > 0) {
			throw new Error(
				`the shared crb serve: this test leaked (e2e/shared-server.ts)\n- ${problems.join("\n- ")}`,
			);
		}
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

/**
 * After a CLI client on the shared server: the server.json it read must be
 * that server's. A client that found none (the server died meanwhile)
 * starts one of its own, detached: it is killed, and the test fails.
 */
function strangerServer(server: Served, clientOutput: string): void {
	const file = join(
		server.env.XDG_STATE_HOME as string,
		"carbonless",
		"server.json",
	);
	let pid: number | undefined;
	try {
		pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: number }).pid;
	} catch {
		return;
	}
	if (pid === undefined || pid === server.child.pid) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
	throw new Error(
		`crb <pr> started a crb serve of its own (pid ${pid}, killed) instead of the shared one (pid ${server.child.pid}); the client said:\n${clientOutput}`,
	);
}

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

export { expect };
