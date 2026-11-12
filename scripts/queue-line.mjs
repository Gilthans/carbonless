// The line of runs waiting in the test queue (queue.mjs), so slots go first
// come, first served. Each run has a ticket in the line's directory from its
// arrival to its end:
//
//   <arrival ns, 20 digits>-<pid>   containing "<pid> <start time> <pid ns>"
//
// Arrival is the system-wide monotonic clock, so tickets sort in arrival
// order. A ticket whose pid is gone, a zombie, or now another process (a
// different start time in /proc/<pid>/stat) is a run killed with SIGKILL:
// whoever reads it removes it. A stopped run (Ctrl-Z) keeps its ticket but
// isn't counted until it runs again. A ticket from another pid namespace (a
// sandbox sharing HOME) can't be judged from here: it isn't counted, and is
// removed only once its file is a day old.
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const TICKET = /^(\d{20})-(\d+)$/;
/** A foreign ticket older than this is left over: removed. */
const FOREIGN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Failed rewrites of our own ticket in a row before trying slots anyway. */
const REJOIN_TRIES = 3;

/** This process's pid namespace ("pid:[4026531836]"); "" when unknown. */
function pidNamespace() {
	try {
		return readlinkSync("/proc/self/ns/pid");
	} catch {
		return "";
	}
}
const NS = pidNamespace();

/**
 * `pid`'s state letter and start time (clock ticks since boot, field 22)
 * from /proc/<pid>/stat; null when unknown (gone, or no /proc).
 */
function proc(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Fields after the command name, which may hold spaces or ")".
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return { state: rest[0] ?? "", start: rest[19] ?? "" };
	} catch {
		return null;
	}
}

/** When `pid` started; "" when unknown (no /proc). */
export function startTime(pid) {
	return proc(pid)?.start ?? "";
}

/**
 * What a ticket ("<pid> <start> <ns>") says of its run: "live" (in line),
 * "dead" (remove it), "stopped" (keep it, don't count it) or "foreign"
 * (another pid namespace: leave it alone).
 */
export function ticketState(content) {
	const [pid, start = "", ns = ""] = content.trim().split(" ");
	if (ns && NS && ns !== NS) return "foreign";
	const n = Number(pid);
	if (!Number.isInteger(n) || n <= 0) return "dead";
	try {
		process.kill(n, 0);
	} catch (e) {
		if (e.code !== "EPERM") return "dead";
	}
	const p = proc(n);
	// No /proc: a live pid is all there is to go on.
	if (!p) return start ? "dead" : "live";
	if (p.start !== start) return "dead";
	if (p.state === "Z" || p.state === "X") return "dead";
	if (p.state === "T" || p.state === "t") return "stopped";
	return "live";
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
		const state = ticketState(content);
		if (state === "live") live.push(name);
		else if (state === "dead" || (state === "foreign" && stale(dir, name))) {
			try {
				unlinkSync(join(dir, name));
			} catch {}
		}
	}
	return live;
}

/** Whether ticket `name`'s file is older than FOREIGN_MAX_AGE_MS. */
function stale(dir, name) {
	try {
		return Date.now() - statSync(join(dir, name)).mtimeMs > FOREIGN_MAX_AGE_MS;
	} catch {
		return false;
	}
}

/**
 * Writes this process's ticket `name` in `dir`, whole before it appears: a
 * reader never sees one without its start time.
 */
function writeTicket(dir, name) {
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${name}.tmp`);
	writeFileSync(tmp, `${process.pid} ${startTime(process.pid)} ${NS}\n`);
	renameSync(tmp, join(dir, name));
}

/**
 * Puts this process at the end of the line in `dir`. `place()`: how many
 * live tickets are ahead of it; Infinity while it has no ticket (never first
 * by accident), until REJOIN_TRIES rewrites in a row failed: then 0, so the
 * run tries the slots as if there were no line (said once on stderr).
 * `leave()`: removes the ticket (again is a no-op).
 */
export function joinLine(dir) {
	const name = `${process.hrtime.bigint().toString().padStart(20, "0")}-${process.pid}`;
	writeTicket(dir, name);
	let left = false;
	let failed = 0;
	let warned = false;
	return {
		name,
		place() {
			const i = line(dir).indexOf(name);
			if (i >= 0) {
				failed = 0;
				return i;
			}
			// Our ticket is gone (removed by hand): back in, at our arrival.
			let j = -1;
			try {
				writeTicket(dir, name);
				j = line(dir).indexOf(name);
			} catch {}
			if (j >= 0) {
				failed = 0;
				return j;
			}
			if (++failed < REJOIN_TRIES) return Number.POSITIVE_INFINITY;
			if (!warned) {
				warned = true;
				console.error(
					`queue: can't keep a ticket in ${dir}; trying the slots without the line`,
				);
			}
			return 0;
		},
		leave() {
			if (left) return;
			left = true;
			try {
				unlinkSync(join(dir, name));
			} catch {}
		},
	};
}
