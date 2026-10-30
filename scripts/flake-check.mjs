#!/usr/bin/env node
// Runs the given tests many times on a deliberately loaded machine, to catch
// a flaky test before it reaches everyone's `pnpm verify`.
//
//   pnpm flake-check <test or spec files...> [--runs=N] [--load=L] [-g <title>]
//                    [--project=chromium|phone]
//
// Unit files (*.test.ts[x]) run N times in fresh Vitest processes; e2e specs
// (e2e/*.spec.ts) are built once and run with --repeat-each=N on both
// Playwright projects. L busy loops (default: 3 per core, a load like several
// suites at once) run alongside; --load=0 checks a quiet machine. Defaults:
// N=5. Waits its turn in the machine-wide queue (scripts/queue.mjs).
import { spawn, spawnSync } from "node:child_process";
import { availableParallelism, loadavg } from "node:os";

if (!process.env.CRB_QUEUE_HELD && !process.env.CRB_NO_QUEUE) {
	const { status } = spawnSync(
		process.execPath,
		[
			"scripts/queue.mjs",
			process.execPath,
			import.meta.filename,
			...process.argv.slice(2),
		],
		{ stdio: "inherit" },
	);
	process.exit(status ?? 1);
}

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const a = args.find((x) => x.startsWith(`--${name}=`));
	return a ? Number(a.slice(name.length + 3)) : fallback;
};
const runs = opt("runs", 5);
const load = opt("load", 3 * availableParallelism());
const grepAt = args.findIndex((a) => a === "-g" || a === "--grep");
const grep = grepAt >= 0 ? args[grepAt + 1] : undefined;
const files = args.filter(
	(a, i) => !a.startsWith("-") && (grepAt < 0 || i !== grepAt + 1),
);
const playwrightFlags = args.filter((a) => a.startsWith("--project="));
const units = files.filter((f) => /\.test\.tsx?$/.test(f));
const specs = files.filter((f) => /\.spec\.ts$/.test(f));
if (!units.length && !specs.length) {
	console.error(
		"usage: pnpm flake-check <x.test.ts | e2e/x.spec.ts ...> [--runs=N] [--load=L] [-g title]",
	);
	process.exit(2);
}

const loops = Array.from({ length: load }, () =>
	spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }),
);
const stopLoops = () => {
	for (const l of loops) l.kill("SIGKILL");
};
process.on("exit", stopLoops);
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => process.exit(130));
}

const results = [];
const sh = (cmd, a) => {
	console.log(`\n$ ${cmd} ${a.join(" ")}   (load ${loadavg()[0].toFixed(1)})`);
	return spawnSync(cmd, a, { stdio: "inherit" }).status ?? 1;
};

if (units.length) {
	const vitest = ["exec", "vitest", "run", ...units];
	if (grep) vitest.push("-t", grep);
	for (let i = 1; i <= runs; i++) {
		results.push([`unit run ${i}/${runs}`, sh("pnpm", vitest)]);
	}
}
if (specs.length) {
	if (sh("pnpm", ["build"]) !== 0) process.exit(1);
	const pw = [
		"exec",
		"playwright",
		"test",
		...specs,
		`--repeat-each=${runs}`,
		...playwrightFlags,
	];
	if (grep) pw.push("-g", grep);
	results.push([`e2e ×${runs}`, sh("pnpm", pw)]);
}

console.log(`\nflake-check, ${load} busy loops:`);
for (const [what, status] of results) {
	console.log(`  ${status === 0 ? "pass" : "FAIL"}  ${what}`);
}
process.exit(results.every(([, s]) => s === 0) ? 0 : 1);
