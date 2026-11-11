#!/usr/bin/env node
// pnpm test:e2e [playwright args...]: builds dist, then runs Playwright on it
// in its turn (scripts/queue.mjs). No run changes a dist another run in this
// tree is serving (scripts/dist-lock.mjs, CAR-117): the build holds the
// tree's dist lock alone, and the run holds it shared from its turn to its
// end. The build goes before the queue, so it overlaps the wait for a turn;
// it waits only for runs of this tree that are serving dist.
import { spawn } from "node:child_process";

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const SIGNAL_CODES = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

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
function run(c, a) {
	return new Promise((done) => {
		const child = spawn(c, a, { stdio: "inherit" });
		current = { child, caught: null };
		child.on("exit", (status, signal) => {
			const by = signal ?? current.caught;
			current = null;
			done(status ?? (by ? 128 + (SIGNAL_CODES[by] ?? 1) : 1));
		});
	});
}

const script = (name) => new URL(name, import.meta.url).pathname;

const built = await run("pnpm", ["build"]);
if (built !== 0) process.exit(built);
process.exit(
	await run(process.execPath, [
		script("queue.mjs"),
		process.execPath,
		script("dist-lock.mjs"),
		"--shared",
		"pnpm",
		"exec",
		"playwright",
		"test",
		...process.argv.slice(2),
	]),
);
