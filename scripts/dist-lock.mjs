#!/usr/bin/env node
// Runs a command holding this tree's dist lock, so no build changes a `dist`
// that a test run in the same tree is serving (CAR-117). A build (`pnpm
// build`, so prepack too) or `pnpm test:pack` holds it alone; a run that
// serves dist (scripts/e2e.mjs) holds it --shared, alongside other such runs.
//
//   node scripts/dist-lock.mjs [--shared] <command> [args...]
//
// The lock is `flock` on node_modules/.crb-dist.lock in this tree: the kernel
// frees it when the holder exits, however it exits. A command run inside a
// hold (CRB_DIST_HELD) doesn't lock again, except that a build inside a
// shared hold fails: it would change the dist that hold serves. No `flock` on
// PATH: the command runs unlocked. A signal gives up the wait, or is passed
// on to the command.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const shared = argv[0] === "--shared";
const [cmd, ...args] = shared ? argv.slice(1) : argv;
if (!cmd) {
	console.error(
		"usage: node scripts/dist-lock.mjs [--shared] <command> [args...]",
	);
	process.exit(2);
}

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const SIGNAL_CODES = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
// flock's exit status when the lock is taken; a held command's own 200 comes
// back as 1 so the two never mix.
const TAKEN = 200;

let current = null;
for (const sig of SIGNALS) {
	process.on(sig, () => {
		if (!current) process.exit(128 + SIGNAL_CODES[sig]);
		current.caught ??= sig;
		try {
			current.child.kill(sig);
		} catch {}
	});
}

/** Runs `c` to its end: its exit status, or 128 + the signal that ended it. */
function run(c, a, env = process.env) {
	return new Promise((done) => {
		const child = spawn(c, a, { stdio: "inherit", env });
		current = { child, caught: null };
		child.on("error", (e) => {
			console.error(`dist-lock: ${c}: ${e.message}`);
		});
		child.on("exit", (status, signal) => {
			const by = signal ?? current.caught;
			current = null;
			done(status ?? (by ? 128 + (SIGNAL_CODES[by] ?? 1) : 1));
		});
	});
}

const lock = join(
	resolve(import.meta.dirname, ".."),
	"node_modules",
	".crb-dist.lock",
);
const mode = shared ? "shared" : "exclusive";

if (process.env.CRB_DIST_INSIDE) {
	// flock runs this script again holding the lock: run the command.
	delete process.env.CRB_DIST_INSIDE;
	const status = await run(cmd, args);
	process.exit(status === TAKEN ? 1 : status);
}

const [heldLock, heldMode] = (process.env.CRB_DIST_HELD ?? "").split("\t");
if (heldLock === lock) {
	if (heldMode === "shared" && !shared) {
		console.error(
			"dist-lock: a build inside a run that serves dist would change that dist under it",
		);
		process.exit(1);
	}
	process.exit(await run(cmd, args));
}

if (spawnSync("flock", ["--version"]).status !== 0) {
	process.exit(await run(cmd, args));
}

mkdirSync(dirname(lock), { recursive: true });
const env = {
	...process.env,
	CRB_DIST_HELD: `${lock}\t${mode}`,
	CRB_DIST_INSIDE: "1",
};
const flock = (wait) => [
	...(shared ? ["-s"] : ["-x"]),
	...(wait ? [] : ["-n"]),
	"-E",
	String(TAKEN),
	"--no-fork",
	lock,
	process.execPath,
	import.meta.filename,
	...argv,
];
const status = await run("flock", flock(false), env);
if (status !== TAKEN) process.exit(status);
console.log(
	shared
		? "dist-lock: waiting for a build in this tree to finish"
		: "dist-lock: waiting for the runs using this tree's dist to finish",
);
process.exit(await run("flock", flock(true), env));
