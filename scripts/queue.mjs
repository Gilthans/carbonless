#!/usr/bin/env node
// Runs a command while holding the machine-wide test lock, so full test runs
// in several worktrees take turns instead of overloading the machine together
// (each one then runs as fast as alone, and none fails on a timeout another
// one's load caused).
//
//   node scripts/queue.mjs [--unless-filtered] <command> [args...]
//
// --unless-filtered: queue only a run of the whole suite; a `playwright test`
// given spec files, a pattern or --last-failed/--only-changed is short and
// goes at once (queue-args.mjs). A command run inside the lock
// (CRB_QUEUE_HELD set) doesn't queue again.
//
// The lock is `flock` on ~/.cache/carbonless-verify.lock: the kernel frees it
// when the holder exits, however it exits. SIGTERM, SIGINT or SIGHUP gives
// up the wait, or stops the command (its whole process group) and exits.
// CRB_NO_QUEUE=1, or no `flock` on PATH, runs the command at once.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { filteredRun } from "./queue-args.mjs";

let argv = process.argv.slice(2);
const unlessFiltered = argv[0] === "--unless-filtered";
if (unlessFiltered) argv = argv.slice(1);
const [cmd, ...args] = argv;
if (!cmd) {
	console.error("usage: node scripts/queue.mjs <command> [args...]");
	process.exit(2);
}

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const SIGNAL_CODES = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/**
 * Runs `c` and exits with its status. A signal to this process goes on to
 * the child: with `group`, to the child's own process group (a shell's or
 * pnpm's children too, which a signal to the child alone would leave
 * running).
 */
function run(c, a, { group = false, env = process.env } = {}) {
	const child = spawn(c, a, { stdio: "inherit", env, detached: group });
	let caught = null;
	const sent = {};
	for (const sig of SIGNALS) {
		process.on(sig, () => {
			caught ??= sig;
			// Ctrl-C reaches this process and the one it runs at once: one
			// press is passed on once, a second press a moment later again.
			if (Date.now() - (sent[sig] ?? 0) < 1000) return;
			sent[sig] = Date.now();
			try {
				if (group) process.kill(-child.pid, sig);
				else child.kill(sig);
			} catch {}
		});
	}
	child.on("exit", (status, signal) => {
		const by = signal ?? caught;
		process.exit(status ?? (by ? 128 + (SIGNAL_CODES[by] ?? 1) : 1));
	});
}

// Inside the lock. The first command in it says who holds it; commands it
// runs that queue again (CRB_QUEUE_HELD still set) just run.
if (process.env.CRB_QUEUE_HELD) {
	const since = process.env.CRB_QUEUE_SINCE;
	if (since) {
		delete process.env.CRB_QUEUE_SINCE;
		try {
			writeFileSync(
				process.env.CRB_QUEUE_HELD,
				`${process.cwd()} (${[cmd, ...args].join(" ")}, since ${new Date().toLocaleTimeString()})\n`,
			);
		} catch {}
		const waited = Math.round((Date.now() - Number(since)) / 1000);
		if (waited > 0) console.log(`queue: our turn after ${waited} s`);
		run(cmd, args, { group: true });
	} else {
		run(cmd, args);
	}
} else {
	const hasFlock = spawnSync("flock", ["--version"]).status === 0;
	if (
		process.env.CRB_NO_QUEUE ||
		!hasFlock ||
		(unlessFiltered && filteredRun(args))
	) {
		run(cmd, args);
	} else {
		const dir = join(homedir(), ".cache");
		mkdirSync(dir, { recursive: true });
		const lock = join(dir, "carbonless-verify.lock");
		const holder = `${lock}.holder`;
		let busy = null;
		if (spawnSync("flock", ["-n", lock, "true"]).status !== 0) {
			busy = "another run";
			try {
				busy = readFileSync(holder, "utf8").trim();
			} catch {}
		}
		// --no-fork: flock becomes this script again, holding the lock; a
		// signal before then just ends the wait.
		run(
			"flock",
			["--no-fork", lock, process.execPath, import.meta.filename, cmd, ...args],
			{
				env: {
					...process.env,
					CRB_QUEUE_HELD: holder,
					CRB_QUEUE_SINCE: String(Date.now()),
				},
			},
		);
		// Said once signals are passed on: a waiter told to stop at once still
		// ends its wait.
		if (busy) console.log(`queue: waiting for ${busy} to finish`);
	}
}
