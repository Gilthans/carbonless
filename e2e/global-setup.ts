import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type FullConfig } from "@playwright/test";
import { createTracer, traceparent } from "../src/server/trace";
import { CrbExitError, runCli, startServe, stopChild } from "./crb-process";
import { CLI, crbEnv, createPr, OWNER_REPO, PR_NUMBER } from "./pr-setup";

/*
 * The warm-up before the workers start (CAR-102). Every worker's first
 * test used to start crb with nothing loaded yet (dist, node_modules, git,
 * the browser binary out of the page cache), all workers at once, next to
 * their browsers launching: on a loaded machine `crb serve` took 10-12 s to
 * listen there, against 1.3 s later in the run, and those first tests timed
 * out. Here one crb serve, one `crb <pr>` (a clone, the fake gh) and one
 * browser run once, alone, so the first wave finds them loaded (and the
 * run's compile cache filled). It runs
 * before any test, so no test's timeout pays for it; its span
 * (`e2e: warm-up`, crb.kind "warmup") shows it in `pnpm test-profile`.
 */
export default async function globalSetup(
	config: FullConfig,
): Promise<() => void> {
	if (!existsSync(CLI)) {
		throw new Error(`${CLI} is missing: build first (pnpm test:e2e builds)`);
	}
	// One compile cache for the run's every crb (Node's NODE_COMPILE_CACHE):
	// each test has its own XDG_CACHE_HOME, so a cache there would start
	// empty for every crb serve. Set here, the workers and every crb they
	// start (crbEnv passes process.env on) inherit it; the warm-up fills it.
	const compileCache = mkdtempSync(join(tmpdir(), "crb-e2e-compile-cache-"));
	process.env.NODE_COMPILE_CACHE = compileCache;
	const teardown = () => rmSync(compileCache, { recursive: true, force: true });
	// Also when the run is stopped (Ctrl-C) before teardown could run.
	process.once("exit", teardown);
	// One worker never starts cold next to another.
	if (config.workers <= 1) return teardown;
	const traced = createTracer({
		dir: process.env.CRB_TRACE_DIR,
		service: "e2e",
		resource: process.env.CRB_TRACE_RUN
			? { "crb.run": process.env.CRB_TRACE_RUN }
			: undefined,
		flushOnExit: false,
	});
	const span = traced.start(
		"e2e: warm-up",
		{ "crb.kind": "warmup", workers: config.workers },
		{ parent: null },
	);
	// Both halves finish before any worker starts, even when one fails:
	// a crb warm-up left running would load the first wave it is for.
	const results = await Promise.allSettled([
		warmCrb(span.context),
		warmBrowser(),
	]);
	// A warm-up that fails is the first test's failure to report, with its
	// own context; the run goes on.
	const errors = results.flatMap((r, i) =>
		r.status === "rejected"
			? [
					`${i === 0 ? "crb" : "browser"}: ${(r.reason as Error)?.message ?? r.reason}`,
				]
			: [],
	);
	for (const e of errors) process.stderr.write(`e2e warm-up failed: ${e}\n`);
	span.end(undefined, errors.length ? errors.join("; ") : undefined);
	traced.flush();
	return teardown;
}

/** crb serve and `crb <pr>` on a fixture PR, as a test runs them. */
async function warmCrb(
	parent: { traceId: string; spanId: string } | null,
): Promise<void> {
	const workdir = mkdtempSync(join(tmpdir(), "crb-e2e-warmup-"));
	const repos: { cleanup: () => void }[] = [];
	const cleanup = () => {
		for (const repo of repos) repo.cleanup();
		rmSync(workdir, { recursive: true, force: true });
	};
	// A run stopped (Ctrl-C) during the warm-up leaves nothing behind either.
	process.once("exit", cleanup);
	try {
		const pr = createPr(workdir);
		repos.push(pr.repo);
		const env = crbEnv(workdir);
		if (parent) env.TRACEPARENT = traceparent(parent);
		const served = await startServe(workdir, [], env);
		try {
			const run = await runCli(workdir, [`${OWNER_REPO}#${PR_NUMBER}`], env);
			if (run.code !== 0) {
				throw new CrbExitError(run.code, `${served.output()}${run.output}`);
			}
		} finally {
			await stopChild(served.child);
		}
	} finally {
		process.off("exit", cleanup);
		cleanup();
	}
}

/** The browser binary, read once before every worker launches its own. */
async function warmBrowser(): Promise<void> {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.goto("about:blank");
	} finally {
		await browser.close();
	}
}
