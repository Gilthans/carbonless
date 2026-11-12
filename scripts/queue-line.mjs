// The line of runs waiting in the test queue (queue.mjs), so slots go first
// come, first served. Each run has a ticket in the line's directory from its
// arrival to its end:
//
//   <arrival ns, 20 digits>-<pid>   containing "<pid> <pid's start time>"
//
// Arrival is the system-wide monotonic clock, so tickets sort in arrival
// order. A ticket whose pid is gone, or now belongs to another process (a
// different start time in /proc/<pid>/stat), is a run killed with SIGKILL:
// whoever reads it removes it.
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const TICKET = /^(\d{20})-(\d+)$/;

/**
 * When `pid` started (clock ticks since boot, /proc/<pid>/stat field 22);
 * "" when unknown (no /proc).
 */
export function startTime(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Fields after the command name, which may hold spaces or ")".
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return rest[19] ?? "";
	} catch {
		return "";
	}
}

/** Whether the process that wrote a ticket ("<pid> <start>") still runs. */
export function alive(content) {
	const [pid, start = ""] = content.trim().split(" ");
	const n = Number(pid);
	if (!Number.isInteger(n) || n <= 0) return false;
	try {
		process.kill(n, 0);
	} catch (e) {
		if (e.code !== "EPERM") return false;
	}
	return startTime(n) === start;
}

/** The live tickets in `dir`, oldest first; dead ones are removed. */
export function line(dir) {
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const tickets = names
		.map((name) => ({ name, m: TICKET.exec(name) }))
		.filter((t) => t.m)
		.sort((a, b) =>
			a.m[1] === b.m[1]
				? Number(a.m[2]) - Number(b.m[2])
				: a.m[1] < b.m[1]
					? -1
					: 1,
		);
	const live = [];
	for (const { name } of tickets) {
		let content;
		try {
			content = readFileSync(join(dir, name), "utf8");
		} catch {
			continue; // Left the line meanwhile.
		}
		if (alive(content)) live.push(name);
		else {
			try {
				unlinkSync(join(dir, name));
			} catch {}
		}
	}
	return live;
}

/**
 * Puts this process at the end of the line in `dir`. `place()`: how many
 * live tickets are ahead of it. `leave()`: removes the ticket (again is a
 * no-op).
 */
export function joinLine(dir) {
	mkdirSync(dir, { recursive: true });
	const name = `${process.hrtime.bigint().toString().padStart(20, "0")}-${process.pid}`;
	const path = join(dir, name);
	// Written whole before it appears: a reader never sees a ticket without
	// its start time.
	const tmp = join(dir, `.${name}.tmp`);
	writeFileSync(tmp, `${process.pid} ${startTime(process.pid)}\n`);
	renameSync(tmp, path);
	let left = false;
	return {
		name,
		place() {
			const i = line(dir).indexOf(name);
			// Our own ticket gone (removed by hand): last in line, rejoin.
			if (i >= 0) return i;
			writeFileSync(path, `${process.pid} ${startTime(process.pid)}\n`);
			return line(dir).indexOf(name);
		},
		leave() {
			if (left) return;
			left = true;
			try {
				unlinkSync(path);
			} catch {}
		},
	};
}
