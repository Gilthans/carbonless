// The line of runs waiting in the test queue (queue.mjs), so slots go first
// come, first served. Each run has a ticket in the line's directory from its
// arrival to its end:
//
//   <arrival ns, 20 digits>-<pid>
//   containing "<pid> <start time> <pid ns> <full|short>[ held]"
//
// Arrival is the system-wide monotonic clock, so tickets sort in arrival
// order. `full` is a whole suite (isFullRun); `held` is added once the run
// holds a slot (markHeld, by the process holding it). A ticket without a
// kind (an older queue.mjs) counts as full and waiting. A ticket whose pid is gone, a zombie, or now another process (a
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
import { basename, dirname, join } from "node:path";

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
	if (ns && ns !== "-" && NS && ns !== NS) return "foreign";
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

/** The names of the live tickets in `dir`, oldest first; dead ones are removed. */
export function line(dir) {
	return tickets(dir).map((t) => t.name);
}

/**
 * The live tickets in `dir`, oldest first, with what each says of its run:
 * `full` (a whole suite) and `held` (holding a slot). Dead ones are removed.
 */
export function tickets(dir) {
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
		if (state === "live") live.push({ name, ...ticketKind(content) });
		else if (state === "dead" || (state === "foreign" && stale(dir, name))) {
			try {
				unlinkSync(join(dir, name));
			} catch {}
		}
	}
	return live;
}

/** What a ticket says of its run; no kind (an older queue.mjs): full. */
export function ticketKind(content) {
	const [, , , kind, held] = content.trim().split(" ");
	return { full: kind !== "short", held: held === "held" };
}

/**
 * The tickets of `line` (oldest first) that may try a slot now, of `slots`,
 * with at most one full run at a time: the held ones take their slots, then
 * the waiting ones go in order while slots are left. A full run waits while
 * another full one holds a slot or goes before it; a short one behind it
 * may then take the free slot.
 */
export function mayTry(line, slots) {
	let free = slots;
	let fullTaken = false;
	for (const t of line) {
		if (!t.held) continue;
		free--;
		if (t.full) fullTaken = true;
	}
	const go = new Set();
	for (const t of line) {
		if (t.held || free <= 0) continue;
		if (t.full && fullTaken) continue;
		go.add(t.name);
		free--;
		if (t.full) fullTaken = true;
	}
	return go;
}

/** The runs holding a slot in the line in `dir` now. */
export function sharing(dir) {
	return tickets(dir).filter((t) => t.held).length;
}

/**
 * Whether `cmd args` runs a whole suite: Vitest with no file filter and no
 * --changed, Playwright with no spec (or more than MANY_SPECS), filter or
 * --grep, or a command that
 * is neither (`pnpm verify`'s sh -c, anything unknown: counted as full, so
 * a mistake only makes a run wait). flake-check names its tests: short.
 */
export function isFullRun(cmd, args) {
	const argv = [cmd, ...args];
	const base = (a) => a.slice(a.lastIndexOf("/") + 1);
	const vitest = argv.findIndex((a) => /^vitest(\.mjs)?$/.test(base(a)));
	if (vitest >= 0) return vitestFull(argv.slice(vitest + 1));
	const pw = argv.findIndex(
		(a) => base(a) === "playwright" || /@playwright\/test\/cli\.js$/.test(a),
	);
	if (pw >= 0) return playwrightFull(argv.slice(pw + 1));
	if (argv.some((a) => base(a) === "flake-check.mjs")) return false;
	return true;
}

// Options that take their value as the next argument, so it isn't a filter.
const VITEST_VALUED = new Set([
	"-t",
	"--testNamePattern",
	"-c",
	"--config",
	"-r",
	"--root",
	"--dir",
	"--project",
	"--reporter",
	"--outputFile",
	"--maxWorkers",
	"--minWorkers",
	"--pool",
	"--environment",
	"--shard",
	"--mode",
	"--exclude",
]);
const PLAYWRIGHT_VALUED = new Set([
	"-c",
	"--config",
	"--project",
	"-j",
	"--workers",
	"--repeat-each",
	"--reporter",
	"--output",
	"--timeout",
	"--global-timeout",
	"--max-failures",
	"--shard",
	"--retries",
	"--trace",
	"--tsconfig",
]);

