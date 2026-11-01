/**
 * Runs the built CLI on the showcase PR (test/fake-gh/showcase.ts: one of
 * every kind of file change, three commits) with its review threads
 * (test/fake-gh/demo-threads.ts), against the fake gh, so they can be seen
 * and tried: replies, new comments, edits, deletes, resolving and the
 * verdict write to the fake gh's scenario, never to GitHub. What blocks
 * the merge is demoVerdict's mix. The gallery's `showcase` PR has
 * the same code and threads on GitHub.
 *
 *   pnpm build && pnpm tsx scripts/demo-threads.ts --port 4790 --host <ip>
 *
 * Ctrl-C (or SIGTERM, or closing the terminal) stops crb; the repo and
 * the scenario are removed on every way out but SIGKILL.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	CLI,
	crbEnv,
	createPr,
	OWNER_REPO,
	PR_NUMBER,
	type Pr,
} from "../e2e/pr-setup";
import {
	DEMO_PR,
	demoThreads,
	demoTimeline,
	demoVerdict,
} from "../test/fake-gh/demo-threads";

const { values } = parseArgs({
	options: {
		port: { type: "string" },
		host: { type: "string" },
	},
});

if (!existsSync(CLI)) {
	console.error("No dist/cli.js: run pnpm build first.");
	process.exit(1);
}

const workdir = mkdtempSync(join(tmpdir(), "crb-demo-threads-"));
let pr: Pr | undefined;
let cleaned = false;
/** Removes the repo and the scenario, once, on every way out. */
const cleanup = () => {
	if (cleaned) return;
	cleaned = true;
	pr?.repo.cleanup();
	rmSync(workdir, { recursive: true, force: true });
};
// The last resort (an uncaught error, process.exit): synchronous, so it runs.
process.on("exit", cleanup);
/** crb, once started. */
let child: ChildProcess | undefined;
// Ctrl-C, kill, or the terminal closing: stop crb, which then cleans up;
// before it runs (or after it's gone), just leave.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => {
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		} else {
			process.exit(1);
		}
	});
}

try {
	const made = createPr(workdir, DEMO_PR);
	pr = made;
	made.editScenario((s) => {
		const graph = s.prs[PR_NUMBER]?.graphql;
		if (!graph) return;
		graph.reviewThreads = demoThreads(made.repo);
		graph.timelineItems = demoTimeline(made.repo.shas);
		// What blocks the merge (the Final Verdict tab).
		const verdict = demoVerdict(
			made.repo.shas.at(-1) ?? "",
			made.repo.shas.at(-2),
		);
		const pr = s.prs[PR_NUMBER];
		if (pr) pr.view = { ...pr.view, ...verdict.view };
		graph.reviews = verdict.reviews;
	});
} catch (error) {
	cleanup();
	throw error;
}

child = spawn(
	process.execPath,
	[
		CLI,
		`${OWNER_REPO}#${PR_NUMBER}`,
		"--no-open",
		...(values.port ? ["--port", values.port] : []),
		...(values.host ? ["--host", values.host] : []),
	],
	{ cwd: workdir, stdio: "inherit", env: crbEnv(workdir) },
);
child.on("error", (error) => {
	console.error(`could not start crb: ${error.message}`);
	process.exit(1);
});
child.on("exit", (code) => {
	process.exit(code ?? 0);
});
