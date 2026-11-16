#!/usr/bin/env node
// Runs a command in its turn on a machine shared by several agents, so test
// runs in several worktrees don't overload it together (each one then runs
// about as fast as alone, and none fails on a timeout another one's load
// caused). The package scripts run every Vitest and Playwright run through
// it, and on a machine with a queue their configs refuse a run outside it
// (queue-guard.mjs).
//
//   node scripts/queue.mjs <command> [args...]
//
// ~/.config/carbonless/queue.json turns the queue on and sets how many runs
// go at once (queue-config.mjs). It is read again while waiting, so a change
// reaches waiting runs too. No file, CRB_NO_QUEUE=1 or no `flock` on PATH:
// the command runs at once. A command run inside a slot (CRB_QUEUE_HELD set)
// doesn't queue again.
//
// Slot i is `flock` on ~/.cache/carbonless-verify.lock (slot 0) or
// ~/.cache/carbonless-verify.lock.<i>: the kernel frees it when the holder
// exits, however it exits. SIGTERM, SIGINT or SIGHUP gives up the wait, or
// stops the command (its whole process group; what is left of it 10 s later
// gets SIGKILL) and exits.
//
// First come, first served: each run puts a ticket in
// ~/.cache/carbonless-queue (queue-line.mjs) from its arrival to its end, and
// tries the slots only while it is among the `slots` oldest live tickets. The
// flock slots stay the real exclusion; the tickets only order who tries. A
// run killed with SIGKILL leaves a ticket the next reader drops (its pid is
// gone, a zombie, or now another process); a stopped run (Ctrl-Z) keeps its
// ticket but lets the runs behind it go.
//
// The run holding a slot is a child of the run that waited for it, and
// stops its command as SIGTERM does once that one is gone (killed with
// SIGKILL); either stops once $CRB_OWNER is gone (owner.mjs).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownerToken, watchOwner } from "./owner.mjs";
import { home, queueSlots } from "./queue-config.mjs";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
	console.error("usage: node scripts/queue.mjs <command> [args...]");
	process.exit(2);
}

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const SIGNAL_CODES = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
// flock's exit status when the slot is taken; a held command's own 200
// comes back as 1 so the two never mix.
const TAKEN = 200;
// CRB_QUEUE_POLL_MS: for tests, a waiter that polls faster than the others.
const POLL_MS = Math.max(10, Number(process.env.CRB_QUEUE_POLL_MS) || 1000);

/** The child a signal goes on to; with `group`, to its process group. */
let current = null;
const sent = {};
for (const sig of SIGNALS) {
	process.on(sig, () => {
		if (!current) process.exit(128 + SIGNAL_CODES[sig]);
		current.caught ??= sig;
		// Ctrl-C reaches this process and the one it runs at once: one press
		// is passed on once, a second press a moment later again.
		if (Date.now() - (sent[sig] ?? 0) < 1000) return;
		sent[sig] = Date.now();
		try {
			if (current.group) process.kill(-current.child.pid, sig);
			else current.child.kill(sig);
		} catch {}
	});
}

// A command that outlives its SIGTERM by this long gets SIGKILL.
const STOP_GRACE_MS = 10_000;

/** Stops as on SIGTERM; SIGKILLs the command's group if it lingers. */
function stopForGone() {
	const pgid = current?.group ? current.child.pid : 0;
	process.kill(process.pid, "SIGTERM");
	setTimeout(
		() => {
			try {
				if (pgid) process.kill(-pgid, "SIGKILL");
			} catch {}
			process.exit(128 + SIGNAL_CODES.SIGTERM);
		},
		// A waiter gives the run holding its slot time to reap its group.
		pgid ? STOP_GRACE_MS : STOP_GRACE_MS + 5_000,
	).unref();
}
watchOwner(stopForGone);

/** Waits up to STOP_GRACE_MS for group `pgid` to empty, then SIGKILLs it. */
async function reapGroup(pgid) {
	const live = () => {
		try {
			process.kill(-pgid, 0);
			return true;
		} catch {
			return false;
		}
	};
	for (let t = 0; live() && t < STOP_GRACE_MS; t += 100) await sleep(100);
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {}
}

