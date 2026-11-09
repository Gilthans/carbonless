import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { argsSummary, type SpanContext, tracer } from "../src/server/trace";

/*
 * Test runs trace themselves (docs/test-profiling.md): the runner's main
 * process picks the run's directory and passes it down as $CRB_TRACE_DIR
 * (tests set their own XDG_CACHE_HOME, so no one below may compute it);
 * every process under it (workers, crb, the fake gh) writes its own file
 * there. CRB_TEST_TRACES=0 turns it off.
 */

/**
 * Where every run's traces go: ~/.cache/carbonless/test-traces, or
 * $CRB_TEST_TRACE_ROOT (CI: a directory it uploads as an artifact).
 */
export function traceRoot(env: NodeJS.ProcessEnv = process.env): string {
	if (env.CRB_TEST_TRACE_ROOT) return env.CRB_TEST_TRACE_ROOT;
	const cache = env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(cache, "carbonless", "test-traces");
}

/** How long runs are kept. */
export const KEEP_MS = 7 * 24 * 60 * 60_000;

/** Removes run directories last changed before `now - keepMs`; returns their names. */
export function pruneRuns(
	root: string,
	now = Date.now(),
	keepMs = KEEP_MS,
): string[] {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	const gone: string[] = [];
	for (const name of names) {
		const path = join(root, name);
		try {
			const stat = statSync(path);
			if (stat.isDirectory() && stat.mtimeMs < now - keepMs) {
				rmSync(path, { recursive: true, force: true });
				gone.push(name);
			}
		} catch {
			// Another run pruned it first.
		}
	}
	return gone;
}

/**
 * In a runner's main process: the run's trace directory, made (pruning old
 * runs first) and set as $CRB_TRACE_DIR and $CRB_TRACE_RUN for everything
 * below. Kept when already set (a worker re-reading the config). Null when
 * CRB_TEST_TRACES=0, or when anything fails: tracing never fails a run.
 */
export function startTraceRun(kind: "e2e" | "unit"): string | null {
	if (process.env.CRB_TEST_TRACES === "0") return null;
	if (process.env.CRB_TRACE_DIR) return process.env.CRB_TRACE_DIR;
	try {
		const root = traceRoot();
		pruneRuns(root);
		const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}-${process.pid}`;
		const dir = join(root, id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "run.json"),
			`${JSON.stringify({ id, kind, startedAt: new Date().toISOString(), cwd: process.cwd(), argv: process.argv.slice(2) })}\n`,
		);
		process.env.CRB_TRACE_DIR = dir;
		process.env.CRB_TRACE_RUN = id;
		return dir;
	} catch (error) {
		process.stderr.write(`test traces off: ${(error as Error).message}\n`);
		return null;
	}
}

/**
 * The ids of a Playwright test's span, the same in its worker (which hands
 * them to crb as TRACEPARENT) and in the reporter (which writes the span):
 * derived from the run and the test's id, retry and repeat.
 */
export function testSpanContext(
	run: string,
	testId: string,
	retry: number,
	repeatEachIndex: number,
): SpanContext {
	const h = createHash("sha256")
		.update(`${run}\0${testId}\0${retry}\0${repeatEachIndex}`)
		.digest("hex");
	return { traceId: h.slice(0, 32), spanId: h.slice(32, 48) };
}

/**
 * Runs a fixture's git command `run` as a span `git <subcommand>` under the
 * current test (marked crb.fixture), when tracing.
 */
export function fixtureGit<T>(args: readonly string[], run: () => T): T {
	const traced = tracer();
	if (!traced.enabled) return run();
	const span = traced.start(
		`git ${args[0] ?? "?"}`,
		{ args: argsSummary(args), "crb.fixture": true },
		{ kind: "client" },
	);
	try {
		return run();
	} catch (error) {
		span.end(undefined, (error as Error).message);
		throw error;
	} finally {
		span.end();
	}
}
