/**
 * Runs the built CLI on a throwaway PR with long, many-party review threads
 * (test/fake-gh/demo-threads.ts), against the fake gh, so they can be seen
 * and tried: replies and resolving write to the fake gh's scenario, never
 * to GitHub.
 *
 *   pnpm build && pnpm tsx scripts/demo-threads.ts --port 4790 --host <ip>
 *
 * Ctrl-C stops crb and removes the repo and the scenario.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CLI, crbEnv, createPr, OWNER_REPO, PR_NUMBER } from "../e2e/pr-setup";
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
const pr = createPr(workdir, {
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

const cleanup = () => {
	pr.repo.cleanup();
	rmSync(workdir, { recursive: true, force: true });
};

const child = spawn(
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
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => child.kill("SIGTERM"));
}
child.on("exit", (code) => {
	cleanup();
	process.exit(code ?? 0);
});
