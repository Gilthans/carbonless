import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queueSlots } from "./queue-config.mjs";
import { queuedWorkers, requireQueue } from "./queue-guard.mjs";
import { joinLine, line, startTime, ticketState } from "./queue-line.mjs";

let home: string;
const env = { ...process.env };
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "crb-queue-"));
});
afterEach(() => {
	process.env = { ...env };
	rmSync(home, { recursive: true, force: true });
});

/** Writes this test's queue config; `null` removes it. */
const configure = (text: string | null) => {
	const dir = join(home, ".config", "carbonless");
	if (text === null) return rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "queue.json"), text);
};

describe("queue config and guard", () => {
	beforeEach(() => {
		process.env.HOME = home;
		delete process.env.CRB_QUEUE_HELD;
		delete process.env.CRB_NO_QUEUE;
	});

	it("no file: no queue, any run goes", () => {
		expect(queueSlots()).toBe(0);
		expect(() => requireQueue("pnpm test")).not.toThrow();
	});

	it("slots come from the file: 1 when missing or not a positive integer", () => {
		configure('{"slots": 3}');
		expect(queueSlots()).toBe(3);
		configure("{}");
		expect(queueSlots()).toBe(1);
		configure('{"slots": 0}');
		expect(queueSlots()).toBe(1);
		configure("not json");
		expect(queueSlots()).toBe(1);
	});

	it("with a queue, refuses a run outside it", () => {
		configure("{}");
		expect(() => requireQueue("pnpm test")).toThrow(/pnpm test/);
	});

	it("with a queue, lets a queued run, or one told to skip it, go", () => {
		configure("{}");
		process.env.CRB_QUEUE_HELD = "/tmp/holder";
		expect(() => requireQueue("pnpm test")).not.toThrow();
		delete process.env.CRB_QUEUE_HELD;
		process.env.CRB_NO_QUEUE = "1";
		expect(() => requireQueue("pnpm test")).not.toThrow();
	});

	it("a queued run gets the cores divided among the slots", () => {
		expect(queuedWorkers(8)).toBeUndefined();
		process.env.CRB_QUEUE_HELD = "/tmp/holder";
		process.env.CRB_QUEUE_SLOTS = "1";
		expect(queuedWorkers(8)).toBe(8);
		process.env.CRB_QUEUE_SLOTS = "3";
		expect(queuedWorkers(8)).toBe(2);
		process.env.CRB_QUEUE_SLOTS = "16";
		expect(queuedWorkers(8)).toBe(1);
	});
});

