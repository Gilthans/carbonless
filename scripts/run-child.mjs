// Runs commands one at a time for a wrapper script (dist-lock.mjs, e2e.mjs),
// passing SIGTERM, SIGINT and SIGHUP on to the one running. Ctrl-C reaches
// the wrapper and its command at once: one press is passed on once, so the
// command (Playwright) gets one signal and still tears down; a second press a
// moment later goes on again.
import { spawn } from "node:child_process";

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const SIGNAL_CODES = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/** The child a signal goes on to. */
let current = null;
const sent = {};
for (const sig of SIGNALS) {
	process.on(sig, () => {
		if (!current) process.exit(128 + SIGNAL_CODES[sig]);
		current.caught ??= sig;
		if (Date.now() - (sent[sig] ?? 0) < 1000) return;
		sent[sig] = Date.now();
		try {
			current.child.kill(sig);
		} catch {}
	});
}

/**
 * Runs `c` to its end: its exit status, 128 + the signal that ended it, or
 * 127 when it can't start (`who` names the wrapper in the message).
 */
export function run(who, c, a, env = process.env) {
	return new Promise((done) => {
		let settled = false;
		const finish = (status) => {
			if (settled) return;
			settled = true;
			current = null;
			done(status);
		};
		const child = spawn(c, a, { stdio: "inherit", env });
		const me = { child, caught: null };
		current = me;
		child.on("error", (e) => {
			console.error(
				`${who}: can't run ${c}: ${e.code === "ENOENT" ? "not found" : e.message}`,
			);
			finish(127);
		});
		child.on("close", (status, signal) => {
			const by = signal ?? me.caught;
			finish(status ?? (by ? 128 + (SIGNAL_CODES[by] ?? 1) : 1));
		});
	});
}