/** Runs `c` to its end: its exit status, or 128 + the signal that ended it. */
function run(c, a, { group = false, env = process.env } = {}) {
	return new Promise((done) => {
		const child = spawn(c, a, { stdio: "inherit", env, detached: group });
		current = { child, group, caught: null };
		child.on("exit", async (status, signal) => {
			const { caught } = current;
			// A member that outlives the signal passed on (it ignores it) gets
			// SIGKILL. `current` stays meanwhile: another signal goes on to it.
			if (group && caught) await reapGroup(child.pid);
			current = null;
			const by = signal ?? caught;
			done(status ?? (by ? 128 + (SIGNAL_CODES[by] ?? 1) : 1));
		});
	});
}

const dir = join(home(), ".cache");
const lock = (i) => join(dir, `carbonless-verify.lock${i ? `.${i}` : ""}`);

/** Who holds each of the first `n` slots, from their holder files. */
function holders(n) {
	return Array.from({ length: n }, (_, i) => {
		try {
			return readFileSync(`${lock(i)}.holder`, "utf8").trim();
		} catch {
			return "another run";
		}
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.CRB_QUEUE_HELD) {
	// Inside a slot. The first command in it says who holds it; commands it
	// runs that queue again (CRB_QUEUE_SINCE gone) just run.
	const since = process.env.CRB_QUEUE_SINCE;
	if (!since) process.exit(await run(cmd, args));
	delete process.env.CRB_QUEUE_SINCE;
	watchOwner(stopForGone, process.env.CRB_QUEUE_WAITER);
	delete process.env.CRB_QUEUE_WAITER;
	try {
		writeFileSync(
			process.env.CRB_QUEUE_HELD,
			`${process.cwd()} (${[cmd, ...args].join(" ")}, since ${new Date().toLocaleTimeString()})\n`,
		);
	} catch {}
	const waited = Math.round((Date.now() - Number(since)) / 1000);
	if (waited > 0) console.log(`queue: our turn after ${waited} s`);
	const status = await run(cmd, args, { group: true });
	process.exit(status === TAKEN ? 1 : status);
}

const unqueued = () =>
	run(cmd, args, { env: { ...process.env, CRB_NO_QUEUE: "1" } });

if (
	process.env.CRB_NO_QUEUE ||
	!queueSlots() ||
	spawnSync("flock", ["--version"]).status !== 0
) {
	process.exit(await unqueued());
}

mkdirSync(dir, { recursive: true });
const start = Date.now();
// Loaded only here: a nested or unqueued run never depends on the line.
const { joinLine } = await import("./queue-line.mjs");
const ticket = joinLine(join(dir, "carbonless-queue"));
// Kept while the command runs too: a run holding a slot stays ahead of the
// ones that came after it. process.exit (signals included) runs this.
process.on("exit", () => ticket.leave());
let told = false;
for (;;) {
	const slots = queueSlots();
	// The queue was turned off while waiting.
	if (!slots) {
		ticket.leave();
		process.exit(await unqueued());
	}
	// Runs that came earlier and still wait (or run) go first.
	const ahead = ticket.place();
	const tries = ahead < slots ? slots : 0;
	for (let i = 0; i < tries; i++) {
		// -n: a taken slot ends flock at once with TAKEN; a free one becomes
		// this script again (--no-fork), holding the slot.
		const status = await run(
			"flock",
			[
				"-n",
				"-E",
				String(TAKEN),
				"--no-fork",
				lock(i),
				process.execPath,
				import.meta.filename,
				cmd,
				...args,
			],
			{
				env: {
					...process.env,
					CRB_QUEUE_HELD: `${lock(i)}.holder`,
					CRB_QUEUE_SINCE: String(start),
					CRB_QUEUE_SLOTS: String(slots),
					CRB_QUEUE_WAITER: ownerToken(process.pid),
				},
			},
		);
		if (status !== TAKEN) process.exit(status);
	}
	if (!told) {
		told = true;
		const n = Number.isFinite(ahead) ? ` (${ahead} ahead)` : "";
		console.log(
			`queue: waiting for ${holders(slots).join("; ")} to finish${n}`,
		);
	}
	await sleep(POLL_MS);
}
