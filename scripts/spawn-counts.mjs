#!/usr/bin/env node
// pnpm spawn-counts [<files>x<threads>] [--calls]: the git and gh processes
// behind each of the page's first reads, on a synthetic PR (CAR-320;
// docs/test-profiling.md, "Processes per request"). Runs
// src/server/spawnCounts.test.ts's table in the test queue and prints it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const size = args.find((a) => /^\d+x\d+$/.test(a)) ?? "40x15";
const dir = mkdtempSync(join(tmpdir(), "crb-spawn-counts-"));
const out = join(dir, "table.md");
try {
	const run = spawnSync(
		process.execPath,
		[
			join(root, "scripts", "queue.mjs"),
			"vitest",
			"run",
			"src/server/spawnCounts.test.ts",
		],
		{
			cwd: root,
			stdio: ["ignore", "ignore", "inherit"],
			shell: process.platform === "win32",
			env: {
				...process.env,
				CRB_SPAWN_TABLE: size,
				CRB_SPAWN_OUT: out,
				...(args.includes("--calls") ? { CRB_SPAWN_CALLS: "1" } : {}),
			},
		},
	);
	if (run.status !== 0) process.exit(run.status ?? 1);
	process.stdout.write(readFileSync(out, "utf8"));
} finally {
	rmSync(dir, { recursive: true, force: true });
}
