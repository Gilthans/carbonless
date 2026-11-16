// $CRB_OWNER ("<pid> <start time>"): the test process that what it starts
// belongs to (test/setup.ts and e2e/pr-setup.ts set it). A runner killed
// mid-test (a Playwright worker past its teardown timeout, an interrupted
// run) never stops what it started: queue.mjs, the fake agent and crb serve
// (src/server/owner.ts, the same check) exit on their own once it is gone.
import { readFileSync } from "node:fs";

export const OWNER_ENV = "CRB_OWNER";
const POLL_MS = 1000;

/**
 * `pid`'s state letter and start time (clock ticks since boot, field 22)
 * from /proc/<pid>/stat; null when unknown (gone, or no /proc).
 */
function stat(pid) {
	try {
		const text = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Fields after the command name, which may hold spaces or ")".
		const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
		return { state: rest[0] ?? "", start: rest[19] ?? "" };
	} catch {
		return null;
	}
}

/** The token naming `pid`. */
export function ownerToken(pid) {
	if (!Number.isInteger(pid) || pid <= 0)
		throw new Error(`no such pid: ${pid}`);
	return `${pid} ${stat(pid)?.start ?? ""}`;
}

/** Whether the process `token` names runs: not ended, a zombie, or its pid reused. */
export function ownerAlive(token) {
	const [pid, start = ""] = token.trim().split(" ");
	const n = Number(pid);
	if (!Number.isInteger(n) || n <= 0) return false;
	try {
		process.kill(n, 0);
	} catch (e) {
		if (e.code !== "EPERM") return false;
	}
	const s = stat(n);
	// No /proc, or hidden: a live pid is all there is to go on.
	if (!s) return true;
	return s.state !== "Z" && s.start === start;
}

/** Calls `onGone` once, when the process `token` names has ended. No token: never. */
export function watchOwner(onGone, token = process.env[OWNER_ENV]) {
	if (!token) return;
	const timer = setInterval(() => {
		if (ownerAlive(token)) return;
		clearInterval(timer);
		onGone();
	}, POLL_MS);
	timer.unref();
}
