import { readFileSync } from "node:fs";

/*
 * $CRB_OWNER ("<pid> <start time>"): the test process that started this crb
 * (e2e/pr-setup.ts, test/setup.ts). A test runner killed mid-test never
 * stops the `crb serve` it started, nor the detached one a client of it
 * started: with an owner, `crb serve` shuts down once the owner is gone.
 * Nothing but the test harness sets it. The same check as
 * scripts/owner.mjs, which the build can't reach.
 */

export const OWNER_ENV = "CRB_OWNER";
const POLL_MS = 1000;

/**
 * `pid`'s state letter and start time (clock ticks since boot, field 22)
 * from /proc/<pid>/stat; null when unknown (gone, or no /proc).
 */
function stat(pid: number): { state: string; start: string } | null {
	try {
		const text = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Fields after the command name, which may hold spaces or ")".
		const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
		return { state: rest[0] ?? "", start: rest[19] ?? "" };
	} catch {
		return null;
	}
}

/** Whether the process `token` names runs: not ended, a zombie, or its pid reused. */
export function ownerAlive(token: string): boolean {
	const [pid, start = ""] = token.trim().split(" ");
	const n = Number(pid);
	if (!Number.isInteger(n) || n <= 0) return false;
	try {
		process.kill(n, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	const s = stat(n);
	// No /proc, or hidden: a live pid is all there is to go on.
	if (!s) return true;
	return s.state !== "Z" && s.start === start;
}

/** Calls `onGone` once, when the process `token` names has ended. No token: never. */
export function watchOwner(
	onGone: () => void,
	token = process.env[OWNER_ENV],
	pollMs = POLL_MS,
): void {
	if (!token) return;
	const timer = setInterval(() => {
		if (ownerAlive(token)) return;
		clearInterval(timer);
		onGone();
	}, pollMs);
	timer.unref();
}
