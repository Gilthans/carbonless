/**
 * Runs the built CLI on a throwaway PR with long, many-party review threads
 * (test/fake-gh/demo-threads.ts), against the fake gh, so they can be seen
 * and tried: replies and resolving write to the fake gh's scenario, never
 * to GitHub.
 *
 *   pnpm build && pnpm tsx scripts/demo-threads.ts --port 4790 --host <ip>
 *
 * It runs crb serve, then crb <pr> to print the review's link. Ctrl-C (or
 * SIGTERM, or closing the terminal) stops crb; the repo and the scenario
 * are removed on every way out but SIGKILL.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
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
	DEMO_FILES,
	DEMO_PEOPLE,
	demoThreads,
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
	pr = createPr(workdir, {
		baseDate: "2026-01-01T00:00:00Z",
		files: DEMO_FILES,
		overview: { title: "Cache widgets, retry the client" },
		scenario: {
			user: {
				login: DEMO_PEOPLE.viewer.login,
				avatarUrl: DEMO_PEOPLE.viewer.avatarUrl,
			},
		},
	});
	const head = pr.repo.shas.at(-1) ?? "";
	pr.editScenario((s) => {
		const graph = s.prs[PR_NUMBER]?.graphql;
		if (graph) graph.reviewThreads = demoThreads(head);
	});
} catch (error) {
	cleanup();
	throw error;
}

child = spawn(
	process.execPath,
	[
		CLI,
		"serve",
		"--port",
		values.port ?? "0",
		...(values.host ? ["--host", values.host] : []),
	],
	{ cwd: workdir, stdio: "inherit", env: crbEnv(workdir) },
);
// Once it's up (server.json written), crb <pr> prints the review's link.
const state = join(workdir, "state", "carbonless", "server.json");
while (!existsSync(state) && child.exitCode === null) await sleep(100);
spawn(process.execPath, [CLI, `${OWNER_REPO}#${PR_NUMBER}`], {
	cwd: workdir,
	stdio: "inherit",
	env: crbEnv(workdir),
});
child.on("error", (error) => {
	console.error(`could not start crb: ${error.message}`);
	process.exit(1);
});
child.on("exit", (code) => {
	process.exit(code ?? 0);
});
