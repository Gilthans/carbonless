#!/usr/bin/env node
// Runs the given tests many times, optionally on a loaded machine, to catch
// a flaky test before it reaches everyone's `pnpm verify`.
//
//   pnpm flake-check <test or spec files...> [--runs N] [--load L]
//                    [-g <title>] [--project chromium|phone]
//
// Unit files (*.test.ts[x]) run N times in fresh Vitest processes; e2e specs
// (e2e/*.spec.ts) are built once and run with --repeat-each=N on both
// Playwright projects (or the --project ones; CRB_NO_PHONE=1 drops the
// phone). --load L adds L busy loops alongside (default none: the devbox is
// loaded by other agents already, and loops slow their runs too). Defaults:
// N=5. Waits its turn in the machine's test queue, if it has one
// (scripts/queue.mjs). A signal stops the current run, the loops and the check.
import { spawn } from "node:child_process";
import { loadavg } from "node:os";
import { parseFlakeArgs } from "./flake-check-args.mjs";

const parsed = parseFlakeArgs(process.argv.slice(2));
if ("error" in parsed) {
	console.error(`flake-check: ${parsed.error}`);
	console.error(
		"usage: pnpm flake-check <x.test.ts | e2e/x.spec.ts ...> [--runs N] [--load L] [-g title] [--project name]",
	);
	process.exit(2);
}

if (!process.env.CRB_QUEUE_HELD && !process.env.CRB_NO_QUEUE) {
	// The queue runs this script again inside the lock; a signal goes to it.
	const queued = spawn(
		process.execPath,
		[
			"scripts/queue.mjs",
			process.execPath,
			import.meta.filename,
			...process.argv.slice(2),
		],
		{ stdio: "inherit" },
	);
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(sig, () => queued.kill(sig));
	}
	queued.on("exit", (status) => process.exit(status ?? 1));
} else {
	await check();
}

async function check() {
	const { runs, load, grep, projects, units, specs } = parsed;

	const loops = Array.from({ length: load }, () =>
		spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }),
	);
	let current = null;
	const stop = () => {
		for (const l of loops) l.kill("SIGKILL");
	};
	process.on("exit", stop);
	const codes = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(sig, () => {
			// The run's own group: Vitest's or Playwright's workers and servers.
			if (current) {
				try {
					process.kill(-current.pid, "SIGTERM");
				} catch {}
			}
			process.exit(128 + codes[sig]);
		});
	}

	const sh = (cmd, a) => {
		console.log(
			`\n$ ${cmd} ${a.join(" ")}   (load ${loadavg()[0].toFixed(1)})`,
		);
		return new Promise((done) => {
			current = spawn(cmd, a, { stdio: "inherit", detached: true });
			current.on("exit", (status) => {
				current = null;
				done(status ?? 1);
			});
		});
	};

	const results = [];
	if (units.length) {
		const vitest = ["exec", "vitest", "run", ...units];
		if (grep) vitest.push("-t", grep);
		for (let i = 1; i <= runs; i++) {
			results.push([`unit run ${i}/${runs}`, await sh("pnpm", vitest)]);
		}
	}
	if (specs.length) {
		if ((await sh("pnpm", ["build"])) !== 0) process.exit(1);
		const pw = [
			"exec",
			"playwright",
			"test",
			...specs,
			`--repeat-each=${runs}`,
			...projects.map((p) => `--project=${p}`),
		];
		if (grep) pw.push("-g", grep);
		results.push([`e2e ×${runs}`, await sh("pnpm", pw)]);
	}

	console.log(`\nflake-check, ${load} busy loops:`);
	for (const [what, status] of results) {
		console.log(`  ${status === 0 ? "pass" : "FAIL"}  ${what}`);
	}
	process.exit(results.length && results.every(([, s]) => s === 0) ? 0 : 1);
}