/** Positional arguments (filters) of `args`, skipping `valued` options' values. */
function positionals(args, valued) {
	const out = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") {
			out.push(...args.slice(i + 1));
			break;
		}
		if (a.startsWith("-")) {
			if (valued.has(a)) i++;
			continue;
		}
		out.push(a);
	}
	return out;
}

function vitestFull(args) {
	const [sub, ...rest] = args;
	if (sub === "related") return false;
	const opts = sub === "run" || sub === "watch" ? rest : args;
	if (opts.some((a) => a === "--changed" || a.startsWith("--changed=")))
		return false;
	return positionals(opts, VITEST_VALUED).length === 0;
}

function playwrightFull(args) {
	const [sub, ...rest] = args;
	if (sub !== "test") return true;
	const short = ["-g", "--grep", "--last-failed", "--only-changed"];
	if (rest.some((a) => short.some((s) => a === s || a.startsWith(`${s}=`))))
		return false;
	const specs = positionals(rest, PLAYWRIGHT_VALUED).length;
	return specs === 0 || specs > MANY_SPECS;
}

/**
 * More specs than this make a full run: verify:fast after a change to
 * widely used code lists most of the suite's ~50 specs one by one.
 */
const MANY_SPECS = 10;

/**
 * Marks the ticket at `path` as holding a slot (from the process holding
 * it: the ticket stays its waiter's). Whole before it appears, as written.
 */
export function markHeld(path) {
	try {
		const content = readFileSync(path, "utf8").trim();
		if (ticketKind(content).held) return;
		const parts = content.split(" ");
		while (parts.length < 4) parts.push(parts.length === 3 ? "full" : "-");
		const tmp = join(dirname(path), `.${basename(path)}.tmp`);
		writeFileSync(tmp, `${parts.join(" ")} held\n`);
		renameSync(tmp, path);
	} catch {}
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
function writeTicket(dir, name, kind) {
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${name}.tmp`);
	writeFileSync(
		tmp,
		`${process.pid} ${startTime(process.pid)} ${NS || "-"} ${kind}\n`,
	);
	renameSync(tmp, join(dir, name));
}

/**
 * Puts this process at the end of the line in `dir`, as a `full` run or a
 * short one. `place()`: how many live tickets are ahead of it; Infinity
 * while it has no ticket (never first by accident), until REJOIN_TRIES
 * rewrites in a row failed: then 0, so the run tries the slots as if there
 * were no line (said once on stderr). `turn(slots)`: whether it may try a
 * slot now (mayTry), and `ahead` as place() says. `path`: its ticket's
 * file. `leave()`: removes the ticket (again is a no-op).
 */
export function joinLine(dir, { full = true } = {}) {
	const name = `${process.hrtime.bigint().toString().padStart(20, "0")}-${process.pid}`;
	const kind = full ? "full" : "short";
	writeTicket(dir, name, kind);
	let left = false;
	let failed = 0;
	let warned = false;
	/** The line with our ticket in it; Infinity or 0 as place() says. */
	const current = () => {
		const now = tickets(dir);
		if (now.some((t) => t.name === name)) {
			failed = 0;
			return now;
		}
		// Our ticket is gone (removed by hand): back in, at our arrival.
		let again = [];
		try {
			writeTicket(dir, name, kind);
			again = tickets(dir);
		} catch {}
		if (again.some((t) => t.name === name)) {
			failed = 0;
			return again;
		}
		if (++failed < REJOIN_TRIES) return Number.POSITIVE_INFINITY;
		if (!warned) {
			warned = true;
			console.error(
				`queue: can't keep a ticket in ${dir}; trying the slots without the line`,
			);
		}
		return 0;
	};
	return {
		name,
		path: join(dir, name),
		place() {
			const now = current();
			return typeof now === "number"
				? now
				: now.findIndex((t) => t.name === name);
		},
		turn(slots) {
			const now = current();
			if (typeof now === "number") return { go: now === 0, ahead: now };
			return {
				go: mayTry(now, slots).has(name),
				ahead: now.findIndex((t) => t.name === name),
			};
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