describe("queue line tickets", () => {
	const started: ChildProcess[] = [];
	afterEach(() => {
		for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
	});
	const state = (pid: number) => {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2)[0];
		} catch {
			return "";
		}
	};
	const until = async (check: () => boolean) => {
		while (!check()) await new Promise((r) => setTimeout(r, 20));
	};
	const ticketOf = (pid: number) => `${pid} ${startTime(pid)}`;

	it("a ticket is live only while its pid runs with the start time it wrote", () => {
		expect(ticketState(ticketOf(process.pid))).toBe("live");
		// The pid now belongs to another process (pid reuse).
		expect(ticketState(`${process.pid} 1`)).toBe("dead");
		expect(ticketState("")).toBe("dead");
		const gone = spawnSync("true").pid as number;
		expect(ticketState(ticketOf(gone))).toBe("dead");
	});

	it.skipIf(!existsSync("/proc/self/stat"))(
		"a zombie's ticket is dead, a stopped run's is stopped",
		{ timeout: 30_000 },
		async () => {
			// A child killed while its parent is stopped stays unreaped.
			const parent = spawn("sh", ["-c", "sleep 30 & echo $!; wait"]);
			started.push(parent);
			let out = "";
			parent.stdout?.on("data", (d) => {
				out += d;
			});
			await until(() => out.endsWith("\n"));
			const zombie = Number(out);
			parent.kill("SIGSTOP");
			await until(() => state(parent.pid as number) === "T");
			process.kill(zombie, "SIGKILL");
			await until(() => state(zombie) === "Z");
			expect(ticketState(ticketOf(zombie))).toBe("dead");

			const stopped = spawn("sleep", ["30"]);
			started.push(stopped);
			const pid = stopped.pid as number;
			const ticket = ticketOf(pid);
			stopped.kill("SIGSTOP");
			await until(() => state(pid) === "T");
			expect(ticketState(ticket)).toBe("stopped");
			stopped.kill("SIGCONT");
			await until(() => state(pid) === "S" || state(pid) === "R");
			expect(ticketState(ticket)).toBe("live");
		},
	);

	it("a ticket from another pid namespace isn't counted, and is removed only a day old", () => {
		const dir = mkdtempSync(join(tmpdir(), "crb-line-"));
		try {
			const gone = spawnSync("true").pid as number;
			const foreign = `${"1".padStart(20, "0")}-${gone}`;
			writeFileSync(join(dir, foreign), `${gone} 5 pid:[1]\n`);
			expect(ticketState(`${gone} 5 pid:[1]`)).toBe("foreign");
			expect(line(dir)).toEqual([]);
			expect(existsSync(join(dir, foreign))).toBe(true);
			// A day old: left over, removed.
			const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
			utimesSync(join(dir, foreign), twoDaysAgo, twoDaysAgo);
			expect(line(dir)).toEqual([]);
			expect(existsSync(join(dir, foreign))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a run whose ticket vanished rejoins whole, is never first without one, and falls back to no line when it can't rejoin", () => {
		const dir = mkdtempSync(join(tmpdir(), "crb-line-"));
		const me = joinLine(dir);
		try {
			expect(me.place()).toBe(0);
			rmSync(join(dir, me.name));
			expect(me.place()).toBe(0);
			expect(ticketState(readFileSync(join(dir, me.name), "utf8"))).toBe(
				"live",
			);
			// Gone and can't be written back: not in line, so not first...
			rmSync(join(dir, me.name));
			chmodSync(dir, 0o555);
			const warn = vi.spyOn(console, "error").mockImplementation(() => {});
			expect(me.place()).toBe(Number.POSITIVE_INFINITY);
			expect(me.place()).toBe(Number.POSITIVE_INFINITY);
			expect(warn).not.toHaveBeenCalled();
			// ...until a few rewrites in a row failed: then it tries the slots
			// without the line, and says so once.
			expect(me.place()).toBe(0);
			expect(me.place()).toBe(0);
			expect(warn).toHaveBeenCalledOnce();
			expect(String(warn.mock.calls[0]?.[0])).toContain("without the line");
			warn.mockRestore();
		} finally {
			chmodSync(dir, 0o755);
			me.leave();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

const hasFlock = spawnSync("flock", ["--version"]).status === 0;
const realFlock = hasFlock
	? spawnSync("sh", ["-c", "command -v flock"], {
			encoding: "utf8",
		}).stdout.trim()
	: "";
const QUEUE = join(import.meta.dirname, "queue.mjs");

describe.skipIf(!hasFlock)("queue", () => {
	const started: ChildProcess[] = [];
	beforeEach(() => configure("{}"));
	afterEach(() => {
		for (const c of started) if (c.exitCode === null) c.kill("SIGKILL");
	});

	/**
	 * A `flock` that logs each attempt at a slot by the run `CRB_TEST_NAME`
	 * names to `attempts()`, then is the real one.
	 */
	const fakeFlock = () => {
		const bin = join(home, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "flock"),
			`#!/bin/sh\n[ "$1" = -n ] && echo "$CRB_TEST_NAME" >> ${join(home, "flock.log")}\nexec ${realFlock} "$@"\n`,
			{ mode: 0o755 },
		);
		return bin;
	};
	const attempts = () => {
		try {
			return readFileSync(join(home, "flock.log"), "utf8")
				.split("\n")
				.filter(Boolean);
		} catch {
			return [];
		}
	};
	const tickets = () => {
		try {
			return readdirSync(join(home, ".cache", "carbonless-queue"));
		} catch {
			return [];
		}
	};

	/**
	 * queue.mjs running `script` in sh, with HOME (so config and locks) in
	 * `home`. `as`: the name its flock attempts log under, and how often it
	 * polls.
	 */
	const queue = (script: string, as?: { name: string; pollMs: number }) => {
		const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
		if (as) {
			childEnv.PATH = `${fakeFlock()}:${process.env.PATH}`;
			childEnv.CRB_TEST_NAME = as.name;
			childEnv.CRB_QUEUE_POLL_MS = String(as.pollMs);
		}
		delete childEnv.CRB_NO_QUEUE;
		delete childEnv.CRB_QUEUE_HELD;
		delete childEnv.CRB_QUEUE_SINCE;
		delete childEnv.CRB_QUEUE_SLOTS;
		const child = spawn(process.execPath, [QUEUE, "sh", "-c", script], {
			env: childEnv,
			cwd: home,
		});
		let out = "";
		child.stdout?.on("data", (d) => {
			out += d;
		});
		started.push(child);
		return { child, out: () => out };
	};
	const exited = (c: ChildProcess) =>
		new Promise<number | null>((done) => {
			if (c.exitCode !== null) done(c.exitCode);
			else c.once("exit", (code) => done(code));
		});
	const until = async (check: () => boolean) => {
		while (!check()) await new Promise((r) => setTimeout(r, 20));
	};
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const lock = (i = 0) =>
		join(home, ".cache", `carbonless-verify.lock${i ? `.${i}` : ""}`);
	const free = (i = 0) =>
		spawnSync("flock", ["-n", lock(i), "true"]).status === 0;
	/** A run that holds its slot until `release` is touched. */
	const holdUntil = (name: string, pollMs?: number) => {
		const held = join(home, `${name}.held`);
		const release = join(home, `${name}.go`);
		const run = queue(
			`touch ${held}; while [ ! -e ${release} ]; do sleep 0.05; done`,
			pollMs ? { name, pollMs } : undefined,
		);
		return {
			...run,
			held: () => existsSync(held),
			release: () => spawnSync("touch", [release]),
		};
	};

	it("a run nested in a held slot, or with no queue, needs no line and waits for none", {
		timeout: 30_000,
	}, async () => {
		// queue.mjs on its own (as another tree's copy may be): no queue-line.mjs.
		const alone = join(home, "alone");
		mkdirSync(alone);
		for (const f of ["queue.mjs", "queue-config.mjs"])
			copyFileSync(join(import.meta.dirname, f), join(alone, f));
		const run = (env: NodeJS.ProcessEnv) =>
			spawnSync(process.execPath, [join(alone, "queue.mjs"), "true"], {
				env: {
					...process.env,
					HOME: home,
					CRB_NO_QUEUE: "",
					CRB_QUEUE_SINCE: "",
					...env,
				},
				timeout: 20_000,
			}).status;
		// A holder in line and in the slot: a nested run still goes at once.
		const a = holdUntil("a");
		await until(a.held);
		expect(tickets().length).toBe(1);
		expect(run({ CRB_QUEUE_HELD: join(home, "nested.holder") })).toBe(0);
		configure(null);
		expect(run({ CRB_QUEUE_HELD: "" })).toBe(0);
		a.release();
		expect(await exited(a.child)).toBe(0);
	});

	it("a signal ends a wait, and stops a held run's whole group; the lock is free", {
		timeout: 30_000,
	}, async () => {
		const pidFile = join(home, "sleep.pid");
		const holder = queue(`sleep 60 & echo $! > ${pidFile}; wait`);
		await until(
			() => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"),
		);
		const sleeper = Number(readFileSync(pidFile, "utf8"));
		const ran = join(home, "ran");
		const waiter = queue(`touch ${ran}`);
		await until(() => waiter.out().includes("queue: waiting for"));
		expect(waiter.out()).toContain(`${home} (sh -c sleep 60`);

		// The waiter gives up: nothing of it waits on, or runs later.
		waiter.child.kill("SIGTERM");
		expect(await exited(waiter.child)).toBe(143);
		// The holder stops its shell and the shell's own child.
		holder.child.kill("SIGTERM");
		expect(await exited(holder.child)).toBe(143);
		await until(() => !alive(sleeper));
		expect(free()).toBe(true);
		expect(existsSync(ran)).toBe(false);
		// Neither left a ticket in the line.
		expect(tickets()).toEqual([]);
	});

	it("waiters go in arrival order, even when a later one polls faster", {
		timeout: 30_000,
	}, async () => {
		// The slot is held outside the line (a run from an older queue.mjs),
		// so b, first in line, keeps trying it.
		mkdirSync(join(home, ".cache"), { recursive: true });
		const aHeld = join(home, "a.held");
		const aGo = join(home, "a.go");
		const a = spawn(realFlock, [
			lock(0),
			"sh",
			"-c",
			`touch ${aHeld}; while [ ! -e ${aGo} ]; do sleep 0.05; done`,
		]);
		started.push(a);
		await until(() => existsSync(aHeld));
		const b = holdUntil("b", 1000);
		await until(() => b.out().includes("queue: waiting for"));
		const c = holdUntil("c", 20);
		await until(() => c.out().includes("queue: waiting for"));
		// Free the slot just after b tried it: c, polling every 20 ms, gets
		// there first if the fastest poll wins.
		const tried = attempts().filter((n) => n === "b").length;
		await until(() => attempts().filter((n) => n === "b").length > tried);
		spawnSync("touch", [aGo]);
		await until(() => b.held() || c.held());
		expect(b.held()).toBe(true);
		expect(c.held()).toBe(false);
		// c, second in line, never even tried the lock, and said so.
		expect(attempts()).not.toContain("c");
		expect(c.out()).toContain("(1 ahead)");

		b.release();
		await until(c.held);
		c.release();
		for (const r of [a, b.child, c.child]) expect(await exited(r)).toBe(0);
		expect(tickets()).toEqual([]);
	});

	it("a stopped waiter lets the ones behind it go, and keeps its place", {
		timeout: 30_000,
	}, async () => {
		const a = holdUntil("a");
		await until(a.held);
		const b = holdUntil("b", 20);
		await until(() => b.out().includes("queue: waiting for"));
		b.child.kill("SIGSTOP");
		const c = holdUntil("c", 20);
		await until(() => c.out().includes("queue: waiting for"));
		a.release();
		await until(c.held);
		expect(b.held()).toBe(false);
		expect(tickets().some((t) => t.endsWith(`-${b.child.pid}`))).toBe(true);

		b.child.kill("SIGCONT");
		c.release();
		await until(b.held);
		b.release();
		for (const r of [a, b, c]) expect(await exited(r.child)).toBe(0);
		expect(tickets()).toEqual([]);
	});

	it("a waiter killed with SIGKILL, or a ticket whose pid was reused, doesn't block the line", {
		timeout: 30_000,
	}, async () => {
		const a = holdUntil("a");
		await until(a.held);
		const b = holdUntil("b", 20);
		await until(() => b.out().includes("queue: waiting for"));
		b.child.kill("SIGKILL");
		await exited(b.child);
		const bTicket = `-${b.child.pid}`;
		expect(tickets().some((t) => t.endsWith(bTicket))).toBe(true);
		// Oldest of all, of a live pid, but a process that started later.
		const reused = `${"1".padStart(20, "0")}-${process.pid}`;
		writeFileSync(
			join(home, ".cache", "carbonless-queue", reused),
			`${process.pid} 1\n`,
		);

		const c = holdUntil("c", 20);
		await until(() => c.out().includes("queue: waiting for"));
		a.release();
		await until(c.held);
		expect(tickets().some((t) => t.endsWith(bTicket))).toBe(false);
		expect(tickets()).not.toContain(reused);
		c.release();
		for (const r of [a, c]) expect(await exited(r.child)).toBe(0);
		expect(tickets()).toEqual([]);
	});

	it("with 2 slots, the two oldest waiters go in", {
		timeout: 30_000,
	}, async () => {
		configure('{"slots": 2}');
		const h1 = holdUntil("h1");
		const h2 = holdUntil("h2");
		await until(() => h1.held() && h2.held());
		const w1 = holdUntil("w1", 1000);
		await until(() => w1.out().includes("queue: waiting for"));
		const w2 = holdUntil("w2", 1000);
		await until(() => w2.out().includes("queue: waiting for"));
		const w3 = holdUntil("w3", 20);
		await until(() => w3.out().includes("queue: waiting for"));

		h1.release();
		h2.release();
		const waiters = [w1, w2, w3];
		await until(() => waiters.filter((w) => w.held()).length >= 2);
		expect(waiters.map((w) => w.held())).toEqual([true, true, false]);
		expect(attempts()).not.toContain("w3");

		w1.release();
		await until(w3.held);
		w2.release();
		w3.release();
		for (const r of [h1, h2, ...waiters]) expect(await exited(r.child)).toBe(0);
		expect(tickets()).toEqual([]);
	});

	it("the next run goes once the holder is done, and its status comes back", {
		timeout: 30_000,
	}, async () => {
		const holder = holdUntil("a");
		await until(holder.held);
		expect(free()).toBe(false);
		const next = queue("exit 3");
		await until(() => next.out().includes("queue: waiting for"));
		holder.release();
		expect(await exited(holder.child)).toBe(0);
		expect(await exited(next.child)).toBe(3);
		expect(free()).toBe(true);
	});

	it("slots runs go at once; raising slots lets a waiting run go, no restart", {
		timeout: 30_000,
	}, async () => {
		configure('{"slots": 2}');
		const a = holdUntil("a");
		const b = holdUntil("b");
		await until(() => a.held() && b.held());
		expect(free(0) || free(1)).toBe(false);
		const c = holdUntil("c");
		await until(() => c.out().includes("queue: waiting for"));
		expect(c.held()).toBe(false);

		configure('{"slots": 3}');
		await until(c.held);
		expect(free(2)).toBe(false);
		for (const r of [a, b, c]) r.release();
		for (const r of [a, b, c]) expect(await exited(r.child)).toBe(0);
	});

	it("removing the config lets a waiting run go unqueued", {
		timeout: 30_000,
	}, async () => {
		const holder = holdUntil("a");
		await until(holder.held);
		const next = queue('[ -z "$CRB_QUEUE_HELD" ] && echo unqueued');
		await until(() => next.out().includes("queue: waiting for"));
		configure(null);
		expect(await exited(next.child)).toBe(0);
		expect(next.out()).toContain("unqueued");
		holder.release();
		expect(await exited(holder.child)).toBe(0);
	});

	it("a held command's own exit 200 doesn't read as a taken slot", {
		timeout: 30_000,
	}, async () => {
		const ran = join(home, "count");
		const run = queue(`echo x >> ${ran}; exit 200`);
		expect(await exited(run.child)).toBe(1);
		expect(readFileSync(ran, "utf8")).toBe("x\n");
	});
});
