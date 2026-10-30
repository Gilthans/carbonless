#!/usr/bin/env node
// Runs a command while holding the machine-wide test lock, so full test runs
// in several worktrees take turns instead of overloading the machine together
// (each one then runs as fast as alone, and none fails on a timeout another
// one's load caused).
//
//   node scripts/queue.mjs [--unless-filtered] <command> [args...]
//
// --unless-filtered: queue only a run of the whole suite; a run given spec
// files or a -g/--grep pattern is short and goes at once.
// A command run inside the lock (CRB_QUEUE_HELD set) doesn't queue again.
//
// The lock is `flock` on ~/.cache/carbonless-verify.lock: the kernel frees it
// when the holder exits, however it exits. CRB_NO_QUEUE=1, or no `flock` on
// PATH, runs the command at once.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let argv = process.argv.slice(2);
const unlessFiltered = argv[0] === "--unless-filtered";
if (unlessFiltered) argv = argv.slice(1);
const [cmd, ...args] = argv;
if (!cmd) {
	console.error("usage: node scripts/queue.mjs <command> [args...]");
	process.exit(2);
}

const run = (c, a) => {
	const { status, signal } = spawnSync(c, a, { stdio: "inherit" });
	process.exit(status ?? (signal ? 1 : 0));
};

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
	}
	run(cmd, args);
}

// `… playwright test e2e/x.spec.ts` or `-g title`: some specs, not the suite.
// A word after a bare `--option` is taken as that option's value.
const testArgs = args.slice(args.indexOf("test") + 1);
const filtered = testArgs.some(
	(a, i) =>
		/^(-g|--grep)(=|$)/.test(a) ||
		(!a.startsWith("-") && !/^-[^=]*$/.test(testArgs[i - 1] ?? "")),
);
const hasFlock = spawnSync("flock", ["--version"]).status === 0;
if (process.env.CRB_NO_QUEUE || !hasFlock || (unlessFiltered && filtered)) {
	run(cmd, args);
}

const dir = join(homedir(), ".cache");
mkdirSync(dir, { recursive: true });
const lock = join(dir, "carbonless-verify.lock");
const holder = `${lock}.holder`;

if (spawnSync("flock", ["-n", lock, "true"]).status !== 0) {
	let who = "another run";
	try {
		who = readFileSync(holder, "utf8").trim();
	} catch {}
	console.log(`queue: waiting for ${who} to finish`);
}
const { status, signal } = spawnSync(
	"flock",
	[lock, process.execPath, import.meta.filename, cmd, ...args],
	{
		stdio: "inherit",
		env: {
			...process.env,
			CRB_QUEUE_HELD: holder,
			CRB_QUEUE_SINCE: String(Date.now()),
		},
	},
);
process.exit(status ?? (signal ? 1 : 0));
