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

export { type CrbClient, NeedsCliError } from "./crb-open";
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
export { OWNER_REPO, PR_NUMBER };

export interface Crb {
	/** The review's URL, as `crb <pr>` printed it: `http://<host>:<port>/r/<id>`. */
	url: string;
	/** What crb serve logged since this `crb <pr>`, then the client's own output. */
	output(): string;
	/** SIGTERMs the test's crb serve; rejects unless it exits promptly with 0. */
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
 * (crb-process.ts) still bounds a start that hangs.
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

export const test = base.extend<{
	/**
	 * How startCrb opens a review: "http" POSTs /api/reviews itself, as the
	 * client would (e2e/crb-open.ts), sparing the client process; "cli" runs
	 * the built `crb <pr>`, for tests of the client: its output and exit
	 * codes, PR resolution, flag checks, --open, finding or starting a server.
	 */
	crbClient: CrbClient;
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
}>({
	crbClient: ["http", { option: true }],

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

	pr: async ({ workdir }, use, info) => {
		const repos: GitFixture[] = [];
		await use(async (opts = {}) => {
			const pr = await untimed(info, () =>
				base.step("setup: fixture repo", () => createPr(workdir, opts), {
					box: true,
				}),
			);
			repos.push(pr.repo);
			return pr;
		});
		for (const repo of repos) repo.cleanup();
	},

	startCrb: async ({ workdir, context, crbClient }, use, info) => {
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
				const server = current;
				const from = server.output().length;
				const run = await base.step(
					"setup: crb open",
					() =>
						crbClient === "cli"
							? runCli(workdir, [arg, ...client])
							: openOverHttp(server, workdir, arg, client),
					{ box: true },
				);
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
		await base.step(
			"teardown: crb stop",
			() => Promise.all(servers.map((s) => stopChild(s.child))),
			{ box: true },
		);
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

export { expect };
