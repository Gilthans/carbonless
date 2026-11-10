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
 * browser run once, alone, so the first wave finds them loaded. It runs
 * before any test, so no test's timeout pays for it; its span
 * (`e2e: warm-up`, crb.kind "warmup") shows it in `pnpm test-profile`.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
	if (!existsSync(CLI)) {
		throw new Error(`${CLI} is missing: build first (pnpm test:e2e builds)`);
	}
	// One worker never starts cold next to another.
	if (config.workers <= 1) return;
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
	let error: string | undefined;
	try {
		await Promise.all([warmCrb(span.context), warmBrowser()]);
	} catch (e) {
		// A warm-up that fails is the first test's failure to report, with
		// its own context; the run goes on.
		error = (e as Error).message;
		process.stderr.write(`e2e warm-up failed: ${error}\n`);
	} finally {
		span.end(undefined, error);
		traced.flush();
	}
}

/** crb serve and `crb <pr>` on a fixture PR, as a test runs them. */
async function warmCrb(
	parent: { traceId: string; spanId: string } | null,
): Promise<void> {
	const workdir = mkdtempSync(join(tmpdir(), "crb-e2e-warmup-"));
	const pr = createPr(workdir);
	const env = crbEnv(workdir);
	if (parent) env.TRACEPARENT = traceparent(parent);
	try {
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
		pr.repo.cleanup();
		rmSync(workdir, { recursive: true, force: true });
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
